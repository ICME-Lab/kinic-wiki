import {bundle} from '@remotion/bundler';
import {renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=path.dirname(new URL(import.meta.url).pathname);
const output=path.resolve(root,'../build/NewFeaturesDemo');
await mkdir(output,{recursive:true});
const serveUrl=await bundle({entryPoint:path.join(root,'src/new-features.tsx'),publicDir:path.join(root,'public')});
const composition=await selectComposition({serveUrl,id:'KinicNewFeatures'});
for(const [name,frame] of [['create',260],['comment',590],['closed',790],['widget',950]]){
 await renderStill({serveUrl,composition,frame,output:path.join(output,`preview-${name}.png`)});
 console.log(`Preview: ${name}`);
}
let previous=-1;
await renderMedia({serveUrl,composition,codec:'h264',crf:18,outputLocation:path.join(output,'KinicWiki-new-features.mp4'),concurrency:3,onProgress:({progress})=>{const percent=Math.floor(progress*10)*10;if(percent!==previous){console.log(`Render ${percent}%`);previous=percent;}}});
console.log(`Video: ${output}/KinicWiki-new-features.mp4`);
