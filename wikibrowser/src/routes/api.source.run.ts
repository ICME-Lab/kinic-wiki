import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { OPTIONS, POST } from "@/app/api/source/run/route";

export const Route = createFileRoute("/api/source/run")({
  server: { handlers: { OPTIONS: ({ request }) => OPTIONS(request), POST: ({ request }) => POST(request, env) } }
});
