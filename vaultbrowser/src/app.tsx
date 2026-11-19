import {useVaultAuth} from "./auth";
import VaultPage from "./vault/page";
import {VaultChrome} from "./chrome";
import {VaultButton} from "./vault/ui";
import {useDraftGuard} from "./draft-guard";
export function App() {
  const guard=useDraftGuard();
  const { identity, loading, ready, error, login, logout } = useVaultAuth();
  return (
    <>
      <VaultChrome
        actions={
          <VaultButton
            tone={identity ? "default" : "primary"}
            disabled={loading || (!identity && !ready)}
            onClick={identity ? () => guard.protect(logout) : login}
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
