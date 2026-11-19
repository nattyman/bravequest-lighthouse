/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — cliffs.js  (cliff skin)
   A separate, denser, visual-only mesh over the headland's rock faces
   (the three sea cliffs and the west escarpment either side of the cliff
   path): stepped bedding with ledges and notches, blocky joints, vertical
   clefts and chimneys, buttresses, a proud and broken lip. Flat facets so
   the cel ramp picks each one out; strata, cavity shading, moss and the
   wet foot are baked into vertex colours.
   Nothing here touches the ground the game walks on: W.height/walkable
   are only read. The terrain mesh tucks its own faces back behind the
   skin through G.cliffs.pushAt (called from world.js's buildTerrain).
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U, W=G.world;
const {clamp,lerp,smooth,vnoise}=U;
const PI=Math.PI, TAU=PI*2, TOP=42, col=U.col;
const hash=(a,b)=>{const s=Math.sin(a*127.1+b*311.7)*43758.5453; return s-Math.floor(s);};

/* ---------------- columns: lines running outward from just inside the plateau rim ----------------
   The rim is the rounded box plateauSD is built on (inner half extents 32 x 30 about x=166, corner radius ~17 at the edge). */
const CX=166, HX=32, HZ=30, RHO=17, BACK=5;
const SX=2*HX, SZ=2*HZ, QA=PI/2*RHO, PER=2*SX+2*SZ+4*QA;
function rim(m,o){ // m: metres along the rim (clockwise seen from above, starting on the east side at its north end)
  let s=((m%PER)+PER)%PER, a;
  if(s<SZ){o.x=CX+HX+RHO;o.z=-HZ+s;o.nx=1;o.nz=0;return o;} s-=SZ;
  if(s<QA){a=s/RHO; o.nx=Math.cos(a);o.nz=Math.sin(a);o.x=CX+HX+o.nx*RHO;o.z=HZ+o.nz*RHO;return o;} s-=QA;
  if(s<SX){o.x=CX+HX-s;o.z=HZ+RHO;o.nx=0;o.nz=1;return o;} s-=SX;
  if(s<QA){a=PI/2+s/RHO; o.nx=Math.cos(a);o.nz=Math.sin(a);o.x=CX-HX+o.nx*RHO;o.z=HZ+o.nz*RHO;return o;} s-=QA;
  if(s<SZ){o.x=CX-HX-RHO;o.z=HZ-s;o.nx=-1;o.nz=0;return o;} s-=SZ;
  if(s<QA){a=PI+s/RHO; o.nx=Math.cos(a);o.nz=Math.sin(a);o.x=CX-HX+o.nx*RHO;o.z=-HZ+o.nz*RHO;return o;} s-=QA;
  if(s<SX){o.x=CX-HX+s;o.z=-HZ-RHO;o.nx=0;o.nz=-1;return o;} s-=SX;
  a=1.5*PI+s/RHO; o.nx=Math.cos(a);o.nz=Math.sin(a);o.x=CX+HX+o.nx*RHO;o.z=-HZ+o.nz*RHO;return o;
}
const GY=(x,z)=>(W.groundY||W.height)(x,z);   // the ground as the terrain mesh draws it
const RC=()=>W.ramp?W.ramp.hw+W.ramp.bank:5;
const DS=.25, DMAX=34;
/** profile of one column: lip (where the plateau ends), foot (where the face stops falling), and the outermost
    distance at which the ground still reaches a height (dAt) — so the skin always sits on or proud of the rock */
function column(m){
  const c=rim(m,{}), ox=c.x-c.nx*BACK, oz=c.z-c.nz*BACK, n=Math.round(DMAX/DS)+1, h=new Float32Array(n), rc=RC()+.6;
  for(let i=0;i<n;i++)h[i]=GY(ox+c.nx*i*DS,oz+c.nz*i*DS);
  let lip=-1; for(let i=0;i<n;i++)if(h[i]<41.95){lip=i;break;}
  const C={m,x:c.x,z:c.z,nx:c.nx,nz:c.nz,ox,oz,ok:lip>0};
  if(lip<=0)return C;
  let foot=n-1, mn=h[lip], mi=lip;
  for(let i=lip+1;i<n-4;i++){ const d=i*DS, x=ox+c.nx*d, z=oz+c.nz*d;
    if(h[i]<mn){mn=h[i];mi=i;}
    if(h[i]<-3.5){foot=i;break;}
    const onRamp=W.rampDist&&x<146&&W.rampDist(x,z)<rc;
    if(onRamp)continue;
    if(h[i]>mn+.35){foot=mi;break;}
    if(d-lip*DS>2&&h[i]<40&&h[i]-h[i+4]<.15){foot=i;break;} }
  const env=new Float32Array(foot+1); let mx=-1e9; for(let i=foot;i>=0;i--){mx=Math.max(mx,h[i]);env[i]=mx;}
  C.lip=lip*DS; C.foot=foot*DS; C.yFoot=env[foot]; C.env=env; C.sea=C.yFoot<.6;
  return C;
}
/** outermost distance along the column at which the ground stands at height y */
function dAt(C,y){
  const e=C.env, n=e.length; if(y>=e[0])return 0; if(y<=e[n-1])return (n-1)*DS;
  let lo=0,hi=n-1; while(hi-lo>1){const md=(lo+hi)>>1; if(e[md]>=y)lo=md; else hi=md;}
  const a=e[lo],b=e[hi]; return (lo+(a-y)/Math.max(1e-4,a-b))*DS;
}

/* ---------------- places the skin keeps off (gathered once, so the terrain and the skin agree) ---------------- */
let KEEP=null;
function keeps(){
  if(KEEP)return KEEP; KEEP=[];
  const L=W.landmarks||{};
  if(L.caveMouth)KEEP.push({x:L.caveMouth.x,y:L.caveMouth.y+3,z:L.caveMouth.z,r:6.5,ry:7.5});   // the sea cave's arch
  else KEEP.push({x:181.2,y:3,z:52,r:6.5,ry:7.5});
  try{ for(const s of (G.companions&&G.companions.spots)||[]) if(s.at&&s.at.x>100&&s.at.y>-5&&s.at.y<45&&Math.abs(s.at.z)<70)KEEP.push({x:s.at.x,y:s.at.y,z:s.at.z,r:3.4,ry:3}); }catch(e){}
  KEEP.push({x:112.8,y:36,z:-6,r:2.8,ry:5});   // the perch rock jutting beside the path's northward run (progression.js)
  try{ for(const o of G.interact.list){ const q=typeof o.pos==='function'?o.pos():o.pos; if(q&&q.x>100&&q.x<235&&Math.abs(q.z)<70&&q.y<41)KEEP.push({x:q.x,y:q.y,z:q.z,r:3,ry:3}); } }catch(e){}
  return KEEP;
}
/** 0 inside the cliff path's corridor and round the kept places, 1 clear of them */
function eXZ(x,z){ let e=1; if(x<146&&z>-46&&z<36&&W.rampDist){const d=W.rampDist(x,z),rc=RC(); e*=smooth(rc+.1,rc+.9,d);} return e; }
function e3(x,y,z){ let e=1; for(const k of keeps()){ const d=Math.hypot(x-k.x,z-k.z,(y-k.y)*k.r/k.ry); if(d<k.r+2.2)e*=smooth(k.r,k.r+2.2,d); } return e; }
const topFade=y=>smooth(41.9,40.4,y);
const botFade=(y,f,sea)=>sea?1:smooth(f+.15,f+1.6,y);
const PUSH=1.8;

/* ---------------- the face map: which terrain vertices sit on a skinned face (1 m grid, built once) ---------------- */
const MX0=92,MZ0=-74,MNX=148,MNZ=149;
let MAP=null;
function buildMap(){
  MAP={n:new Float32Array(MNX*MNZ*2),f:new Float32Array(MNX*MNZ).fill(-99),s:new Uint8Array(MNX*MNZ)};
  const step=.45, nc=Math.ceil(PER/step);
  for(let k=0;k<nc;k++){ const C=column(k*PER/nc); if(!C.ok)continue;
    for(let d=C.lip-.25;d<=C.foot-.3;d+=.3){ const x=C.ox+C.nx*d, z=C.oz+C.nz*d, i=Math.round(x)-MX0, j=Math.round(z)-MZ0;
      if(i<0||j<0||i>=MNX||j>=MNZ)continue; const a=j*MNX+i;
      MAP.n[a*2]+=C.nx; MAP.n[a*2+1]+=C.nz; MAP.f[a]=Math.max(MAP.f[a],C.yFoot); MAP.s[a]=MAP.s[a]|(C.sea?2:1); } }
}
const _pv={x:0,z:0};
/** how far (m) the terrain vertex at integer (x,z) with height h tucks back under the skin; out gets the shift */
function pushAt(x,z,h,out){
  out=out||_pv; out.x=out.z=0;
  if(h>=41.95)return 0; if(!MAP)buildMap();
  const i=Math.round(x)-MX0, j=Math.round(z)-MZ0; if(i<0||j<0||i>=MNX||j>=MNZ)return 0;
  const a=j*MNX+i; if(!MAP.s[a])return 0;
  const sea=MAP.s[a]===2, w=eXZ(x,z)*e3(x,h,z)*topFade(h)*botFade(h,MAP.f[a],sea); if(w<=.001)return 0;
  const nx=MAP.n[a*2], nz=MAP.n[a*2+1], l=Math.hypot(nx,nz)||1, d=PUSH*w;
  out.x=-nx/l*d; out.z=-nz/l*d; return d;
}
/** how much the spot is skinned cliff face, 0..1 (others use it to avoid or attach to the faces) */
function faceAt(x,z){
  if(!MAP)buildMap();
  const fx=x-MX0, fz=z-MZ0; if(fx<0||fz<0||fx>=MNX-1||fz>=MNZ-1)return 0;
  const i=fx|0,j=fz|0,u=fx-i,v=fz-j,a=j*MNX+i, s=k=>MAP.s[k]?1:0;
  return ((s(a)*(1-u)+s(a+1)*u)*(1-v)+(s(a+MNX)*(1-u)+s(a+MNX+1)*u)*v)*eXZ(x,z);
}

/* ---------------- the rock's structure, shared by every quality level ----------------
   Along the rim the face is cut into joint-bounded pillars (some recessed into chimneys); up the face a handful of
   tilted bedding planes make ledges, each with a notch under the bed above. Every pillar stands a little prouder or
   more set back in each bed, so ledges come and go, some beds overhang, and pillars that stop short break the lip. */
const LEDGES=(()=>{ const r=U.rng(4207), L=[]; let y=1.5+r()*2; while(y<38.5){ L.push(y); y+=3.1+r()*3.6; } if(L[L.length-1]<37)L.push(38+r()*.8); return L; })();
const NSEG=LEDGES.length+1;
const dip=m=>2.2*Math.sin(m*.017+1.2)+1.6*(vnoise(m*.04+5,2.2)-.5)*2;
const PIL=(()=>{ const r=U.rng(5309), p=[]; let m=0;
  while(m<PER){ const ch=r()<.09, w=ch?1.3+r()*1.4:1.4+r()*r()*7.5;
    p.push({m0:m,w,ch,P:ch?-.45-r()*.5:.1+r()*.95,jd:.18+r()*.4,v:r(),wob:r()*50,stop:r()<.3?NSEG-1-Math.floor(r()*2.6):99,seg:[],tl:[],sk:[],J:[],o:[],ge:[]}); m+=w; }
  const last=p[p.length-1]; last.w=PER-last.m0; if(last.w<1.2&&p.length>1){ p.pop(); p[p.length-1].w=PER-p[p.length-1].m0; }
  for(let i=0;i<p.length;i++){ const q=p[i]; let on=q.ch||r()<.55;
    for(let j=0;j<NSEG;j++){
      let v=q.P*(.5+.8*r()); if(j&&r()<.62)v=q.seg[j-1];               // most beds carry straight on: ledges come and go
      if(j===NSEG-1&&!q.ch)v+=.3+.5*r(); if(j>=q.stop)v=Math.min(v,.05);
      q.seg.push(v); q.tl.push((r()-.5)*.1); q.sk.push((r()-.5)*1.2);
      if(r()<.33)on=!on; q.J.push(q.ch||on||(j===NSEG-1&&r()<.6)); } }
  // where a joint is missing the pillar carries on its neighbour's rock: one face across the whole group
  for(let j=0;j<NSEG;j++){ for(let i=0;i<p.length;i++){ const q=p[i]; q.o[j]=(q.J[j]||i===0)?i:p[i-1].o[j]; }
    let o=0; for(let i=1;i<=p.length;i++){ if(i===p.length||p[i].o[j]===i){ p[o].ge[j]=i===p.length?PER:p[i].m0; o=i; } } }
  return p; })();
const segBase=j=>j?LEDGES[j-1]:0;
/** chipped facets: the highest of a few jittered pyramids around (m, y'), so the face breaks into planes with crisp creases */
function chisel(m,y){ const cm=4.4, cy=4.9, ci=Math.floor(m/cm), cj=Math.floor(y/cy); let v=-9;
  for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){ const a=ci+di, b=cj+dj, h1=hash(a,b), h2=hash(b+.37,a*1.3), h3=hash(a*.71+3,b*2.1);
    const dm=Math.abs(m-(a+.15+.7*h1)*cm), dy=Math.abs(y-(b+.15+.7*h2)*cy), q=h3*.7-(dm*(.2+.22*h2)+dy*(.16+.2*h1));
    if(q>v)v=q; }
  return v; }
