import type { Metadata } from "next";
import Image from "next/image";
import { CheckCircle2, Database, Search, ShieldCheck, TerminalSquare, Wrench } from "lucide-react";
import { CliGuideBlock } from "./cli-guide-block";

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
  'kinic-vfs-cli search-remote "query text" --prefix /Wiki --top-k 10 --json',
  "kinic-vfs-cli read-node --path /Wiki/page.md --json",
  "kinic-vfs-cli read-node-context --path /Wiki/page.md --json"
];

const writeCommands = [
  "kinic-vfs-cli read-node --path /Wiki/page.md --json",
  "kinic-vfs-cli edit-node --path /Wiki/page.md --old-text before --new-text after --expected-etag <etag> --json",
  "kinic-vfs-cli read-node --path /Wiki/page.md --json"
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

export default function CliPage() {
  return (
    <main className="min-h-screen px-6 py-8">
      <section className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="border-b border-line pb-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <Image className="h-12 w-12 rounded-xl shadow-sm" src="/icon.png" alt="" width={48} height={48} unoptimized />
              <div className="min-w-0">
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Kinic Wiki</p>
                <h1 className="mt-1 text-4xl font-semibold text-ink">CLI</h1>
              </div>
            </div>
            <a
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-action bg-action px-4 py-2 text-sm font-bold text-white no-underline hover:border-accent hover:bg-accent"
              href="https://www.npmjs.com/package/kinic-vfs-cli"
              rel="noreferrer"
              target="_blank"
            >
              <TerminalSquare aria-hidden size={16} />
              <span>Open npm</span>
            </a>
          </div>
          <p className="mt-5 max-w-3xl text-base leading-7 text-muted">
            <code>kinic-vfs-cli</code> is the npm-distributed operator CLI for Kinic Wiki databases and Skill Registry packages. Use this page as the canonical setup and agent workflow reference.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <CliGuideBlock icon={<TerminalSquare aria-hidden size={18} />} title="Install" commands={installCommands}>
            The npm package downloads the matching release binary and verifies its SHA-256 checksum.
          </CliGuideBlock>
          <CliGuideBlock icon={<CheckCircle2 aria-hidden size={18} />} title="First Check" commands={checkCommands}>
            Confirm the installed binary, then inspect the command index before connecting it to a database.
          </CliGuideBlock>
          <CliGuideBlock icon={<Database aria-hidden size={18} />} title="Connect" commands={connectionCommands}>
            Pass <code>--database-id</code> for one command, run <code>database link</code> once for a workspace, or set <code>VFS_DATABASE_ID</code> for scripts.
          </CliGuideBlock>
          <CliGuideBlock icon={<Search aria-hidden size={18} />} title="Agent Read Workflow" commands={readCommands}>
            Search first, read exact paths next, then request context when link relationships matter. Agents should use <code>--json</code>.
          </CliGuideBlock>
          <CliGuideBlock icon={<Wrench aria-hidden size={18} />} title="Agent Write Workflow" commands={writeCommands}>
            Read the node first, keep its <code>etag</code>, mutate with <code>--expected-etag</code>, then read again to verify the stored content.
          </CliGuideBlock>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <CliGuideBlock icon={<CheckCircle2 aria-hidden size={18} />} title="Skill Registry Workflow" commands={skillCommands}>
            Agents and operators should discover a skill, inspect the package, use it, then record run evidence.
          </CliGuideBlock>
          <section className="min-w-0 rounded-lg border border-line bg-paper p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Safety Notes</h2>
            </div>
            <ul className="mt-4 flex flex-col gap-3 text-sm leading-6 text-muted">
              {safetyNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        </section>
      </section>
    </main>
  );
}
