import { createFileRoute } from "@tanstack/react-router";
import MetricsLayout from "@/app/metrics/layout";
import MetricsPage from "@/app/metrics/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/metrics")({ head: () => routeHead("Kinic Wiki Metrics", "Public metrics for Kinic Wiki usage and KINIC charges."), component: () => <MetricsLayout><MetricsPage /></MetricsLayout> });
