import type { Metadata } from "next";
import { CheckCircle2, Database, Search, ShieldCheck, TerminalSquare, Wrench } from "lucide-react";
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
    <AdminContent>
      <div className="flex flex-col gap-8">
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
          <AdminPanel className="min-w-0" padding="lg">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="text-accent" size={18} />
              <h2 className="text-lg font-semibold text-ink">Safety Notes</h2>
            </div>
            <ul className="mt-4 flex flex-col gap-3 text-sm leading-6 text-muted">
              {safetyNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          </AdminPanel>
        </section>
      </div>
    </AdminContent>
  );
}
