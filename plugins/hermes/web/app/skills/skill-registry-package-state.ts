"use client";

import { useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { PackageDraft, PackageHandlers } from "@/app/skills/skill-registry-management-ui";
import { importPublicGitHubSkill, upsertSkillPackage } from "@/lib/skill-registry-package";
import { recordSkillEvent } from "@/lib/skill-registry-operations";

const DEFAULT_PACKAGE_DRAFT: PackageDraft = {
  source: "",
  reference: "main",
  id: "",
  catalog: "private",
  skill: "",
  manifest: "",
  provenance: "",
  evals: "",
  extraName: "",
  extraContent: ""
};

export function usePackageManager(input: {
  canisterId: string;
  databaseId: string;
  identity: Identity | undefined;
  writable: boolean;
  refresh: (identity: Identity) => Promise<void>;
  errorMessage: (cause: unknown) => string;
}): { draft: PackageDraft; busy: boolean; message: string | null; handlers: PackageHandlers } {
  const [draft, setDraft] = useState<PackageDraft>(DEFAULT_PACKAGE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(operation: (activeIdentity: Identity) => Promise<string[]>) {
    if (!input.identity || !input.writable) {
      setMessage("Writer or owner access is required.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const written = await operation(input.identity);
      await recordSkillEvent(input.canisterId, input.databaseId, input.identity, draft.id, { action: "package.upsert", targetPath: written[0] ?? draft.id, result: "success" });
      setMessage(`Package updated: ${written.length} files`);
      await input.refresh(input.identity);
    } catch (cause) {
      setMessage(input.errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    draft,
    busy,
    message,
    handlers: {
      setDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
      importGitHub: () => void run((identity) => importPublicGitHubSkill(input.canisterId, input.databaseId, identity, draft)),
      pasteUpsert: () =>
        void run((identity) =>
          upsertSkillPackage(input.canisterId, input.databaseId, identity, {
            id: draft.id,
            catalog: draft.catalog,
            files: [
              { name: "SKILL.md", content: draft.skill },
              { name: "manifest.md", content: draft.manifest },
              { name: "provenance.md", content: draft.provenance },
              { name: "evals.md", content: draft.evals },
              { name: draft.extraName, content: draft.extraContent }
            ]
          })
        )
    }
  };
}
