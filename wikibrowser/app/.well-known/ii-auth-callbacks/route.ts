// Where: wikibrowser/app/.well-known/ii-auth-callbacks/route.ts
// What: Declares the exact HTTPS callback accepted by the native iOS ICRC-167 flow.
// Why: Internet Identity must authorize the callback before returning delegation data.

export const internetIdentityCallbacks = {
  callbacks: ["https://wiki.kinic.xyz/ios-auth-callback"]
};

export function GET(callbacks = internetIdentityCallbacks): Response {
  return Response.json(callbacks, {
    headers: {
      "access-control-allow-origin": "https://id.ai",
      "cache-control": "no-store"
    }
  });
}
