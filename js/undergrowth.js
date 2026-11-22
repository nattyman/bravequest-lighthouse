/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — undergrowth.js
   The wood's and the moor's small plants: hazel and holly shrubs, bramble mounds, bracken and fern clumps, gorse and
   heather (made in Blender by tools/florakit/build_bushes.py, embedded in js/bushkit_data.js as G.bushkitData, three
   levels of detail each). world.js hands over its fern and bush placements (Tiled objects) and this module draws them:
   the kind comes from where each one stands (old wood, moor, headland plateau) and a hash of its position, never from
   the world's random streams; position, yaw and scale are kept, the instance tint is carried as a gentle variation.
   Each 80 m tile is one merged mesh for the fern-like plants and one for the bushes (as many draws as before). A plant
   near a switch distance carries two levels in its tile's mesh and the shader dissolves one into the other by its own
   distance to G.focus (complementary screen-door dither, shadows too), so plants change one by one and smoothly; a
   tile's contents only change for plants whose levels are fully one way, and a rebuild copies the plants it keeps.
   Quality: saver = lowest detail everywhere, fewer ferns, no shadows; balanced and high: see Q.
   API: G.undergrowth = { build(ctx), kinds:{name:[geo0,geo1,geo2]}, plants(kind?), update(force), stats, debug }
   plants(kind) is the read-only list of placed plants ({kind,grp,x,y,z,q,s}), optionally one kind; [] before the build.
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U, D=G.bushkitData;
if(!D||!D.kinds){ console.warn('[undergrowth] no data: world.js keeps its own ferns and bushes'); return; }
let W=null;
const FERNY={fern:1,bracken:1};
const MAXH={bush:1.55,fern:1.15};                        // tallest a plant may stand once scaled
// switch distances per group, [centre, half band] for full -> mid and mid -> far (ferns are small: they switch nearer
// for the same size on screen); saver: the far level only
const Q={saver:{skip:.35,cast:false},
  balanced:{bush:[[20,2.5],[48,4]],fern:[[13,2],[38,3.5]],skip:0,cast:true},
  high:{bush:[[30,3],[68,4.5]],fern:[[24,2.5],[62,4.5]],skip:0,cast:true}};
const KEEP=1.75, SLACK=.75, PER_FRAME=2;                  // levels kept for +-KEEP m of focus travel; refresh SLACK m before
const UGU={f:{value:G.focus},fern:{value:new THREE.Vector4(-1e4,1,-1e4,1)},bush:{value:new THREE.Vector4(-1e4,1,-1e4,1)}};
const KS={shrub:1.35,holly:1.25,bramble:1.3,gorse:1.7,heather:2.0,fern:1.2,bracken:1.15}; // model size -> the old plants' bulk
const UG=G.undergrowth={kinds:{},build,update,add,plants,stats:{bytes:0,ms:0,tris:0,draws:0,instances:0,byKind:{}},debug:{}};

/* ---------- decode ---------- */
function b64(s,T){ const bin=atob(s), u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i); return new T(u8.buffer); }
const s2l=v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);
function decode(){
  let bytes=0;
  for(const name in D.kinds){ UG.kinds[name]=D.kinds[name].map(d=>{ bytes+=d.p.length+d.n.length+d.c.length+d.i.length;
    const q=b64(d.p,Int16Array), nq=b64(d.n,Int8Array), cq=b64(d.c,Uint8Array), ix=b64(d.i,Uint16Array), n=q.length/3;
    const pos=new Float32Array(n*3), nor=new Float32Array(n*3), col=new Float32Array(n*3);
    for(let i=0;i<n*3;i++){ const k=i%3; pos[i]=d.min[k]+(q[i]+32768)/65535*d.size[k]; nor[i]=nq[i]/127; col[i]=s2l(cq[i]/255); }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('normal',new THREE.BufferAttribute(nor,3));
    g.setAttribute('color',new THREE.BufferAttribute(col,3)); g.setIndex(new THREE.BufferAttribute(ix,1));
    g.computeBoundingSphere(); g.userData.h=d.size[1]; return g; }); }
  UG.stats.bytes=bytes;
}

