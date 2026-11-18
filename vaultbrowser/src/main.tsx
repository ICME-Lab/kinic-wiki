import { createRoot } from "react-dom/client";
import { VaultAuthProvider } from "./auth";
import "./style.css";
import {App} from "./app";
import {VaultErrorBoundary} from "./error-boundary";
import {VaultRouter} from "./navigation";
import {DraftGuardProvider} from "./draft-guard";
createRoot(document.getElementById("root")!,{onCaughtError:()=>{}}).render(
  <VaultErrorBoundary>
  <VaultRouter><DraftGuardProvider><VaultAuthProvider>
    <App />
  </VaultAuthProvider></DraftGuardProvider></VaultRouter></VaultErrorBoundary>,
);
