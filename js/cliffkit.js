/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — cliffkit.js
   Sculpted rock pieces for the headland (made in Blender by tools/cliffkit/build_kit.py, embedded in
   js/cliffkit_data.js as G.cliffkitData) and their placement round the cliffs, fitted to the rock skin (cliffs.js):
   buttresses growing out of the sea faces and ledge slabs part way up (backs buried in the face, fronts standing clear
   of it), crags tucked under the plateau edge, scree and fallen blocks at the feet and along the escarpment, and a
   few low skerries. Every kind takes turns in the priority order, so each one survives every quality level's cut;
   colliders follow what is drawn. Visual only. One InstancedMesh per land piece; the skerries share one merged mesh.
   API: G.cliffkit = { pieces:{name:{geo,tris,size,origin}}, place(list), placements, group, stats, debug }
     place([{piece,x,y,z,yaw,scale|[sx,sy,sz],tint,pitch,roll,pri}]) rebuilds the meshes from a new list.
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U, W=G.world;
const {clamp,lerp,smooth}=U;
const PI=Math.PI, TAU=PI*2, TOP=42;
const D=G.cliffkitData;
const SEA_GROUP={stackTall:1,stackSquat:1,arch:1};   // few instances each: merged into one draw (only low skerries are placed now)
const BUDGET={high:60000,balanced:36000,saver:18000}; // placed triangles per quality level
const K=G.cliffkit={pieces:{},placements:[],group:new THREE.Group(),stats:{tris:0,draws:0,bytes:0,instances:0,levels:{}},
  place, debug:{}};
K.group.name='cliffkit';
if(!D){ console.warn('[cliffkit] no data'); return; }

/* ---------- decode ---------- */
function b64(s,T){ const bin=atob(s), u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i); return new T(u8.buffer); }
const s2l=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
let matMode='toon';
function decode(){
  matMode=G.cliffmat&&G.cliffmat.rock?'cliffmat':'toon';
  let bytes=0;
  for(const name in D.pieces){ const d=D.pieces[name]; bytes+=d.p.length+d.n.length+d.c.length+d.i.length;
    const q=b64(d.p,Int16Array), nq=b64(d.n,Int8Array), cq=b64(d.c,Uint8Array), ix=b64(d.i,Uint16Array), n=q.length/3;
    const pos=new Float32Array(n*3), nor=new Float32Array(n*3), col=new Float32Array(n*3);
    for(let i=0;i<n;i++){ for(let k=0;k<3;k++){ pos[i*3+k]=d.min[k]+(q[i*3+k]+32768)/65535*d.size[k]; nor[i*3+k]=nq[i*3+k]/127; }
      const ao=cq[i*4+3]/255, r=s2l(cq[i*4]/255), g=s2l(cq[i*4+1]/255), b=s2l(cq[i*4+2]/255);
      if(matMode==='toon'){ const s=.42+.58*ao; col[i*3]=r*s; col[i*3+1]=g*s; col[i*3+2]=b*s; }
      else { // the rock material brings its own stone colour: keep the bake as a shade (AO) with a little of its tint
        const s=.68+.36*ao, m=(r+g+b)/3||1; col[i*3]=lerp(1,r/m,.12)*s; col[i*3+1]=lerp(1,g/m,.12)*s; col[i*3+2]=lerp(1,b/m,.12)*s; } }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(pos,3)); geo.setAttribute('normal',new THREE.BufferAttribute(nor,3));
    geo.setAttribute('color',new THREE.BufferAttribute(col,3)); geo.setIndex(new THREE.BufferAttribute(ix,1));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    K.pieces[name]={geo,tris:d.tris,size:d.size.slice(),origin:d.origin,min:d.min,max:d.max,step:Math.max(1,Math.floor(n/260))};
  }
  K.stats.bytes=bytes;
}
let MAT=null, MATS=null;
function material(inst){
  if(!MAT){ const cm=G.cliffmat&&G.cliffmat.rock;
    MAT=cm?G.cliffmat.rock({instanced:true,wet:true,moss:true,strata:true,vertexColors:true}):G.toon('#ffffff',{vertexColors:true});
    MATS=cm?G.cliffmat.rock({wet:true,moss:true,strata:true,vertexColors:true}):MAT; }
  return inst?MAT:MATS;
}

/* ---------- instance transforms ---------- */
const _m=new THREE.Matrix4(), _q=new THREE.Quaternion(), _e=new THREE.Euler(), _p=new THREE.Vector3(), _s=new THREE.Vector3(), _v=new THREE.Vector3();
function matrixOf(o,out){
  const s=o.scale==null?1:o.scale, sx=Array.isArray(s)?s[0]:s, sy=Array.isArray(s)?s[1]:s, sz=Array.isArray(s)?s[2]:s;
  return (out||new THREE.Matrix4()).compose(_p.set(o.x,o.y,o.z),_q.setFromEuler(_e.set(o.pitch||0,o.yaw||0,o.roll||0,'YXZ')),_s.set(sx,sy,sz));
}
function tintOf(o){ const t=o.tint; if(t==null)return new THREE.Color(1,1,1); if(t.isColor)return t.clone(); if(typeof t==='number')return new THREE.Color(t,t,t);
  if(Array.isArray(t))return new THREE.Color(t[0],t[1],t[2]); return U.col(t); }

