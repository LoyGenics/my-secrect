/**
 * Expo config plugin: Android Credential Manager provider (Android 14+).
 *
 * On `npx expo prebuild --platform android` it
 *  1. copies the Kotlin sources, resources and tests from
 *     native/android-credential-provider/src/<set>/ into the generated
 *     app module (android/app/src/<set>/kotlin, res), replacing earlier
 *     copies (debug/release hold the debug-only assetlinks override);
 *  2. declares MySecrectCredentialProviderService + GetPasswordActivity
 *     in the manifest (enabled only on API 34+ via a bool resource) and a
 *     launcher `<queries>` entry so the provider can read a calling app's
 *     `asset_statements` (Digital Asset Links);
 *  3. adds the Gradle dependencies (androidx.credentials, androidx.biometric,
 *     JNA, SQLCipher) and test dependencies, plus R8 keep rules for the JNA /
 *     SQLCipher native bindings. libsodium itself is the app's own
 *     libsodium.so from react-native-libsodium (one copy per APK), reached
 *     through JNA; the provider fails closed if it is missing.
 *
 * Generated android/ is gitignored (specs/mobile-local-store.md §7); this
 * plugin is the only way the provider gets into the app.
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const PROVIDER_ROOT = path.resolve(__dirname, '../../../native/android-credential-provider');
const PACKAGE_DIR = path.join('com', 'loygenics', 'mysecrect', 'provider');
const SERVICE = 'com.loygenics.mysecrect.provider.MySecrectCredentialProviderService';
const ACTIVITY = 'com.loygenics.mysecrect.provider.GetPasswordActivity';
const ENABLED = '@bool/my_secrect_credential_provider_enabled';
const MARK_BEGIN = '// @generated begin my-secrect-android-credential-provider';
const MARK_END = '// @generated end my-secrect-android-credential-provider';
const PROGUARD_MARK = '# begin my-secrect-android-credential-provider';
const PROGUARD_END = '# end my-secrect-android-credential-provider';

const GRADLE_BLOCK = `${MARK_BEGIN} (with-android-credential-provider.js; do not edit)
android {
    defaultConfig {
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
}
dependencies {
    implementation "androidx.credentials:credentials:1.5.0"
    implementation "androidx.biometric:biometric:1.1.0"
    implementation "androidx.fragment:fragment:1.8.6"
    implementation "net.java.dev.jna:jna:5.14.0@aar"
    implementation "net.zetetic:sqlcipher-android:4.6.1@aar"
    implementation "androidx.sqlite:sqlite:2.4.0"

    testImplementation "junit:junit:4.13.2"
    testImplementation "org.json:json:20240303"

    androidTestImplementation "androidx.test:runner:1.6.2"
    androidTestImplementation "androidx.test:core:1.6.1"
    androidTestImplementation "androidx.test.ext:junit:1.2.1"
    debugImplementation "androidx.fragment:fragment-testing-manifest:1.8.6"
    androidTestImplementation "androidx.fragment:fragment-testing:1.8.6"
}
${MARK_END}
`;

const PROGUARD_RULES = `
${PROGUARD_MARK}
-keep class com.sun.jna.** { *; }
-keep class com.loygenics.mysecrect.provider.Libsodium { *; }
-keep class net.zetetic.database.** { *; }
-dontwarn java.awt.**
${PROGUARD_END}
`;

/**
 * native/android-credential-provider/src/<from> -> android/app/src/<to>.
 * Kotlin goes to src/<set>/kotlin (a default Kotlin source root), NOT
 * src/<set>/java: prebuild's package rename treats the first file it finds
 * under src/debug|release/java as the app package and would move ours.
 */
const COPIES = [
  ['main/kotlin', 'main/kotlin'],
  ['debug/kotlin', 'debug/kotlin'],
  ['release/kotlin', 'release/kotlin'],
  ['test/kotlin', 'test/kotlin'],
  ['androidTest/kotlin', 'androidTest/kotlin'],
  ['main/res', 'main/res'],
];

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Every resource this plugin owns is named my_secrect_*. */
function removeOwnResources(resDir) {
  if (!fs.existsSync(resDir)) return;
  for (const dir of fs.readdirSync(resDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of fs.readdirSync(path.join(resDir, dir.name))) {
      if (file.startsWith('my_secrect_')) fs.rmSync(path.join(resDir, dir.name, file));
    }
  }
}

function withProviderFiles(config) {
  return withDangerousMod(config, ['android', async (cfg) => {
    const appSrc = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src');
    // Replace, never merge: a file deleted from native/ must disappear here too.
    for (const [, to] of COPIES) {
      if (to.endsWith('/kotlin')) fs.rmSync(path.join(appSrc, to, PACKAGE_DIR), { recursive: true, force: true });
    }
    removeOwnResources(path.join(appSrc, 'main', 'res'));
    for (const [from, to] of COPIES) copyTree(path.join(PROVIDER_ROOT, 'src', from), path.join(appSrc, to));
    const proguard = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
    let rules = fs.existsSync(proguard) ? fs.readFileSync(proguard, 'utf8') : '';
    const start = rules.indexOf(`\n${PROGUARD_MARK}`);
    if (start !== -1) rules = rules.slice(0, start) + rules.slice(rules.indexOf(PROGUARD_END, start) + PROGUARD_END.length + 1);
    fs.writeFileSync(proguard, rules + PROGUARD_RULES);
    return cfg;
  }]);
}

function withProviderGradle(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-android-credential-provider: expected a Groovy app/build.gradle');
    }
    const start = cfg.modResults.contents.indexOf(MARK_BEGIN);
    let contents = cfg.modResults.contents;
    if (start !== -1) {
      const end = contents.indexOf(MARK_END, start);
      contents = contents.slice(0, start) + contents.slice(end + MARK_END.length + 1);
    }
    cfg.modResults.contents = `${contents.trimEnd()}\n\n${GRADLE_BLOCK}`;
    return cfg;
  });
}

function upsertByName(list, element) {
  const name = element.$['android:name'];
  return [...(list ?? []).filter((e) => e.$?.['android:name'] !== name), element];
}

function withProviderManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const app = manifest.application[0];
    app.service = upsertByName(app.service, {
      $: {
        'android:name': SERVICE,
        'android:enabled': ENABLED,
        'android:exported': 'true',
        'android:label': '@string/app_name',
        'android:icon': '@mipmap/ic_launcher',
        'android:permission': 'android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE',
      },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.credentials.CredentialProviderService' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.credentials.provider', 'android:resource': '@xml/my_secrect_credential_provider' } }],
    });
    app.activity = upsertByName(app.activity, {
      $: {
        'android:name': ACTIVITY,
        'android:enabled': ENABLED,
        'android:exported': 'false',
        'android:excludeFromRecents': 'true',
        'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
        'android:configChanges': 'orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density',
      },
    });
    // Package visibility for reading a caller's `asset_statements` (Android 11+).
    const launcherQuery = {
      action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
      category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
    };
    manifest.queries = manifest.queries ?? [{}];
    const queries = manifest.queries[0];
    const hasLauncher = (queries.intent ?? []).some(
      (i) => i.action?.[0]?.$?.['android:name'] === 'android.intent.action.MAIN'
        && i.category?.[0]?.$?.['android:name'] === 'android.intent.category.LAUNCHER',
    );
    if (!hasLauncher) queries.intent = [...(queries.intent ?? []), launcherQuery];
    return cfg;
  });
}

module.exports = function withAndroidCredentialProvider(config) {
  return withProviderFiles(withProviderGradle(withProviderManifest(config)));
};
