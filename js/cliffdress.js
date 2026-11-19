/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — cliffdress.js
   The last touches on the headland cliffs (visual only, nothing here touches the ground the game walks on):
   - foam: one strip of broken surf hugging the waterline round the headland's sea feet, the rock pieces standing in
     the water and the offshore stacks. It sits on the sea's own swell and tide, flat-toned and soft, and draws back
     off the low-tide sand bar under the south cliff while that is dry.
   - lip grass: tufts along the plateau edge and a ragged fringe of turf hanging over it, tinted from the turf beside
     it and swaying with the same gentle wind as the moor grass.
   API: G.cliffdress = { foam, lipGrass, stats:{tris,draws,ms,level,foam:{tris},grass:{tris}}, rebuild() }
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U, W=G.world;
const {clamp,lerp,smooth,vnoise}=U;
const PI=Math.PI, TAU=PI*2, TOP=42, CX=166, CZ=0;
const D=G.cliffdress={foam:null,lipGrass:null,stats:{tris:0,draws:0,ms:0,level:'',foam:{tris:0},grass:{tris:0}},rebuild:()=>build(),debug:{}};
const gh=(x,z)=>(W.groundY||W.height)(x,z);
/* per quality: foam ring segments and rows; tufts per lip point and fringe columns per lip segment */
const Q={high:{ring:48,rows:4,tufts:4,fringe:4},balanced:{ring:40,rows:3,tufts:3,fringe:3},saver:{ring:28,rows:2,tufts:1,fringe:2}};
const UNI={uTime:{value:0},uTide:{value:0},uLight:{value:1},uBar:{value:0}};

/* ---------------- where rock meets water: points on the y=yc contour of a set of meshes ---------------- */
const _a=new THREE.Vector3(), _b=new THREE.Vector3(), _c=new THREE.Vector3(), _m=new THREE.Matrix4(), _w=new THREE.Matrix4();
function contour(geo,mat,yc,out,i0,i1){
  const P=geo.attributes.position, I=geo.index, n=I?I.count:P.count; i0=i0||0; i1=Math.min(n,i1==null?n:i1);
  const get=(k,v)=>v.fromBufferAttribute(P,I?I.getX(k):k).applyMatrix4(mat);
  const edge=(p,q)=>{ if((p.y-yc)*(q.y-yc)>=0)return; const t=(yc-p.y)/(q.y-p.y); out.push(p.x+(q.x-p.x)*t,p.z+(q.z-p.z)*t); };
  for(let k=i0;k+2<i1;k+=3){ get(k,_a); get(k+1,_b); get(k+2,_c);
    const lo=Math.min(_a.y,_b.y,_c.y), hi=Math.max(_a.y,_b.y,_c.y); if(lo>yc||hi<yc)continue;
    edge(_a,_b); edge(_b,_c); edge(_c,_a); }
}
function meshContour(o,yc,out){
  o.updateMatrixWorld(true);
  if(o.isInstancedMesh){ for(let i=0;i<o.count;i++){ o.getMatrixAt(i,_m); _w.multiplyMatrices(o.matrixWorld,_m); contour(o.geometry,_w,yc,out); } return; }
  const g=o.geometry, r=g.drawRange; contour(g,o.matrixWorld,yc,out,r.start,r.start+(isFinite(r.count)?r.count:1e9));
}
function findMesh(name){ let m=null; G.scene.traverse(o=>{ if(!m&&o.name===name)m=o; }); return m; }

