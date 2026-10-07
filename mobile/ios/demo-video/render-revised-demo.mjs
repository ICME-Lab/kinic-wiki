import {bundle} from '@remotion/bundler';
import {renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=path.dirname(new URL(import.meta.url).pathname);
const output=path.resolve(root,'../build/NewFeaturesDemo');
await mkdir(path.join(output,'revised-review'),{recursive:true});
const serveUrl=await bundle({entryPoint:path.join(root,'src/revised-demo.tsx'),publicDir:path.join(root,'public')});
const composition=await selectComposition({serveUrl,id:'KinicRevisedDemo'});
for(const [name,frame] of [['hook',30],['type-title',94],['type-body',134],['save',163],['created',188],['reply-input',290],['send',316],['discussion',350],['home-context',430],['widget-focus',477],['widget-tap',494],['opened',530]]){
 await renderStill({serveUrl,composition,frame,output:path.join(output,'revised-review',`${name}.png`)});
 console.log(`Preview: ${name}`);
}
if(process.argv.includes('--previews-only'))process.exit(0);
let previous=-1;
await renderMedia({serveUrl,composition,codec:'h264',crf:16,pixelFormat:'yuv420p',imageFormat:'png',colorSpace:'bt709',outputLocation:path.join(output,'KinicWiki-new-features-revised.mp4'),concurrency:3,onProgress:({progress})=>{const p=Math.floor(progress*10)*10;if(p!==previous){console.log(`Render ${p}%`);previous=p;}}});
console.log('Rendered final demo');