/* ---------- materials: toon + the shared rim light + wind from the shared gust field + near fade + level dissolve ---------- */
function sway(sh){ const F=W.fol; sh.uniforms.uTime=F.SH.time; sh.uniforms.uWind=F.SH.wind;
  sh.vertexShader=F.wind+'\nattribute vec4 fol;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
  { float k=fol.z*fol.z*.5; transformed.xz+=bqTreeWind(fol.xy)*k;
    #ifndef BQ_LQ
    float fl=sin(uTime*3.1+dot(transformed,vec3(2.3,1.9,2.7)))*.025*k; transformed.x+=fl; transformed.z-=fl;
    #endif
  }`); }
// each vertex knows its plant (fol.xy) and level (fol.w): the level owns the dither values [lo,hi) at the plant's distance
function dissolve(sh,grp){ sh.uniforms.uUGf=UGU.f; sh.uniforms.uUGb=UGU[grp];
  sh.vertexShader='uniform vec3 uUGf;uniform vec4 uUGb;varying vec2 vUGr;\n'+sh.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
  { float d=distance(fol.xy,uUGf.xz), t1=clamp((d-uUGb.x)*uUGb.y,0.,1.), t2=clamp((d-uUGb.z)*uUGb.w,0.,1.);
    vUGr=fol.w<.5?vec2(t1,2.):fol.w<1.5?vec2(t2,t1):vec2(-1.,t2);
    if(max(vUGr.x,0.)>=min(vUGr.y,1.))gl_Position=vec4(0.,0.,-2.,1.); }`);
  sh.fragmentShader='varying vec2 vUGr;\n'+sh.fragmentShader.replace('void main() {',`void main() {
  { vec2 q=floor(gl_FragCoord.xy); float n=fract(fract(52.9829189*fract(dot(q,vec2(.06711056,.00583715))))+.5);
    if(n<vUGr.x||n>=vUGr.y)discard; }`); }
let depthMat=null;
function depthMaterial(){ if(depthMat)return depthMat;
  const m=depthMat=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  m.onBeforeCompile=sh=>{ sway(sh); dissolve(sh,'bush'); }; m.customProgramCacheKey=()=>'bqUGd'; return m; }
function material(double){
  const F=W.fol, m=G.toon('#ffffff',{vertexColors:true,side:double?THREE.DoubleSide:THREE.FrontSide});
  F.rim(m); const rim=m.onBeforeCompile;
  m.onBeforeCompile=(sh,r)=>{ rim(sh,r); sway(sh); dissolve(sh,double?'fern':'bush'); };
  G.nearFade(m,double?1.2:1.8,double?3.5:5.5);
  m.customProgramCacheKey=()=>'bqUG'+(double?'D':'S')+(m.defines&&m.defines.BQ_LQ?'q':'');
  F.mats.push(m); return m;
}

/* ---------- which plant stands where ---------- */
function kindOf(grp,x,z,y,ratio){
  const h=U.hash(x*.37+1.3,z*.29-2.1), n=U.vnoise(x*.07+11,z*.07-5);
  if(grp==='fern'){ const dc=Math.hypot(x+165,z-5), pd=W.pathDist?W.pathDist(x,z):99;
    const b=n*.75+(x>-92?.35:0)+(dc<26?.3:0)+(pd<6?.2:0)+h*.25; return b>.78?'bracken':'fern'; }
  if(ratio>.8){ // the old wood (the forest loop's bushes stand taller for their width than the moor's)
    if((x<-150?.22:0)+U.vnoise(x*.05-7,z*.05+3)*.62+h*.3>.74)return 'holly';
    const pd=W.pathDist?W.pathDist(x,z):99; return ((pd<8||n>.56)&&h<.78)||h<.25?'bramble':'shrub'; }
  if(x>112&&y>41)return h<.7?'gorse':'heather';            // the headland plateau: gorse by the sea wind
  const hn=U.fbm(x*.045+2,z*.045+8,3);                       // the ground's heather patches
  return (hn>.5?h<.78:h<.3)?'heather':'gorse';
}

