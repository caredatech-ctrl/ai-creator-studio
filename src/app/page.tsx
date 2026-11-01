const modules = [
  ["01","Video Intake","Upload finished videos and validate format, duration, and size.","Upload video"],
  ["02","AI Analyzer","Extract scenes, speech, story structure, and audience signals.","Analyze content"],
  ["03","Trend Intelligence","Research relevant YouTube topics and audience interest.","Research trends"],
  ["04","SEO Studio","Generate editable titles, descriptions, tags, and hashtags.","Create metadata"],
  ["05","Publishing Queue","Review every detail and approve before official YouTube upload.","Review queue"],
  ["06","Performance","Track published video performance and recommendations.","View analytics"]
];
export default function Home() {
 return <main style={{maxWidth:1440,margin:"0 auto",padding:"42px 28px 80px"}}>
  <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:20,marginBottom:64}}>
   <div style={{display:"flex",alignItems:"center",gap:12}}><div style={{width:42,height:42,borderRadius:14,background:"linear-gradient(135deg,#8b5cf6,#22d3ee)",display:"grid",placeItems:"center",fontWeight:800}}>AI</div><div><div style={{fontWeight:700,fontSize:18}}>CREATOR STUDIO</div><div style={{fontSize:11,color:"#94a3b8",letterSpacing:2}}>VIDEO INTELLIGENCE WORKSPACE</div></div></div>
   <div style={{fontSize:12,color:"#94a3b8",border:"1px solid #263247",padding:"9px 14px",borderRadius:30}}>WORKSPACE · SETUP</div>
  </header>
  <section style={{maxWidth:850,marginBottom:52}}><div style={{color:"#36d9cf",fontSize:12,letterSpacing:3,fontWeight:700,marginBottom:18}}>YOUR CREATION COMMAND CENTER</div><h1 style={{fontFamily:"Space Grotesk",fontSize:"clamp(42px,7vw,76px)",lineHeight:1.02,letterSpacing:-3,margin:"0 0 22px"}}>Make every video<br/><span style={{background:"linear-gradient(90deg,#a78bfa,#36d9cf)",backgroundClip:"text",color:"transparent"}}>work smarter.</span></h1><p style={{fontSize:17,lineHeight:1.7,color:"#a6b2c5",maxWidth:680}}>Analyze your finished videos, discover relevant trends, craft stronger YouTube metadata, and publish only after your explicit approval.</p></section>
  <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(270px,1fr))",gap:16}}>{modules.map(([n,title,desc,action])=><article key={n} style={{background:"linear-gradient(145deg,#121c2c,#0c121e)",border:"1px solid #263247",borderRadius:20,padding:24,minHeight:210}}><div style={{color:"#36d9cf",fontSize:12,letterSpacing:2,marginBottom:22}}>MODULE {n}</div><h2 style={{fontFamily:"Space Grotesk",fontSize:22,margin:"0 0 10px"}}>{title}</h2><p style={{color:"#94a3b8",lineHeight:1.6,fontSize:14,minHeight:48}}>{desc}</p><div style={{color:"#a78bfa",fontSize:13,fontWeight:700,marginTop:20}}>{action} <span aria-hidden="true">↗</span></div></article>)}</section>
  <footer style={{marginTop:48,paddingTop:22,borderTop:"1px solid #202b3d",color:"#64748b",fontSize:12}}>AI Creator Studio · Publishing is approval-gated · Connect your services to activate workflows</footer>
 </main>;
}