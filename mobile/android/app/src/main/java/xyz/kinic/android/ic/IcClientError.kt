// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcClientError.kt
// What: Shared error surface for Android IC request and auth primitives.
// Why: Callers need stable failure kinds for invalid auth, boundary-node errors, and rejected canister calls.

package xyz.kinic.android.ic

sealed class IcClientError(message: String) : Exception(message) {
    data object InvalidCanisterId : IcClientError("Invalid canister id.")
    data class InvalidIdentity(val detail: String) : IcClientError(detail)
    data object InvalidPayload : IcClientError("Internet Identity returned an invalid payload.")
    data class AuthorizationFailed(val detail: String) : IcClientError(detail)
    data object ExpiredDelegation : IcClientError("Internet Identity delegation expired.")
    data object EmptyResponse : IcClientError("The canister returned no response.")
    data class InvalidResponse(val detail: String) : IcClientError("The canister response could not be decoded: $detail.")
    data class BackendUnavailable(val detail: String) : IcClientError("IC boundary node is unavailable. ($detail)")
    data class Rejected(val detail: String) : IcClientError(detail)
    data object PollTimeout : IcClientError("IC update polling timed out.")
}
