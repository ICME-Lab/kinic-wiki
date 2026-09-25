import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { OPTIONS, POST } from "@/app/api/recall/rerank/route";

export const Route = createFileRoute("/api/recall/rerank")({
  server: { handlers: { OPTIONS: ({ request }) => OPTIONS(request, env), POST: ({ request }) => POST(request, env) } }
});
