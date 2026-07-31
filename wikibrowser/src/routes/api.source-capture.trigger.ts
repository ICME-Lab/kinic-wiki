import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { OPTIONS, POST } from "@/app/api/source-capture/trigger/route";

export const Route = createFileRoute("/api/source-capture/trigger")({
  server: { handlers: { OPTIONS: ({ request }) => OPTIONS(request), POST: ({ request }) => POST(request, env) } }
});
