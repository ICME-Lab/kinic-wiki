import { AnonymousIdentity } from "@icp-sdk/core/agent";
import { createRoot } from "react-dom/client";
import { MarkdownEditDocument } from "@/components/markdown-edit-document";
import { MarkdownPreview } from "@/components/markdown-preview";
import type { WikiNode } from "@/lib/types";
import { isVaultId, trustedVaultOrigin } from "@/lib/vault-reference";
import "@/app/globals.css";

const origin = trustedVaultOrigin(window.location.origin);
const search = new URLSearchParams(window.location.search);
const vault = search.get("vault");
const object = search.get("object");
const ids = isVaultId(vault) && isVaultId(object)
  ? `${vault}/${object}`
  : "0123456789abcdef0123456789abcdef/fedcba9876543210fedcba9876543210";
const reference = `[非公開資料](${origin}/embed/${ids})`;
const article = {
  canisterId: "fixture",
  databaseId: "db_fixture",
  nodePath: "/Knowledge/private-document.md"
};
const node: WikiNode = {
  path: article.nodePath,
  kind: "file",
  content: "Original draft.",
  createdAt: "0",
  updatedAt: "0",
  etag: "fixture",
  metadataJson: "{}"
};

createRoot(document.getElementById("root")!).render(
  <main>
    <h1>Private documents in Wiki</h1>
    <section>
      <h2>Article preview</h2>
      <div className="markdown-body">
        <MarkdownPreview {...article} content={`${reference}\n\n\`\`\`md\n${reference}\n\`\`\``} />
      </div>
    </section>
    <section>
      <h2>Markdown editor</h2>
      <div className="draft-panel">
        <MarkdownEditDocument
          canisterId={article.canisterId}
          databaseId={article.databaseId}
          node={node}
          isLargeContent={false}
          contentBytes={node.content.length}
          writeIdentity={new AnonymousIdentity()}
          onNodeSaved={async () => node}
        />
      </div>
    </section>
  </main>
);