/** the rock face (proud, in relief units) of pillar i's group in bed j at m: its bed value, a lean, a skew across */
function rockAt(i,j,m,yp){ const O=PIL[PIL[i].o[j]]; let t=(m-O.m0)/Math.max(.5,O.ge[j]-O.m0); if(t<-.5)t+=PER/Math.max(.5,O.ge[j]-O.m0);
  return O.seg[j]+O.tl[j]*(yp-segBase(j)-2)+O.sk[j]*(clamp(t,0,1)-.5); }
const pilAt=m=>{ m=((m%PER)+PER)%PER; let lo=0,hi=PIL.length-1; while(lo<hi){const md=(lo+hi+1)>>1; if(PIL[md].m0<=m)lo=md; else hi=md-1;} return lo; };
const zone=m=>.55+.65*smooth(.25,.7,vnoise(m*.021+11,3.3));   // stretches of bold and of quiet rock

/* ---------------- quality levels ---------------- */
const LOD={
  high:    {ds:1.15,dy:.9, edge:.32,led:[-.42,-.06,.06,.55]},
  balanced:{ds:1.6, dy:1.3,edge:0,  led:[-.42,-.06,.06,.55]},
  saver:   {ds:2.6, dy:2.2,edge:0,  led:[-.3,.06]}};

