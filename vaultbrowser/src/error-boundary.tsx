import {Component,type ReactNode} from "react";
export function VaultFailure(){return <main className="vault-page" role="alert"><h1>Vault unavailable</h1><p>Reload Vault to start a new session.</p><a href="/">Reload Vault</a></main>;}
export class VaultErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<VaultFailure/>:this.props.children;}
}
