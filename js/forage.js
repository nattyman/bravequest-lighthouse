/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — forage.js
   Ingredients gathered out in the world for the keeper's oils (Spec: OILS.md).
     · The charcoal-burners' kiln in the old wood: a cold turf-and-stone kiln with a pitch pot, there from a new game.
       Interact "Scrape pitch" for 2 pitch; the pot refills after 240 s of play. A note pinned to a post by the kiln
       teaches the Kilnfire recipe the first time it is read (later reads just show it again).
     · The keeper's page on the sea cave's bench teaches Burst Oil (only readable inside the cave).
     · Holly berries on ten of the deep wood's real holly bushes (more of them west of x=-150), the same way as the gorse.
     · Gorse blossom on a dozen of the moor's and headland's real gorse bushes (picked deterministically from the
       undergrowth's plant list, well apart, on open walkable ground): walk into one for 1-2 blossom; it regrows in 240 s.
       All the blossom is one InstancedMesh (a picked bush's instance is scaled to zero) and every spot shares one Points
       glint, so the whole module adds a handful of draw calls.
   Nothing can be picked, scraped or read until the core loop is active (G.loop.active / 'loop:start').
   The kiln is drawn from the start; blossom and glints only once the loop runs.
   Save: G.persist 'forage' {v:1, left:{spotId:seconds}, notes:{kiln:true}, tree:{draws,dead}}; spots by id, never by index.
   Events: forage:pick {id,item,n,pos} · forage:note {id}
   API: G.forage = { ITEMS, spots:[{id,item,pos,ready,left}], kiln:{pos,noteRead}, tree (null until the tree is built),
                     REGROW, debug:{ripen(), pick(id), near(item), tp(id), state()} }
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U;
const PI=Math.PI, TAU=PI*2, V=(x,y,z)=>new THREE.Vector3(x,y,z);
const REGROW=240, PICK_R=1.5, GORSE_N=12, GORSE_GAP=18, HOLLY_N=10, HOLLY_GAP=14, SCRAPE_N=2;
const ITEMS=['pitch','gorse','holly','sap'];
const NOTE_WHO='A charcoal-burner’s note';
const NOTE='Pitch off the kiln floor, worked warm into the wood. Gorse flower for the bite: nothing on this moor burns like gorse. A stick dressed so will carry fire a minute and more. Mind your sleeves.';
// the kiln place: the pot stands where the boat quest's pitch has always been; the mound sits back from it in a gap
// between the trees, its mouth turned to the pot; the note's post stands on the far side
const POT={x:-104,z:-7}, KC={x:-102.9,z:-9.9}, POST={x:-101.05,z:-10.75}, KILN_R=1.45;

// keep the wood's undergrowth out of the kiln's little clearing (undergrowth.js reads these when the world builds)
if(G.world&&G.world.plantClearings)G.world.plantClearings.push({x:KC.x,z:KC.z,r:KILN_R+1.4},{x:POT.x,z:POT.z,r:1.5},{x:POST.x,z:POST.z,r:.9});
const H=(x,z)=>G.world.height(x,z);
const looping=()=>!!(G.loop&&G.loop.active);
const isPlay=()=>G.state&&G.state.mode==='play';
const col=c=>U.col(c);
const fmt=s=>{ s=Math.max(0,Math.ceil(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

const S={notes:{},tree:{draws:0,dead:false}};
const spots=[];              // {id,item,pos,ready,left, i (gorse instance), top (glint pos), grow}
const byId={};
const kiln={pos:V(POT.x,0,POT.z),get noteRead(){ return !!S.notes.kiln; }};
const F=G.forage={ITEMS,spots,kiln,tree:null,REGROW,get built(){ return built; }};   // tree: the Resisting Tree's sap comes later

/* ------------------------------------------------------------------ the kiln (one merged mesh + its outline, the pitch) */
let kilnMesh=null, tar=null, built=false;
function kilnGeo(GE,y0){
  const parts=[], rnd=U.rng(7051);
  const turf=col('#6a7a44'), earth=col('#77603f'), soot=col('#3a312b'), hole=col('#0d0a0a'), stone=col('#9a948a'), stone2=col('#857f76'), moss=col('#4a5a34'),
    wood=col('#5a4231'), wood2=col('#3e2e22'), iron=col('#2b2729'), paper=col('#f6eed8'), ink=col('#6e6152'), char=col('#1b1716');
  const lh=(x,z)=>H(KC.x+x,KC.z+z)-y0;                       // local ground height
  const md=new THREE.Vector2(POT.x-KC.x,POT.z-KC.z).normalize(), mA=Math.atan2(md.x,md.y);
  // the turf dome: low and lumpy, sooted round the vent, the mouth a dark arch toward the pot
  const dome=new THREE.SphereGeometry(1,18,9,0,TAU,0,PI/2), DP=dome.attributes.position;
  for(let i=0;i<DP.count;i++){ const x=DP.getX(i), y=DP.getY(i), z=DP.getZ(i), n=U.vnoise(x*2.3+4,z*2.3+y*1.7-1);
    const k=1+(n-.5)*.16; DP.setXYZ(i,x*KILN_R*k,y*1.02*k-.12,z*KILN_R*k); }
  dome.computeVertexNormals();
  parts.push({g:dome,m:GE.mat4(0,lh(0,0),0,0,0,0),c:(p,nn,o)=>{
    const r=Math.hypot(p.x,p.z)||1, dx=p.x/r, dz=p.z/r, facing=dx*md.x+dz*md.y, hy=p.y-lh(0,0);
    o.copy(earth).lerp(turf,U.clamp(.35+U.vnoise(p.x*1.6+2,p.z*1.6-3)*.9,0,1));
    if(hy>.62)o.lerp(soot,U.smooth(.62,.86,hy));
    if(facing>.82&&hy<.62){ const t=U.smooth(.82,.92,facing)*U.smooth(.62,.5,hy); o.lerp(char,U.clamp(t*1.4,0,1)); if(t>.55)o.copy(hole); } }});
  // a ring of footing stones round the base, the mouth's two jambs and a lintel over it
  for(let k=0;k<15;k++){ const a=mA+(k+.5)/15*TAU; if(Math.abs(Math.atan2(Math.sin(a-mA),Math.cos(a-mA)))<.42)continue;
    const R=KILN_R+.05+rnd()*.08, x=Math.sin(a)*R, z=Math.cos(a)*R, s=.22+rnd()*.13;
    parts.push({g:GE.blob(s,1,rnd()*20,.28),m:GE.mat4(x,lh(x,z)+s*.25,z,rnd(),a,rnd()*.4,1.25,.8,1),c:(p,nn,o)=>o.copy(rnd()<.5?stone:stone2).lerp(moss,U.smooth(.3,.9,nn.y)*.7)}); }
  for(const sd of [-1,1]){ const a=mA+sd*.47, R=KILN_R+.02, x=Math.sin(a)*R, z=Math.cos(a)*R;
    parts.push({g:new THREE.BoxGeometry(.26,.62,.3),m:GE.mat4(x,lh(x,z)+.24,z,0,a,sd*.06),c:(p,nn,o)=>o.copy(stone2).lerp(moss,U.smooth(.5,1,nn.y)*.5)}); }
  { const R=KILN_R+.04, x=Math.sin(mA)*R, z=Math.cos(mA)*R;
    parts.push({g:new THREE.BoxGeometry(1.05,.18,.34),m:GE.mat4(x,lh(x,z)+.62,z,0,mA,0),c:(p,nn,o)=>o.copy(stone2).lerp(moss,U.smooth(.6,1,nn.y)*.8)}); }
  // the vent: a charred lip at the crown, a couple of burnt stakes
  parts.push({g:new THREE.TorusGeometry(.2,.07,5,12),m:GE.mat4(0,lh(0,0)+.86,0,PI/2,0,0),c:char});
  for(const [a,l] of [[.6,.55],[2.9,.42]])parts.push({g:new THREE.CylinderGeometry(.025,.035,l,5),m:GE.mat4(Math.sin(a)*.15,lh(0,0)+.86+l*.4,Math.cos(a)*.15,.25*Math.cos(a),0,.25*Math.sin(a)),c:char});
  // the kiln floor in front of the mouth: a sooty, pitch-stained scrape that follows the ground
  { const cx=md.x*(KILN_R+.6), cz=md.y*(KILN_R+.6), N=14, pos=[];
    for(let k=0;k<N;k++){ const a0=k/N*TAU, a1=(k+1)/N*TAU, r0=.6+U.vnoise(Math.cos(a0)*2+9,Math.sin(a0)*2)*.45, r1=.6+U.vnoise(Math.cos(a1)*2+9,Math.sin(a1)*2)*.45;
      for(const [x,z] of [[cx,cz],[cx+Math.sin(a1)*r1*1.15,cz+Math.cos(a1)*r1],[cx+Math.sin(a0)*r0*1.15,cz+Math.cos(a0)*r0]])pos.push(x,lh(x,z)+.035,z); }
    const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    const nn=new Float32Array(pos.length); for(let i=1;i<nn.length;i+=3)nn[i]=1; g.setAttribute('normal',new THREE.BufferAttribute(nn,3));
    parts.push({g,c:(p,n,o)=>o.copy(char).lerp(earth,.25+U.clamp(Math.hypot(p.x-cx,p.z-cz)*.45,0,.5))}); }
  // charcoal lumps left on the floor and a few split logs stacked by the side
  for(let k=0;k<9;k++){ const a=mA+(rnd()-.5)*1.3, R=KILN_R+.35+rnd()*1.1, x=Math.sin(a)*R, z=Math.cos(a)*R, s=.06+rnd()*.06;
    parts.push({g:GE.blob(s,0,rnd()*9,.3),m:GE.mat4(x,lh(x,z)+s*.5,z,rnd(),rnd()*3,0),c:char}); }
  { const a=mA+2.1, R=KILN_R+.7, bx=Math.sin(a)*R, bz=Math.cos(a)*R;
    for(const [dx,dy,dz,ry] of [[-.2,.13,0,0],[.2,.13,.02,.05],[0,.36,.01,-.04]]){ const x=bx+dx*Math.cos(a), z=bz-dx*Math.sin(a);
      parts.push({g:new THREE.CylinderGeometry(.13,.14,1.1,7),m:GE.mat4(x,lh(bx,bz)+dy,z,PI/2,a+PI/2+ry,0),c:(p,nn,o)=>o.copy(wood).lerp(wood2,U.smooth(.2,.9,Math.abs(nn.y))*.3)}); } }
  // the pitch pot: an open iron pot on three stones, a wooden scraper leaning in it
  { const px=POT.x-KC.x, pz=POT.z-KC.z, py=lh(px,pz)+.1;
    for(let k=0;k<3;k++){ const a=k/3*TAU+.4, x=px+Math.sin(a)*.22, z=pz+Math.cos(a)*.22; parts.push({g:GE.blob(.11,0,k*3+1,.25),m:GE.mat4(x,lh(x,z)+.04,z,0,a,0,1.2,.8,1.1),c:stone2}); }
    parts.push({g:new THREE.CylinderGeometry(.32,.25,.5,12,1,true),m:GE.mat4(px,py+.25,pz,0,0,0),c:iron});
    parts.push({g:new THREE.CircleGeometry(.25,12),m:GE.mat4(px,py+.01,pz,-PI/2,0,0),c:iron});
    parts.push({g:new THREE.TorusGeometry(.32,.03,4,14),m:GE.mat4(px,py+.5,pz,PI/2,0,0),c:iron});
    parts.push({g:new THREE.BoxGeometry(.07,.95,.03),m:GE.mat4(px+.12,py+.62,pz-.06,.12,mA,.38),c:wood});
    parts.push({g:new THREE.BoxGeometry(.16,.12,.025),m:GE.mat4(px+.01,py+.22,pz-.02,.12,mA,.38),c:char}); }
  // the note's post: a stake by the kiln with a sheet nailed to it, turned toward the trail
  { const x=POST.x-KC.x, z=POST.z-KC.z, g0=lh(x,z), ya=Math.atan2(POT.x-POST.x+.6,POT.z-POST.z+2.4);
    parts.push({g:new THREE.CylinderGeometry(.06,.075,1.25,6),m:GE.mat4(x,g0+.55,z,.05,0,-.04),c:wood2});
    parts.push({g:new THREE.BoxGeometry(.4,.5,.015),m:GE.mat4(x+Math.sin(ya)*.075,g0+.88,z+Math.cos(ya)*.075,-.04,ya,.03),c:(p,nn,o)=>{ o.copy(paper); if(Math.abs(nn.x)+Math.abs(nn.z)>.5&&Math.sin(p.y*90)>.6)o.lerp(ink,.5); }});
    parts.push({g:new THREE.CylinderGeometry(.015,.015,.05,4),m:GE.mat4(x+Math.sin(ya)*.09,g0+1.05,z+Math.cos(ya)*.09,PI/2,ya,0),c:iron}); }
  return GE.mergeParts(parts);
}
function buildKiln(){
  const GE=G.world&&G.world.geo; if(!GE)return false;
  const y0=H(KC.x,KC.z);
  kilnMesh=new THREE.Mesh(kilnGeo(GE,y0),G.toon('#ffffff',{vertexColors:true,side:THREE.DoubleSide}));
  kilnMesh.name='charcoalKiln'; kilnMesh.position.set(KC.x,y0,KC.z); kilnMesh.castShadow=true; kilnMesh.receiveShadow=true;
  G.outline&&G.outline(kilnMesh,{thickness:.02}); G.scene.add(kilnMesh);
  // the pitch in the pot: glossy and near the rim when there's some, a dull crust low in the pot when scraped bare
  const py=H(POT.x,POT.z)+.1;
  tar=new THREE.Mesh(new THREE.CircleGeometry(.29,14),new THREE.MeshPhongMaterial({color:col('#0c0a0b'),specular:col('#8a7660'),shininess:80}));
  tar.rotation.x=-PI/2; tar.position.set(POT.x,py+.44,POT.z); tar.name='kilnPitch'; tar.userData.full=py+.44; tar.userData.low=py+.09; G.scene.add(tar);
  G.addCollider({x:KC.x,z:KC.z,r:KILN_R,y0:y0-2,y1:y0+1.1});
  kiln.pos.set(POT.x,H(POT.x,POT.z),POT.z);
  return true;
}

/* ------------------------------------------------------------------ the bushes: gorse on the moor, holly in the deep wood */
// one table row per bush ingredient: which plants, how many, how far apart, where they may stand, how the fruit looks
const BUSH={
  gorse:{kind:'gorse',n:GORSE_N,gap:GORSE_GAP,clear:1.6,ring:2.6,glint:[1,.82,.32],speck:.055,max:110,keep:.6,lift:.035,
    colors:['#f2c02c','#e9a91c','#f6d65e','#dca11a'],emissive:'#3a2806',
    // spread out from the moor's middle, nudged toward the trails so they are found
    first:c=>Math.hypot(c.o.x-20,c.o.z),score:(c,md)=>Math.min(md,55)-.6*Math.max(0,c.pd-5)},
  holly:{kind:'holly',n:HOLLY_N,where:o=>o.x<-76,gap:HOLLY_GAP,clear:.9,ring:1.8,glint:[1,.42,.4],speck:.05,max:90,keep:.5,lift:.03,
    colors:['#b8172a','#d22834','#9c1222','#e0403c'],emissive:'#3a0608',
    // the deep wood, more of them west of x=-150: the far west counts as nearer when spreading them
    first:c=>Math.hypot(c.o.x+190,c.o.z),score:(c,md)=>Math.min(md,40)+(c.o.x<-150?14:0)-.25*Math.max(0,c.pd-8)}
};
const bushes={};                 // item -> {mesh, list}
let glint=null, gCol=null, kilnPt=-1;
const _m=new THREE.Matrix4(), _z=new THREE.Matrix4().makeScale(0,0,0), _s=new THREE.Vector3();
function openGround(x,z,y,B){
  const W=G.world;
  if(W.walkable&&!W.walkable(x,z))return false;
  if(y<3)return false;
  if(Math.abs(G.floorAt(x,z,y+2)-(y+.03))>.5)return false;                // nothing built over it
  for(let k=0;k<8;k++){ const a=k/8*TAU, qx=x+Math.sin(a)*B.ring, qz=z+Math.cos(a)*B.ring;   // room all round: no cliff edge, no wall
    if(W.walkable&&!W.walkable(qx,qz))return false; if(Math.abs(H(qx,qz)-y)>1.1)return false; }
  for(const c of G.collidersNear(x,z))if(Math.hypot(c.x-x,c.z-z)<c.r+B.clear)return false;
  for(const b of G.boxColliders){ if(Math.abs(b.x-x)>40||Math.abs(b.z-z)>40)continue; const cs=Math.cos(b.yaw||0), sn=Math.sin(b.yaw||0), dx=x-b.x, dz=z-b.z;
    const lx=dx*cs-dz*sn, lz=dx*sn+dz*cs; if(Math.abs(lx)<b.hw+B.clear+.4&&Math.abs(lz)<b.hd+B.clear+.4)return false; }
  const LM=W.landmarks||{};
  for(const [k,r] of [['lighthouse',14],['cottage',11],['shed',8],['hamlet',17],['stones',9],['halloran',5],['start',5],['cliffPathTop',6],['cliffPathBottom',6],['lanternSpot',5]]){ const l=LM[k]; if(l&&Math.hypot(l.x-x,l.z-z)<r)return false; }
  const rt=LM.resistingTree; if(rt&&Math.hypot(rt.x-x,rt.z-z)<(rt.r||14)+3)return false;     // the Resisting Tree's clearing
  const vh=LM.vigilHollow; if(vh&&Math.hypot(vh.x-x,vh.z-z)<(vh.r||8)+4)return false;        // the Vigil's hollow
  for(const c of W.plantClearings||[])if(Math.hypot(c.x-x,c.z-z)<c.r+1)return false;
  return true;
}
function choose(B){
  const UG=G.undergrowth; if(!UG||!UG.plants)return [];
  const W=G.world, cand=[];
  for(const o of UG.plants(B.kind)){ const y=o.y+.03; if(B.where&&!B.where(o))continue; if(!openGround(o.x,o.z,y,B))continue;
    cand.push({o,pd:W.pathDist?W.pathDist(o.x,o.z):10,h:U.hash(o.x*.13+.7,o.z*.19-.3)}); }
  if(!cand.length)return [];
  // each next pick is the best-scoring bush that keeps its distance from those already chosen (deterministic)
  const pick=[]; let first=cand[0], fd=1e9;
  for(const c of cand){ const d=B.first(c)+c.h; if(d<fd){ fd=d; first=c; } }
  pick.push(first);
  while(pick.length<B.n){ let best=null, bs=-1e9;
    for(const c of cand){ if(pick.includes(c))continue; let md=1e9; for(const p of pick)md=Math.min(md,Math.hypot(c.o.x-p.o.x,c.o.z-p.o.z));
      if(md<B.gap)continue; const sc=B.score(c,md)+c.h; if(sc>bs){ bs=sc; best=c; } }
    if(!best)break; pick.push(best); }
  return pick.map(c=>c.o);
}
// fruit or flower specks sampled off the plant model's own upper surface, so they sit on the bush at its placement transform
function fruitGeo(B){
  const UG=G.undergrowth, src=UG&&UG.kinds&&UG.kinds[B.kind]&&UG.kinds[B.kind][0];
  const parts=[], GE=G.world.geo, cs=B.colors.map(col);
  const speck=B.kind==='holly'?new THREE.IcosahedronGeometry(B.speck,0):new THREE.OctahedronGeometry(B.speck,0);
  if(src){ const P=src.attributes.position, N=src.attributes.normal, h=src.userData.h||1, n=P.count; let k=0;
    for(let i=0;i<n&&k<B.max;i++){ const j=(i*97+13)%n, y=P.getY(j), ny=N.getY(j); if(y<h*.3||ny<-.15)continue;
      if(U.hash(P.getX(j)*31.7+j*.01,P.getZ(j)*27.3)>B.keep)continue;
      const s=.75+U.hash(j*.37,1.3)*.6, x=P.getX(j)+N.getX(j)*B.lift, yy=y+N.getY(j)*B.lift, z=P.getZ(j)+N.getZ(j)*B.lift;
      if(B.kind==='holly'){ for(let q=0;q<3;q++){ const a=q*2.1+j; parts.push({g:speck,m:GE.mat4(x+Math.sin(a)*.045,yy-q*.02,z+Math.cos(a)*.045,0,0,0,s),c:cs[(j+q)%4]}); } k+=3; }
      else{ parts.push({g:speck,m:GE.mat4(x,yy,z,j,j*.7,0,s,s*.8,s),c:cs[j%4]}); k++; } } }
  else for(let i=0;i<40;i++){ const a=i*2.4, r=.2+(i%7)*.08; parts.push({g:speck,m:GE.mat4(Math.sin(a)*r,.4+(i%5)*.12,Math.cos(a)*r,i,i,0),c:cs[i%4]}); }
  return GE.mergeParts(parts);
}
function fruitMat(B){
  const W=G.world, FO=W.fol, m=G.toon('#ffffff',{vertexColors:true,emissive:B.emissive});
  if(FO&&FO.SH&&FO.wind){
    // sway with the bush under it: the undergrowth bends each plant by the shared wind field at its root, more with height
    m.onBeforeCompile=sh=>{ sh.uniforms.uTime=FO.SH.time; sh.uniforms.uWind=FO.SH.wind;
      sh.vertexShader=FO.wind+'\n'+sh.vertexShader.replace('#include <project_vertex>',`vec4 mvPosition=vec4(transformed,1.);
  #ifdef USE_INSTANCING
  mvPosition=instanceMatrix*mvPosition;
  { vec2 ip=instanceMatrix[3].xz; float hh=max(0.,mvPosition.y-instanceMatrix[3].y); mvPosition.xz+=bqTreeWind(ip)*hh*hh*.5; }
  #endif
  mvPosition=modelViewMatrix*mvPosition;
  gl_Position=projectionMatrix*mvPosition;`); };
    m.customProgramCacheKey=()=>'bqBushFruit'+(m.defines&&m.defines.BQ_LQ!=null?'q':'');
    if(FO.mats)FO.mats.push(m); }
  G.nearFade&&G.nearFade(m,1.8,5.5);
  return m;
}
function buildBush(item){
  const B=BUSH[item], list=choose(B); if(!list.length)return [];
  const mesh=new THREE.InstancedMesh(fruitGeo(B),fruitMat(B),list.length);
  mesh.name=item==='gorse'?'gorseBlossom':'hollyBerries'; mesh.frustumCulled=false; mesh.castShadow=false; mesh.receiveShadow=true; mesh.visible=false;
  const hh=(G.undergrowth.kinds[B.kind]&&G.undergrowth.kinds[B.kind][0].userData.h)||1, out=[];
  bushes[item]={mesh,list:out};
  list.forEach((o,i)=>{ const id=item+':'+Math.round(o.x)+','+Math.round(o.z);
    const s={id,item,pos:V(o.x,o.y+.03,o.z),ready:true,left:0,i,q:o.q,sc:o.s,grow:1};
    s.top=V(o.x,o.y+hh*o.s.y*.9,o.z); spots.push(s); byId[id]=s; out.push(s); place(s); });
  mesh.instanceMatrix.needsUpdate=true; G.scene.add(mesh);
  return out;
}
// one shared glint for every spot: each bush's crown, and the kiln's pot
function buildGlint(){
  const pts=spots.filter(s=>s.top||s.item==='pitch'), gp=new Float32Array(pts.length*3); gCol=new Float32Array(pts.length*3);
  pts.forEach((s,k)=>{ s.gi=k; if(s.item==='pitch'){ kilnPt=k; gp[k*3]=POT.x; gp[k*3+1]=H(POT.x,POT.z)+.8; gp[k*3+2]=POT.z; }
    else{ gp[k*3]=s.top.x; gp[k*3+1]=s.top.y+.1; gp[k*3+2]=s.top.z; } });
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(gp,3)); g.setAttribute('color',new THREE.BufferAttribute(gCol,3));
  glint=new THREE.Points(g,new THREE.PointsMaterial({size:.9,map:G.tex.flame,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,sizeAttenuation:true}));
  glint.name='forageGlint'; glint.frustumCulled=false; glint.renderOrder=4; glint.visible=false; G.scene.add(glint);
}
function place(s){
  const b=bushes[s.item]; if(!b||s.i==null)return; const mesh=b.mesh;
  if(!s.ready){ mesh.setMatrixAt(s.i,_z); }
  else{ const k=s.grow<1?.2+.8*U.smooth(0,1,s.grow):1; mesh.setMatrixAt(s.i,_m.compose(s.pos.clone().setY(s.pos.y-.03),s.q,_s.copy(s.sc).multiplyScalar(k))); }
  mesh.instanceMatrix.needsUpdate=true;
}

/* ------------------------------------------------------------------ the kiln spot, picking, regrowing */
function kilnSpot(){ const s={id:'kiln',item:'pitch',pos:kiln.pos,ready:true,left:0}; spots.push(s); byId.kiln=s; return s; }
function setReady(s,ready,left){
  s.ready=ready; s.left=ready?0:Math.max(0,left==null?REGROW:left);
  if(BUSH[s.item]){ s.grow=ready?(s.grow==null?1:s.grow):0; place(s); }
  if(s.id==='kiln')kilnLook();
}
function kilnLook(){ const s=byId.kiln; if(!tar||!s)return;
  tar.position.y=s.ready?tar.userData.full:tar.userData.low; tar.scale.setScalar(s.ready?1:.82);
  // full: glossy black with a faint warm glow so it reads in the wood's shade; bare: a pale, dry, matte crust at the bottom
  tar.material.color.copy(col(s.ready?'#0c0a0b':'#8a7458')); tar.material.shininess=s.ready?80:2; tar.material.specular.copy(col(s.ready?'#c09a6a':'#000000'));
  tar.material.emissive.copy(col(s.ready?'#3a1e08':'#000000')); }
function give(s){
  const n=s.item==='pitch'?SCRAPE_N:1+(Math.random()<.5?1:0);
  if(G.inv&&G.inv.add)G.inv.add(s.item,n);
  setReady(s,false);
  G.emit('forage:pick',{id:s.id,item:s.item,n,pos:s.pos.clone()});
  return n;
}
function canPick(s){ return !!s&&s.ready&&looping(); }
function scrape(){
  const s=byId.kiln; if(!s||!looping())return 0;
  if(!s.ready){ try{ G.ui.toast('Scraped bare','More pitch will seep up in '+fmt(s.left)); }catch(e){} return 0; }
  try{ const A=G.audio; if(A&&A.ready&&A.S&&A.S.thud)A.S.thud(A.context.currentTime,{g:.12,dur:.16}); }catch(e){}
  return give(s);
}
function readNote(){
  if(!looping())return;
  try{ G.ui.say(NOTE,NOTE_WHO,{priority:'high'}); }catch(e){}
  const first=!S.notes.kiln; S.notes.kiln=true;
  const A=G.alchemy; if(A&&A.learn&&!(A.known&&A.known.has&&A.known.has('kilnfire')))A.learn('kilnfire');
  if(first)G.emit('forage:note',{id:'kiln'});
}
/* ------------------------------------------------------------------ the keeper's page on the sea cave's bench */
// it lies on the bench top at the end away from the apparatus; built into the cave's own group (hidden outside the cave)
// once the cave has made its bench, so it never needs an anchor in cave.js
const PAGE_WHO='A keeper’s page';
const PAGE='Pitch, brine crystal ground fine, and a little of the black stuff the fog-things leave. It does nothing until the ether strikes it. Then stand well back.';
let page=null;
function caveTable(){ const C=G.cave, A=G.alchemy; if(!C||!C.room||!A||!A.tables)return null;
  return A.tables.find(t=>t&&t.world&&C.room(t.world))||null; }
function buildPage(){
  if(page)return true; const t=caveTable(); if(!t||!t.grp)return false;
  const tex=G.canvasTex(128,(g,sz)=>{ g.fillStyle='#e9dfc4'; g.fillRect(0,0,sz,sz);
    const r=U.rng(4417); g.strokeStyle='rgba(70,52,40,.75)'; g.lineWidth=2;
    for(let y=18;y<sz-12;y+=11){ let x=12; g.beginPath(); g.moveTo(x,y); while(x<sz-14-r()*20){ x+=4+r()*9; g.lineTo(x,y+(r()-.5)*2.5); } g.stroke(); }
    g.fillStyle='rgba(120,90,60,.25)'; g.beginPath(); g.arc(sz*.78,sz*.8,14,0,TAU); g.fill(); },true);
  const m=new THREE.Mesh(new THREE.PlaneGeometry(.3,.4),G.toon('#ffffff',{map:tex,emissive:'#5e5240',side:THREE.DoubleSide}));
  m.name='keeperPage'; m.rotation.set(-PI/2,0,.3); m.position.set(-.85,1.006,.1); t.grp.add(m); m.updateMatrixWorld(true);
  const w=new THREE.Vector3(); m.getWorldPosition(w); w.y=t.world.y;
  page={mesh:m,pos:w,table:t};
  G.interact.add({pos:()=>page.pos,radius:1.3,priority:2,label:'Read the keeper’s page',
    enabled:()=>isPlay()&&looping()&&!!(G.cave&&G.cave.inside),use:readPage});
  return true;
}
function readPage(){
  if(!looping()||!(G.cave&&G.cave.inside))return;
  try{ G.ui.say(PAGE,PAGE_WHO,{priority:'high'}); }catch(e){}
  const first=!S.notes.cavePage; S.notes.cavePage=true;
  const A=G.alchemy; if(A&&A.learn&&!(A.known&&A.known.has&&A.known.has('burst')))A.learn('burst');
  if(first)G.emit('forage:note',{id:'cavePage'});
}
G.on('cave:enter',()=>{ try{ buildPage(); }catch(e){ console.error('forage page',e); } });

function walkIn(){
  const P=G.player; if(!P||!P.pos||P.alive===false||(G.cine&&G.cine.on))return;
  for(const s of spots){ if(s.item==='pitch'||!s.ready)continue;
    const dx=s.pos.x-P.pos.x, dz=s.pos.z-P.pos.z;
    if(dx*dx+dz*dz<PICK_R*PICK_R&&Math.abs(s.pos.y-P.pos.y)<2)give(s); }
}
function tick(dt){
  for(const s of spots){
    if(!s.ready){ s.left-=dt; if(s.left<=0){ s.grow=0; setReady(s,true); } }
    else if(s.grow!=null&&s.grow<1){ s.grow=Math.min(1,s.grow+dt*1.25); place(s); }
  }
}
function twinkle(){
  const on=looping(); for(const k in bushes)bushes[k].mesh.visible=on;
  if(!glint)return; glint.visible=on; if(!on)return;
  const t=G.time||0;
  for(const s of spots){ const i=s.gi; if(i==null)continue;
    let k=0; if(s.ready){ const w=Math.max(0,Math.sin(t*1.3+i*2.17)); k=.28+.9*Math.pow(w,8); }
    const c=s.item==='pitch'?[.95,.72,.42]:BUSH[s.item].glint; const kk=s.item==='pitch'?k*.8:k;
    gCol[i*3]=c[0]*kk; gCol[i*3+1]=c[1]*kk; gCol[i*3+2]=c[2]*kk; }
  glint.geometry.attributes.color.needsUpdate=true;
}

/* ------------------------------------------------------------------ save */
const PERSIST={
  save:()=>{ const left={}; for(const s of spots)if(!s.ready&&s.left>0)left[s.id]=+s.left.toFixed(1);
    return {v:1,left,notes:Object.assign({},S.notes),tree:{draws:S.tree.draws|0,dead:!!S.tree.dead}}; },
  load:d=>{ d=d||{}; const left=d.left||{};
    S.notes=Object.assign({},d.notes||{}); const t=d.tree||{}; S.tree={draws:t.draws|0,dead:!!t.dead};
    for(const s of spots){ const l=+left[s.id]; if(l>0)setReady(s,false,l); else{ s.grow=1; setReady(s,true); } } }
};
const reg=()=>G.persist&&G.persist.register&&G.persist.register('forage',PERSIST);
if(G.persist&&G.persist.register)reg(); else G.on('ready',reg);
G.on('game:reset',()=>PERSIST.load(null));

/* ------------------------------------------------------------------ wiring */
G.system('forage',{order:56,modes:['play','paused','dead'],
  init(){
    try{ buildKiln(); }catch(e){ console.error('forage kiln',e); }
    kilnSpot(); kilnLook();
    for(const it of ['gorse','holly'])try{ buildBush(it); }catch(e){ console.error('forage '+it,e); }
    try{ buildGlint(); }catch(e){ console.error('forage glint',e); }
    try{ buildPage(); }catch(e){}
    built=true;
    const pp=()=>V(POT.x,H(POT.x,POT.z)+.4,POT.z), np=()=>V(POST.x,H(POST.x,POST.z)+.6,POST.z);
    // a lower priority than the boat's own "Take the pitch", which shares the pot while that part is still wanted
    G.interact.add({pos:pp,radius:2,priority:3,label:()=>{ const s=byId.kiln; return s.ready?'Scrape pitch':'Scraped bare · '+fmt(s.left); },
      enabled:()=>isPlay()&&looping(),use:scrape});
    G.interact.add({pos:np,radius:1.8,priority:3,label:'Read the note',enabled:()=>isPlay()&&looping(),use:readNote});
  },
  update(dt){
    if(isPlay()&&looping()){ tick(dt||0); walkIn(); }
    twinkle();
  }
});

/* ------------------------------------------------------------------ test helpers */
F.debug={
  ripen(){ for(const s of spots){ s.grow=1; setReady(s,true); } return spots.length; },
  pick(id){ const s=byId[id]; if(!canPick(s))return 0; return s.item==='pitch'?scrape():give(s); },
  near(item){ const P=G.player&&G.player.pos; let best=null, bd=1e9; for(const s of spots){ if(item&&s.item!==item)continue; const d=P?Math.hypot(s.pos.x-P.x,s.pos.z-P.z):0; if(d<bd){ bd=d; best=s; } } return best; },
  // stand a few steps off a spot (out of reach of a walk-in pick), facing it; the kiln: in front of the pot, on the trail side
  tp(id,dist){ const s=byId[id], P=G.player; if(!s||!P)return null; const d=dist==null?(s.item==='pitch'?1.2:2.6):dist;
    let best=null; for(let k=0;k<16;k++){ const a=(s.item==='pitch'?0:.3)+k/16*TAU, x=s.pos.x+Math.sin(a)*d, z=s.pos.z+Math.cos(a)*d;
      if(G.world.walkable&&!G.world.walkable(x,z))continue; if(G.collidersNear(x,z).some(c=>Math.hypot(c.x-x,c.z-z)<c.r+.5))continue; best={x,z}; break; }
    if(!best)best={x:s.pos.x+d,z:s.pos.z};
    P.teleport(best.x,G.floorAt(best.x,best.z,H(best.x,best.z)+3),best.z,Math.atan2(s.pos.x-best.x,s.pos.z-best.z)); return s; },
  state:()=>({spots:spots.map(s=>({id:s.id,item:s.item,ready:s.ready,left:+s.left.toFixed(1),x:+s.pos.x.toFixed(1),z:+s.pos.z.toFixed(1)})),notes:Object.assign({},S.notes),tree:Object.assign({},S.tree)}),
  save:()=>PERSIST.save(), load:d=>PERSIST.load(d), readPage, get page(){ return page; }, POT, KC, POST, get mesh(){ return {kiln:kilnMesh,tar,bloom:bushes.gorse&&bushes.gorse.mesh,holly:bushes.holly&&bushes.holly.mesh,glint,page:page&&page.mesh}; }
};
})();