/* ---------------- palette (linear) ---------------- */
const ROCK=col('#5d6372'), ROCK2=col('#434957'), WARM=col('#6c665f'), PALE=col('#737886');
const MOSS=col('#3d5230'), MOSS2=col('#56693e'), TURF=col('#5c7550'), WET=col('#232b2f'), SALT=col('#b8b8b0');
const _c=new THREE.Color(), _d=new THREE.Color();

const API=G.cliffs={mesh:null,meshes:[],lip:[],foot:[],faceAt,pushAt,rebuild:()=>build(),stats:{tris:0,draws:0,ms:0,level:''},
  keeps:()=>keeps().slice(),columnAt:m=>column(m)};

function material(){
  if(G.cliffmat&&G.cliffmat.rock){ try{ return {m:G.cliffmat.rock({wet:true,moss:true,strata:true}),cm:true}; }catch(e){ console.error('cliffmat',e); } }
  return {m:G.toon('#ffffff',{vertexColors:true}),cm:false};
}
let MAT=null;

function build(){
  const t0=performance.now();
  if(!MAP)buildMap();
  const lv=LOD[G.quality&&G.quality.level]?G.quality.level:'balanced', Q=LOD[lv];
  // columns: one on every joint, one just inside each pillar edge (high), fill between
  const CM=[];
  for(let i=0;i<PIL.length;i++){ const q=PIL[i]; CM.push({m:q.m0,pi:i,k:0});
    const e=Q.edge&&q.w>1.6?Q.edge:0; if(e)CM.push({m:q.m0+e,pi:i,k:1,e:1});
    const a=q.m0+(e||0), b=q.m0+q.w-(e||0), n=Math.max(0,Math.ceil((b-a)/Q.ds)-1);
    for(let k=1;k<=n;k++)CM.push({m:a+(b-a)*k/(n+1),pi:i,k:2});
    if(e)CM.push({m:q.m0+q.w-e,pi:i,k:1,e:-1}); }
  CM.push({m:PER,pi:0,k:0});
  // rows in tilted height: the ledge rows round every bedding plane, fill between
  const RW=[]; const lo=-3.6, hi=43.5;
  const keyY=[]; for(let j=0;j<LEDGES.length;j++)for(const o of Q.led)keyY.push({y:LEDGES[j]+o,j,o});
  let yy=lo; for(const K of keyY){ const n=Math.max(0,Math.ceil((K.y-yy)/Q.dy)-1); for(let k=1;k<=n;k++)RW.push({y:yy+(K.y-yy)*k/(n+1),o:null}); RW.push({y:K.y,j:K.j,o:K.o}); yy=K.y; }
  { const n=Math.ceil((hi-yy)/Q.dy); for(let k=1;k<=n;k++)RW.push({y:yy+(hi-yy)*k/n,o:null}); }
  RW.unshift({y:lo,o:null});
  const NR=RW.length+1, NC=CM.length-1;
  const cols=CM.map(c=>column(c.m));
  const NV=(NC+1)*NR, P=new Float32Array(NV*3), RR=new Float32Array(NV), WV=new Float32Array(NV), Y=new Float32Array(NV), YP=new Float32Array(NV), TAG=new Uint8Array(NV), live=new Uint8Array(NV);
  for(let k=0;k<=NC;k++){ const C=cols[k], cm=CM[k], m=cm.m; if(!C.ok)continue;
    const dp=dip(m), sea=C.sea, amp=(sea?1.7:.8)*zone(m), cap0=sea?3.8:1.4, tx=-C.nz, tz=C.nx, yF=C.yFoot;
    const q=PIL[cm.pi], qp=PIL[(cm.pi+PIL.length-1)%PIL.length];
    const lo2=sea?-3.4:yF-.7; let r0=0,r1=NR-2; while(r0<NR-2&&RW[r0].y-dp<lo2)r0++; while(r1>r0&&RW[r1].y-dp>41.62)r1--;
    for(let r=r0;r<=r1;r++){ const v=k*NR+r, Rw=RW[r], yp=Rw.y, y=yp-dp;
      let j=0; while(j<LEDGES.length&&yp>LEDGES[j]+(Rw.o!=null&&Rw.j===j&&Rw.o<0?.01:-.0))j++;
      if(Rw.o!=null)j=Rw.o<0?Rw.j:Rw.j+1;
      const jj=Math.min(j,NSEG-1), ip=(cm.pi+PIL.length-1)%PIL.length;
      let p=rockAt(cm.pi,jj,m,yp), tag=0;
      if(cm.k===0&&q.J[jj]){ p=Math.min(p,rockAt(ip,jj,m-.01,yp))-q.jd; tag=1; }
      else if(cm.k===1&&((cm.e<0?PIL[(cm.pi+1)%PIL.length]:q).J[jj]))p-=.08;
      // the ledge itself: a rounded edge under the bedding plane, a notch cut in above it where the bed above stands back
      if(Rw.o!=null){ const lj=Rw.j, l2=Math.min(lj+1,NSEG-1), ledge=rockAt(cm.pi,lj,m,LEDGES[lj])-rockAt(cm.pi,l2,m,LEDGES[lj]);
        if(ledge>.18||hash(PIL[cm.pi].o[lj],lj*5.3)<.08){ if(Rw.o>-.1&&Rw.o<0)p-=.12; else if(Rw.o>0&&Rw.o<.1){ p-=.3+.35*hash(cm.pi,lj); tag|=2; } } }
      const d0=dAt(C,y), x0=C.ox+C.nx*d0, z0=C.oz+C.nz*d0;
      const w=eXZ(x0,z0)*e3(x0,y,z0)*botFade(y,yF,sea);
      // the escarpment stands its beds up straighter: each bed's face keeps the line of its foot
      let terr=0; if(!sea){ const yb=(j?LEDGES[j-1]:lo)-dp; terr=Math.min(1.1,.6*Math.max(0,dAt(C,Math.max(yb,yF))-d0)); }
      let R=p*amp+terr+(sea?1.2:.6)*(chisel(m,yp)+.45)+.22*(vnoise(m*.15,y*.13)-.5)+(sea?1.1*(vnoise(m*.036+2,1.1)-.5)*2*smooth(-1,5,y)*smooth(41.5,36,y):0);
      let cap=sea?.9+2.9*smooth(-.5,10,y):cap0;
      if(!sea&&z0>4&&z0<20&&x0<118)cap=Math.min(cap,.3);   // keep the air west of the high bend clear
      if(x0<146&&W.rampDist){ const dr=W.rampDist(x0,z0); if(dr<9)cap=Math.min(cap,.15+.35*Math.max(0,dr-RC())); }   // low beside the path
      R=clamp(lerp(R,(sea?.2:0)+.9*hash(PIL[cm.pi].o[NSEG-1],7.7)+.35*(chisel(m*1.7,y)+.45),smooth(40.3,41.6,y)*.75),-1.2,cap);   // a broken, uneven rim of rock
      const fl=lerp(-.35,.3-PUSH*w*topFade(y),smooth(.3,.7,w));
      R=Math.max(lerp(-.35,R,w),fl);
      const jw=cm.k<2?PIL[cm.e<0?(cm.pi+1)%PIL.length:cm.pi].wob:0, jt=cm.k<2?(vnoise(yp*.33,jw)-.5)*.6:(hash(k,r)-.5)*.12*Q.ds, jy=0;
      const d=d0+R;
      P[v*3]=C.ox+C.nx*d+tx*jt; P[v*3+1]=Math.min(41.62,y+jy); P[v*3+2]=C.oz+C.nz*d+tz*jt;
      RR[v]=R; WV[v]=w; Y[v]=y; YP[v]=yp; TAG[v]=tag; live[v]=1; }
    { const v=k*NR+NR-1, d=Math.max(0,C.lip-.45);   // tuck under the plateau edge
      P[v*3]=C.ox+C.nx*d; P[v*3+1]=41.97; P[v*3+2]=C.oz+C.nz*d; RR[v]=-.45; WV[v]=eXZ(C.ox+C.nx*C.lip,C.oz+C.nz*C.lip); Y[v]=41.97; YP[v]=41.97+dp; live[v]=1; }
    // rows below the foot or above the rim collapse onto the last real one (their triangles vanish)
    const cp=(r,s)=>{ const v=k*NR+r,u=k*NR+s; P[v*3]=P[u*3];P[v*3+1]=P[u*3+1];P[v*3+2]=P[u*3+2]; RR[v]=RR[u];WV[v]=WV[u];Y[v]=Y[u];YP[v]=YP[u];TAG[v]=TAG[u];live[v]=1; };
    for(let r=0;r<r0;r++)cp(r,r0); for(let r=r1+1;r<NR-1;r++)cp(r,r1);
  }
  // grid normals (for moss and shading)
  const NN=new Float32Array(NV*3), e1=new THREE.Vector3(), e2=new THREE.Vector3(), nn=new THREE.Vector3();
  for(let k=0;k<=NC;k++)for(let r=0;r<NR;r++){ const v=k*NR+r; if(!live[v])continue;
    const ka=Math.max(0,k-1),kb=Math.min(NC,k+1); let ra=r-1,rb=r+1;
    while(ra>0&&Math.abs(Y[k*NR+ra]-Y[v])<.01)ra--; while(rb<NR-1&&Math.abs(Y[k*NR+rb]-Y[v])<.01)rb++; ra=Math.max(0,ra); rb=Math.min(NR-1,rb);
    const a=ka*NR+r,b=kb*NR+r,c=k*NR+ra,d=k*NR+rb; if(!live[a]||!live[b]){NN[v*3+1]=0;continue;}
    e1.set(P[b*3]-P[a*3],P[b*3+1]-P[a*3+1],P[b*3+2]-P[a*3+2]); e2.set(P[d*3]-P[c*3],P[d*3+1]-P[c*3+1],P[d*3+2]-P[c*3+2]);
    nn.crossVectors(e2,e1); if(nn.lengthSq()<1e-8)nn.set(cols[k].nx,0,cols[k].nz); nn.normalize();
    NN[v*3]=nn.x;NN[v*3+1]=nn.y;NN[v*3+2]=nn.z; }
  if(!MAT)MAT=material(); const cmat=MAT.cm;
  const CLR=new Float32Array(NV*3);
  for(let k=0;k<=NC;k++){ const C=cols[k], cm=CM[k], m=cm.m; if(!C.ok)continue; const q=PIL[cm.pi];
    for(let r=0;r<NR;r++){ const v=k*NR+r, y=Y[v], yp=YP[v], ny=NN[v*3+1];
      // a ledge's top: the surface just above this vertex steps back
      let up=0; if(r<NR-1){ const u=v+1; const dy=Y[u]-y; if(dy>.02)up=clamp((RR[v]-RR[u])/dy,0,4); }
      let av=0,an=0; for(const [dk,dr] of [[-1,0],[1,0],[0,-1],[0,1]]){ const kk=k+dk, rr=r+dr; if(kk<0||kk>NC||rr<0||rr>=NR)continue; const u=kk*NR+rr; if(!live[u])continue; av+=RR[u]; an++; }
      const cav=an?clamp((RR[v]-av/an)*.5,-.32,.1):0;
      let ao=1+cav; if(TAG[v]&1)ao*=.74; if(TAG[v]&2)ao*=.72; if(ny<-.3)ao*=.94; ao=clamp(ao,.45,1.12);
      const band=smooth(.42,.58,vnoise(yp*.62+m*.004,1.7)), band2=smooth(.5,.6,vnoise(yp*2.1,m*.01+8));
      if(cmat){ const a=clamp(lerp(1,ao,.8)*(.92+.1*q.v)*(.95+.07*band),.55,1.06); _c.setRGB(a,a,a); }
      else{
        _c.copy(ROCK).lerp(ROCK2,band*.32).lerp(PALE,band2*.22*(1-band)).lerp(WARM,smooth(.66,.82,vnoise(m*.03+2,yp*.05))*.3);
        _c.multiplyScalar((.95+.08*q.v)*(.94+.12*vnoise(m*.35,y*.3)));
        _c.multiplyScalar(ao);
        const mk=Math.max(smooth(.25,.62,ny),smooth(.5,2,up)*.95)*(C.sea?lerp(.45,1,smooth(6,30,y)):1)*(.6+.4*vnoise(m*.23,y*.31+4));
        if(mk>0){ _d.copy(MOSS).lerp(MOSS2,vnoise(m*.5,y*.5)); _c.lerp(_d,mk*.9); }
        if(y>40.7&&ny>.15)_c.lerp(TURF,smooth(40.7,41.6,y)*.75);
        if(C.sea&&y>5&&ny<.4&&!(TAG[v]&2)){ const st=smooth(.7,.84,vnoise(m*1.7,9.3+cm.pi))*(.5+.5*vnoise(m*.6,y*.5)); _c.lerp(SALT,st*.14); }
        if(C.sea&&y<2.2)_c.lerp(WET,smooth(2.2,-.6,y)*.72);
      }
      CLR[v*3]=_c.r;CLR[v*3+1]=_c.g;CLR[v*3+2]=_c.b; } }
  // triangles (one indexed mesh per half of the rim; smooth normals, so the cel bands follow the rock's planes)
  const halves=[[0,Math.floor(NC/2)],[Math.floor(NC/2),NC]], geos=[]; let tris=0;
  const A=new THREE.Vector3(),Bv=new THREE.Vector3(),Cv=new THREE.Vector3();
  for(const [k0,k1] of halves){
    const nv=(k1-k0+1)*NR, map=new Int32Array(nv).fill(-1), pos=[], cl=[], idx=[];
    const vid=q=>{ const l=q-k0*NR; if(map[l]<0){ map[l]=pos.length/3; pos.push(P[q*3],P[q*3+1],P[q*3+2]); cl.push(CLR[q*3],CLR[q*3+1],CLR[q*3+2]); } return map[l]; };
    const tri=(a,b,c)=>{ if(WV[a]<.02||WV[b]<.02||WV[c]<.02)return;
      A.set(P[a*3],P[a*3+1],P[a*3+2]); Bv.set(P[b*3],P[b*3+1],P[b*3+2]); Cv.set(P[c*3],P[c*3+1],P[c*3+2]);
      if(A.distanceToSquared(Bv)>36||A.distanceToSquared(Cv)>36||Bv.distanceToSquared(Cv)>36)return;
      e1.subVectors(Bv,A); e2.subVectors(Cv,A); nn.crossVectors(e1,e2); if(nn.lengthSq()<1e-8)return;
      idx.push(vid(a),vid(b),vid(c)); };
    for(let k=k0;k<k1;k++){ if(!cols[k].ok||!cols[k+1].ok)continue;
      for(let r=0;r<NR-1;r++){ const a=k*NR+r,b=(k+1)*NR+r,c=k*NR+r+1,d=(k+1)*NR+r+1;
        const dAD=(P[a*3]-P[d*3])**2+(P[a*3+1]-P[d*3+1])**2+(P[a*3+2]-P[d*3+2])**2, dBC=(P[b*3]-P[c*3])**2+(P[b*3+1]-P[c*3+1])**2+(P[b*3+2]-P[c*3+2])**2;
        if(dAD<dBC){ tri(a,d,b); tri(a,c,d); } else { tri(a,c,b); tri(b,c,d); } } }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setAttribute('color',new THREE.Float32BufferAttribute(cl,3));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere(); geos.push(g); tris+=idx.length/3; }
  for(const o of API.meshes){ if(o.parent)o.parent.remove(o); o.geometry.dispose(); }
  API.meshes=geos.map((g,i)=>{ const o=new THREE.Mesh(g,MAT.m); o.name=i?'cliffSkin2':'cliffSkin'; o.receiveShadow=true; o.castShadow=false;
    o.raycast=()=>{}; o.matrixAutoUpdate=false; o.updateMatrix(); G.scene.add(o); return o; });
  API.mesh=API.meshes[0];
  // the rim and foot lines others hang things from (every ~2 m; none inside the cliff path's corridor)
  if(!API.lip.length){ const n=Math.round(PER/2);
    for(let k=0;k<n;k++){ const C=column(k*PER/n); if(!C.ok)continue; const lx=C.ox+C.nx*C.lip, lz=C.oz+C.nz*C.lip; const w=eXZ(lx,lz); if(w<.5)continue;
      API.lip.push({x:lx,y:GY(lx,lz),z:lz,nx:C.nx,nz:C.nz,m:k*2,w});
      const yb=C.sea?Math.max(C.yFoot,0):C.yFoot, d=dAt(C,yb+.05); API.foot.push({x:C.ox+C.nx*d,y:yb,z:C.oz+C.nz*d,nx:C.nx,nz:C.nz,sea:C.sea,m:k*2}); } }
  API.stats={tris,draws:API.meshes.length,ms:Math.round(performance.now()-t0),level:lv,rows:NR,cols:NC+1};
  if(G.debug)console.log('[cliffs] built',JSON.stringify(API.stats));
}

G.system('cliffs',{order:1,modes:'always',init(){ try{ build(); }catch(e){ console.error('cliffs',e); } }});
G.on('quality',()=>{ if(API.meshes.length&&API.stats.level!==G.quality.level){ try{ build(); }catch(e){ console.error('cliffs',e); } } });
})();
