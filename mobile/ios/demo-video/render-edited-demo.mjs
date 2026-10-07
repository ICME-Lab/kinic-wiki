import {bundle} from '@remotion/bundler';
import {renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=path.dirname(new URL(import.meta.url).pathname);
const output=path.resolve(root,'../build/NewFeaturesDemo');
await mkdir(output,{recursive:true});
const serveUrl=await bundle({entryPoint:path.join(root,'src/edited-demo.tsx'),publicDir:path.join(root,'public')});
const composition=await selectComposition({serveUrl,id:'KinicEditedDemo'});
for(const [name,frame] of [['hook',15],['typing',105],['body',142],['comment-input',291],['comment-result',360],['complete',431],['widget-focus',550],['widget-open',720]]){
 await renderStill({serveUrl,composition,frame,output:path.join(output,`edited-${name}.png`)});
 console.log(`Preview: ${name}`);
}
if(process.argv.includes('--previews-only'))process.exit(0);
let previous=-1;
const draft=process.argv.includes('--draft');
await renderMedia({serveUrl,composition,codec:'h264',crf:18,pixelFormat:'yuv420p',...(draft?{frameRange:[60,239]}:{}),outputLocation:path.join(output,draft?'KinicWiki-create-draft.mp4':'KinicWiki-new-features-edited.mp4'),concurrency:3,onProgress:({progress})=>{const p=Math.floor(progress*10)*10;if(p!==previous){console.log(`Render ${p}%`);previous=p;}}});
console.log(`Video: ${path.join(output,draft?'KinicWiki-create-draft.mp4':'KinicWiki-new-features-edited.mp4')}`);
