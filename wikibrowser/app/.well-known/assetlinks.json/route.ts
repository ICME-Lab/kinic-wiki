// Where: wikibrowser/app/.well-known/assetlinks.json/route.ts
// What: Serves the Android Digital Asset Links statement for KinicWiki.
// Why: Android must verify HTTPS app links against the Play App Signing certificate.

const androidPackageName = "xyz.kinic.android.kinicwiki";
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

type AssetLinksEnv = Pick<CloudflareEnv, "KINIC_ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT">;

export function GET(
  _request?: Request,
  runtimeEnv: AssetLinksEnv = process.env as unknown as AssetLinksEnv
): Response {
  const fingerprint = runtimeEnv.KINIC_ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT?.trim().toUpperCase();
  if (!fingerprint || !fingerprintPattern.test(fingerprint)) {
    return Response.json(
      { error: "Android App Links fingerprint is not configured." },
      {
        status: 503,
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  }

  return new Response(
    JSON.stringify(
      [
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: androidPackageName,
            sha256_cert_fingerprints: [fingerprint]
          }
        }
      ],
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json"
      }
    }
  );
}
