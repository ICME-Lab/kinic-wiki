import { DashboardDatabaseClient } from "@/app/dashboard/dashboard-client";

export default async function DashboardDatabasePage({ params }: { params: Promise<{ databaseId: string }> }) {
  const { databaseId } = await params;
  return <DashboardDatabaseClient databaseId={databaseId} />;
}
