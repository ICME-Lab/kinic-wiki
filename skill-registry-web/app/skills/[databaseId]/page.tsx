import { SkillRegistryClient } from "../skill-registry-client";

export default function SkillRegistryPage({ databaseId }: { databaseId: string }) {
  return <SkillRegistryClient databaseId={databaseId} />;
}
