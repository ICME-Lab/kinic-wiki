// Where: /canister-api console guide.
// What: explains Browser, kinic-vfs-cli, and raw icp canister call access.
// Why: developers need the right access surface before debugging or automating a wiki DB.
import type { Metadata } from "next";
import Link from "next/link";
import { Braces, Database, FileText, Globe2, KeyRound, Search, ShieldCheck, TerminalSquare, Unplug } from "lucide-react";
import { CliGuideBlock } from "@/app/cli/cli-guide-block";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";

export const metadata: Metadata = {
  title: "Kinic Wiki Canister API",
  description: "Choose between Browser, kinic-vfs-cli, and direct icp canister calls for Kinic Wiki access.",
  openGraph: {
    title: "Kinic Wiki Canister API",
    description: "Choose between Browser, kinic-vfs-cli, and direct icp canister calls for Kinic Wiki access."
  },
  twitter: {
    title: "Kinic Wiki Canister API",
    description: "Choose between Browser, kinic-vfs-cli, and direct icp canister calls for Kinic Wiki access."
  }
};

const targetCommands = [
  String.raw`icp canister call <canister-id> canister_health '()' --query -n ic -o candid`,
  String.raw`icp canister call wiki canister_health '()' --query -e ic -o candid`
];

const readNodeCommands = [
  String.raw`icp canister call <canister-id> read_node \
  '("<database-id>", "/Wiki/index.md")' \
  --query -n ic -o candid`
];

const sqlCommands = [
  String.raw`icp canister call <canister-id> query_database_sql_json \
  '("<database-id>", "SELECT json_object('\''path'\'', path) FROM fs_nodes LIMIT 20", 20 : nat32)' \
  --query -n ic -o candid`
];

const accessRows = [
  {
    name: "Browser",
    useWhen: "You want interactive browsing, public or private reads, the SQL panel, wallet funding, or database management.",
    avoidWhen: "You need a headless script or repeatable agent workflow.",
    identity: "Internet Identity or anonymous public read.",
    writeSafety: "UI handles roles, cycles state, and write controls.",
    output: "Rendered pages and interactive panels."
  },
  {
    name: "kinic-vfs-cli",
    useWhen: "You want agent/script workflows, DB linking, JSON output, explicit anonymous reads, or etag-guarded writes.",
    avoidWhen: "You only need one raw endpoint smoke check.",
    identity: "Selected icp identity, auto identity mode, or explicit anonymous read mode.",
    writeSafety: "CLI wraps safer read-before-write and etag flows.",
    output: "Human text or structured JSON."
  },
  {
    name: "icp canister call",
    useWhen: "You want raw Candid calls, endpoint debugging, smoke checks, or SQL inspection without kinic-vfs-cli.",
    avoidWhen: "You are doing normal writes or want the CLI to manage etags, cycles preflight, and access checks.",
    identity: "Default icp identity, --identity <name>, or --identity anonymous.",
    writeSafety: "Caller must handle roles, etags, cycles preflight, and errors.",
    output: "Candid, text, hex, or command JSON."
  }
];

const quickChoices = [
  { label: "Browser", text: "Use it for interactive inspection, management, and wallet flows." },
  { label: "kinic-vfs-cli", text: "Use it for automation, JSON output, anonymous reads, and safer writes." },
  { label: "icp canister call", text: "Use it for raw Candid access and endpoint debugging." }
];

const beforeYouCall = [
  { label: "Install icp", text: "Direct calls require the ICP CLI, not kinic-vfs-cli." },
  { label: "Pick a target", text: "Use -n ic with a canister principal, or -e ic with a canister name from icp.yaml." },
  { label: "Mark queries", text: "Add --query for read-only query entrypoints. Without it, icp sends an update call." },
  { label: "Choose identity", text: "Use the default identity, --identity <name>, or --identity anonymous for principal 2vxsx-fae." }
];

const endpoints = [
  { name: "read_node(database_id, path)", detail: "Read one file or folder node by exact path." },
  { name: "read_node_context(request)", detail: "Read a node with nearby link context." },
  { name: "search_nodes(request)", detail: "Search wiki content and paths with lightweight previews." },
  { name: "search_node_paths(request)", detail: "Search paths only when a lightweight path result is enough." },
  { name: "list_children(request)", detail: "List direct children under a folder path." },
  { name: "query_context(request)", detail: "Ask for query context assembled from search and linked nodes." },
  { name: "source_evidence(request)", detail: "Resolve source evidence for a wiki node." },
  { name: "memory_manifest()", detail: "Inspect the canister memory layout." },
  { name: "query_database_sql_json(database_id, sql, limit)", detail: "Run a restricted JSON SELECT against one readable wiki database." }
];

const sqlRules = [
  "SQL must be one restricted SELECT, <=4096 bytes, from exactly fs_nodes or fs_links.",
  "LIMIT 1..100 is required.",
  "Joins, subqueries, grouping/window/aggregate functions, comments, semicolons, OFFSET, and mutating/admin tokens are rejected.",
  "The query must return exactly one non-null JSON object text column, usually json_object(...). Each row is capped at 64 KiB and the total response at 256 KiB.",
  "Index DB tables, metrics tables, sessions, marketplace orders, and billing tables are not available.",
  "Granting reader to 2vxsx-fae makes wiki content, read-only member metadata, and restricted database-scoped SQL readable by anonymous callers.",
  "For guaranteed anonymous public reads, pass --identity anonymous or use Browser, kinic-vfs-cli --identity-mode anonymous, or an anonymous agent."
];

const primaryLinkClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-action bg-action px-3 text-sm font-bold text-white no-underline hover:border-accent hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

export default function CanisterApiPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-6 lg:grid-cols-[1fr_0.85fr]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Unplug aria-hidden className="text-accent" size={20} />
                <p className="text-sm font-semibold uppercase text-accentText">Access guide</p>
              </div>
              <h1 className="mt-3 text-2xl font-semibold text-ink">Choose an access surface for Kinic Wiki</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                Use Browser for interactive work, <code>kinic-vfs-cli</code> for automation and safer writes, and <code>icp canister call</code> for raw Candid endpoint debugging without installing <code>kinic-vfs-cli</code>.
              </p>
              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                {quickChoices.map((choice) => (
                  <div className="rounded-lg border border-line bg-white p-3" key={choice.label}>
                    <p className="text-sm font-semibold text-ink">{choice.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted">{choice.text}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link className={primaryLinkClass} href="/cli">
                  <TerminalSquare aria-hidden size={15} />
                  <span>CLI Guide</span>
                </Link>
              </div>
            </div>
            <div className="min-w-0 rounded-lg border border-line bg-white p-4">
              <div className="flex items-center gap-2">
                <KeyRound aria-hidden className="text-accent" size={18} />
                <h2 className="text-base font-semibold text-ink">Before You Call</h2>
              </div>
              <dl className="mt-4 grid gap-3">
                {beforeYouCall.map((item) => (
                  <div className="grid gap-1" key={item.label}>
                    <dt className="text-sm font-semibold text-ink">{item.label}</dt>
                    <dd className="text-sm leading-5 text-muted">{item.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Globe2 aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Ways to Access Kinic Wiki</h2>
          </div>
          <div className="mt-4 hidden overflow-x-auto rounded-lg border border-line bg-white lg:block">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-paper text-xs font-semibold uppercase text-muted">
                <tr>
                  <th className="border-b border-line px-3 py-2">Surface</th>
                  <th className="border-b border-line px-3 py-2">Use When</th>
                  <th className="border-b border-line px-3 py-2">Avoid When</th>
                  <th className="border-b border-line px-3 py-2">Identity</th>
                  <th className="border-b border-line px-3 py-2">Write Safety</th>
                  <th className="border-b border-line px-3 py-2">Output</th>
                </tr>
              </thead>
              <tbody>
                {accessRows.map((row) => (
                  <tr className="align-top" key={row.name}>
                    <th className="border-b border-line px-3 py-3 font-semibold text-ink">{row.name}</th>
                    <td className="border-b border-line px-3 py-3 leading-6 text-muted">{row.useWhen}</td>
                    <td className="border-b border-line px-3 py-3 leading-6 text-muted">{row.avoidWhen}</td>
                    <td className="border-b border-line px-3 py-3 leading-6 text-muted">{row.identity}</td>
                    <td className="border-b border-line px-3 py-3 leading-6 text-muted">{row.writeSafety}</td>
                    <td className="border-b border-line px-3 py-3 leading-6 text-muted">{row.output}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 lg:hidden">
            {accessRows.map((row) => (
              <div className="grid gap-3 rounded-lg border border-line bg-white p-3" key={row.name}>
                <h3 className="text-base font-semibold text-ink">{row.name}</h3>
                <AccessField label="Use When" value={row.useWhen} />
                <AccessField label="Avoid When" value={row.avoidWhen} />
                <AccessField label="Identity" value={row.identity} />
                <AccessField label="Write Safety" value={row.writeSafety} />
                <AccessField label="Output" value={row.output} />
              </div>
            ))}
          </div>
        </AdminPanel>

        <div className="grid gap-4 md:grid-cols-2">
          <CliGuideBlock icon={<Unplug aria-hidden size={18} />} title="1. Pick Target" commands={targetCommands}>
            Use a canister principal with <code>-n ic</code>, or use a canister name from <code>icp.yaml</code> with <code>-e ic</code>.
          </CliGuideBlock>
          <CliGuideBlock icon={<FileText aria-hidden size={18} />} title="2. Read Node" commands={readNodeCommands}>
            Read one exact wiki path with the same database read access rules used by Browser and <code>kinic-vfs-cli</code>.
          </CliGuideBlock>
          <CliGuideBlock icon={<Braces aria-hidden size={18} />} title="3. Run SQL" commands={sqlCommands}>
            Query one readable wiki database through <code>query_database_sql_json</code>. The response is the canister&apos;s Candid result envelope.
          </CliGuideBlock>
          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Common Query Endpoints (Excerpt)</h2>
            </div>
            <dl className="mt-4 grid gap-3">
              {endpoints.map((endpoint) => (
                <div className="grid gap-1" key={endpoint.name}>
                  <dt className="break-words font-mono text-sm font-semibold text-ink">{endpoint.name}</dt>
                  <dd className="text-sm leading-5 text-muted">{endpoint.detail}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm leading-6 text-muted">
              The full Candid interface includes more methods. Update and write endpoints can also be called directly, but Browser or <code>kinic-vfs-cli</code> is usually safer because writes involve access roles, cycles preflight, and etag handling.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Database aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">SQL over Canister</h2>
          </div>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-muted">
            Database SQL is a read-only inspection API for one wiki database at a time. It is not a general SQLite console and it never exposes the canister index database.
          </p>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
            {sqlRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </AdminPanel>
      </div>
    </AdminContent>
  );
}

function AccessField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase text-muted">{label}</span>
      <span className="text-sm leading-5 text-muted">{value}</span>
    </div>
  );
}