/* ---------------- foam ---------------- */
function foamMaterial(){
  return new THREE.ShaderMaterial({uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{uFoam:{value:U.col('#a9a7b2')}}]),
    transparent:true,depthWrite:false,fog:true,side:THREE.DoubleSide,
    vertexShader:`uniform float uTime,uTide;attribute vec3 fa;varying vec3 vF;varying vec2 vP;
#include <fog_pars_vertex>
float sw(vec2 p){ return sin(p.x*.075+uTime*.7)*.32+sin(p.y*.11+uTime*.55)*.24+sin((p.x-p.y)*.19+uTime*1.25)*.09; }
float seaY(vec2 p){ // the sea's swell as its 13 m grid draws it (linear across each triangle)
  vec2 g=p/13., c=floor(g), f=g-c; vec2 a=c*13., b=a+vec2(0.,13.), cc=a+vec2(13.,13.), d=a+vec2(13.,0.);
  if(f.x+f.y<1.)return sw(a)+f.x*(sw(d)-sw(a))+f.y*(sw(b)-sw(a));
  return sw(cc)+(1.-f.x)*(sw(b)-sw(cc))+(1.-f.y)*(sw(d)-sw(cc)); }
void main(){ vec3 p=position; p.y=uTide+seaY(p.xz)+.07+fa.x*.02; vF=fa; vP=p.xz;
  vec4 mvPosition=viewMatrix*vec4(p,1.); gl_Position=projectionMatrix*mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader:`uniform float uTime,uLight,uBar;uniform vec3 uFoam;varying vec3 vF;varying vec2 vP;
#include <fog_pars_fragment>
float h2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=p-i; f=f*f*(3.-2.*f);
  return mix(mix(h2(i),h2(i+vec2(1,0)),f.x),mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x),f.y); }
