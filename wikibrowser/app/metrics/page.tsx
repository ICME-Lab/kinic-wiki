import { MetricsClient } from "./metrics-client";

export const metadata: Record<string, unknown> = {
  title: "Kinic Wiki Metrics",
  description: "Public metrics for Kinic Wiki usage and KINIC charges."
};

export default function MetricsPage() {
  return <MetricsClient canisterId={import.meta.env.VITE_KINIC_WIKI_CANISTER_ID || ""} />;
}
