import { DashboardDatabaseClient } from "@/app/dashboard/dashboard-client";

export default function DashboardDatabasePage({ databaseId }: { databaseId: string }) {
  return <DashboardDatabaseClient databaseId={databaseId} />;
}
