import type { Metadata } from "next";
import Link from "next/link";
import { Bot, CheckCircle2, Database, Search, ShieldCheck, TerminalSquare, Wrench } from "lucide-react";
import { CliGuideBlock } from "./cli-guide-block";
import { AdminContent } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";

export const metadata: Metadata = {
  title: "Kinic Wiki CLI",
  description: "Install and use kinic-vfs-cli from npm for Kinic Wiki database and Skill Registry workflows.",
  openGraph: {
    title: "Kinic Wiki CLI",
    description: "Install and use kinic-vfs-cli from npm for Kinic Wiki database and Skill Registry workflows."
  },
  twitter: {
    title: "Kinic Wiki CLI",
    description: "Install and use kinic-vfs-cli from npm for Kinic Wiki database and Skill Registry workflows."
  }
};

const installCommands = ["npm install -g kinic-vfs-cli"];
const checkCommands = ["kinic-vfs-cli --version", "kinic-vfs-cli --help"];

const connectionCommands = [
  "kinic-vfs-cli --database-id <database-id> status --json",
  "kinic-vfs-cli database link <database-id>",
  "VFS_DATABASE_ID=<database-id> kinic-vfs-cli status --json"
];

const readCommands = [
  'kinic-vfs-cli search-remote "query text" --prefix /Knowledge --top-k 10 --json',
  "kinic-vfs-cli read-node --path /Knowledge/page.md --json",
  "kinic-vfs-cli read-node-context --path /Knowledge/page.md --json"
];

const writeCommands = [
  "kinic-vfs-cli read-node --path /Knowledge/page.md --json",
  "kinic-vfs-cli edit-node --path /Knowledge/page.md --old-text before --new-text after --expected-etag <etag> --json",
  "kinic-vfs-cli read-node --path /Knowledge/page.md --json"
];

const skillCommands = [
  'kinic-vfs-cli skill find "contract review" --json',
  "kinic-vfs-cli skill inspect legal-review --json",
  'kinic-vfs-cli skill record-run legal-review --task "review contract" --outcome success --notes-file ./notes.md --json'
];

const safetyNotes = [
  "Public reads can run with --identity-mode anonymous when the database grants anonymous reader access.",
  "Writes, database grants, archive operations, and private Skill Registry writes require identity mode.",
  "Non-Internet Identity credentials require the explicit --allow-non-ii-identity opt-in.",
  "Agents should request JSON output and use etag guards before mutating existing nodes."
];

const workflowSteps = [
  { label: "Install", text: "Add the CLI package once per machine." },
  { label: "Connect", text: "Link a database or pass a database id per command." },
  { label: "Use JSON", text: "Request structured output for agents and scripts." },
  { label: "Guard writes", text: "Read etags before editing existing nodes." }
];

export default function CliPage() {
  return (
    <AdminContent>
      <div className="flex flex-col gap-6">
        <AdminPanel className="min-w-0" padding="lg">
          <div className="grid gap-6 lg:grid-cols-[1fr_0.92fr]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Bot aria-hidden className="text-accent" size={20} />
                <p className="text-sm font-semibold uppercase text-accentText">Automation entrypoint</p>
              </div>
              <h1 className="mt-3 text-2xl font-semibold text-ink">Run Kinic Wiki from the CLI</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                <code>kinic-vfs-cli</code> is the command-line interface for Kinic Wiki databases. It lets automation search, read, edit,
                connect databases, and record Skill Registry evidence without opening the browser.
              </p>
              <div className="mt-5">
                <CliGuideBlock compact icon={<TerminalSquare aria-hidden size={18} />} title="Install" commands={installCommands}>
                  Install the published npm package. It downloads the matching <code>kinic-vfs-cli</code> release binary and verifies its SHA-256 checksum.
                </CliGuideBlock>
              </div>
            </div>
            <div className="min-w-0 rounded-lg border border-line bg-white p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 aria-hidden className="text-accent" size={18} />
                <h2 className="text-base font-semibold text-ink">CLI workflow</h2>
              </div>
              <ol className="mt-4 grid gap-3">
                {workflowSteps.map((step, index) => (
                  <li className="grid grid-cols-[2rem_1fr] gap-3" key={step.label}>
                    <span className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-paper text-sm font-semibold text-ink">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{step.label}</span>
                      <span className="mt-0.5 block text-sm leading-5 text-muted">{step.text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </AdminPanel>

        <div className="grid gap-4 md:grid-cols-2">
          <CliGuideBlock icon={<CheckCircle2 aria-hidden size={18} />} title="First Check" commands={checkCommands}>
            Confirm the installed binary, then use <code>--help</code> to inspect the command index before connecting automation to a database.
          </CliGuideBlock>
          <CliGuideBlock icon={<Database aria-hidden size={18} />} title="Connect Database" commands={connectionCommands}>
            Pass <code>--database-id</code> for one command, run <code>database link</code> once for a workspace, or set <code>VFS_DATABASE_ID</code> in scripted environments.
          </CliGuideBlock>
          <CliGuideBlock icon={<Search aria-hidden size={18} />} title="Read Workflow" commands={readCommands}>
            Search first, read exact paths next, then request context when link relationships matter. Use <code>--json</code> so agents can parse results safely.
          </CliGuideBlock>
          <CliGuideBlock icon={<Wrench aria-hidden size={18} />} title="Safe Write Workflow" commands={writeCommands}>
            Read the node first, keep its <code>etag</code>, edit with <code>--expected-etag</code>, then read again to verify the stored content.
          </CliGuideBlock>
          <CliGuideBlock icon={<CheckCircle2 aria-hidden size={18} />} title="Skill Registry" commands={skillCommands}>
            Find a skill, inspect the package before use, then record run evidence after the agent completes the task.
          </CliGuideBlock>
          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <TerminalSquare aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Raw canister calls</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted">
              Use raw calls for endpoint debugging and database SQL without installing <code>kinic-vfs-cli</code>. Use <code>kinic-vfs-cli</code> for scripted reads and safe writes.
            </p>
            <Link className="mt-4 inline-flex min-h-10 items-center justify-center rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink no-underline hover:border-accent hover:bg-accentSoft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" href="/canister-api">
              Open Canister API
            </Link>
          </AdminPanel>
        </div>

        <div>
          <AdminPanel className="min-w-0" padding="md">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-base font-semibold text-ink">Safety Notes</h2>
            </div>
            <ul className="mt-3 grid gap-2 text-sm leading-6 text-muted md:grid-cols-2">
              {safetyNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AdminPanel>
        </div>
      </div>
    </AdminContent>
  );
}
