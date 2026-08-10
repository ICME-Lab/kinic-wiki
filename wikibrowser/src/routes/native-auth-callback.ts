import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/native-auth-callback/route";

export const Route = createFileRoute("/native-auth-callback")({ server: { handlers: { GET: () => GET() } } });