void main(){
  float f=vF.x, s=vF.y;                        // f: 0 at the rock .. 1 at the outer edge; s: metres along the strip
  float n1=vn(vec2(s*.33,uTime*.18)), n2=vn(vP*.7+vec2(uTime*.11,-uTime*.07))*.65+vn(vP*1.9-vec2(uTime*.05,0.))*.35;
  float edge=.34+.3*n1+.08*sin(uTime*.9+s*.21);                    // the clinging band breathes in and out
  float band=1.-smoothstep(edge-.06,edge+.02,f);
  float ph=fract(uTime*.13+n1*.6+s*.013), line=(1.-smoothstep(.0,.07,abs(f-mix(.25,.95,ph))))*(1.-ph)*step(.42,n2); // a line of surf drifting out
  float a=max(band*step(.4,n2+.3*(1.-f)-.1*f),line*.8);
  a*=smoothstep(.0,.06,f+.03)*(1.-smoothstep(.86,1.,f));
  a=a>.6?.82:(a>.2?.5:0.);                    // flat steps, like the cel shading
  a*=1.-vF.z*uBar;
  if(a<.01)discard;
  gl_FragColor=vec4(uFoam*uLight,a);
  #include <fog_fragment>
}`});
}
function buildFoam(level){
  const q=Q[level]||Q.balanced, rows=q.rows, pos=[], fa=[], idx=[];
  const yc=-.45;
  /* the headland: walk the sea feet and push each one out to the rock's real waterline (skin and kit pieces) */
  const pts=[];
  for(const o of (G.cliffs&&G.cliffs.meshes)||[])meshContour(o,yc,pts);
  if(G.cliffkit&&G.cliffkit.group)for(const o of G.cliffkit.group.children)if(o.visible&&o.name!=='cliffkit:sea')meshContour(o,yc,pts);
  const HS=3, hash=new Map(); for(let i=0;i<pts.length;i+=2){ const k=Math.floor(pts[i]/HS)+','+Math.floor(pts[i+1]/HS); let a=hash.get(k); if(!a)hash.set(k,a=[]); a.push(pts[i],pts[i+1]); }
  const bar=G.cave&&G.cave._debug&&G.cave._debug.cwDist;
  const barM=(x,z)=>{ try{ return bar&&x>90&&x<192&&z>46&&z<64?1-smooth(2.5,5,bar(x,z)):0; }catch(e){ return 0; } };
  const strip=(L,closed,wf)=>{ wf=wf||1; // L: [{x,z,nx,nz}], closed ring or open run; builds rows across the strip
    const n=L.length; if(n<2)return; const v0=pos.length/3; let s=0;
    for(let i=0;i<n;i++){ const p=L[i]; if(i)s+=Math.hypot(p.x-L[i-1].x,p.z-L[i-1].z);
      const w=(1.5+1.9*vnoise(p.x*.13+3,p.z*.13))*wf, m=barM(p.x,p.z);
      for(let r=0;r<=rows;r++){ const f=r/rows, d=lerp(-.8,w,f); pos.push(p.x+p.nx*d,0,p.z+p.nz*d); fa.push(f,s,m); } }
    const R=rows+1, segs=closed?n:n-1;
    for(let i=0;i<segs;i++){ const a=v0+i*R, b=v0+((i+1)%n)*R; for(let r=0;r<rows;r++)idx.push(a+r,a+r+1,b+r,b+r,a+r+1,b+r+1); } };
  const feet=((G.cliffs&&G.cliffs.foot)||[]).filter(f=>f.sea);
  let run=[];
  const flush=()=>{ if(run.length>2){ for(let k=0;k<2;k++)for(let i=1;i<run.length-1;i++)run[i].o=(run[i-1].o+run[i].o*2+run[i+1].o)/4;
      strip(run.map(p=>({x:p.x+p.nx*p.o,z:p.z+p.nz*p.o,nx:p.nx,nz:p.nz})),false); } run=[]; };
  for(const f of feet){
    let o=0; const cx=Math.floor(f.x/HS), cz=Math.floor(f.z/HS);
    for(let i=-3;i<=3;i++)for(let j=-3;j<=3;j++){ const a=hash.get((cx+i)+','+(cz+j)); if(!a)continue;
      for(let k=0;k<a.length;k+=2){ const dx=a[k]-f.x, dz=a[k+1]-f.z, along=dx*f.nx+dz*f.nz, side=Math.abs(dx*f.nz-dz*f.nx);
        if(side<1.4&&along>o&&along<9)o=along; } }
    const prev=run[run.length-1]; if(prev&&Math.hypot(prev.x-f.x,prev.z-f.z)>4.5)flush();
    run.push({x:f.x,z:f.z,nx:f.nx,nz:f.nz,o}); }
  flush();
  /* the stacks and skerries off the headland: rings from their own waterline, in polar bins round each one */
  const sp=[]; const st=findMesh('seaStacks'); if(st)meshContour(st,yc,sp);
  const ks=G.cliffkit&&G.cliffkit.group&&G.cliffkit.group.getObjectByName('cliffkit:sea'); if(ks&&ks.visible)meshContour(ks,yc,sp);
  const cl=[];
  for(let i=0;i<sp.length;i+=2){ const x=sp[i], z=sp[i+1]; if(Math.hypot(x-CX,z-CZ)>140)continue;
    let c=cl.find(c=>Math.hypot(c.x/c.n-x,c.z/c.n-z)<12); if(!c)cl.push(c={x:0,z:0,n:0,p:[]}); c.x+=x; c.z+=z; c.n++; c.p.push(x,z); }
  const NB=q.ring;
  for(const c of cl){ if(c.n<6)continue; const x0=c.x/c.n, z0=c.z/c.n, rb=new Float32Array(NB);
    for(let i=0;i<c.p.length;i+=2){ const dx=c.p[i]-x0, dz=c.p[i+1]-z0, b=Math.floor(((Math.atan2(dz,dx)+TAU)%TAU)/TAU*NB)%NB; rb[b]=Math.max(rb[b],Math.hypot(dx,dz)); }
    for(let it=0;it<NB;it++)for(let b=0;b<NB;b++)if(!rb[b]){ const a=rb[(b+NB-1)%NB], e=rb[(b+1)%NB]; if(a||e)rb[b]=Math.max(a,e); }
    const sm=rb.map((v,b)=>Math.max(v,(rb[(b+NB-1)%NB]+v*2+rb[(b+1)%NB])/4));
    const L=[]; for(let b=0;b<NB;b++){ const a=(b+.5)/NB*TAU, ca=Math.cos(a), sa=Math.sin(a); L.push({x:x0+ca*sm[b],z:z0+sa*sm[b],nx:ca,nz:sa}); }
    strip(L,true,clamp(Math.max(...sm)/7,.45,1)); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setAttribute('fa',new THREE.Float32BufferAttribute(fa,3));
  g.setIndex(idx); g.computeBoundingSphere(); if(g.boundingSphere)g.boundingSphere.radius+=3;
  if(!foamMat){ foamMat=foamMaterial(); for(const k in UNI)foamMat.uniforms[k]=UNI[k]; }
  const m=new THREE.Mesh(g,foamMat); m.name='cliffFoam'; m.renderOrder=2; m.raycast=()=>{};
  D.debug.foamRuns={feet:feet.length,rings:cl.length};
  return m;
}
let foamMat=null;

/* ---------------- lip grass ---------------- */
let turf=null;
function turfColour(x,z,out){ // the turf's own colour just inside the edge (read off the terrain mesh)
  if(!turf){ turf=new Map(); G.scene.traverse(o=>{ if(o.name!=='terrain'||!o.geometry)return; const P=o.geometry.attributes.position, C=o.geometry.attributes.color; if(!C)return;
      for(let i=0;i<P.count;i++){ const y=P.getY(i); if(y<TOP-.2)continue; const px=P.getX(i); if(px<100)continue;
        turf.set(Math.round(px)*4096+Math.round(P.getZ(i)),[C.getX(i),C.getY(i),C.getZ(i)]); } }); }
  for(let r=0;r<4;r++)for(let i=-r;i<=r;i++)for(let j=-r;j<=r;j++){ const c=turf.get(Math.round(x+i)*4096+Math.round(z+j)); if(c)return out.setRGB(c[0],c[1],c[2]); }
  return out.copy(U.col('#5c7550'));
}
/* how far out the rock reaches at height y beside a lip point: the terrain, and the skin (which stands a little proud) */
function edgeProfile(lip){
  const N=lip.length, prof=lip.map(()=>new Float32Array(4).fill(-9)), HY=[41.95,41.5,41,40.4];
  const band=y=>y>41.72?0:y>41.25?1:y>40.7?2:y>40.1?3:-1;
  for(let i=0;i<N;i++){ const l=lip[i]; for(let b=0;b<4;b++){ let d=-3; while(d<8&&gh(l.x+l.nx*(d+.25),l.z+l.nz*(d+.25))>=HY[b])d+=.25; prof[i][b]=d; } }
  const HS=3, hash=new Map(); lip.forEach((l,i)=>{ const k=Math.floor(l.x/HS)+','+Math.floor(l.z/HS); (hash.get(k)||hash.set(k,[]).get(k)).push(i); });
  for(const o of (G.cliffs&&G.cliffs.meshes)||[]){ const P=o.geometry.attributes.position;
    for(let v=0;v<P.count;v++){ const y=P.getY(v), b=band(y); if(b<0)continue; const x=P.getX(v), z=P.getZ(v), cx=Math.floor(x/HS), cz=Math.floor(z/HS);
      for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){ const a=hash.get((cx+i)+','+(cz+j)); if(!a)continue;
        for(const k of a){ const l=lip[k], dx=x-l.x, dz=z-l.z, along=dx*l.nx+dz*l.nz, side=Math.abs(dx*l.nz-dz*l.nx); if(side<1.2&&along<6&&along>prof[k][b])prof[k][b]=along; } } } }
  return {prof,HY};
}
function grassMaterial(){
  const m=G.toon('#ffffff',{vertexColors:true,side:THREE.DoubleSide});
  m.onBeforeCompile=sh=>{ sh.uniforms.uTime=UNI.uTime;
    sh.vertexShader='uniform float uTime;attribute float sw;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
  { vec3 wp0=(modelMatrix*vec4(position,1.)).xyz; float k=sw*sw;
    float w=sin(uTime*1.7+wp0.x*.23+wp0.z*.17)*.38+sin(uTime*2.9+wp0.x*.61-wp0.z*.43)*.16+.22;
    transformed.xz+=vec2(.87,.49)*w*k*.22; transformed.y-=k*w*w*.03; }`); };
  m.customProgramCacheKey=()=>'bqLipGrass';
  return m;
}
let grassMat=null;
function buildGrass(level){
  const q=Q[level]||Q.balanced, lip=(G.cliffs&&G.cliffs.lip)||[]; if(!lip.length)return null;
  const rng=U.rng(9127), R=()=>rng(), pos=[], col=[], swa=[], nor=[], idx=[];
  const {prof,HY}=edgeProfile(lip), c0=new THREE.Color(), c1=new THREE.Color(), dark=U.col('#3d5230');
  const vtx=(x,y,z,c,s,ny)=>{ pos.push(x,y,z); col.push(c.r,c.g,c.b); swa.push(s); nor.push(0,ny==null?1:ny,0); return pos.length/3-1; };
  const blade=(x,y,z,ax,az,h,lean,c,w)=>{ const px=-az*w, pz=ax*w, cr=c1.copy(c).multiplyScalar(.74), cm=new THREE.Color().copy(c).multiplyScalar(.95), ct=new THREE.Color().copy(c).multiplyScalar(1.2);
    const a=vtx(x-px,y-.05,z-pz,cr,0), b=vtx(x+px,y-.05,z+pz,cr,0);
    const m1=vtx(x-px*.6+ax*lean*.45,y+h*.5,z-pz*.6+az*lean*.45,cm,.5), m2=vtx(x+px*.6+ax*lean*.45,y+h*.5,z+pz*.6+az*lean*.45,cm,.5);
    const t=vtx(x+ax*lean,y+h,z+az*lean,ct,1); idx.push(a,b,m1,b,m2,m1,m1,m2,t); };
  /* tufts on the shoulder, leaning out over the drop */
  for(let i=0;i<lip.length;i++){ const l=lip[i], tx=l.nz, tz=-l.nx;
    for(let k=0;k<q.tufts;k++){ const d=lerp(-1.4,.15,R()), s=(R()-.5)*2, x=l.x+l.nx*d+tx*s, z=l.z+l.nz*d+tz*s, y=Math.min(gh(x,z),TOP)+.02;
      turfColour(l.x-l.nx*1.5,l.z-l.nz*1.5,c0).multiplyScalar(.92+R()*.18);
      const nb=4+(R()<.5?1:0), base=R()*TAU;
      for(let b=0;b<nb;b++){ const a=base+b/nb*TAU+R()*.6, ax=Math.cos(a)*.35+l.nx*.65, az=Math.sin(a)*.35+l.nz*.65, al=Math.hypot(ax,az);
        blade(x+Math.cos(a)*.06,y,z+Math.sin(a)*.06,ax/al,az/al,lerp(.35,.75,R())*(d>-.3?1.15:1),lerp(.12,.38,R()),c0,.045); } } }
  /* the hanging fringe: turf rolled over the edge, ragged at the bottom, between each pair of lip points */
  const nf=q.fringe;
  for(let i=0;i+1<lip.length;i++){ const A=lip[i], B=lip[i+1]; if(Math.hypot(A.x-B.x,A.z-B.z)>3.2)continue;
    turfColour(A.x-A.nx*1.5,A.z-A.nz*1.5,c0);
    // three rows down the shoulder: on the turf, just over the edge, over the rock below it (outside the skin)
    const rowsAt=P=>[[P[0]-.55,TOP+.02],[Math.max(P[0],P[1])+.18,HY[1]],[Math.max(P[1],P[2])+.2,HY[2]]];
    const RA=rowsAt(prof[i]), RB=rowsAt(prof[i+1]);
    const cols=[]; for(let k=0;k<=nf;k++){ const t=k/nf, nx=lerp(A.nx,B.nx,t), nz=lerp(A.nz,B.nz,t), bx=lerp(A.x,B.x,t), bz=lerp(A.z,B.z,t);
      const C=[]; for(let r=0;r<3;r++){ const d=lerp(RA[r][0],RB[r][0],t), y=lerp(RA[r][1],RB[r][1],t); C.push([bx+nx*d,y,bz+nz*d]); }
      cols.push({C,nx,nz,bx,bz,t}); }
    // the turf rolls over the edge (one short band, lit like the turf), then a curtain of single blades hangs from it
    const v=[]; for(const c of cols){ const row=[]; for(let r=0;r<2;r++){ const p=c.C[r]; c1.copy(c0).multiplyScalar(r?.9:1); row.push(vtx(p[0],p[1],p[2],c1,r*.3,1)); } v.push(row); }
    for(let k=0;k<nf;k++)idx.push(v[k][0],v[k][1],v[k+1][0],v[k+1][0],v[k][1],v[k+1][1]);
    const nb=nf*3;
    for(let k=0;k<nb;k++){ const t=(k+R())/nb, j=Math.min(nf-1,Math.floor(t*nf)), u=t*nf-j, a=cols[j], bb=cols[j+1];
      const p1=[lerp(a.C[1][0],bb.C[1][0],u),lerp(a.C[1][1],bb.C[1][1],u),lerp(a.C[1][2],bb.C[1][2],u)];
      const nx=lerp(a.nx,bb.nx,u), nz=lerp(a.nz,bb.nz,u), tx=nz, tz=-nx, w=.07+R()*.05, len=.3+R()*R()*1.1;
      c1.copy(c0).multiplyScalar(.85+R()*.2); const r0=vtx(p1[0]-tx*w,p1[1]+.03,p1[2]-tz*w,c1,.2,.6), r1=vtx(p1[0]+tx*w,p1[1]+.03,p1[2]+tz*w,c1,.2,.6);
      c1.copy(c0).lerp(dark,.25).multiplyScalar(1.05); const out=.2+R()*.25, tip=vtx(p1[0]+nx*out+tx*(R()-.5)*.3,p1[1]-.25-len,p1[2]+nz*out+tz*(R()-.5)*.3,c1,1,.4);
      idx.push(r0,tip,r1); } }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(col,3)); g.setAttribute('sw',new THREE.Float32BufferAttribute(swa,1));
  g.setIndex(idx); g.computeBoundingSphere();
  if(!grassMat)grassMat=grassMaterial();
  const m=new THREE.Mesh(g,grassMat); m.name='cliffLipGrass'; m.receiveShadow=true; m.castShadow=false; m.raycast=()=>{};
  return m;
}

