import { createFileRoute } from "@tanstack/react-router";
import DashboardPage from "@/app/dashboard/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/dashboard/")({ head: () => routeHead("Kinic Wiki Database Dashboard", "Browse, create, fund, and manage Kinic Wiki canister databases."), component: DashboardPage });
