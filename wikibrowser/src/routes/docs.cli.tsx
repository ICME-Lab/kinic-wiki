import { createFileRoute } from "@tanstack/react-router";
import CliPage from "@/app/docs/cli/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/cli")({ head: () => routeHead("Kinic Wiki CLI", "Install and use kinic-vfs-cli from npm for Kinic Wiki database and Skill Registry workflows."), component: CliPage });