/* ---------- build meshes from a placement list ---------- */
let meshes=[];   // {mesh, piece, list:[placement], sea:bool, tris per instance}
function clear(){ for(const m of meshes){ K.group.remove(m.mesh); if(m.sea)m.mesh.geometry.dispose(); } meshes=[]; }
function place(list){
  if(!Object.keys(K.pieces).length)decode();
  clear(); K.placements=list.slice();
  const by={};
  list.forEach((o,i)=>{ if(!K.pieces[o.piece])return; (by[o.piece]=by[o.piece]||[]).push(o); });
  const seaList=[];
  for(const name in by){
    const P=K.pieces[name], L=by[name].slice().sort((a,b)=>(b.pri||0)-(a.pri||0));
    if(SEA_GROUP[name]){ for(const o of L)seaList.push(o); continue; }
    const g=new THREE.BufferGeometry(); for(const k in P.geo.attributes)g.setAttribute(k,P.geo.attributes[k]); g.setIndex(P.geo.index);
    const im=new THREE.InstancedMesh(g,material(true),L.length), box=new THREE.Box3(); let maxS=1;
    L.forEach((o,i)=>{ matrixOf(o,_m); im.setMatrixAt(i,_m); im.setColorAt(i,tintOf(o));
      _v.copy(P.geo.boundingSphere.center).applyMatrix4(_m); box.expandByPoint(_v); maxS=Math.max(maxS,_m.getMaxScaleOnAxis()); });
    const sph=new THREE.Sphere(); box.getBoundingSphere(sph); sph.radius+=P.geo.boundingSphere.radius*maxS; g.boundingSphere=sph;
    im.instanceMatrix.needsUpdate=true; if(im.instanceColor)im.instanceColor.needsUpdate=true;
    im.receiveShadow=true; im.castShadow=true; im.name='cliffkit:'+name; im.frustumCulled=true;
    K.group.add(im); meshes.push({mesh:im,piece:name,list:L,sea:false,tris:P.tris});
  }
  if(seaList.length){ // merged: instances in priority order, so a quality level can cut the draw range
    seaList.sort((a,b)=>(b.pri||0)-(a.pri||0));
    let nv=0, ni=0; for(const o of seaList){ const P=K.pieces[o.piece]; nv+=P.geo.attributes.position.count; ni+=P.geo.index.count; }
    const pos=new Float32Array(nv*3), nor=new Float32Array(nv*3), col=new Float32Array(nv*3), idx=nv>65535?new Uint32Array(ni):new Uint16Array(ni);
    const nm=new THREE.Matrix3(), ends=[]; let vo=0, io=0;
    for(const o of seaList){ const P=K.pieces[o.piece], A=P.geo.attributes, n=A.position.count, I=P.geo.index.array, t=tintOf(o);
      matrixOf(o,_m); nm.getNormalMatrix(_m);
      for(let i=0;i<n;i++){ _v.fromBufferAttribute(A.position,i).applyMatrix4(_m); pos.set([_v.x,_v.y,_v.z],(vo+i)*3);
        _v.fromBufferAttribute(A.normal,i).applyMatrix3(nm).normalize(); nor.set([_v.x,_v.y,_v.z],(vo+i)*3);
        col[(vo+i)*3]=A.color.getX(i)*t.r; col[(vo+i)*3+1]=A.color.getY(i)*t.g; col[(vo+i)*3+2]=A.color.getZ(i)*t.b; }
      for(let i=0;i<I.length;i++)idx[io+i]=I[i]+vo;
      vo+=n; io+=I.length; ends.push(io); }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('normal',new THREE.BufferAttribute(nor,3));
    g.setAttribute('color',new THREE.BufferAttribute(col,3)); g.setIndex(new THREE.BufferAttribute(idx,1)); g.computeBoundingSphere();
    const m=new THREE.Mesh(g,material(false)); m.receiveShadow=true; m.castShadow=true; m.name='cliffkit:sea';
    K.group.add(m); meshes.push({mesh:m,piece:'sea',list:seaList,sea:true,ends});
  }
  applyQuality();
  return K;
}

/* ---------- quality: keep the highest-priority placements that fit the level's triangle budget ---------- */
function plan(level){
  const all=[]; for(const m of meshes)m.list.forEach((o,i)=>all.push({o,m,i,t:K.pieces[o.piece].tris}));
  all.sort((a,b)=>(b.o.pri||0)-(a.o.pri||0));
  const keep=new Map(meshes.map(m=>[m,0])); let tris=0; const B=BUDGET[level]||BUDGET.balanced;
  // within each mesh the list is already in priority order, so "keep the first n" is exact
  const taken=new Set();
  for(const a of all){ if(tris+a.t>B)continue; tris+=a.t; taken.add(a.o); }
  for(const m of meshes){ let n=0; while(n<m.list.length&&taken.has(m.list[n]))n++; keep.set(m,n); }
  let t2=0, draws=0, inst=0; const kinds={};
  for(const m of meshes){ const n=keep.get(m); for(let i=0;i<n;i++){ const o=m.list[i]; t2+=K.pieces[o.piece].tris; kinds[o.piece]=(kinds[o.piece]||0)+1; } if(n)draws++; inst+=n; }
  return {keep,tris:t2,draws,instances:inst,kinds};
}
function applyQuality(){
  const level=(G.quality&&G.quality.level)||'balanced', P=plan(level), shadows=level!=='saver';
  for(const m of meshes){ const n=P.keep.get(m);
    if(m.sea){ m.mesh.geometry.setDrawRange(0,n?m.ends[n-1]:0); }
    else m.mesh.count=n;
    m.mesh.visible=n>0; m.mesh.castShadow=shadows&&(m.sea||m.piece==='buttress'||m.piece==='lipcrag'||m.piece==='stackTall'); }
  Object.assign(K.stats,{level,tris:P.tris,draws:P.draws,instances:P.instances});
  for(const l of ['saver','balanced','high']){ const q=plan(l); K.stats.levels[l]={tris:q.tris,draws:q.draws,instances:q.instances,kinds:q.kinds}; }
  syncColliders(P);
}
/* colliders follow what is drawn: a piece cut at this quality level leaves no invisible wall behind */
let liveCols=[];
function syncColliders(P){
  if(!G.addCollider)return;
  for(const c of liveCols)G.removeCollider&&G.removeCollider(c); liveCols=[];
  for(const m of meshes){ const n=P.keep.get(m); for(let i=0;i<n;i++)for(const c of (m.list[i].col||[]))liveCols.push(G.addCollider(Object.assign({},c))); }
  K.stats.colliders=liveCols.length;
}
G.on&&G.on('quality',()=>{ if(meshes.length)applyQuality(); });

