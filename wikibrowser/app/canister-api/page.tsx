// Where: /canister-api console guide.
// What: documents direct ICP CLI calls to the Kinic Wiki canister API.
// Why: developers need exact Candid call shapes for endpoint debugging.
import type { Metadata } from "next";
import { Braces, Database, KeyRound, ListTree, PencilLine, ShieldCheck, Unplug } from "lucide-react";
import { CliGuideBlock } from "@/app/cli/cli-guide-block";
import { AdminContent } from "@/components/admin-shell";
import { AdminField, AdminPanel } from "@/components/admin-ui";

export const metadata: Metadata = {
  title: "Kinic Wiki Canister API",
  description: "Direct ICP CLI calls for Kinic Wiki canister query and write endpoints.",
  openGraph: {
    title: "Kinic Wiki Canister API",
    description: "Direct ICP CLI calls for Kinic Wiki canister query and write endpoints."
  },
  twitter: {
    title: "Kinic Wiki Canister API",
    description: "Direct ICP CLI calls for Kinic Wiki canister query and write endpoints."
  }
};

const wikiCanisterId = "xis3j-paaaa-aaaai-axumq-cai";
const publicDatabaseId = "db_kva4v2twg6jv";

const healthCommands = [
  String.raw`icp canister call ${wikiCanisterId} canister_health '()' --query -n ic -o candid`
];

const listDatabaseCommands = [
  String.raw`icp canister call ${wikiCanisterId} list_databases '()' \
  --query -n ic --identity anonymous -o candid`
];

const sqlCommands = [
  String.raw`icp canister call ${wikiCanisterId} query_database_sql_json \
  '("<database-id>", "SELECT json_object('\''path'\'', path, '\''updated_at'\'', updated_at) FROM fs_nodes ORDER BY updated_at DESC LIMIT 20", 20 : nat32)' \
  --query -n ic -o candid`
];

const anonymousSqlCommands = [
  String.raw`icp canister call ${wikiCanisterId} query_database_sql_json \
  '("${publicDatabaseId}", "SELECT json_object('\''path'\'', path) FROM fs_nodes LIMIT 20", 20 : nat32)' \
  --query -n ic --identity anonymous -o candid`
];

const anonymousReadNodeCommands = [
  String.raw`icp canister call ${wikiCanisterId} read_node \
  '("${publicDatabaseId}", "/Sources")' \
  --query -n ic --identity anonymous -o candid`
];

const writePreflightCommands = [
  String.raw`icp canister call ${wikiCanisterId} check_database_write_cycles \
  '("<database-id>")' \
  --query -n ic -o candid`
];

const writeNodesCommands = [
  String.raw`icp canister call ${wikiCanisterId} write_nodes \
  '(record {
    database_id = "<database-id>";
    nodes = vec {
      record {
        path = "/Wiki/example.md";
        kind = variant { File };
        content = "# Example";
        metadata_json = "{}";
        expected_etag = null;
      };
    };
  })' \
  -n ic -o candid`
];

const callFields = [
  { label: "Mainnet canister", value: wikiCanisterId, mono: true },
  { label: "Public read means", value: "anonymous principal has Reader role", mono: false },
  { label: "Anonymous-readable DB", value: publicDatabaseId, mono: true },
  { label: "Anonymous principal", value: "2vxsx-fae", mono: true },
  { label: "Network flag", value: "-n ic for direct canister-principal calls", mono: true }
];

const parameters = [
  { name: "database_id", type: "text", detail: "Readable wiki database ID. Private DBs require a member identity; anonymous-readable DBs can use anonymous." },
  { name: "sql", type: "text", detail: "Restricted JSON SELECT over fs_nodes or fs_links." },
  { name: "limit", type: "nat32", detail: "Maximum rows returned by the canister response envelope." },
  { name: "path", type: "text", detail: "Exact VFS path, for example /Wiki/index.md or a path returned by query_database_sql_json." },
  { name: "nodes", type: "vec WriteNodeItem", detail: "Batch of File or Source writes. Each item has path, kind, content, metadata_json, and optional expected_etag." },
  { name: "expected_etag", type: "opt text", detail: "Use null for create or unchecked replace; use opt \"<etag>\" to reject stale overwrites." }
];

