import { createRoot } from "react-dom/client";
import { useState } from "react";
import { WikiCreditFunding } from "../../vaultbrowser/src/wiki-credit";
import { VaultCreditClient } from "../../wikibrowser/app/vault-credit/vault-credit-client";
import { FixtureSession } from "./session";
import { vaultPrincipal, wikiPrincipal } from "./actors";
const isVault = location.hostname === "localhost";
if (isVault) await import("../../vaultbrowser/src/style.css");
else await import("../../wikibrowser/app/globals.css");
function App() {
  const [serial, setSerial] = useState(0);
  const [identity, setIdentity] = useState(() => ({
    getPrincipal: () => (isVault ? vaultPrincipal : wikiPrincipal),
  }));
  const [client, setClient] = useState(() => ({
    identity,
    session: { capture: () => 0 },
    canister: vaultPrincipal.toText(),
  }));
  const session = {
    principal: wikiPrincipal.toText(),
    authLoading: false,
    authClient: { getIdentity: () => identity },
    login: () => {},
  };
  return (
    <main className={isVault ? "vault-page" : ""}>
      <div className="p-4">
        <p>Local synthetic transport · no real credits or Internet Identity</p>
        <button
          type="button"
          onClick={() => {
            const fresh = { getPrincipal: identity.getPrincipal };
            setIdentity(fresh);
            setClient({
              identity: fresh,
              session: { capture: () => serial + 1 },
              canister: vaultPrincipal.toText(),
            });
            setSerial(serial + 1);
          }}
        >
          Reauthenticate same Principal
        </button>
        <output>{serial > 0 ? `Session refreshed ${serial}` : ""}</output>
      </div>
      {isVault ? (
        <section className="vault-panel">
          <h1 className="text-2xl font-semibold">Vault funding</h1>
          <WikiCreditFunding
            client={client as never}
            onFunded={async () => {}}
          />
        </section>
      ) : (
        <FixtureSession.Provider value={session}>
          <VaultCreditClient canisterId={wikiPrincipal.toText()} />
        </FixtureSession.Provider>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