/* =====================================================================
   DEFAULT PLACEMENT
   ===================================================================== */
const gh=(x,z)=>(W.groundY||W.height)(x,z);
const CX=166, CZ=0; // the headland's middle

/* the plateau edge, every ~2 m: lip point, the foot of the face below it, the outward normal */
function probeRim(){
  if(G.cliffs&&G.cliffs.lip&&G.cliffs.foot&&G.cliffs.lip.length===G.cliffs.foot.length){
    return G.cliffs.lip.map((l,i)=>{ const f=G.cliffs.foot[i]; return {lx:l.x,lz:l.z,fx:f.x,fy:f.y,fz:f.z,nx:l.nx,nz:l.nz,sea:!!f.sea}; }); }
  const out=[], N=200;
  for(let k=0;k<N;k++){ const a=k/N*TAU, dx=Math.cos(a), dz=Math.sin(a);
    let r=20; while(r<140&&gh(CX+dx*r,CZ+dz*r)>41.9)r+=.5;
    if(r>=140)continue;
    const lx=CX+dx*r, lz=CZ+dz*r;
    // outward normal: downhill direction half way down the face
    let rr=r; while(rr<r+30&&gh(CX+dx*rr,CZ+dz*rr)>24)rr+=.5;
    const mx=CX+dx*rr, mz=CZ+dz*rr, gx=gh(mx+1,mz)-gh(mx-1,mz), gz=gh(mx,mz+1)-gh(mx,mz-1), gl=Math.hypot(gx,gz)||1;
    let nx=-gx/gl, nz=-gz/gl;
    // foot: walk down the normal until the ground stops falling (or reaches the sea floor)
    let fx=lx, fz=lz, fy=gh(fx,fz);
    for(let s=0;s<60;s+=.5){ const x=lx+nx*s, z=lz+nz*s, y=gh(x,z), y2=gh(x+nx,z+nz);
      fx=x; fz=z; fy=y; if(y<-1.5||(y-y2<.35&&y<TOP-6))break; }
    out.push({lx,lz,fx,fy,fz,nx,nz,sea:fy<1.5});
  }
  return out;
}

/* places to keep clear (plan circles, with a height band), filled from the world and the game's interact points */
function keepOuts(){
  const L=W.landmarks||{}, K0=[];
  const add=(x,z,r,y0=-99,y1=999)=>K0.push({x,z,r,y0,y1});
  if(L.halloran)add(L.halloran.x,L.halloran.z,6);
  if(L.cliffPathTop)add(L.cliffPathTop.x,L.cliffPathTop.z,7);
  if(L.cliffPathBottom)add(L.cliffPathBottom.x,L.cliffPathBottom.z,7);
  if(L.caveMouth)add(L.caveMouth.x,L.caveMouth.z+1.5,8);
  if(L.lighthouse)add(L.lighthouse.x,L.lighthouse.z,14);
  // the low-tide walk along the foot of the south cliff to the cave (its floor only exists while the loop runs, so
  // walkable() cannot see it): a band kept clear up to well above head height
  for(let x=92;x<=190;x+=3)add(x,57,4.8,-12,9);
  if(L.cottage)add(L.cottage.x,L.cottage.z,9);
  if(L.shed)add(L.shed.x,L.shed.z,6);
  // the ledge under the north lip, the outcrop by the path, the glider's launch lip and its glide west
  add(165,-46,8,28); add(112.8,-6,6); for(let t=0;t<=1;t+=.1)add(lerp(114,86,t),12,6+2*t,lerp(40.6,23,t)-9,lerp(40.6,23,t)+8);
  return K0.concat(interactKO());
}
function interactKO(){
  const out=[];
  try{ for(const it of (G.interact&&G.interact.list)||[]){ const p=typeof it.pos==='function'?it.pos():it.pos;
    if(p&&p.x>90&&Math.abs(p.z)<120)out.push({x:p.x,z:p.z,r:(it.radius||1.5)+2.5,y0:(p.y||0)-6,y1:(p.y||0)+8}); } }catch(e){}
  return out;
}

