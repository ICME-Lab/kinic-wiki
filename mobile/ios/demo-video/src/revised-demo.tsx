import React from 'react';
import {AbsoluteFill,Audio,Composition,Easing,Img,Sequence,interpolate,registerRoot,staticFile,useCurrentFrame} from 'remotion';
import timing from '../revised-timing.json';

const W=402,H=874,pink='#ff3887';
const cue=(index:number,sceneStart=0)=>timing.events[index].frame-sceneStart;
const ease=Easing.bezier(.22,.72,.2,1);
const mix=(f:number,points:number[],values:number[])=>interpolate(f,points,values,{easing:ease,extrapolateLeft:'clamp',extrapolateRight:'clamp'});
const Photo=({name,style={}}:{name:string;style?:React.CSSProperties})=><Img src={staticFile(`${name}.png`)} style={{position:'absolute',width:W,height:H,...style}}/>;
const Crop=({name,x,y,w,h,left=x,top=y,scale=1,radius=0}:{name:string;x:number;y:number;w:number;h:number;left?:number;top?:number;scale?:number;radius?:number})=><div style={{position:'absolute',left,top,width:w*scale,height:h*scale,overflow:'hidden',borderRadius:radius*scale}}><Photo name={name} style={{width:W*scale,height:H*scale,left:-x*scale,top:-y*scale}}/></div>;
const Camera=({zoom=1,children}:{zoom?:number;children:React.ReactNode})=><AbsoluteFill style={{transform:`scale(${zoom})`,transformOrigin:'50% 35%'}}>{children}</AbsoluteFill>;
const Tap=({at,x,y}:{at:number;x:number;y:number})=>{
 const f=useCurrentFrame()-at;if(f<0||f>8)return null;
 const r=interpolate(f,[0,8],[6,21]);
 return <div style={{position:'absolute',left:x-r,top:y-r,width:r*2,height:r*2,border:`1.5px solid ${pink}`,borderRadius:'50%',background:'#ff388725',opacity:1-f/8,boxShadow:'0 0 9px #ff388750'}}/>;
};
const Focus=({at,duration,x,y,w,h,radius=14}:{at:number;duration:number;x:number;y:number;w:number;h:number;radius?:number})=>{
 const f=useCurrentFrame()-at;if(f<0||f>duration)return null;
 return <div style={{position:'absolute',left:x,top:y,width:w,height:h,border:`1px solid ${pink}`,borderRadius:radius,boxShadow:'0 0 15px #ff388730',opacity:mix(f,[0,7,duration-7,duration],[0,.9,.9,0])}}/>;
};
const Typed=({text,at,duration,x,y,w}:{text:string;at:number;duration:number;x:number;y:number;w:number})=>{
 const f=useCurrentFrame();const n=Math.floor(interpolate(f,[at,at+duration],[0,text.length],{extrapolateLeft:'clamp',extrapolateRight:'clamp'}));
 return <div style={{position:'absolute',left:x,top:y,width:w,fontSize:17,lineHeight:1.35,letterSpacing:-.3,color:'#f5f5f7'}}>{text.slice(0,n)}{f>=at&&f<at+duration+8&&<span style={{display:'inline-block',width:1.5,height:19,background:pink,verticalAlign:'text-bottom',marginLeft:1,boxShadow:'0 0 6px #ff388755'}}/>}</div>;
};
const Caption=({number,kicker,text,at=0,until,top=648}:{number:string;kicker:string;text:string;at?:number;until:number;top?:number})=>{
 const f=useCurrentFrame();if(f<at||f>=until)return null;
 const a=mix(f,[at,at+9,until-7,until],[0,1,1,0]);
 return <div style={{position:'absolute',left:24,right:24,top,opacity:a,transform:`translateY(${mix(f,[at,at+12],[9,0])}px)`}}><div style={{color:pink,fontWeight:650,fontSize:11,letterSpacing:2,marginBottom:8}}>{number} / {kicker}</div><div style={{color:'white',fontSize:26,lineHeight:1.18,fontWeight:650,letterSpacing:-.7,textShadow:'0 2px 16px #000'}}>{text}</div></div>;
};
const Reveal=({name,at,duration=8}:{name:string;at:number;duration?:number})=>{
 const f=useCurrentFrame();if(f<at)return null;
 return <Photo name={name}/>;
};
const Hook=()=>{
 const f=useCurrentFrame();return <><Camera zoom={mix(f,[0,48],[1.045,1])}><Photo name="final-home"/><Focus at={8} duration={42} x={16} y={379} w={370} h={111}/></Camera><Caption number="1.0.5" kicker="NEW FEATURES" text="Shared Work items." until={59}/><Tap at={cue(0)} x={80} y={155}/></>;
};
const Create=()=>{
 const f=useCurrentFrame();return <>
 {f<115&&<><Photo name="final-create-empty" style={{filter:'blur(14px) brightness(.24)',transform:'scale(1.04)'}}/><AbsoluteFill style={{background:'linear-gradient(180deg,#0003,#08090ded 70%)'}}/>
 <Crop name={f<17?'final-create-empty':'final-create-filled'} x={0} y={62} w={402} h={70}/>
 <Caption number="01" kicker="CREATE" text="Give your team the context." top={190} until={106}/>
 <div style={{position:'absolute',left:16,top:290,width:370,height:339,overflow:'hidden',borderRadius:24,boxShadow:'0 12px 50px #0008',transform:`translateY(${mix(f,[0,12],[12,0])}px)`}}>
 <Photo name="final-compose-clean-empty" style={{left:-16,top:-184}}/>
 <div style={{position:'absolute',left:17,top:55,width:338,height:33,background:'#2c2c2e'}}/>
 <Typed text="Write launch notes" at={15} duration={23} x={20} y={61} w={330}/>
 <Typed text="Ship shared work, one step at a time." at={45} duration={35} x={17} y={138} w={333}/>
 </div>
 <Focus at={13} duration={32} x={16} y={290} w={370} h={98} radius={24}/>
 <Focus at={46} duration={43} x={16} y={404} w={370} h={225} radius={24}/>
 <Tap at={cue(1,60)} x={364} y={100}/>
 </>}
 <Reveal name="final-created" at={107}/>
 <Focus at={119} duration={35} x={16} y={379} w={370} h={51} radius={10}/>
 <Caption number="01" kicker="CREATE" text="Shared in Team Wiki." at={117} until={163}/>
 <Tap at={159} x={143} y={464}/>
 </>;
};
const Reply=()=>{
 const f=useCurrentFrame();return <><Camera zoom={mix(f,[0,15,148,183],[1,1.075,1.075,1])}>
 {f<103&&<><Photo name="final-discussion-before"/><div style={{position:'absolute',left:36,top:487,width:331,height:35,background:'#000'}}/>
 <Typed text="Reviewed. Ready to ship." at={24} duration={31} x={40} y={493} w={326}/>
 {f>=25&&<Crop name="final-reply-filled" x={324} y={416} w={50} h={50} radius={25}/>}
 <Focus at={6} duration={35} x={16} y={297} w={370} h={95}/>
 <Focus at={42} duration={45} x={28} y={478} w={346} h={110}/>
 </>}
 <Reveal name="final-discussion-after" at={95}/>
 <Focus at={108} duration={64} x={16} y={404} w={370} h={96}/>
 <Tap at={cue(2,225)} x={349} y={441}/>
 </Camera><Caption number="02" kicker="DISCUSS" text="Reply to your team." at={0} until={94} top={655}/></>;
};
const Widget=()=>{
 const f=useCurrentFrame();const zoom=mix(f,[0,30,47],[1,1,1.4]);
 return <>
 {f<78?<>
  <AbsoluteFill style={{transform:`scale(${zoom})`,transformOrigin:'0 0'}}>
   <Photo name="final-widget"/>
   <Focus at={35} duration={31} x={26} y={90} w={164} h={164} radius={32}/>
   <Tap at={cue(3,420)} x={108} y={143}/>
  </AbsoluteFill>
  <div style={{position:'absolute',left:16,right:16,top:728,height:84,borderRadius:16,background:'#08090dea',opacity:mix(f,[0,8,65,73],[0,1,1,0])}}/>
  <Caption number="03" kicker="HOME SCREEN WIDGET" text="Tap to open your item." at={0} until={73} top={741}/>
 </>:<Photo name="final-widget-opened"/>}
 <Focus at={91} duration={46} x={16} y={191} w={370} h={95}/>
 <Caption number="KINICWIKI" kicker="1.0.5" text="Back to the work." at={95} until={164}/>
 </>;
};
const FinalDemo=()=> <AbsoluteFill style={{background:'#08090d',fontFamily:'-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif'}}><Audio src={staticFile('revised-soundtrack.wav')}/><div style={{width:W,height:H,position:'absolute',transform:'scale(3)',transformOrigin:'0 0',overflow:'hidden'}}>
 <Sequence from={0} durationInFrames={60}><Hook/></Sequence>
 <Sequence from={60} durationInFrames={165}><Create/></Sequence>
 <Sequence from={225} durationInFrames={195}><Reply/></Sequence>
 <Sequence from={420} durationInFrames={165}><Widget/></Sequence>
 </div></AbsoluteFill>;
registerRoot(()=> <Composition id="KinicRevisedDemo" component={FinalDemo} width={1206} height={2622} fps={timing.fps} durationInFrames={timing.frames}/>);
