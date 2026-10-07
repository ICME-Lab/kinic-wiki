import React from 'react';
import {AbsoluteFill, Audio, Composition, Img, Sequence, interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

const pink = '#ff3887';
const steps = [
  {label:'YOUR AI MEMORY', title:['Less scattered.', 'More connected.'], copy:'Your notes, sources and next steps.\nOne place to keep moving.', file:'home.png', number:'01', tag:'Personal Memory', pills:['SAVE', 'ORGANIZE', 'ACT']},
  {label:'ASK WITH CONTEXT', title:['An answer.', 'With evidence.'], copy:'Ask your memory.\nKeep the source notes in view.', file:'ask.png', number:'02', tag:'Ask AI · Source notes', pills:['QUESTION', 'CONTEXT', 'SOURCES']},
  {label:'MOVE IDEAS FORWARD', title:['Knowledge.', 'Meet action.'], copy:'Keep shared work items close.\nMake room for the next step.', file:'detail.png', number:'03', tag:'Work items', pills:['CREATE', 'COMMENT', 'FOLLOW UP']},
];

const Grid = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{backgroundColor:'#07090d', backgroundImage:'linear-gradient(#ffffff06 1px, transparent 1px),linear-gradient(90deg,#ffffff06 1px,transparent 1px)',backgroundSize:'72px 72px'}}>
    <div style={{position:'absolute',width:1000,height:1000,borderRadius:'50%',right:-130,top:-200,background:`radial-gradient(circle, ${pink}14, transparent 68%)`,transform:`translateY(${Math.sin(f/80)*35}px)`}}/>
    <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 45% 45%,transparent 20%,#07090dcc 85%)'}}/>
  </AbsoluteFill>;
};

const Phone = ({file, height=820}: {file:string;height?:number}) => <div style={{height,width:height*402/874,padding:9,boxSizing:'content-box',borderRadius:height*.062,background:'#12151b',border:'2px solid #343842',boxShadow:'0 38px 90px #000a, 0 0 85px #ff38870b',overflow:'hidden'}}>
  <div style={{height:'100%',width:'100%',borderRadius:height*.051,overflow:'hidden',background:'#111'}}>
    <Img src={staticFile(file)} style={{width:'100%',height:'100%',objectFit:'cover'}}/>
  </div>
</div>;

const Scene = ({index}: {index:number}) => {
  const f=useCurrentFrame(); const {fps}=useVideoConfig(); const s=steps[index];
  const enter=spring({frame:f,fps,config:{damping:22,stiffness:85}});
  const out=interpolate(f,[220,239],[1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
  return <AbsoluteFill style={{opacity:out}}>
    <div style={{position:'absolute',left:130,top:230,width:950,opacity:enter,transform:`translateY(${(1-enter)*35}px)`}}>
      <div style={{color:pink,fontSize:20,fontWeight:650,letterSpacing:5,marginBottom:32}}>{s.label}</div>
      <div style={{fontSize:110,lineHeight:1.06,fontWeight:650,letterSpacing:-6}}>{s.title[0]}<br/><span style={{color:pink}}>{s.title[1]}</span></div>
      <div style={{color:'#adb2bf',fontSize:29,lineHeight:1.6,whiteSpace:'pre-line',marginTop:32}}>{s.copy}</div>
      <div style={{display:'flex',gap:13,marginTop:45}}>{s.pills.map((p,i)=><div key={p} style={{border:`1px solid ${i===2?'#ff38875c':'#ffffff25'}`,color:i===2?pink:'#cbd0da',padding:'12px 18px',borderRadius:7,fontSize:15,letterSpacing:2}}>{p}</div>)}</div>
    </div>
    <div style={{position:'absolute',right:195,top:110,transform:`translateY(${(1-enter)*65-f*.04}px) rotate(${interpolate(f,[0,239],[2,-1])}deg)`}}><Phone file={s.file}/></div>
    <div style={{position:'absolute',right:135,bottom:95,padding:'17px 25px',background:'#151820',border:'1px solid #ffffff20',borderRadius:14,color:'#e3e6ee',fontSize:20}}><span style={{color:pink}}>●</span>　{s.tag}</div>
    <div style={{position:'absolute',bottom:87,left:130,fontSize:16,letterSpacing:3,color:'#686e7a'}}>{s.number} / 03　—　KINICWIKI FOR iOS</div>
  </AbsoluteFill>;
};

const Finale = () => {
 const f=useCurrentFrame(); const {fps}=useVideoConfig(); const e=spring({frame:f,fps,config:{damping:25}});
 return <AbsoluteFill style={{alignItems:'center',justifyContent:'center',opacity:e}}>
   <div style={{position:'absolute',left:145,top:180,transform:`rotate(-10deg) translateY(${(1-e)*80}px)`,opacity:.45}}><Phone file="home.png" height={640}/></div>
   <div style={{position:'absolute',right:145,top:180,transform:`rotate(10deg) translateY(${(1-e)*80}px)`,opacity:.45}}><Phone file="ask.png" height={640}/></div>
   <div style={{zIndex:2,textAlign:'center',background:'radial-gradient(ellipse,#07090dfc 30%,#07090de0 55%,transparent 72%)',padding:'120px 160px'}}>
     <div style={{fontSize:23,letterSpacing:7,color:pink,marginBottom:25}}>BUILT FOR YOUR NEXT IDEA</div>
     <div style={{fontSize:124,fontWeight:700,letterSpacing:-7}}>KinicWiki<span style={{color:pink}}>.</span></div>
     <div style={{fontSize:37,color:'#b5bbc7',marginTop:18}}>Your memory. Ready for AI.</div>
     <div style={{marginTop:42,fontSize:23,color:'#f5f6fa',padding:'18px 28px',display:'inline-block',border:'1px solid #ffffff3a',borderRadius:11}}>Available on the App Store　↗</div>
   </div>
 </AbsoluteFill>;
};

const Film = () => {
 const f=useCurrentFrame();
 return <AbsoluteFill style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',color:'#f5f6fa'}}>
  <Grid/>
  <Audio src={staticFile('soundtrack.wav')} volume={(frame)=>interpolate(frame,[0,35,850,899],[0,.55,.55,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}/>
  <div style={{position:'absolute',left:130,top:60,fontSize:28,fontWeight:650,letterSpacing:-1}}>kinic<span style={{color:pink}}> / </span>wiki</div>
  <div style={{position:'absolute',right:130,top:67,fontFamily:'monospace',fontSize:15,letterSpacing:2,color:'#8b92a1'}}>CAPTURE → CONTEXT → ACTION</div>
  {steps.map((_,i)=><Sequence key={i} from={i*240} durationInFrames={240}><Scene index={i}/></Sequence>)}
  <Sequence from={720} durationInFrames={180}><Finale/></Sequence>
  <div style={{position:'absolute',bottom:0,height:3,width:`${f/899*100}%`,background:pink}}/>
 </AbsoluteFill>;
};

const Root = () => <Composition id="KinicLaunch" component={Film} width={1920} height={1080} fps={30} durationInFrames={900}/>;
registerRoot(Root);
