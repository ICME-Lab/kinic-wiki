import {execFileSync,spawn} from 'node:child_process';
import {mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname);
const udid=process.argv[2];
if(!udid) throw new Error('Pass the task-owned Simulator UDID.');
const app='xyz.kinic.ios.KinicWiki';
const raw=path.resolve(root,'../build/DemoVideo/raw');
await mkdir(raw,{recursive:true}); await mkdir(path.join(root,'public'),{recursive:true});
const sim=(...args)=>execFileSync('xcrun',['simctl',...args],{stdio:'inherit'});
for(const [name,mode] of [['home','navigation'],['ask','ask-ai']]){
 try{sim('terminate',udid,app);}catch{}
 execFileSync('xcrun',['simctl','launch',udid,app],{stdio:'inherit',env:{...process.env,SIMCTL_CHILD_KINIC_SCREENSHOT_MODE:mode,SIMCTL_CHILD_KINIC_DARK_MODE:'1'}});
 await new Promise(r=>setTimeout(r,3500));
 const png=`/private/tmp/kinic-demo-${name}.png`;
 sim('io',udid,'screenshot',png);
 await copyFile(png,path.join(raw,`${name}.png`)); await copyFile(png,path.join(root,'public',`${name}.png`));
 const recording=`/private/tmp/kinic-demo-${name}.mp4`;
 const processVideo=spawn('xcrun',['simctl','io',udid,'recordVideo','--codec=h264','-f',recording],{stdio:'inherit'});
 const exited=new Promise((resolve,reject)=>{processVideo.once('exit',code=>code===0?resolve():reject(new Error(`recordVideo exit ${code}`)));processVideo.once('error',reject);});
 await new Promise(r=>setTimeout(r,5000)); processVideo.kill('SIGINT');
 await exited;
 await copyFile(recording,path.join(raw,`${name}.mp4`));
}
