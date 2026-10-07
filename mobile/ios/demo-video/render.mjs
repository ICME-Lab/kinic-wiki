import {bundle} from '@remotion/bundler';
import {renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=path.dirname(new URL(import.meta.url).pathname);
const output=path.resolve(root,'../build/DemoVideo');
await mkdir(output,{recursive:true});
const serveUrl=await bundle({entryPoint:path.join(root,'src/index.tsx'),publicDir:path.join(root,'public')});
const composition=await selectComposition({serveUrl,id:'KinicLaunch'});
for(const [name,frame] of [['hero',100],['ask',340],['action',580],['end',800]]){
 await renderStill({serveUrl,composition,frame,output:path.join(output,`${name}.png`)});
 console.log(`Preview: ${name}`);
}
if(!process.argv.includes('--stills-only')){
 let previous=-1;
 await renderMedia({serveUrl,composition,codec:'h264',crf:18,outputLocation:path.join(output,'KinicWiki-demo-1080p.mp4'),concurrency:3,onProgress:({progress})=>{const percent=Math.floor(progress*10)*10;if(percent!==previous){console.log(`Render ${percent}%`);previous=percent;}}});
 console.log(`Video: ${output}/KinicWiki-demo-1080p.mp4`);
}
