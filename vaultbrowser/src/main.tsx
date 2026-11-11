import { createRoot } from 'react-dom/client';
import { VaultAuthProvider, useVaultAuth } from './auth';
import VaultPage from './vault/page';
import './style.css';
function App() {
  const {
    identity,
    loading,
    error,
    login,
    logout
  } = useVaultAuth();
  return <><header className="flex items-center justify-between border-b border-line p-5"><strong>Kinic Vault</strong><button type="button" disabled={loading} onClick={identity ? logout : login}>{identity ? 'Sign out' : 'Sign in with Internet Identity'}</button></header>{error ? <p role="alert" className="px-5">{error}</p> : null}<VaultPage /></>;
}
createRoot(document.getElementById('root')!).render(<VaultAuthProvider><App /></VaultAuthProvider>);