/* ---------- placements -> tiles ---------- */
let tiles=[], mats=null, built=false;
const _m=new THREE.Matrix4(), _p=new THREE.Vector3(), _q=new THREE.Quaternion(), _s=new THREE.Vector3(), _v=new THREE.Vector3(), _n=new THREE.Vector3(), _c=new THREE.Color();
function gather(tl,grp,hollow,out){
  let sum=0, cnt=0; const raw=[];
  for(const [key,items] of tl.t)for(const [m,c] of items){
    const x=m.elements[12], z=m.elements[14];
    if(hollow&&Math.hypot(x-hollow.x,z-hollow.z)<hollow.r)continue;
    m.decompose(_p,_q,_s); const lum=c?(c.r+c.g+c.b)/3:1; sum+=lum; cnt++;
    raw.push({key,x,z,q:_q.clone(),s:_s.clone(),c:c?c.clone():null,lum,m}); }
  const mean=cnt?sum/cnt:1;
  for(const o of raw){
    const y=W.groundY(o.x,o.z), kind=kindOf(grp,o.x,o.z,y,o.s.y/o.s.x), H=UG.kinds[kind][0].userData.h; o.s.multiplyScalar(KS[kind]||1);
    if(o.s.y*H>MAXH[grp]){ const k=MAXH[grp]/(o.s.y*H); o.s.y*=k; }
    const t=new THREE.Color(1,1,1);
    if(o.c){ t.setRGB(o.c.r/o.lum,o.c.g/o.lum,o.c.b/o.lum).lerp(_c.setRGB(1,1,1),.8).multiplyScalar(U.clamp(Math.pow(o.lum/mean,.8),.78,1.25)); }
    if(grp==='fern')t.multiplyScalar(1.4);                 // fronds are thin: a little extra light so they part from the floor
    out.push({key:o.key,grp,kind,x:o.x,y:y-(grp==='fern'?.05:.03),z:o.z,q:o.q,s:o.s,tint:t,skip:grp==='fern'?U.hash(o.x*1.7+.3,o.z*1.3-.7):1,src:o.m});
  }
}
function build(ctx){
  const t0=performance.now(); W=G.world;
  if(!Object.keys(UG.kinds).length)decode();
  mats=mats||{fern:material(true),bush:material(false)};
  const LM=W.landmarks||{}, hv=LM.vigilHollow, hollow=hv?{x:hv.x,z:hv.z,r:hv.r+1.2}:null;
  const list=[]; gather(ctx.ferns,'fern',hollow,list); gather(ctx.bushes,'bush',hollow,list);
  UG.debug.handed={ferns:ctx.ferns.count,bushes:ctx.bushes.count,kept:list.length};
  UG.debug.list=list;
  const by=new Map();
  for(const o of list){ let T=by.get(o.key); if(!T){ T={key:o.key,fern:[],bush:[],box:new THREE.Box3(),mesh:{}}; by.set(o.key,T); }
    T[o.grp].push(o); T.box.expandByPoint(_v.set(o.x,o.y,o.z)); UG.stats.byKind[o.kind]=(UG.stats.byKind[o.kind]||0)+1; }
  tiles=[...by.values()];
  const root=ctx.root;
  for(const T of tiles)for(const grp of ['fern','bush']){ if(!T[grp].length)continue;
    const sph=new THREE.Sphere(); T.box.getBoundingSphere(sph); sph.radius+=2.2;
    const mesh=new THREE.Mesh(new THREE.BufferGeometry(),mats[grp]); mesh.name='undergrowth-'+grp; mesh.userData.bqUnder=1;
    mesh.receiveShadow=true; mesh.castShadow=false; mesh.matrixAutoUpdate=false; mesh.updateMatrix(); mesh.customDepthMaterial=depthMaterial();
    T.mesh[grp]={mesh,sph}; root.add(mesh); }
  UG.stats.instances=list.length; built=true;
  update(true);
  const prev=G.scene.onBeforeRender;
  G.scene.onBeforeRender=function(){ if(prev)prev.apply(this,arguments); update(false); };
  G.on('quality',()=>update(true));
  UG.stats.ms=Math.round(performance.now()-t0);
}

