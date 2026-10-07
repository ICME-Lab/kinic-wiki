import React from 'react';
import {AbsoluteFill, Audio, Composition, Easing, Img, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';

// Logical coordinates match the 402 × 874 point Simulator screen. Render at 3×.
const W=402, H=874, pink='#ff3887';
type Pose={at:number; scale:number; x:number; y:number};
const ease=Easing.bezier(.22,.72,.2,1);
const mix=(f:number,points:number[],values:number[])=>interpolate(f,points,values,{easing:ease,extrapolateLeft:'clamp',extrapolateRight:'clamp'});
const Photo=({name}:{name:string})=><Img src={staticFile(name)} style={{position:'absolute',width:W,height:H}}/>;
const Camera=({poses,children}:{poses:Pose[];children:React.ReactNode})=>{
 const f=useCurrentFrame(), points=poses.map(p=>p.at);
 const s=mix(f,points,poses.map(p=>p.scale));
 const x=mix(f,points,poses.map(p=>p.x)),y=mix(f,points,poses.map(p=>p.y));
 // Clamp the camera to the source edges, keeping every pixel covered.
 const tx=Math.max(W-W*s,Math.min(0,W/2-x*s));
 const ty=Math.max(H-H*s,Math.min(0,H/2-y*s));
 return <AbsoluteFill style={{transformOrigin:'0 0',transform:`translate(${tx}px,${ty}px) scale(${s})`}}>{children}</AbsoluteFill>;
};
const Tap=({at,x,y}:{at:number;x:number;y:number})=>{
 const f=useCurrentFrame()-at;
 if(f<0||f>13)return null;
 const radius=interpolate(f,[0,13],[7,25]);
 return <div style={{position:'absolute',left:x-radius,top:y-radius,width:radius*2,height:radius*2,border:`1.5px solid ${pink}`,borderRadius:'50%',background:'#ff388724',opacity:1-f/13,boxShadow:'0 0 12px #ff388744'}}/>;
};
const Focus=({at,duration=45,x,y,width,height,radius=12}:{at:number;duration?:number;x:number;y:number;width:number;height:number;radius?:number})=>{
 const f=useCurrentFrame()-at;
 if(f<0||f>duration)return null;
 const opacity=mix(f,[0,8,duration-9,duration],[0,.85,.85,0]);
 return <div style={{position:'absolute',left:x,top:y,width,height,borderRadius:radius,border:`1px solid ${pink}`,boxShadow:'0 0 16px #ff388736',opacity}}/>;
};
const Typed=({text,at,duration,x,y,width,fontSize=17,lineHeight=1.35}:{text:string;at:number;duration:number;x:number;y:number;width:number;fontSize?:number;lineHeight?:number})=>{
 const f=useCurrentFrame();
 const n=Math.floor(interpolate(f,[at,at+duration],[0,text.length],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}));
 const cursor=f>=at&&f<at+duration+10;
 return <div style={{position:'absolute',left:x,top:y,width,fontSize,lineHeight,color:'#f5f5f7',fontFamily:'-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',letterSpacing:-.3}}>{text.slice(0,n)}{cursor&&<span style={{display:'inline-block',verticalAlign:'text-bottom',width:1.5,height:19,marginLeft:1,background:pink,boxShadow:'0 0 5px #ff388766'}}/>}</div>;
};
const Clip=({name,start=0,rate=1}:{name:string;start?:number;rate?:number})=><OffthreadVideo muted src={staticFile(name)} trimBefore={Math.round(start*30)} playbackRate={rate} style={{width:W,height:H}}/>;
const Badge=({text,at=0,until=36}:{text:string;at?:number;until?:number})=>{
 const f=useCurrentFrame();if(f<at||f>until)return null;
 const opacity=mix(f,[at,at+7,until-7,until],[0,1,1,0]);
 return <div style={{position:'absolute',bottom:95,left:24,background:'#08080deb',border:'1px solid #ff388755',borderRadius:10,padding:'9px 13px',fontSize:15,fontWeight:600,color:'white',opacity}}><span style={{color:pink,marginRight:7}}>●</span>{text}</div>;
};
const Intro=()=> <><Camera poses={[{at:0,scale:2.1,x:110,y:172},{at:24,scale:2.1,x:110,y:172},{at:58,scale:1,x:201,y:437}]}><Photo name="edit-widget.png"/><Focus at={2} duration={48} x={26} y={91} width={164} height={164} radius={28}/></Camera><Badge text="Your work. Within reach." until={59}/></>;
const Create=()=>{
 const f=useCurrentFrame();
 return <><Camera poses={[{at:0,scale:1,x:201,y:437},{at:18,scale:1,x:201,y:437},{at:32,scale:1.4,x:174,y:357},{at:55,scale:1.4,x:174,y:357},{at:70,scale:1.12,x:201,y:393},{at:97,scale:1.12,x:201,y:393},{at:116,scale:1,x:201,y:437}]}>
 {f<18?<Clip name="new-create.mp4"/>:f<126?<>
  <Photo name="edit-create.png"/>
  <div style={{position:'absolute',left:30,top:352,width:343,height:40,background:'#2c2c2e'}}/>
  <div style={{position:'absolute',left:31,top:432,width:338,height:62,background:'#1c1c1e'}}/>
  <Typed text="Ship the next idea" at={29} duration={24} x={36} y={358} width={326}/>
  <Typed text="Review the sources and sketch a first prototype." at={58} duration={29} x={33} y={436} width={328}/>
  <Focus at={24} duration={37} x={16} y={301} width={370} height={97} radius={23}/>
  <Focus at={60} duration={38} x={16} y={415} width={370} height={119} radius={23}/>
 </>:f<168?<Sequence from={126} durationInFrames={42}><Clip name="new-create.mp4" start={6.25}/></Sequence>:<Photo name="edit-created.png"/>}
 <Tap at={2} x={82} y={118}/><Tap at={115} x={364} y={100}/>
 </Camera><Badge text="Shared Work items" at={133} until={179}/></>;
};
const Comment=()=>{
 const f=useCurrentFrame();
 return <><Camera poses={[{at:0,scale:1,x:201,y:437},{at:17,scale:1.15,x:183,y:386},{at:80,scale:1.15,x:183,y:386},{at:106,scale:1.12,x:183,y:297},{at:134,scale:1.12,x:183,y:297},{at:149,scale:1,x:201,y:437}]}>
 {f<85?<><Photo name="edit-comment-empty.png"/>
  <div style={{position:'absolute',left:35,top:408,width:331,height:56,background:'#000'}}/>
  <Typed text="Notes reviewed. Ready to build." at={21} duration={30} x={40} y={411} width={326}/>
  {f>=51&&<div style={{position:'absolute',left:324,top:334,width:50,height:50,borderRadius:'50%',background:'#ca0058',display:'flex',alignItems:'center',justifyContent:'center'}}><svg width="21" height="21" viewBox="0 0 24 24"><path d="M3 11 21 3 13 21 10 14 3 11Z M10 14 21 3" fill="none" stroke="white" strokeWidth="2" strokeLinejoin="round"/></svg></div>}
  <Focus at={14} duration={60} x={28} y={397} width={344} height={110} radius={15}/>
 </>:f<100?<Sequence from={85} durationInFrames={15}><Clip name="new-comment.mp4" start={3.5}/></Sequence>:<Photo name="edit-comment-posted.png"/>}
 <Tap at={8} x={114} y={425}/><Tap at={80} x={349} y={359}/>
 <Focus at={103} duration={43} x={16} y={330} width={370} height={96} radius={14}/>
 </Camera></>;
};
const Complete=()=>{
 const f=useCurrentFrame();
 return <><Camera poses={[{at:0,scale:1,x:201,y:437},{at:13,scale:1.13,x:185,y:222},{at:53,scale:1.13,x:185,y:222},{at:68,scale:1,x:201,y:437},{at:99,scale:1.16,x:183,y:390}]}>
 {f<14?<Photo name="edit-comment-posted.png"/>:f<60?<Sequence from={14} durationInFrames={46}><Clip name="new-close.mp4" start={0}/></Sequence>:f<96?<Sequence from={60} durationInFrames={36}><Clip name="new-close.mp4" start={4.75} rate={1.35}/></Sequence>:<Photo name="edit-closed-list.png"/>}
 <Tap at={9} x={294} y={84}/><Tap at={79} x={201} y={387}/>
 <Focus at={22} duration={32} x={157} y={160} width={63} height={22} radius={7}/>
 <Focus at={98} duration={21} x={16} y={420} width={370} height={50} radius={9}/>
 </Camera></>;
};
const Widget=()=>{
 const f=useCurrentFrame();
 return <><Camera poses={[{at:0,scale:1,x:201,y:437},{at:24,scale:2.1,x:110,y:172},{at:82,scale:2.1,x:110,y:172},{at:107,scale:1,x:201,y:437},{at:164,scale:1.1,x:185,y:266}]}>
 <Photo name="edit-widget.png"/>
 {f>=110&&<AbsoluteFill style={{opacity:mix(f,[110,119],[0,1]),transform:`translateY(${mix(f,[110,122],[16,0])}px)`}}><Photo name="edit-widget-opened.png"/></AbsoluteFill>}
 <Focus at={24} duration={43} x={26} y={91} width={164} height={164} radius={28}/>
 <Tap at={83} x={105} y={147}/>
 </Camera><Badge text="Home Screen widget" at={0} until={67}/>
 {f>172&&<div style={{position:'absolute',left:24,bottom:115,fontSize:17,color:'#ff3887',opacity:mix(f,[173,186],[0,1]),fontWeight:650}}>KinicWiki</div>}
 </>;
};
const EditedDemo=()=> <AbsoluteFill style={{background:'#000',fontFamily:'-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif'}}>
 <Audio src={staticFile('edit-soundtrack.wav')}/>
 <div style={{width:W,height:H,position:'absolute',transform:'scale(3)',transformOrigin:'0 0',overflow:'hidden',background:'#000'}}>
  <Sequence from={0} durationInFrames={60}><Intro/></Sequence>
  <Sequence from={60} durationInFrames={180}><Create/></Sequence>
  <Sequence from={240} durationInFrames={150}><Comment/></Sequence>
  <Sequence from={390} durationInFrames={120}><Complete/></Sequence>
  <Sequence from={510} durationInFrames={240}><Widget/></Sequence>
 </div>
 </AbsoluteFill>;
registerRoot(()=> <Composition id="KinicEditedDemo" component={EditedDemo} width={1206} height={2622} fps={30} durationInFrames={750}/>);