/* ---------------- build / quality / per frame ---------------- */
function drop(o){ if(o){ if(o.parent)o.parent.remove(o); o.geometry.dispose(); } }
function build(){
  const t0=performance.now(), level=(G.quality&&G.quality.level)||'balanced';
  drop(D.foam); drop(D.lipGrass); D.foam=D.lipGrass=null;
  try{ D.foam=buildFoam(level); G.scene.add(D.foam); }catch(e){ console.error('cliffdress foam',e); }
  try{ D.lipGrass=buildGrass(level); if(D.lipGrass)G.scene.add(D.lipGrass); }catch(e){ console.error('cliffdress grass',e); }
  const ft=D.foam&&D.foam.geometry.index?D.foam.geometry.index.count/3:0, gt=D.lipGrass?D.lipGrass.geometry.index.count/3:0;
  D.stats={tris:ft+gt,draws:(ft?1:0)+(gt?1:0),ms:Math.round(performance.now()-t0),level,foam:{tris:ft},grass:{tris:gt}};
  if(G.debug)console.log('[cliffdress]',JSON.stringify(D.stats));
}
G.system('cliffdress',{order:10,modes:'always',
  init(){ try{ build(); }catch(e){ console.error('cliffdress',e); } },
  update(){
    UNI.uTime.value=G.time||0; const t=W.tide||0; UNI.uTide.value=t;
    UNI.uBar.value=smooth(-.8,-1.02,t);
    const A=G.atmo; UNI.uLight.value=1-clamp(A?A.dark:0,0,1)*.975;
  }});
// after the kit has applied the new level (it listens first), so the foam follows the pieces that are drawn
G.on('quality',()=>{ if(D.stats.level&&D.stats.level!==G.quality.level){ try{ build(); }catch(e){ console.error('cliffdress',e); } } });
})();
