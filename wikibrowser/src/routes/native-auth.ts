import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/native-auth/route";

export const Route = createFileRoute("/native-auth")({ server: { handlers: { GET: () => GET() } } });
