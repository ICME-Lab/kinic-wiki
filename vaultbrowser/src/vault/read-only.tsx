import { useState } from "react";
import type { CredentialLogin } from "./credential";
import { VaultButton } from "./ui";
import { VaultPreview } from "./preview";

export type ReadOnlyContent =
  | { kind: "note"; body: string }
  | {
      kind: "credential";
      logins: CredentialLogin[];
      notes: string;
    }
  | { kind: "attachment" };

export function VaultReadOnly({ content }: { content: ReadOnlyContent }) {
  const [revealedLogin, setRevealedLogin] = useState<number>();
  if (content.kind === "note") return <VaultPreview content={content.body} />;
  if (content.kind === "attachment") return null;
  return (
    <div className="grid min-w-0 gap-3 break-words">
      {content.logins.map((login, index) => {
        const reveal = revealedLogin === index;
        return (
          <fieldset key={index} className="grid min-w-0 gap-2">
            {content.logins.length > 1 ? <legend>Login {index + 1}</legend> : null}
            {reveal ? (
              <dl className="grid gap-2">
                {login.username ? (
                  <div>
                    <dt className="font-medium">Username</dt>
                    <dd>{login.username}</dd>
                  </div>
                ) : null}
                {login.url ? (
                  <div>
                    <dt className="font-medium">URL</dt>
                    <dd>{login.url}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="font-medium">Password</dt>
                  <dd>{login.password}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted">Credential details are hidden.</p>
            )}
            <VaultButton
              aria-pressed={reveal}
              onClick={() => setRevealedLogin(reveal ? undefined : index)}
            >
              {reveal ? "Hide credential" : "Show credential"}
            </VaultButton>
          </fieldset>
        );
      })}
      {revealedLogin !== undefined && content.notes ? (
        <dl>
          <dt className="font-medium">Notes</dt>
          <dd className="whitespace-pre-wrap">{content.notes}</dd>
        </dl>
      ) : null}
    </div>
  );
}
