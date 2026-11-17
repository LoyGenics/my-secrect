package expo.modules.devicekey

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Arrays
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// specs/mobile-local-store.md §1, §3, §4, §5. The Android Credential Provider
// (same process) reuses these aliases and paths from its own code.
private const val DIR_NAME = "my-secrect"
private const val LSK_FILE = "lsk.bin"
private const val LSK_ALIAS = "my-secrect.lsk.v1"
private const val UNLOCK_ALIAS = "my-secrect.device-unlock.v1"
private const val SCHEME = "android-ks-aesgcm-v1"
private const val KEYSTORE = "AndroidKeyStore"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val IV_LEN = 12
private const val TAG_BITS = 128
private const val TAG_LEN = 16

/** Rejections carry exactly one of the contract §4 codes as `error.code` in JS. */
class DeviceKeyException(code: String, message: String, cause: Throwable? = null) : CodedException(code, message, cause)

private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

private fun aesKeySpec(alias: String, strongBox: Boolean, userAuth: Boolean): KeyGenParameterSpec {
  val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256)
  if (userAuth) {
    b.setUserAuthenticationRequired(true)
    b.setInvalidatedByBiometricEnrollment(true)
    // Auth per use, strong biometrics only: the key works only inside a BiometricPrompt CryptoObject.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
  }
  if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
  return b.build()
}

private fun generateAesKey(context: Context, alias: String, userAuth: Boolean): SecretKey {
  val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
  val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
    context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
  if (strongBox) {
    try {
      gen.init(aesKeySpec(alias, true, userAuth))
      return gen.generateKey()
    } catch (e: StrongBoxUnavailableException) {
      // fall through to the TEE-backed key
    }
  }
  gen.init(aesKeySpec(alias, false, userAuth))
  return gen.generateKey()
}

private fun storageDir(context: Context): File {
  val dir = File(context.filesDir, DIR_NAME)
  if (!dir.isDirectory && !dir.mkdirs()) throw DeviceKeyException("NOT_AVAILABLE", "cannot create ${dir.path}")
  return dir
}

private val lskLock = Any()

/** Contract §3: 32 random bytes, AES-256-GCM under a no-auth Keystore key, `iv(12) || ct+tag` in lsk.bin. */
private fun getOrCreateStorageKey(context: Context): String {
  synchronized(lskLock) { return storageKeyLocked(context) }
}

private fun storageKeyLocked(context: Context): String {
  val file = File(storageDir(context), LSK_FILE)
  val ks = keyStore()
  if (file.exists()) {
    // Never regenerate over an existing file: vault.db is keyed with it.
    val key = ks.getKey(LSK_ALIAS, null) as? SecretKey
      ?: throw DeviceKeyException("CORRUPT", "storage key wrapping key is missing")
    val blob = file.readBytes()
    if (blob.size != IV_LEN + 32 + TAG_LEN) throw DeviceKeyException("CORRUPT", "lsk.bin has ${blob.size} bytes")
    val lsk = try {
      Cipher.getInstance(TRANSFORMATION).run {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob, 0, IV_LEN))
        doFinal(blob, IV_LEN, blob.size - IV_LEN)
      }
    } catch (e: AEADBadTagException) {
      throw DeviceKeyException("CORRUPT", "lsk.bin does not decrypt", e)
    }
    try { return hex(lsk) } finally { Arrays.fill(lsk, 0) }
  }
  val key = (ks.getKey(LSK_ALIAS, null) as? SecretKey) ?: generateAesKey(context, LSK_ALIAS, userAuth = false)
  val lsk = ByteArray(32).also { SecureRandom().nextBytes(it) }
  try {
    val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
    val blob = cipher.iv + cipher.doFinal(lsk)
    val tmp = File(file.parentFile, "$LSK_FILE.tmp")
    tmp.writeBytes(blob)
    if (!tmp.renameTo(file)) throw DeviceKeyException("NOT_AVAILABLE", "cannot write lsk.bin")
    return hex(lsk)
  } finally {
    Arrays.fill(lsk, 0)
  }
}

private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

private fun biometricStatus(context: Context): Int = BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG)

private fun statusCode(status: Int): String? = when (status) {
  BiometricManager.BIOMETRIC_SUCCESS -> null
  BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "NOT_ENROLLED"
  else -> "NOT_AVAILABLE"
}

private fun promptErrorCode(errorCode: Int): String = when (errorCode) {
  BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED,
  BiometricPrompt.ERROR_TIMEOUT -> "USER_CANCEL"
  BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT"
  BiometricPrompt.ERROR_NO_BIOMETRICS -> "NOT_ENROLLED"
  BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
  BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> "NOT_AVAILABLE"
  else -> "AUTH_FAILED"
}

private fun deleteUnlockKey() {
  val ks = keyStore()
  if (ks.containsAlias(UNLOCK_ALIAS)) ks.deleteEntry(UNLOCK_ALIAS)
}

class DeviceKeyModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw DeviceKeyException("NOT_AVAILABLE", "no React context")

  /**
   * Runs `cipher` through a BiometricPrompt (strong biometrics only, no device-credential
   * fallback). `onCipher` gets the authenticated cipher; any failure runs `onFail` and rejects
   * with a contract code.
   */
  private fun withBiometricCipher(cipher: Cipher, prompt: String, promise: Promise, onFail: () -> Unit, onCipher: (Cipher) -> Any) {
    fun reject(code: String, message: String, cause: Throwable?) {
      onFail()
      promise.reject(code, message, cause)
    }
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return reject("NOT_AVAILABLE", "no foreground activity for the biometric prompt", null)
    activity.runOnUiThread {
      val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val authed = result.cryptoObject?.cipher
            ?: return reject("AUTH_FAILED", "no crypto object after authentication", null)
          try {
            promise.resolve(onCipher(authed))
          } catch (e: AEADBadTagException) {
            reject("CORRUPT", "wrapped AMK does not decrypt", e)
          } catch (e: DeviceKeyException) {
            reject(e.code, e.message ?: e.code, e)
          } catch (e: Exception) {
            reject("CORRUPT", e.message ?: "cipher failed", e)
          }
        }
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          reject(promptErrorCode(errorCode), errString.toString(), null)
        }
        // onAuthenticationFailed (no match) is not terminal: the prompt stays up for another try.
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(prompt)
        .setNegativeButtonText("Use passphrase")
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .setConfirmationRequired(false)
        .build()
      BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
        .authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    /** Contract §1: filesDir/my-secrect/. */
    AsyncFunction("getStorageDirectory") {
      storageDir(context).absolutePath
    }

    AsyncFunction("isAvailable") {
      val status = biometricStatus(context)
      val hasHardware = status != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE &&
        status != BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE &&
        status != BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED
      mapOf(
        "available" to (status == BiometricManager.BIOMETRIC_SUCCESS),
        // The contract has no Android face/iris value; any strong sensor is reported as fingerprint.
        "biometry" to (if (hasHardware) "fingerprint" else "none"),
        "scheme" to (if (hasHardware) SCHEME else null),
      )
    }

    AsyncFunction("getOrCreateStorageKey") {
      getOrCreateStorageKey(context)
    }

    AsyncFunction("enroll") { amkB64: String, prompt: String, promise: Promise ->
      val amk = try { Base64.decode(amkB64, Base64.NO_WRAP) } catch (e: IllegalArgumentException) { null }
      if (amk == null || amk.size != 32) return@AsyncFunction promise.reject("CORRUPT", "AMK must be 32 bytes", null)
      val cipher: Cipher
      try {
        statusCode(biometricStatus(context))?.let { throw DeviceKeyException(it, "biometrics not usable") }
        deleteUnlockKey()
        val key = generateAesKey(context, UNLOCK_ALIAS, userAuth = true)
        cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
      } catch (e: DeviceKeyException) {
        Arrays.fill(amk, 0)
        runCatching { deleteUnlockKey() }
        return@AsyncFunction promise.reject(e)
      } catch (e: Exception) {
        Arrays.fill(amk, 0)
        runCatching { deleteUnlockKey() }
        return@AsyncFunction promise.reject("NOT_AVAILABLE", e.message ?: "device key generation failed", e)
      }
      val onFail = {
        Arrays.fill(amk, 0)
        runCatching { deleteUnlockKey() }
        Unit
      }
      withBiometricCipher(cipher, prompt, promise, onFail) { authed ->
        try {
          val blob = authed.iv + authed.doFinal(amk)
          mapOf("scheme" to SCHEME, "wrappedAmkB64" to Base64.encodeToString(blob, Base64.NO_WRAP))
        } finally {
          Arrays.fill(amk, 0)
        }
      }
    }

    AsyncFunction("unwrap") { scheme: String, wrappedAmkB64: String, prompt: String, promise: Promise ->
      if (scheme != SCHEME) return@AsyncFunction promise.reject("CORRUPT", "unknown scheme $scheme", null)
      val blob = try { Base64.decode(wrappedAmkB64, Base64.NO_WRAP) } catch (e: IllegalArgumentException) { null }
      if (blob == null || blob.size != IV_LEN + 32 + TAG_LEN) return@AsyncFunction promise.reject("CORRUPT", "wrapped AMK has the wrong size", null)
      val cipher: Cipher
      try {
        statusCode(biometricStatus(context))?.let { throw DeviceKeyException(it, "biometrics not usable") }
        val key = keyStore().getKey(UNLOCK_ALIAS, null) as? SecretKey
          ?: throw DeviceKeyException("KEY_INVALIDATED", "device key is gone")
        cipher = Cipher.getInstance(TRANSFORMATION).apply {
          init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob, 0, IV_LEN))
        }
      } catch (e: KeyPermanentlyInvalidatedException) {
        // Biometric enrolment changed (setInvalidatedByBiometricEnrollment).
        runCatching { deleteUnlockKey() }
        return@AsyncFunction promise.reject("KEY_INVALIDATED", "biometric enrolment changed", e)
      } catch (e: DeviceKeyException) {
        return@AsyncFunction promise.reject(e)
      } catch (e: Exception) {
        return@AsyncFunction promise.reject("NOT_AVAILABLE", e.message ?: "device key unusable", e)
      }
      withBiometricCipher(cipher, prompt, promise, onFail = {}) { authed ->
        val amk = authed.doFinal(blob, IV_LEN, blob.size - IV_LEN)
        try {
          if (amk.size != 32) throw DeviceKeyException("CORRUPT", "unwrapped AMK has ${amk.size} bytes")
          Base64.encodeToString(amk, Base64.NO_WRAP)
        } finally {
          Arrays.fill(amk, 0)
        }
      }
    }

    AsyncFunction("remove") {
      deleteUnlockKey()
    }
  }
}