/* ---------- the placed plants, for other modules (forage.js picks its gorse from these): copies, so callers can't move them */
function plants(kind){ const L=UG.debug.list||[]; const out=[];
  for(const o of L){ if(kind&&o.kind!==kind)continue; out.push({kind:o.kind,grp:o.grp,x:o.x,y:o.y,z:o.z,q:o.q.clone(),s:o.s.clone()}); }
  return out; }

/* ---------- extra placements from elsewhere (the cottage garden): [{x,y,z,kind,h?}] -> one more tile, no colliders ---------- */
const GARDEN_H={shrub:.86,heather:.6};
function add(items,root){
  if(!built||!items.length)return false;
  const T={key:'extra'+tiles.length,fern:[],bush:[],box:new THREE.Box3(),mesh:{}};
  for(const it of items){ const kind=UG.kinds[it.kind]?it.kind:'shrub', g=UG.kinds[kind][0], H=g.userData.h;
    const k=(it.h||GARDEN_H[kind]||.8)/H, hh=U.hash(it.x*.91+.2,it.z*1.13-.4);
    const q=new THREE.Quaternion().setFromAxisAngle(_v.set(0,1,0),hh*Math.PI*2);
    T.bush.push({key:T.key,grp:'bush',kind,x:it.x,y:it.y-.03,z:it.z,q,s:new THREE.Vector3(k*(1+.1*hh),k,k*(1.1-.1*hh)),tint:new THREE.Color(1,1,1).multiplyScalar(.95+.12*hh),skip:1});
    T.box.expandByPoint(_v.set(it.x,it.y,it.z)); UG.stats.byKind[kind]=(UG.stats.byKind[kind]||0)+1; }
  const sph=new THREE.Sphere(); T.box.getBoundingSphere(sph); sph.radius+=2.2;
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),mats.bush); mesh.name='undergrowth-garden'; mesh.userData.bqUnder=1;
  mesh.receiveShadow=true; mesh.castShadow=false; mesh.matrixAutoUpdate=false; mesh.updateMatrix(); mesh.customDepthMaterial=depthMaterial();
  T.mesh.bush={mesh,sph}; (root||G.scene).add(mesh); tiles.push(T); UG.stats.instances+=T.bush.length;
  update(true); return true;
}

/* ---------- one merged mesh per tile and group: each plant with the levels it can show before the next refresh ---------- */
function setBands(q){ for(const grp of ['fern','bush']){ const b=q[grp], B=UGU[grp].value;
  if(b)B.set(b[0][0]-b[0][1],.5/b[0][1],b[1][0]-b[1][1],.5/b[1][1]); else B.set(-1e4,1,-1e4,1); } }
function need(bands,a,b){ // bit per level visible somewhere in [a,b] metres
  if(!bands)return 4; const [s1,h1]=bands[0], [s2,h2]=bands[1];
  return (a<s1+h1?1:0)|(b>s1-h1&&a<s2+h2?2:0)|(b>s2-h2?4:0); }
