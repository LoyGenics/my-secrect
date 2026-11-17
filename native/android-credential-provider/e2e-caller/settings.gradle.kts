// TEST CALLER ONLY (never shipped): a stand-in third-party app that calls
// CredentialManager.getCredential, for the provider's emulator check.
// Build with the generated Expo project's wrapper:
//   apps/mobile/android/gradlew -p native/android-credential-provider/e2e-caller assembleDebug
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "my-secrect-credtest"
