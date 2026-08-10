// Where: wikibrowser/app/.well-known/ii-auth-callbacks/route.ts
// What: Declares the exact HTTPS callbacks accepted by the native ICRC-167 flows.
// Why: Internet Identity must authorize the callback before returning delegation data.

export const internetIdentityCallbacks = {
  callbacks: [
    "https://wiki.kinic.xyz/ios-auth-callback",
    "https://wiki.kinic.xyz/native-auth-callback"
  ]
};

export function GET(callbacks = internetIdentityCallbacks): Response {
  return Response.json(callbacks, {
    headers: {
      "access-control-allow-origin": "https://id.ai",
      "cache-control": "no-store"
    }
  });
}
