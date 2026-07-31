import { createFileRoute } from "@tanstack/react-router";
import CanisterApiPage from "@/app/docs/canister-api/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/canister-api")({ head: () => routeHead("Kinic Wiki Canister API", "Direct ICP CLI calls for Kinic Wiki canister query and write endpoints."), component: CanisterApiPage });
