import { createRoot } from "react-dom/client";
import { VaultAuthProvider } from "./auth";
import { VaultEmbedPage } from "./vault/embed";
import { VaultPickerPage } from "./vault/picker";
import { parseVaultRoute } from "./vault/routes";
import { AuthenticatedFundingRoot } from "./funding/session";
import { App } from "./app";
import { VaultErrorBoundary } from "./error-boundary";
import { VaultRouter } from "./navigation";
import { DraftGuardProvider } from "./draft-guard";
import "./style.css";

const route = parseVaultRoute(location.pathname);
createRoot(document.getElementById("root")!, { onCaughtError: () => {} }).render(
  <VaultErrorBoundary>
    {route.kind === "workspace" ? (
      <VaultRouter>
        <DraftGuardProvider>
          <VaultAuthProvider>
            <AuthenticatedFundingRoot>
              <App />
            </AuthenticatedFundingRoot>
          </VaultAuthProvider>
        </DraftGuardProvider>
      </VaultRouter>
    ) : (
      <VaultAuthProvider>
        {route.kind === "embed" ? (
          <VaultEmbedPage ids={route.ids} />
        ) : (
          <VaultPickerPage />
        )}
      </VaultAuthProvider>
    )}
  </VaultErrorBoundary>,
);