/* sea stacks already in the world: centres and waterline radii from the stacks mesh itself */
function worldStacks(){
  let m=null; G.scene.traverse(o=>{ if(o.name==='seaStacks')m=o; }); if(!m)return [];
  const P=m.geometry.attributes.position, cl=[];
  for(let i=0;i<P.count;i+=3){ const y=P.getY(i); if(y<-1||y>3)continue; const x=P.getX(i), z=P.getZ(i); if(x<100)continue;
    let c=cl.find(c=>Math.hypot(c.x/c.n-x,c.z/c.n-z)<13); if(!c)cl.push(c={x:0,z:0,n:0,p:[]}); c.x+=x;c.z+=z;c.n++; c.p.push(x,z); }
  return cl.map(c=>{ const x=c.x/c.n, z=c.z/c.n; let r=0; for(let i=0;i<c.p.length;i+=2)r=Math.max(r,Math.hypot(c.p[i]-x,c.p[i+1]-z)); return {x,z,r}; });
}

/* the face profile under a rim point: how far out from the lip (along the outward normal) the rock reaches at height y.
   Sampled once per rim point; the outermost ground at or above y wins, so overhanging bits count as face. */
const PS=.25, P0=-4, PN=180;
function profile(r){
  if(r._e)return r._e; const e=new Float32Array(PN);
  for(let i=0;i<PN;i++)e[i]=gh(r.lx+r.nx*(P0+i*PS),r.lz+r.nz*(P0+i*PS));
  for(let i=PN-2;i>=0;i--)e[i]=Math.max(e[i],e[i+1]);
  return r._e=e;
}
function faceD(r,y){
  const e=profile(r); if(y>=e[0])return P0; if(y<=e[PN-1])return P0+(PN-1)*PS;
  let lo=0,hi=PN-1; while(hi-lo>1){ const md=(lo+hi)>>1; if(e[md]>=y)lo=md; else hi=md; }
  return P0+(lo+(e[lo]-y)/Math.max(1e-4,e[lo]-e[hi]))*PS;
}

/* how far out the skin (which stands proud of the terrain on the sea faces) reaches beside each rim point, in 2 m height
   bands, so pieces are fitted to the rock that is drawn: their backs inside it, their fronts standing clear of it */
const SB0=-4, SBN=24;
function skinBands(rim){
  const out=rim.map(()=>new Float32Array(SBN).fill(-99)); if(!G.cliffs||!G.cliffs.meshes)return out;
  const n=rim.length, LX=new Float32Array(n), LZ=new Float32Array(n); rim.forEach((r,i)=>{ LX[i]=r.lx; LZ[i]=r.lz; });
  for(const o of G.cliffs.meshes){ const P=o.geometry.attributes.position;
    for(let v=0;v<P.count;v++){ const x=P.getX(v), y=P.getY(v), z=P.getZ(v), b=Math.floor((y-SB0)/2); if(b<0||b>=SBN)continue;
      let bi=-1, bd=1e9; for(let i=0;i<n;i++){ const dx=x-LX[i]; if(dx>26||dx<-26)continue; const dz=z-LZ[i], d=dx*dx+dz*dz; if(d<bd){bd=d;bi=i;} }
      if(bi<0)continue; const r=rim[bi], dx=x-r.lx, dz=z-r.lz, along=dx*r.nx+dz*r.nz; if(Math.abs(dx*r.nz-dz*r.nx)>1.6)continue;
      if(along>out[bi][b])out[bi][b]=along; } }
  return out;
}
let SKB=null;
const faceS=(r,y)=>{ const f=faceD(r,y); if(!SKB||r._i==null)return f; const b=Math.floor((y-SB0)/2), B=SKB[r._i];
  let m=-99; for(let k=b-1;k<=b+1;k++)if(k>=0&&k<SBN)m=Math.max(m,B[k]); return Math.max(f,m); };

