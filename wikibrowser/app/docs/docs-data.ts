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
};

export const primaryDocs: DocsLink[] = [
  {
    href: "/docs/ios",
    title: "iOS App",
    description: "Install KinicWiki, sign in, save Safari pages, browse your database, and ask questions with cited source notes."
  },
  {
    href: "/docs/clipper",
    title: "Wiki Clipper",
    description: "Save ChatGPT and Claude conversations or active web pages under /Sources, then open the same database from the Dashboard."
  },
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
    summary: "Use query workflows when an agent needs to inspect wiki content, read known nodes, or answer from a public wiki URL or database ID."
  },
  {
    slug: "edit",
    href: "/docs/skills/edit",
    title: "Edit",
    eyebrow: "Safe mutation",
    description: "Apply explicit, etag-aware wiki edits without adding compatibility branches.",
    summary: "Use edit workflows for remote wiki page corrections, redactions, leakage cleanup, and multi-node repair after reading the current node revision."
  },
  {
    slug: "mcp",
    href: "/docs/skills/mcp",
    title: "MCP",
    eyebrow: "Remote read workflow",
    description: "Use the anonymous read-only Kinic Wiki MCP to discover public databases and retrieve evidence.",
    summary: "Use the MCP workflow for public Kinic Wiki recall when MCP tools are available or the local CLI is not the requested interface."
  },
  {
    slug: "ingest",
    href: "/docs/skills/ingest",
    title: "Ingest",
    eyebrow: "Evidence capture",
    description: "Bring source material into /Sources before organized /Knowledge synthesis.",
    summary: "Use ingest workflows when source material needs to become durable wiki evidence before review, synthesis, or later query."
  },
  {
    slug: "lint",
    href: "/docs/skills/lint",
    title: "Lint",
    eyebrow: "Health inspection",
    description: "Inspect local or remote wiki health without silently repairing content.",
    summary: "Use lint workflows to find wiki structure issues, missing source evidence, stale paths, malformed skill packages, or inconsistent store layout."
  },
  {
    slug: "context-pack",
    href: "/docs/skills/context-pack",
    title: "Context Pack",
    eyebrow: "Portable handoff",
    description: "Export /Knowledge scopes into OKF Context Pack bundles for another AI client or agent.",
    summary: "Use Context Pack workflows when a bounded wiki scope needs to become a portable markdown bundle with Kinic references and verification."
  },
  {
    slug: "registry",
    href: "/docs/skills/registry",
    title: "Skill Registry",
    eyebrow: "Skill lifecycle",
    description: "Manage reusable SKILL.md packages, manifests, snapshots, status, and run evidence.",
    summary: "Use Skill Registry workflows to find, inspect, import, upsert, promote, deprecate, rollback, and record evidence for reusable agent skills."
  }
];

export function findSkillDoc(slug: string): SkillDoc | null {
  return skillDocs.find((doc) => doc.slug === slug) ?? null;
}
