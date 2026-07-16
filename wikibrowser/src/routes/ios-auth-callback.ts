import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/ios-auth-callback/route";

export const Route = createFileRoute("/ios-auth-callback")({ server: { handlers: { GET: () => GET() } } });
