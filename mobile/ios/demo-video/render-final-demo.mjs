import {bundle} from '@remotion/bundler';
import {renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=path.dirname(new URL(import.meta.url).pathname);
const output=path.resolve(root,'../build/NewFeaturesDemo');
await mkdir(path.join(output,'final-review'),{recursive:true});
const serveUrl=await bundle({entryPoint:path.join(root,'src/final-demo.tsx'),publicDir:path.join(root,'public')});
const composition=await selectComposition({serveUrl,id:'KinicFinalDemo'});
for(const [name,frame] of [['hook',30],['type-title',94],['type-body',134],['save',163],['created',188],['reply-input',290],['send',316],['discussion',350],['closed',452],['closed-list',505],['widget',575],['widget-tap',615],['opened',661]]){
 await renderStill({serveUrl,composition,frame,output:path.join(output,'final-review',`${name}.png`)});
 console.log(`Preview: ${name}`);
}
if(process.argv.includes('--previews-only'))process.exit(0);
let previous=-1;
await renderMedia({serveUrl,composition,codec:'h264',crf:16,pixelFormat:'yuv420p',imageFormat:'png',colorSpace:'bt709',outputLocation:path.join(output,'KinicWiki-new-features-final.mp4'),concurrency:3,onProgress:({progress})=>{const p=Math.floor(progress*10)*10;if(p!==previous){console.log(`Render ${p}%`);previous=p;}}});
console.log('Rendered final demo');
