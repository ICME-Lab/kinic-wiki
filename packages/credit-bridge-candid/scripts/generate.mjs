// Generate only the bridge user surface from the actual exported canister DIDs.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const selections={
 wiki:['preview_vault_link','approve_vault_link','get_vault_link','revoke_vault_link','quote_vault_transfer','execute_vault_transfer','get_vault_transfer','get_pending_vault_transfer','cancel_vault_transfer','reconcile_vault_transfer','set_vault_auto_topup','get_vault_auto_topup'],
 vault:['wiki_link_status','begin_wiki_link','prepare_wiki_credit','revoke_wiki_link','request_wiki_auto_topup','wiki_auto_topup_status'],
};
for(const [side,methods] of Object.entries(selections)) {
 const did=`${root}crates/${side==='wiki'?'vfs':'vault'}_canister/${side==='wiki'?'vfs':'vault'}.did`;
 const source=readFileSync(did,'utf8');
 const aliases=new Map([...source.matchAll(/^type (\w+) = ([\s\S]*?)(?=\ntype |\nservice )/gm)].map(m=>[m[1],m[0]]));
 const service=source.slice(source.indexOf('service :'));
 const selected=[...service.matchAll(/^  (\w+) : ([\s\S]*?);/gm)].filter(m=>methods.includes(m[1]));
 if(selected.length!==methods.length)throw Error(`Missing bridge methods for ${side}`);
 const needed=new Set();
 function visit(text){for(const name of text.match(/\b\w+\b/g)??[])if(aliases.has(name)&&!needed.has(name)){needed.add(name);visit(aliases.get(name).slice(`type ${name} = `.length));}}
 selected.forEach(m=>visit(m[0]));
 const subset=[...aliases].filter(([name])=>needed.has(name)).map(([,body])=>body).join('\n')+'\nservice : {\n'+selected.map(m=>m[0]).join('\n')+'\n}\n';
 const subsetPath=`${root}packages/credit-bridge-candid/${side}.did`;
 const emit=(path,output)=>{if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error(`Bridge Candid drift: ${path}`);}else writeFileSync(path,output);};
 emit(subsetPath,subset);
 for(const [target,extension] of [['ts','d.ts'],['js','js']]){
  const output=execFileSync('didc',['bind',subsetPath,'--target',target],{encoding:'utf8'})
   .replaceAll('@dfinity/agent','@icp-sdk/core/agent').replaceAll('@dfinity/principal','@icp-sdk/core/principal').replaceAll('@dfinity/candid','@icp-sdk/core/candid');
  emit(`${root}packages/credit-bridge-candid/${side}.${extension}`,output);
 }
}
console.log('Neutral bridge Candid contracts match');
