import { SkillRegistryClient } from "../skill-registry-client";

export default async function SkillRegistryPage({ params }: { params: Promise<{ databaseId: string }> }) {
  const { databaseId } = await params;
  return <SkillRegistryClient databaseId={databaseId} />;
}
