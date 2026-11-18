import { createRoot } from "react-dom/client";
import { VaultAuthProvider, useVaultAuth } from "./auth";
import VaultPage from "./vault/page";
import { VaultChrome } from "./chrome";
import { VaultButton } from "./vault/ui";
import { VaultEmbedPage } from "./vault/embed";
import { VaultPickerPage } from "./vault/picker";
import { parseVaultRoute } from "./vault/routes";
import "./style.css";
function App() {
  const { identity, loading, ready, error, login, logout } = useVaultAuth();
  return (
    <>
      <VaultChrome
        actions={
          <VaultButton
            tone={identity ? "default" : "primary"}
            disabled={loading || (!identity && !ready)}
            onClick={identity ? logout : login}
          >
            {identity ? "Sign out" : "Sign in with Internet Identity"}
          </VaultButton>
        }
      />
      {error ? (
        <p role="alert" className="vault-auth-error">
          {error}
        </p>
      ) : null}
      <VaultPage />
    </>
  );
}
const route = parseVaultRoute(location.pathname);
createRoot(document.getElementById("root")!).render(
  <VaultAuthProvider>
    {route.kind === "embed" ? (
      <VaultEmbedPage ids={route.ids} />
    ) : route.kind === "picker" ? (
      <VaultPickerPage />
    ) : (
      <App />
    )}
  </VaultAuthProvider>,
);