function build(){
  const t0=performance.now();
  decode();
  const rng=U.rng(73113), R=()=>rng(), RR=(a,b)=>lerp(a,b,R());
  const rim=probeRim(), KO=keepOuts(), N=rim.length;
  rim.forEach((r,i)=>r._i=i); SKB=skinBands(rim);
  const tide0=W.tide; W.tide=-1.25;            // judge "walkable" at the lowest tide
  const WC=new Map(), walk=(x,z)=>{ const k=Math.round(x*2)*4096+Math.round(z*2); let v=WC.get(k);
    if(v===undefined){ try{ v=!!G.world.walkable(x,z); }catch(e){ v=false; } WC.set(k,v); } return v; };
  let KOn=KO;
  const out=[];
  const inKO=(x,y,z)=>{ for(const k of KOn){ const dx=x-k.x, dz=z-k.z; if(dx*dx+dz*dz<k.r*k.r&&y>k.y0&&y<k.y1)return true; } return false; };
  const RJ=K.debug.rej={}, rej=(n,w)=>{ RJ[n]=RJ[n]||{}; RJ[n][w]=(RJ[n][w]||0)+1; return null; };

  /* a candidate against the rules: nothing in a kept place, nothing over the plateau top, nothing standing on walkable
     ground unless the piece takes colliders there; returns what was found or null */
  function judge(o,allowWalk){
    const P=K.pieces[o.piece], A=P.geo.attributes.position; matrixOf(o,_m);
    { const bb=new THREE.Box3(new THREE.Vector3().fromArray(P.min),new THREE.Vector3().fromArray(P.max)).applyMatrix4(_m);
      KOn=KO.filter(k=>bb.max.x>k.x-k.r&&bb.min.x<k.x+k.r&&bb.max.z>k.z-k.r&&bb.min.z<k.z+k.r&&bb.max.y>k.y0&&bb.min.y<k.y1); }
    let above=0, n=0, walkHit=false, ymax=-1e9;
    for(let i=0;i<A.count;i+=P.step){ _v.fromBufferAttribute(A,i).applyMatrix4(_m); n++;
      if(inKO(_v.x,_v.y,_v.z))return rej(o.piece,'keepout');
      if(_v.y>TOP-.45&&(W.onPlateau?W.onPlateau(_v.x,_v.z):_v.x>110&&gh(_v.x,_v.z)>TOP-.5))return rej(o.piece,'plateau');
      const g=gh(_v.x,_v.z);
      if(_v.y>g+.05){ above++;
        if(walk(_v.x,_v.z)){ if(!allowWalk||g>TOP-1.5)return rej(o.piece,'walk'); walkHit=true;
          if(W.pathDist&&W.pathDist(_v.x,_v.z)<3)return rej(o.piece,'path');
          if(W.rampDist&&W.rampDist(_v.x,_v.z)<(W.ramp?W.ramp.hw+W.ramp.bank:5)+2.5)return rej(o.piece,'ramp'); } }
      ymax=Math.max(ymax,_v.y); }
    return {above:above/n,walkHit,ymax};
  }
  const tint=(warm,v0)=>{ const v=(v0||.94)+R()*.12, w=(R()-.5)*.07+(warm||0); return [v*(1+w),v,v*(1-w*.8)]; };
  const yawOf=r=>Math.atan2(r.nx,r.nz);
  const used={}; const near=(cls,i,span)=>{ const u=used[cls]; if(!u)return false; for(let d=-span;d<=span;d++)if(u[(i+d+N)%N])return true; return false; };
  const mark=(cls,i)=>{ (used[cls]=used[cls]||new Uint8Array(N))[i]=1; };
  const faceH=r=>TOP-Math.max(r.fy,-1);
  /* colliders: circles across the piece's front, so a glider or walker meets the rock it sees */
  const colsFor=(o,r,d0,d1,y0,y1,halfW)=>{ const tx=r.nz, tz=-r.nx, c=[], n=Math.max(1,Math.round(halfW/2.2)), rad=Math.min(2.6,halfW/n+.4), dm=(d0+d1)/2;
    for(let k=0;k<n;k++){ const s=n===1?0:lerp(-halfW+rad*.8,halfW-rad*.8,k/(n-1));
      c.push({x:r.lx+r.nx*dm+tx*s,z:r.lz+r.nz*dm+tz*s,r:Math.max(.8,Math.min(rad,(d1-d0)/2+.6)),y0,y1}); }
    o.col=c; };
  /* back plane of a face piece: from its origin up (or down) the piece's height, tilted by pitch; push it in until every
     sample of it sits inside the rock, and report how far proud of the face its front would stand */
  function fitBack(r,o,hLocal,inset,dir){ // dir: +1 piece rises from its origin (back-base), -1 hangs below it (back-top)
    const sp=Math.sin(o.pitch||0), cp=Math.cos(o.pitch||0), sy=Array.isArray(o.scale)?o.scale[1]:o.scale;
    let dO=1e9; const gaps=[];
    for(let k=0;k<=6;k++){ const yl=dir*hLocal*sy*k/6, h=o.y+cp*yl; const f=Math.min(faceS(r,h),faceD(r,h)+1.2)-inset-sp*yl; if(f<dO)dO=f; }
    for(let k=0;k<=6;k++){ const yl=dir*hLocal*sy*k/6, h=o.y+cp*yl; gaps.push(faceS(r,h)-(dO+sp*yl)); }
    gaps.sort((a,b)=>a-b); return {dO,gap:gaps[3],gmax:gaps[6]};
  }
  const put=(o,r,d)=>{ o.x=r.lx+r.nx*d; o.z=r.lz+r.nz*d; return o; };
  const lat=(o,r,s)=>{ o.x+=r.nz*s; o.z-=r.nx*s; return o; };
  const T={buttress:[],lipcrag:[],slab:[],scree:[],boulders:[],stackSquat:[]};
  const add=(o,info)=>{ T[o.piece].push(o); out.push(o); return o; };

  /* 1. buttresses: grow out of the sea faces from below the waterline, leaning back with the face, backs buried */
  for(let i=0;i<N;i++){ const r=rim[i]; if(!r.sea||faceH(r)<28||near('buttress',i,6)||R()<.35)continue;
    const fh=faceH(r), sy=fh*RR(.42,.72)/19.3, sx=sy*RR(.55,.8);
    const top=-.4+17.9*sy, dB=faceD(r,.5), dT=faceD(r,top-1);
    const pitch=-clamp(Math.atan2(dB-dT,top),0,.38)*.92;
    const o={piece:'buttress',y:-.4,yaw:yawOf(r)+(R()-.5)*.12,pitch,roll:(R()-.5)*.06,scale:[sx,sy,1],tint:tint(0)};
    const f=fitBack(r,o,17.9,.5,1); const sz=clamp((RR(3.2,4.6)+f.gap)/5.2,.75,1.9); if((3.2+f.gap)/5.2>2.1){ rej('buttress','recess'); continue; }
    o.scale[2]=sz; put(o,r,f.dO); lat(o,r,(R()-.5)*1.5);
    const info=judge(o,false); if(!info)continue; if(info.above<.2){ rej('buttress','buried'); continue; }
    colsFor(o,r,f.dO+f.gap,f.dO+5.2*sz,-6,top-1,6.2*sx); o.q=R(); add(o); mark('buttress',i); }

  /* 2. crags tucked under the plateau edge: top below the turf, back buried under the lip, nose out over the face */
  for(let i=0;i<N;i++){ const r=rim[i]; if(near('lipcrag',i,4)||near('buttress',i,1)||R()<.4)continue;
    if(!r.sea&&(faceH(r)<12||r.fy>TOP-12))continue;
    const s=RR(.7,1.08), yT=TOP-RR(.8,1.7);
    const o={piece:'lipcrag',y:yT,yaw:yawOf(r)+(R()-.5)*.25,pitch:RR(-.04,.12),roll:(R()-.5)*.1,scale:[s*RR(.8,1.15),s*RR(.75,1.05),1],tint:tint(.03,.9)};
    const f=fitBack(r,o,7.4,.9,-1); const want=RR(2.4,3.4); o.scale[2]=clamp((want+f.gap)/5.2,.6,1.6);
    put(o,r,f.dO); lat(o,r,(R()-.5));
    const info=judge(o,false); if(!info)continue; if(info.above<.15){ rej('lipcrag','buried'); continue; }
    colsFor(o,r,f.dO+f.gap,f.dO+5.2*o.scale[2],yT-7.4*o.scale[1],yT-.3,4*o.scale[0]); o.q=R(); add(o); mark('lipcrag',i); }

  /* 3. ledge slabs: shelves standing out of the faces part way up */
  for(let i=0;i<N;i++){ const r=rim[i]; const fh=faceH(r); if(fh<16||near('slab',i,3)||near('buttress',i,2)||R()<.45)continue;
    const y=lerp(Math.max(r.fy,0)+6,TOP-7,R()), s=RR(.75,1.2);
    const o={piece:'slab',y,yaw:yawOf(r)+(R()-.5)*.3,pitch:RR(-.03,.08),roll:(R()-.5)*.08,scale:[s*RR(.8,1.3),s*RR(.7,1.1),1],tint:tint(0)};
    const f=fitBack(r,o,3.3,.7,-1); o.scale[2]=clamp((RR(2,3)+f.gap)/4.5,.55,1.6);
    put(o,r,f.dO); lat(o,r,(R()-.5)*2);
    const info=judge(o,false); if(!info)continue; if(info.above<.2){ rej('slab','buried'); continue; }
    colsFor(o,r,f.dO+f.gap,f.dO+4.5*o.scale[2],y-3.3*o.scale[1],y,4.3*o.scale[0]); o.q=R(); add(o); mark('slab',i); }

  /* 4. scree fans and boulders at the feet: on ground, in water shallow enough to show at low tide, along the escarpment */
  for(let i=0;i<N;i++){ const r=rim[i];
    if(R()<.3)continue;
    const kind=R()<.5?'scree':'boulders'; if(near(kind,i,kind==='scree'?3:2))continue;
    let ok=false;
    for(let tr=0;tr<4&&!ok;tr++){
      const s=RR(.75,1.25);
      if(kind==='scree'){
        // in deep water the fan is a talus heap leaning on the foot, its toe under the surface
        const dF=faceS(r,Math.max(r.fy,-1.4)+.3), gr=gh(r.lx+r.nx*(dF+2.5),r.lz+r.nz*(dF+2.5)); if(gr>TOP-6||(gr<-1.9&&dF>12))break;
        const deep=gr<-1.9, g0=deep?-1.7:gr;
        const g1=deep?-3.2:gh(r.lx+r.nx*(dF+6),r.lz+r.nz*(dF+6)), pitch=clamp(Math.asin(clamp((g0-g1)/3.5,-1,1)),-.1,.38);
        const o={piece:'scree',y:Math.min(g0,gh(r.lx+r.nx*dF,r.lz+r.nz*dF))-.3*s,yaw:yawOf(r)+(R()-.5)*.35,pitch,roll:(R()-.5)*.08,scale:[s*RR(.8,1.2),s*RR(.75,1.15),s*RR(.85,1.15)],tint:tint(.02)};
        const f=fitBack(r,o,3.7,.4,1); put(o,r,Math.min(f.dO,dF-.6)); lat(o,r,(R()-.5)*3);
        const info=judge(o,!r.sea||g0>-1.4); if(!info||info.above<.3){ rej('scree','fit'); continue; }
        if(info.walkHit)colsFor(o,r,dF,dF+2.2*o.scale[2],o.y-1,o.y+2.6*o.scale[1],3*o.scale[0]);
        o.q=R()+(info.walkHit?.5:0); add(o); mark('scree',i); ok=true;
      }else{
        const d0=faceS(r,Math.max(r.fy,-1.4)+.3), gr=gh(r.lx+r.nx*(d0+3),r.lz+r.nz*(d0+3)), deep=gr<-1.9; if(deep&&d0>12)continue;
        const d=d0+(deep?RR(.6,2.4):RR(1.2,5.5)), x=r.lx+r.nx*d, z=r.lz+r.nz*d, g=deep?-1.3:gh(x,z); if(g>TOP-6)continue;   // deep: fallen blocks against the foot
        const o={piece:'boulders',x,z,y:g-.35*s,yaw:R()*TAU,scale:[s,s*RR(.8,1.2),s],tint:tint(.02,.9)}; lat(o,r,(R()-.5)*3);
        const info=judge(o,!r.sea||g>-1.4); if(!info||info.above<.3){ rej('boulders','fit'); continue; }
        if(info.walkHit)o.col=[{x:o.x,z:o.z,r:2.2*s,y0:o.y-1,y1:o.y+2.2*s}];
        o.q=R()+(info.walkHit?.5:0); add(o); mark('boulders',i); ok=true; } } }

  /* 5. a few low skerries off the sea feet, clear of the standing stacks, to break the line of the waterline */
  const stacks=worldStacks();
  let nSk=0;
  for(let k=0;k<N*3&&nSk<5;k++){ const r=rim[Math.floor(R()*N)]; if(!r.sea)continue;
    const d=faceS(r,0)+RR(7,24), x=r.lx+r.nx*d, z=r.lz+r.nz*d, g=gh(x,z); if(g>-1.6||g<-7)continue;
    if(stacks.some(s=>Math.hypot(s.x-x,s.z-z)<s.r+7))continue; if(T.stackSquat.some(o=>Math.hypot(o.x-x,o.z-z)<20))continue;
    const s=RR(.38,.62), o={piece:'stackSquat',x,z,y:-.9*s-.6,yaw:R()*TAU,scale:[s*RR(.9,1.3),s*RR(.7,1),s*RR(.9,1.3)],tint:tint(-.02)};
    const info=judge(o,false); if(!info)continue;
    o.col=[{x,z,r:3.6*s,y0:-6,y1:4*s}]; o.q=R(); add(o); nSk++; }

  /* 6. the west escarpment: the cliff path's terraced wall above the moor. Outcrops, ribs and shelves rooted in its steep
     steps, scree where a step meets the terrace or moor below, blocks scattered at the foot; never in the path's corridor
     (judge() keeps them out of it), colliders wherever a walker can reach them */
  { const placed=[], far=(k,x,z,d)=>!placed.some(p=>p.k===k&&Math.hypot(p.x-x,p.z-z)<d), WB=.45;
    const grad=(x,z)=>[gh(x+.6,z)-gh(x-.6,z),gh(x,z+.6)-gh(x,z-.6)];
    const cand=[]; for(let x=94;x<=126;x+=2.2)for(let z=-52;z<=52;z+=2.2)cand.push([x+(R()-.5)*1.6,z+(R()-.5)*1.6,R()]);
    cand.sort((a,b)=>a[2]-b[2]);
    for(const [x,z] of cand){
      const h=gh(x,z); if(h<14.5||h>TOP-2.5)continue;
      if(W.onPlateau&&W.onPlateau(x,z))continue;
      const [gx,gz]=grad(x,z), sl=Math.hypot(gx,gz)/1.2; if(sl<1)continue;
      let nx=-gx, nz=-gz; const nl=Math.hypot(nx,nz)||1; nx/=nl; nz/=nl;
      if(nx>.35)continue;                                     // this side faces west (seaward faces are dressed above)
      // the step's foot: walk downhill until the ground flattens
      let fd=0, fy=h; for(let s=.5;s<14;s+=.5){ const y=gh(x+nx*s,z+nz*s), y2=gh(x+nx*(s+.6),z+nz*(s+.6)); fd=s; fy=y; if(y-y2<.25)break; }
      const r={lx:x-nx*8,lz:z-nz*8,nx,nz,fy,sea:false};
      const yaw=Math.atan2(nx,nz)+(R()-.5)*.3, fh=h-fy+2, pick=R();
      let o=null, kind;
      if(pick<.3&&fh>5&&far('buttress',x,z,14)){ kind='buttress';
        const sy=clamp(fh*RR(.7,1.05)/17.9,.28,.62), sx=sy*RR(.6,.9);
        o={piece:kind,y:fy-.8,yaw,pitch:-RR(.04,.16),roll:(R()-.5)*.08,scale:[sx,sy,1],tint:tint(.04,.9)};
        const f=fitBack(r,o,17.9,.4,1); o.scale[2]=clamp((RR(1.6,2.6)+f.gap)/5.2,.35,1.1); put(o,r,f.dO); o.cw=[f.dO+f.gap,f.dO+5.2*o.scale[2],fy-1,fy-.8+17.9*sy,6*sx]; }
      else if(pick<.62&&far('lipcrag',x,z,9)){ kind='lipcrag';
        const s=RR(.45,.8), yT=Math.min(h+RR(.4,1.4),TOP-2);
        o={piece:kind,y:yT,yaw,pitch:RR(-.06,.1),roll:(R()-.5)*.14,scale:[s*RR(.8,1.2),s*RR(.7,1),1],tint:tint(.05,.9)};
        const f=fitBack(r,o,7.4,.6,-1); o.scale[2]=clamp((RR(1.4,2.4)+f.gap)/5.2,.3,1.1); put(o,r,f.dO); o.cw=[f.dO+f.gap,f.dO+5.2*o.scale[2],yT-7.4*o.scale[1],yT,4*o.scale[0]]; }
      else if(far('slab',x,z,8)){ kind='slab';
        const s=RR(.5,.9), y=Math.min(h+RR(.2,.9),TOP-2);
        o={piece:kind,y,yaw,pitch:RR(-.04,.08),roll:(R()-.5)*.1,scale:[s*RR(.8,1.3),s*RR(.8,1.2),1],tint:tint(.04,.92)};
        const f=fitBack(r,o,3.3,.5,-1); o.scale[2]=clamp((RR(1.4,2.2)+f.gap)/4.5,.3,1.1); put(o,r,f.dO); o.cw=[f.dO+f.gap,f.dO+4.5*o.scale[2],y-3.3*o.scale[1],y,4.3*o.scale[0]]; }
      if(o){ lat(o,r,(R()-.5)*1.2); const info=judge(o,true);
        if(info&&info.above>.15){ colsFor(o,r,o.cw[0],o.cw[1],o.cw[2],o.cw[3],o.cw[4]); delete o.cw; o.q=R()+WB; add(o); placed.push({k:kind,x,z}); }
        else rej(kind,'west'); }
      // at the step's foot: a scree fan against it, or a few fallen blocks just out from it
      const bx=x+nx*fd, bz=z+nz*fd;
      if(fh>3&&R()<.55){ const kind2=R()<.5?'scree':'boulders'; if(!far(kind2,bx,bz,kind2==='scree'?9:7))continue;
        const s=RR(.55,.95); let o2;
        if(kind2==='scree'){ const dF=faceD(r,fy+.3);
          o2={piece:'scree',y:fy-.3*s,yaw:yaw+(R()-.5)*.3,pitch:clamp(Math.atan2(fy-gh(bx+nx*4,bz+nz*4),4),-.1,.3),roll:(R()-.5)*.08,scale:[s*RR(.8,1.2),s*RR(.7,1.1),s],tint:tint(.04,.9)};
          put(o2,r,dF-.7); }
        else{ const d=RR(.8,3.5); o2={piece:'boulders',x:bx+nx*d,z:bz+nz*d,y:0,yaw:R()*TAU,scale:[s,s*RR(.8,1.2),s],tint:tint(.04,.88)}; o2.y=gh(o2.x,o2.z)-.35*s; }
        lat(o2,r,(R()-.5)*2);
        const info=judge(o2,true); if(!info||info.above<.3){ rej(kind2,'westfoot'); continue; }
        o2.col=[{x:o2.x+(kind2==='scree'?nx*1.6*s:0),z:o2.z+(kind2==='scree'?nz*1.6*s:0),r:(kind2==='scree'?3:2.2)*s,y0:o2.y-1,y1:o2.y+(kind2==='scree'?2.8:2.2)*s}];
        o2.q=R()+WB; add(o2); placed.push({k:kind2,x:bx,z:bz}); } }
    // fallen blocks on the moor along the escarpment's foot, just clear of the path's corridor
    for(let z=-40;z<=34;z+=RR(4,7)){ let x=88; while(x<118&&gh(x,z)<15.2)x+=.5; if(x>=118)continue;
      const d=RR(1,3.5), bx=x-d, s=RR(.5,.9); if(!far('boulders',bx,z,6))continue;
      const o2={piece:'boulders',x:bx,z:z+(R()-.5)*2,y:0,yaw:R()*TAU,scale:[s,s*RR(.8,1.2),s],tint:tint(.04,.88)}; o2.y=gh(o2.x,o2.z)-.35*s;
      const info=judge(o2,true); if(!info||info.above<.3){ rej('boulders','westmoor'); continue; }
      o2.col=[{x:o2.x,z:o2.z,r:2.2*s,y0:o2.y-1,y1:o2.y+2.2*s}]; o2.q=R()+WB; add(o2); placed.push({k:'boulders',x:bx,z}); }
    K.stats.west=placed.length; }
  W.tide=tide0;
  /* priority: the kinds take turns, best first, so every kind is in the mix at every quality level */
  const order=['lipcrag','buttress','scree','slab','boulders','stackSquat','lipcrag','scree','boulders'];
  for(const k in T)T[k].sort((a,b)=>b.q-a.q);
  const ix={}; let p=1e4;
  for(let round=0;round<200;round++){ let any=false;
    for(const k of order){ const L=T[k], j=ix[k]||0; if(j<L.length){ L[j].pri=p--; ix[k]=j+1; any=true; } } if(!any)break; }
  for(const o of out){ delete o.q; } for(const r of rim)delete r._e; SKB=null;
  place(out);
  K.stats.ms=Math.round(performance.now()-t0); K.stats.rim=N;
  K.stats.kinds={}; for(const k in T)K.stats.kinds[k]=T[k].length;
  K.debug.rim=rim; K.debug.keepOuts=KO;
}
K.debug.rebuild=build;

G.system('cliffkit',{order:9,modes:'always',
  init(){ try{ build(); if(!K.group.parent)G.scene.add(K.group);
      if(G.debug)console.log('[cliffkit]',JSON.stringify(K.stats)); }catch(e){ console.error('cliffkit',e); } }});
/* interact points registered after this module's init: drop any piece that crowds one */
G.on&&G.on('ready',()=>{ try{
  const KO=interactKO(); if(!KO.length||!K.placements.length)return;
  const keep=K.placements.filter(o=>{ const P=K.pieces[o.piece], A=P.geo.attributes.position; matrixOf(o,_m);
    for(let i=0;i<A.count;i+=P.step){ _v.fromBufferAttribute(A,i).applyMatrix4(_m);
      for(const k of KO){ const dx=_v.x-k.x, dz=_v.z-k.z; if(dx*dx+dz*dz<k.r*k.r&&_v.y>k.y0&&_v.y<k.y1)return false; } }
    return true; });
  if(keep.length<K.placements.length){ K.stats.droppedForInteract=K.placements.length-keep.length; place(keep); }
}catch(e){ console.error('cliffkit ready',e); } });
})();
