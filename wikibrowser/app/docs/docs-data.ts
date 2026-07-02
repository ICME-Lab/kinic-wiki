// Where: /docs pages.
// What: centralizes static documentation navigation and skill workflow summaries.
// Why: docs index, sidebar links, and skill detail pages should share labels and routes.

export type DocsLink = {
  href: string;
  title: string;
  description: string;
};

export type SkillDoc = DocsLink & {
  slug: string;
  eyebrow: string;
  summary: string;
  commandLines: string[];
  responsibilities: string[];
  safety: string[];
};

export const primaryDocs: DocsLink[] = [
  {
    href: "/docs/cli",
    title: "CLI Guide",
    description: "Install kinic-vfs-cli, connect databases, run search, reads, writes, Store API calls, and Skill Registry commands."
  },
  {
    href: "/docs/canister-api",
    title: "Canister API",
    description: "Call the Kinic Wiki canister directly through ICP CLI for query, SQL, access, and write endpoint debugging."
  },
  {
    href: "/docs/skills",
    title: "Skills",
    description: "Use agent workflow skills for wiki query, edit, ingest, lint, Context Pack export, and Skill Registry operations."
  }
];

export const skillDocs: SkillDoc[] = [
  {
    slug: "query",
    href: "/docs/skills/query",
    title: "Query",
    eyebrow: "Read workflow",
    description: "Search and read Kinic Wiki VFS databases before answering from stored evidence.",
    summary: "Use query workflows when an agent needs to inspect wiki content, read known nodes, or answer from a public wiki URL or database ID.",
    commandLines: [
      'kinic-vfs-cli --database-id <database-id> search-remote "query" --prefix /Knowledge --json',
      "kinic-vfs-cli --database-id <database-id> read-node --path /Knowledge/page.md --json",
      'kinic-vfs-cli --database-id <database-id> query-context --task "answer question" --namespace /Knowledge --json'
    ],
    responsibilities: [
      "Start with task-scoped recall or content search, then read final evidence bodies before answering.",
      "Use /Knowledge first, inspect /Sources when organized notes are thin, and preserve exact paths and titles.",
      "Cite read nodes, not search hits alone."
    ],
    safety: [
      "Do not mutate nodes during query work.",
      "Do not parse client-rendered wiki HTML when VFS access is available.",
      "Treat broad answers as insufficient when inventory and reads do not cover the scope."
    ]
  },
  {
    slug: "edit",
    href: "/docs/skills/edit",
    title: "Edit",
    eyebrow: "Safe mutation",
    description: "Apply explicit, etag-aware wiki edits without adding compatibility branches.",
    summary: "Use edit workflows for remote wiki page corrections, redactions, leakage cleanup, and multi-node repair after reading the current node revision.",
    commandLines: [
      "kinic-vfs-cli --database-id <database-id> read-node --path /Knowledge/page.md --json",
      "kinic-vfs-cli --database-id <database-id> edit-node --path /Knowledge/page.md --old-text before --new-text after --expected-etag <etag> --json",
      "kinic-vfs-cli --database-id <database-id> read-node --path /Knowledge/page.md --json"
    ],
    responsibilities: [
      "Read the current node and etag before changing existing content.",
      "Keep edits scoped to the requested paths and preserve source-backed claims.",
      "Verify the stored node after mutation."
    ],
    safety: [
      "Use expected_etag for replacements.",
      "Do not add shim, fallback, or old-format rescue behavior.",
      "Stop and report conflicts when the node content no longer matches the planned edit."
    ]
  },
  {
    slug: "ingest",
    href: "/docs/skills/ingest",
    title: "Ingest",
    eyebrow: "Evidence capture",
    description: "Bring source material into /Sources before organized /Knowledge synthesis.",
    summary: "Use ingest workflows when source material needs to become durable wiki evidence before review, synthesis, or later query.",
    commandLines: [
      "kinic-vfs-cli --database-id <database-id> write-node --path /Sources/web/example.md --input source.md --json",
      "kinic-vfs-cli --database-id <database-id> write-node --path /Knowledge/topic.md --input topic.md --json",
      "kinic-vfs-cli --database-id <database-id> source-evidence --node-path /Knowledge/topic.md --json"
    ],
    responsibilities: [
      "Keep raw evidence under /Sources and organized notes under /Knowledge.",
      "Preserve source URLs, source paths, and provenance metadata where available.",
      "Synthesize only the requested scope."
    ],
    safety: [
      "Do not treat raw captures as canonical facts before review.",
      "Avoid bulk ingestion when a narrow source set is enough.",
      "Verify source evidence links after creating knowledge notes."
    ]
  },
  {
    slug: "lint",
    href: "/docs/skills/lint",
    title: "Lint",
    eyebrow: "Health inspection",
    description: "Inspect local or remote wiki health without silently repairing content.",
    summary: "Use lint workflows to find wiki structure issues, missing source evidence, stale paths, malformed skill packages, or inconsistent store layout.",
    commandLines: [
      "kinic-vfs-cli --database-id <database-id> list-nodes --prefix /Knowledge --recursive --json",
      "kinic-vfs-cli --database-id <database-id> source-evidence --node-path /Knowledge/page.md --json",
      "kinic-vfs-cli --database-id <database-id> skill inspect <skill-id> --json"
    ],
    responsibilities: [
      "Inspect paths, metadata, source refs, and skill package files.",
      "Report findings with exact paths and observed evidence.",
      "Keep lint output separate from mutation."
    ],
    safety: [
      "Do not auto-fix during lint-only work.",
      "Do not infer missing metadata from path names.",
      "Escalate when repair would delete or rewrite content."
    ]
  },
  {
    slug: "context-pack",
    href: "/docs/skills/context-pack",
    title: "Context Pack",
    eyebrow: "Portable handoff",
    description: "Export /Knowledge scopes into OKF Context Pack bundles for another AI client or agent.",
    summary: "Use Context Pack workflows when a bounded wiki scope needs to become a portable markdown bundle with Kinic references and verification.",
    commandLines: [
      "kinic-vfs-cli --database-id <database-id> export-snapshot --prefix /Knowledge --limit 100 --json",
      "kinic-vfs-cli --database-id <database-id> context-pack export --prefix /Knowledge --output context-pack.md",
      "kinic-vfs-cli --database-id <database-id> fetch-updates --known-snapshot-revision <revision> --prefix /Knowledge --json"
    ],
    responsibilities: [
      "Export only the requested scope.",
      "Keep Kinic store references for sources and sessions instead of copying unrelated bodies.",
      "Verify bundle structure before handoff."
    ],
    safety: [
      "Do not export private scopes without confirming access intent.",
      "Do not present exported content as fresher than its snapshot revision.",
      "Narrow the prefix when the bundle is too broad."
    ]
  },
  {
    slug: "registry",
    href: "/docs/skills/registry",
    title: "Skill Registry",
    eyebrow: "Skill lifecycle",
    description: "Manage reusable SKILL.md packages, manifests, snapshots, status, and run evidence.",
    summary: "Use Skill Registry workflows to find, inspect, import, upsert, promote, deprecate, rollback, and record evidence for reusable agent skills.",
    commandLines: [
      'kinic-vfs-cli skill find "contract review" --json',
      "kinic-vfs-cli skill inspect legal-review --json",
      'kinic-vfs-cli skill record-run legal-review --task "review contract" --outcome success --notes-file ./notes.md --json'
    ],
    responsibilities: [
      "Store current packages under /Skills/<id> with manifest and SKILL.md files.",
      "Record operational evidence under /Sources/skill-runs.",
      "Prefer promoted or reviewed skills and ignore deprecated skills by default."
    ],
    safety: [
      "Inspect packages before use.",
      "Record evidence after useful runs.",
      "Use rollback snapshots for intentional restore, not implicit compatibility."
    ]
  }
];

export function findSkillDoc(slug: string): SkillDoc | null {
  return skillDocs.find((doc) => doc.slug === slug) ?? null;
}
