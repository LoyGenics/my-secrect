// FRAGMENT — merge into the Android app module's build.gradle.kts.
// Not a standalone build file. Pin the versions below to the latest
// available in Android Studio at integration time; 1.3.0 is the minimum
// that provides CredentialProviderService as used here.
//
// plugins {
//     id("com.android.application")
//     id("org.jetbrains.kotlin.android")
// }
//
// android {
//     compileSdk = 34
//     defaultConfig {
//         // Credential Manager provider service requires API 34+ (Android 14).
//         minSdk = 34
//         applicationId = "com.loygenics.mysecrect"
//     }
// }
//
// dependencies {
//     implementation("androidx.credentials:credentials:1.3.0")
//     implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
// }
