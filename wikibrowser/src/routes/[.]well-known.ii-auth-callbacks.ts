import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { GET } from "@/app/.well-known/ii-auth-callbacks/route";

const stagingCallbacks = {
  callbacks: [
    "https://kinic-wiki-browser-staging.hude.workers.dev/ios-auth-callback",
    "https://kinic-wiki-browser-staging.hude.workers.dev/android-auth-callback"
  ]
};

export const Route = createFileRoute("/.well-known/ii-auth-callbacks")({
  server: {
    handlers: {
      GET: () => GET(env.KINIC_DEPLOYMENT_ENV === "staging" ? stagingCallbacks : undefined)
    }
  }
});
