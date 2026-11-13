import { createRoot } from "react-dom/client";
import { VaultAuthProvider, useVaultAuth } from "./auth";
import VaultPage from "./vault/page";
import { VaultChrome } from "./chrome";
import { VaultButton } from "./vault/ui";
import "./style.css";
function App() {
  const { identity, loading, error, login, logout } = useVaultAuth();
  return (
    <>
      <VaultChrome
        actions={
          <VaultButton
            tone={identity ? "default" : "primary"}
            disabled={loading}
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
createRoot(document.getElementById("root")!).render(
  <VaultAuthProvider>
    <App />
  </VaultAuthProvider>,
);