function rebuild(T,grp,f,q){
  const M=T.mesh[grp]; if(!M)return;
  const items=T[grp], n=items.length, inc=new Uint8Array(n), old=M.inc, ov=M.v0, oi=M.i0, O=M.arr, bands=q[grp];
  let nv=0, ni=0;
  for(let j=0;j<n;j++){ const o=items[j]; if(q.skip&&o.skip<q.skip)continue;
    const d=Math.hypot(o.x-f.x,o.z-f.z), m=need(bands,d-KEEP,d+KEEP); inc[j]=m;
    for(let l=0;l<3;l++)if(m>>l&1){ const g=UG.kinds[o.kind][l]; nv+=g.attributes.position.count; ni+=g.index.count; } }
  const pos=new Float32Array(nv*3), nor=new Float32Array(nv*3), col=new Float32Array(nv*3), fol=new Float32Array(nv*4);
  const idx=nv>65535?new Uint32Array(ni):new Uint16Array(ni), v0=new Int32Array(n*3), i0=new Int32Array(n*3);
  let V=0, I0=0, made=0;
  for(let j=0;j<n;j++){ const m=inc[j]; if(!m)continue; const o=items[j];
    for(let l=0;l<3;l++){ if(!(m>>l&1))continue;
      const g=UG.kinds[o.kind][l], P=g.attributes.position.array, I=g.index.array, c=P.length/3, k=j*3+l;
      v0[k]=V; i0[k]=I0;
      if(old&&old[j]>>l&1){ const a=ov[k], b=oi[k]; // kept: copy the plant's level from the last build
        pos.set(O.pos.subarray(a*3,(a+c)*3),V*3); nor.set(O.nor.subarray(a*3,(a+c)*3),V*3); col.set(O.col.subarray(a*3,(a+c)*3),V*3); fol.set(O.fol.subarray(a*4,(a+c)*4),V*4);
        const src=O.idx, sh=V-a; for(let i=0;i<I.length;i++)idx[I0+i]=src[b+i]+sh; }
      else{ made++; _m.compose(_p.set(o.x,o.y,o.z),o.q,o.s); const e=_m.elements, N=g.attributes.normal.array, C=g.attributes.color.array, t=o.tint;
        for(let i=0;i<c;i++){ const a=i*3, b=(V+i)*3, x=P[a], y=P[a+1], z=P[a+2], w=(V+i)*4;
          pos[b]=e[0]*x+e[4]*y+e[8]*z+e[12]; pos[b+1]=e[1]*x+e[5]*y+e[9]*z+e[13]; pos[b+2]=e[2]*x+e[6]*y+e[10]*z+e[14];
          _n.set(N[a],N[a+1],N[a+2]).applyQuaternion(o.q); nor[b]=_n.x; nor[b+1]=_n.y; nor[b+2]=_n.z;
          col[b]=C[a]*t.r; col[b+1]=C[a+1]*t.g; col[b+2]=C[a+2]*t.b;
          fol[w]=o.x; fol[w+1]=o.z; fol[w+2]=Math.max(0,y*o.s.y); fol[w+3]=l; }
        for(let i=0;i<I.length;i++)idx[I0+i]=I[i]+V; }
      V+=c; I0+=I.length; } }
  M.inc=inc; M.extra=inc.some(m=>m&3); M.far=false; M.v0=v0; M.i0=i0; M.arr={pos,nor,col,fol,idx}; M.bp={x:f.x,z:f.z};
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3)); geo.setAttribute('normal',new THREE.BufferAttribute(nor,3));
  geo.setAttribute('color',new THREE.BufferAttribute(col,3)); geo.setAttribute('fol',new THREE.BufferAttribute(fol,4));
  geo.setIndex(new THREE.BufferAttribute(idx,1)); geo.boundingSphere=M.sph.clone();
  M.mesh.geometry.dispose(); M.mesh.geometry=geo; M.mesh.visible=ni>0;
  M.mesh.castShadow=grp==='bush'&&q.cast; M.tris=ni/3; UG.debug.made=(UG.debug.made||0)+made; UG.debug.rebuilds=(UG.debug.rebuilds||0)+1;
}
// how soon a tile group needs new contents: 2 = a level is showing that it lacks, 1 = within SLACK m of that, 0 = fine
function urgency(T,grp,f,q){
  const M=T.mesh[grp]; if(!M)return 0; if(!M.inc)return 2;
  const items=T[grp], inc=M.inc, bands=q[grp]; let u=0;
  for(let j=0;j<items.length;j++){ const o=items[j]; if(q.skip&&o.skip<q.skip)continue;
    const d=Math.hypot(o.x-f.x,o.z-f.z);
    if(need(bands,d-SLACK,d+SLACK)&~inc[j]){ if(need(bands,d,d)&~inc[j])return 2; u=1; } }
  return u;
}
let qLevel=null;
function update(force){
  if(!built)return;
  const f=G.focus, lvl=(G.quality&&G.quality.level)||'balanced', q=Q[lvl]||Q.balanced;
  if(lvl!==qLevel){ qLevel=lvl; force=true; }
  if(force)setBands(q);
  let n=0; const due=[];
  for(const T of tiles){
    // a tile whose every plant is past the last switch (and was built so) keeps its far levels until the focus nears it
    const td=T.box.distanceToPoint(_v.set(f.x,T.box.min.y,f.z));
    for(const grp of ['fern','bush']){ const M=T.mesh[grp]; if(!M)continue;
      const b=q[grp], far=!b||td>b[1][0]+b[1][1]+KEEP+2;
      if(force){ rebuild(T,grp,f,q); n++; continue; }
      if(far&&M.far)continue;
      const u=urgency(T,grp,f,q);
      if(far&&!u){ if(M.extra)due.push([T,grp,-1]); else M.far=true; continue; }
      M.far=false;
      if(u===2){ rebuild(T,grp,f,q); n++; } else if(u)due.push([T,grp,Math.hypot(f.x-M.bp.x,f.z-M.bp.z)]); } }
  due.sort((a,b)=>b[2]-a[2]);
  for(const [T,grp] of due){ if(n>=PER_FRAME)break; rebuild(T,grp,f,q); n++; }
  if(n){ let tr=0, dr=0; for(const T of tiles)for(const g in T.mesh){ if(T.mesh[g].mesh.visible){ tr+=T.mesh[g].tris; dr++; } } UG.stats.tris=tr; UG.stats.draws=dr; }
}

