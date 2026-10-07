import React from 'react';
import {AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import scenes from '../new-scenes.json';
const pink='#ff3887';
const specs=[
 {id:'create',label:'01 / CREATE',title:['Start with','an idea.'],copy:'Create a shared work item.\nKeep the title and context together.',frames:360},
 {id:'comment',label:'02 / COMMENT',title:['Keep the','conversation.'],copy:'Add a comment to the same item.\nKeep the next step in view.',frames:300},
 {id:'close',label:'03 / COMPLETE',title:['Done?','Close it.'],copy:'Mark the item complete.\nFind it again under Closed.',frames:180},
 {id:'widget',label:'04 / HOME SCREEN WIDGET',title:['Your work.','Within reach.'],copy:'See open items on your Home Screen.\nOne widget. One database.',frames:210}
];
const Device=({children}:{children:React.ReactNode})=><div style={{width:413,height:900,padding:9,borderRadius:61,background:'#11151b',border:'2px solid #3c414a',boxShadow:'0 45px 90px #000a'}}><div style={{height:'100%',borderRadius:51,overflow:'hidden',background:'#111'}}>{children}</div></div>;
const Chapter=({index}:{index:number})=>{
 const f=useCurrentFrame();const {fps}=useVideoConfig();const s=specs[index];
 const enter=spring({frame:f,fps,config:{damping:24,stiffness:110}});
 const rate=scenes[s.id].duration/(s.frames/fps);
 return <AbsoluteFill>
  <div style={{position:'absolute',left:120,top:240,width:1030,opacity:enter,transform:`translateY(${(1-enter)*25}px)`}}>
   <div style={{fontFamily:'monospace',fontSize:21,color:pink,letterSpacing:4,marginBottom:37}}>{s.label}</div>
   <div style={{fontSize:104,lineHeight:1.09,fontWeight:650,letterSpacing:-5}}>{s.title[0]}<br/><span style={{color:pink}}>{s.title[1]}</span></div>
   <div style={{fontSize:29,color:'#b8bdc9',lineHeight:1.65,marginTop:38,whiteSpace:'pre-line'}}>{s.copy}</div>
   <div style={{display:'flex',gap:18,marginTop:65}}>{specs.map((p,i)=><div key={p.id} style={{width:88,height:3,background:i<=index?pink:'#343943'}}/>)}</div>
  </div>
  <div style={{position:'absolute',right:205,top:80,transform:`translateY(${(1-enter)*35}px)`}}><Device><OffthreadVideo muted src={staticFile(`new-${s.id}.mp4`)} playbackRate={rate} style={{width:'100%',height:'100%',objectFit:'cover'}}/></Device></div>
 </AbsoluteFill>;
};
const Ending=()=>{
 const f=useCurrentFrame();const {fps}=useVideoConfig();const enter=spring({frame:f,fps,config:{damping:24}});
 return <AbsoluteFill style={{alignItems:'center',justifyContent:'center',opacity:enter}}>
   <div style={{fontSize:22,color:pink,letterSpacing:5,marginBottom:25}}>SHARED WORK ITEMS + HOME SCREEN WIDGET</div>
   <div style={{fontSize:115,fontWeight:700,letterSpacing:-6}}>KinicWiki<span style={{color:pink}}>.</span></div>
   <div style={{fontSize:34,color:'#b8bdc9',marginTop:24}}>From an idea to the next step.</div>
   <div style={{fontSize:22,marginTop:40,border:'1px solid #ffffff30',borderRadius:12,padding:'18px 28px'}}>Available on the App Store　↗</div>
 </AbsoluteFill>;
};
const Film=()=>{
 const frame=useCurrentFrame();let offset=0;
 return <AbsoluteFill style={{background:'#07090d',color:'#f5f6fa',fontFamily:'-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',backgroundImage:'linear-gradient(#ffffff06 1px,transparent 1px),linear-gradient(90deg,#ffffff06 1px,transparent 1px)',backgroundSize:'72px 72px'}}>
  <AbsoluteFill style={{background:'radial-gradient(ellipse at 80% 30%,#ff388710,transparent 55%)'}}/>
  <Audio src={staticFile('soundtrack.wav')} loop volume={(f)=>interpolate(f,[0,30,1125,1169],[0,.5,.5,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}/>
  <div style={{position:'absolute',left:120,top:62,fontSize:28,fontWeight:650}}>kinic<span style={{color:pink}}> / </span>wiki</div>
  <div style={{position:'absolute',left:120,bottom:70,fontSize:16,color:'#a0a6b2',letterSpacing:3}}>NEW IN KINICWIKI</div>
  {specs.map((s,i)=>{const from=offset;offset+=s.frames;return <Sequence key={s.id} from={from} durationInFrames={s.frames}><Chapter index={i}/></Sequence>})}
  <Sequence from={1050} durationInFrames={120}><Ending/></Sequence>
  <div style={{position:'absolute',bottom:0,height:3,width:`${frame/1169*100}%`,background:pink}}/>
 </AbsoluteFill>;
};
registerRoot(()=> <Composition id="KinicNewFeatures" component={Film} width={1920} height={1080} fps={30} durationInFrames={1170}/>);
