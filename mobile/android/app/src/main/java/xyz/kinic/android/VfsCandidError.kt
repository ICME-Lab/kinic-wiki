// Where: mobile/android/app/src/main/java/xyz/kinic/android/VfsCandidError.kt
// What: Android VFS Candid decode failures.
// Why: Browse calls need clear local errors before UI displays canister results.

package xyz.kinic.android

sealed class VfsCandidError(message: String) : Exception(message) {
    data class InvalidPayload(val detail: String) : VfsCandidError(detail)
    data class CanisterRejected(val detail: String) : VfsCandidError(detail)
}

