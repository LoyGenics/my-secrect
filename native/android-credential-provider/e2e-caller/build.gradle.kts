plugins {
    id("com.android.application") version "8.6.0"
    id("org.jetbrains.kotlin.android") version "1.9.25"
}

android {
    namespace = "com.loygenics.mysecrect.credtest"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.loygenics.mysecrect.credtest"
        minSdk = 34
        targetSdk = 35
        versionCode = 1
        versionName = "1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].java.srcDir("src/main/kotlin")
}

dependencies {
    implementation("androidx.credentials:credentials:1.5.0")
}
