import {useVaultAuth} from "./auth";
import VaultPage from "./vault/page";
import {VaultChrome,VaultSignOut} from "./chrome";
import {VaultButton} from "./vault/ui";
import {useDraftGuard} from "./draft-guard";
export function App() {
  const guard=useDraftGuard();
  const { identity, loading, ready, error, login, logout } = useVaultAuth();
  return (
    <>
      <VaultChrome
        actions={
          identity ? (
            <VaultSignOut disabled={loading} onClick={() => guard.protect(logout)} />
          ) : (
            <VaultButton tone="primary" disabled={loading || !ready} onClick={login}>
              Sign in with Internet Identity
            </VaultButton>
          )
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