/* ---------- test helpers: what the camera sees of the undergrowth (r128's own frustum test) ---------- */
UG.debug.count=()=>{ const cam=G.camera; cam.updateMatrixWorld(); const fr=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse));
  const r={tris:0,draws:0,shadowDraws:0}; G.scene.traverseVisible(o=>{ if(!o.isMesh||!o.userData.bqUnder)return; if(o.frustumCulled&&!fr.intersectsObject(o))return;
    const g=o.geometry; let t=(g.index?g.index.count:g.attributes.position.count)/3; if(o.isInstancedMesh)t*=o.count; if(!t)return; r.tris+=t; r.draws++; if(o.castShadow)r.shadowDraws++; });
  r.tris=Math.round(r.tris); return r; };
UG.debug.signature=()=>{ let s=0, k=0; for(const o of UG.debug.list){ const e=o.src.elements; for(let i=0;i<16;i++){ s=(s+e[i]*(i+1)*(++k%97+1))%1e9; } } return {n:UG.debug.list.length,sum:Math.round(s*1e3)/1e3}; };
/* ?ugmain draws the handed-over placements the old way (same Tiled builds as world.js) for side-by-side numbers */
if(/[?&]ugmain/.test(location.search)){ const real=build; UG.build=ctx=>{ W=G.world; const LM=W.landmarks||{}, hv=LM.vigilHollow;
    const list=[]; gather(ctx.ferns,'fern',hv?{x:hv.x,z:hv.z,r:hv.r+1.2}:null,list); UG.debug.list=list.concat((()=>{const l=[]; gather(ctx.bushes,'bush',hv?{x:hv.x,z:hv.z,r:hv.r+1.2}:null,l); return l;})());
    UG.debug.handed={ferns:ctx.ferns.count,bushes:ctx.bushes.count,kept:UG.debug.list.length};
    for(const t of [ctx.ferns,ctx.bushes])for(const m of t.build(ctx.root))m.userData.bqUnder=1; }; UG.debug.real=real;
  if(!Object.keys(UG.kinds).length)decode(); }
})();
