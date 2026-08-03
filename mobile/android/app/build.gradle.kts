plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val releaseVersionCodeVariable = "KINIC_ANDROID_VERSION_CODE"
val releaseSigningVariables = listOf(
    "KINIC_ANDROID_UPLOAD_STORE_FILE",
    "KINIC_ANDROID_UPLOAD_STORE_PASSWORD",
    "KINIC_ANDROID_UPLOAD_KEY_ALIAS",
    "KINIC_ANDROID_UPLOAD_KEY_PASSWORD",
)
val releaseRequested = gradle.startParameter.taskNames.any { taskName ->
    taskName.contains("release", ignoreCase = true)
}
val releaseVersionCodeText = providers.environmentVariable(releaseVersionCodeVariable).orNull
val releaseVersionCode = releaseVersionCodeText?.toIntOrNull()
val releaseSigningValues = releaseSigningVariables.associateWith { variable ->
    providers.environmentVariable(variable).orNull?.takeIf(String::isNotBlank)
}

if (releaseRequested) {
    val invalidVersionCode = releaseVersionCode == null || releaseVersionCode <= 0
    val missingVariables = releaseSigningValues.filterValues { it == null }.keys
    if (invalidVersionCode || missingVariables.isNotEmpty()) {
        val missing = buildList {
            if (invalidVersionCode) add(releaseVersionCodeVariable)
            addAll(missingVariables)
        }
        throw GradleException(
            "Release build configuration is incomplete. Set: ${missing.joinToString()}.",
        )
    }
    val storePath = requireNotNull(releaseSigningValues["KINIC_ANDROID_UPLOAD_STORE_FILE"])
    if (!file(storePath).isFile) {
        throw GradleException("Release upload keystore file does not exist.")
    }
}

android {
    namespace = "xyz.kinic.android"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "xyz.kinic.android.kinicwiki"
        minSdk = 26
        targetSdk = 37
        versionCode = releaseVersionCode ?: 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

    val releaseSigningConfigured = releaseSigningValues.values.all { it != null }
    val releaseSigningConfig = if (releaseSigningConfigured) {
        signingConfigs.create("release") {
            storeFile = file(requireNotNull(releaseSigningValues["KINIC_ANDROID_UPLOAD_STORE_FILE"]))
            storePassword = requireNotNull(releaseSigningValues["KINIC_ANDROID_UPLOAD_STORE_PASSWORD"])
            keyAlias = requireNotNull(releaseSigningValues["KINIC_ANDROID_UPLOAD_KEY_ALIAS"])
            keyPassword = requireNotNull(releaseSigningValues["KINIC_ANDROID_UPLOAD_KEY_PASSWORD"])
        }
    } else {
        null
    }

    buildTypes {
        getByName("release") {
            signingConfig = releaseSigningConfig
        }
    }
}

dependencies {
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.navigation:navigation-compose:2.9.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")
    implementation("org.commonmark:commonmark:0.28.0")
    implementation("org.commonmark:commonmark-ext-autolink:0.28.0")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.28.0")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.28.0")
    implementation("org.jsoup:jsoup:1.22.2")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260522")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")

    androidTestImplementation(platform("androidx.compose:compose-bom:2026.06.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.navigation:navigation-testing:2.9.8")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