const queryEndpoints = [
  { name: "canister_health()", detail: "Smoke check for the target canister." },
  { name: "list_databases()", detail: "List databases readable by the caller identity." },
  { name: "check_database_write_cycles(database_id)", detail: "Preflight write access and cycles state for writer or owner identities." },
  { name: "read_node(database_id, path)", detail: "Read one file or folder node by exact path." },
  { name: "query_database_sql_json(database_id, sql, limit)", detail: "Run a restricted JSON SELECT against one readable wiki database." },
  { name: "search_nodes(request)", detail: "Search wiki content and paths with lightweight previews." },
  { name: "search_node_paths(request)", detail: "Search paths only." },
  { name: "list_children(request)", detail: "List direct children under one folder path." },
  { name: "read_node_context(request)", detail: "Read a node with nearby link context." },
  { name: "memory_recall(request)", detail: "Recall task-scoped memory from role pages, search, and linked nodes." },
  { name: "knowledge_evidence(request)", detail: "Resolve source evidence for a knowledge node." },
  { name: "store_manifest(request)", detail: "Inspect the profile-scoped four-store layout and recall limits." }
];

const writeEndpoints = [
  { name: "write_node(request)", detail: "Write or replace one file/source node." },
  { name: "write_nodes(request)", detail: "Write or replace multiple file/source nodes in one batch." },
  { name: "append_node(request)", detail: "Append content to one node with an optional etag guard." },
  { name: "edit_node(request)", detail: "Replace text inside one node with an optional etag guard." },
  { name: "delete_node(request)", detail: "Delete one node. Use etag guards for destructive edits." },
  { name: "mkdir_node(request)", detail: "Create a folder node." },
  { name: "move_node(request)", detail: "Move or rename one node." }
];

const sqlRules = [
  "SQL must be one SELECT, <=4096 bytes, from exactly fs_nodes or fs_links.",
  "LIMIT 1..100 is required in SQL; pass the same upper bound as the nat32 argument.",
  "Return exactly one non-null JSON object TEXT column, usually with json_object(...).",
  "Each row is capped at 64 KiB; the total row payload is capped at 256 KiB.",
  "Joins, subqueries, grouping, window functions, aggregate functions, comments, semicolons, OFFSET, and mutating/admin tokens are rejected.",
  "Index DB tables, metrics, sessions, marketplace orders, and billing tables are not exposed."
];

const writeRules = [
  "Write calls are update calls. Do not pass --query.",
  "The caller must be a writer or owner of the target database.",
  "The database must have enough cycles for writes.",
  "check_database_write_cycles is a query preflight; it rejects anonymous callers and underfunded DBs.",
  "Use expected_etag when replacing existing content to avoid overwriting concurrent edits.",
  "Use expected_etag = null only for a create or intentionally unchecked replace.",
  "write_nodes accepts File and Source items; create folders with mkdir_node.",
  "Anonymous identity can read only anonymous-readable DBs; it cannot write."
];

const accessRules = [
  "The mainnet canister ID is the endpoint target. Access is still enforced per database.",
  "Anonymous read means calls use --identity anonymous and caller principal 2vxsx-fae.",
  "Only DBs that granted Reader to 2vxsx-fae are readable anonymously.",
  "Private DB calls use the current ICP CLI identity and require that identity to be a DB member.",
  "This page documents raw Candid calls, not kinic-vfs CLI commands."
];

