import { useState } from "react";
import { VaultButton } from "./ui";
import { VaultPreview } from "./preview";

export type ReadOnlyContent =
  | { kind: "note"; body: string }
  | {
      kind: "credential";
      username: string;
      password: string;
      url: string;
      notes: string;
    }
  | { kind: "attachment" };

export function parseCredential(
  json: string,
): ReadOnlyContent & { kind: "credential" } {
  const value = JSON.parse(json) as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" ? value[key] : "";
  return {
    kind: "credential",
    username: text("username"),
    password: text("password"),
    url: text("URL"),
    notes: text("notes"),
  };
}

export function VaultReadOnly({ content }: { content: ReadOnlyContent }) {
  const [reveal, setReveal] = useState(false);
  if (content.kind === "note") return <VaultPreview content={content.body} />;
  if (content.kind === "attachment") return null;
  return (
    <div className="grid min-w-0 gap-3 break-words">
      {reveal ? (
        <dl className="grid gap-2">
          {content.username ? (
            <div>
              <dt className="font-medium">Username</dt>
              <dd>{content.username}</dd>
            </div>
          ) : null}
          {content.url ? (
            <div>
              <dt className="font-medium">URL</dt>
              <dd>{content.url}</dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium">Password</dt>
            <dd>{content.password}</dd>
          </div>
          {content.notes ? (
            <div>
              <dt className="font-medium">Notes</dt>
              <dd className="whitespace-pre-wrap">{content.notes}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="text-sm text-muted">Credential details are hidden.</p>
      )}
      <VaultButton
        aria-pressed={reveal}
        onClick={() => setReveal((value) => !value)}
      >
        {reveal ? "Hide credential" : "Show credential"}
      </VaultButton>
    </div>
  );
}