export default function CanisterApiPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Unplug aria-hidden className="text-accent" size={20} />
                <p className="text-sm font-semibold uppercase text-accentText">Canister API</p>
              </div>
              <h1 className="mt-3 text-2xl font-semibold text-ink">Call Kinic Wiki from ICP CLI</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                Use <code>icp canister call</code> when you need the raw Candid API on the mainnet canister. Query methods include <code>--query</code>; write methods are update calls and omit it.
              </p>
            </div>
            <div className="grid gap-3 rounded-lg border border-line bg-white p-4">
              {callFields.map((field) => (
                <AdminField breakAll key={field.label} label={field.label} mono={field.mono} value={field.value} />
              ))}
            </div>
          </div>
        </AdminPanel>

        <div className="grid gap-4 md:grid-cols-2">
          <CliGuideBlock icon={<Unplug aria-hidden size={18} />} title="1. Smoke Check" commands={healthCommands}>
            Confirm that ICP CLI can reach the Kinic Wiki canister on mainnet.
          </CliGuideBlock>
          <CliGuideBlock icon={<ListTree aria-hidden size={18} />} title="2. List Anonymous-Readable DBs" commands={listDatabaseCommands}>
            Use <code>--identity anonymous</code> to find DBs readable by principal <code>2vxsx-fae</code>.
          </CliGuideBlock>
          <CliGuideBlock icon={<Braces aria-hidden size={18} />} title="3. Query Database SQL" commands={sqlCommands}>
            Call a readable DB with the current ICP CLI identity. Private DBs require a member identity.
          </CliGuideBlock>
          <CliGuideBlock icon={<KeyRound aria-hidden size={18} />} title="4. Anonymous SQL Read" commands={anonymousSqlCommands}>
            Read the example DB anonymously. This is not an auth bypass; the DB grants Reader to <code>2vxsx-fae</code>.
          </CliGuideBlock>
          <CliGuideBlock icon={<Database aria-hidden size={18} />} title="5. Anonymous Node Read" commands={anonymousReadNodeCommands}>
            Use a path returned by SQL or search, then call <code>read_node</code> against the same anonymous-readable DB.
          </CliGuideBlock>
          <CliGuideBlock icon={<ShieldCheck aria-hidden size={18} />} title="6. Write Preflight" commands={writePreflightCommands}>
            Check writer access and DB cycles before sending an update call. Anonymous identity is rejected.
          </CliGuideBlock>
          <CliGuideBlock icon={<PencilLine aria-hidden size={18} />} title="7. Write Nodes" commands={writeNodesCommands}>
            Call <code>write_nodes</code> as a database writer or owner. This is an update call, so it has no <code>--query</code> flag.
          </CliGuideBlock>
        </div>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <KeyRound aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Access Model</h2>
          </div>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
            {accessRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </AdminPanel>

        <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <Database aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Parameters</h2>
            </div>
            <dl className="mt-4 grid gap-3">
              {parameters.map((parameter) => (
                <div className="grid gap-1 rounded-lg border border-line bg-white p-3" key={parameter.name}>
                  <dt className="break-words font-mono text-sm font-semibold text-ink">
                    {parameter.name}: {parameter.type}
                  </dt>
                  <dd className="text-sm leading-5 text-muted">{parameter.detail}</dd>
                </div>
              ))}
            </dl>
          </AdminPanel>

          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Query Endpoints</h2>
            </div>
            <dl className="mt-4 grid gap-3 md:grid-cols-2">
              {queryEndpoints.map((endpoint) => (
                <div className="grid gap-1" key={endpoint.name}>
                  <dt className="break-words font-mono text-sm font-semibold text-ink">{endpoint.name}</dt>
                  <dd className="text-sm leading-5 text-muted">{endpoint.detail}</dd>
                </div>
              ))}
            </dl>
          </AdminPanel>
        </div>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <PencilLine aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">Write Endpoints</h2>
          </div>
          <dl className="mt-4 grid gap-3 md:grid-cols-2">
            {writeEndpoints.map((endpoint) => (
              <div className="grid gap-1" key={endpoint.name}>
                <dt className="break-words font-mono text-sm font-semibold text-ink">{endpoint.name}</dt>
                <dd className="text-sm leading-5 text-muted">{endpoint.detail}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
            {writeRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </AdminPanel>

        <AdminPanel className="min-w-0" padding="lg">
          <div className="flex items-center gap-2">
            <Braces aria-hidden className="text-accent" size={18} />
            <h2 className="text-lg font-semibold text-ink">SQL Rules</h2>
          </div>
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
