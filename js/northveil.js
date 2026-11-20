/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — northveil.js
   The north island, seen from home: a vague shape on the northern horizon, there from the first evening.
   No words, no quest, no flag: just "wait, is that land?" when you look north from the headland, the tower or
   the north shore. (Rowan learns what it is later: north.js's light, then the crossing.)
     - The shape is the real island's (northisle.js), as seen from the south: three soft layers at roughly their
       true depths (the south cliffs and the cove's dip; the middle of the island with the crag and the wrecker's
       tower as a thin upright; the higher ground behind), traced once from G.northIsle.height plus the sea stacks,
       blurred, and drawn a shade darker than the haze, with a pale band of sea mist along its foot.
     - The tower sits in the middle layer's plane at its true x/z, so north.js's flare (G.north.pos, the
       fire-basket) burns exactly on top of it once that light is lit.
     - Colour: a cooler, darker take on the scene's own fog colour each frame (world.js / fog.js set it), so it
       belongs in the plain dusk, the forest's murk, the fog beyond the wall and the clearer air after the cure.
     - Visibility follows the fog's density (exp2 fog would swallow anything 700 m out, so the material ignores the
       fog and fades by hand): full in the island's ordinary air, a little clearer after the cure, gone in thick fog
       (out past the fog wall, deep in the forest) and in the dark tower (G.atmo.dark).
     - Hands over to the real island: fades out as the camera comes within ~480 m of it (northisle.js draws the
       real thing inside 380 m), gone on the crossing's fog leg, on the north island, and in every interior
       (sea cave, Undercroft, Vigil, north cave, fire room).
   Cost: one mesh (four quads, 16 vertices), one draw call, one 512x512 canvas texture made once; per frame only
   a few numbers change (opacity and 16 vertex colours). Not drawn at all while hidden. Same on every quality tier.
   Draw order: transparent, depth-tested, no depth write, renderOrder -5: after the sky (-10) and stars (-9), before
   every other transparent thing (fog wall 1, mist 2, north.js's sprites 0), and the island's terrain, cliffs,
   tower and trees (opaque, drawn earlier) hide it where they stand in front.
   API: G.northVeil = { visible, opacity, built, layers, debug:{ show(on), state(), mesh } }
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U;
const {clamp,lerp,smooth}=U;

/* where the quads stand (world units). x spans the island with room for the soft ends; y from under the sea to above
   the fire-basket. The middle layer's plane is the tower's z, so the flare at G.north.pos lands on it. */
const X0=40, X1=260, Y0=-4, Y1=68;
const TOWER_Z=-708;
const LAYERS=[   // far → near (drawn in this order: back to front)
  {name:'far',  z:-756, z0:-800, z1:-724, soft:3.0, blur:4.0, a:.30},
  {name:'mid',  z:TOWER_Z, z0:-724, z1:-662, soft:2.2, blur:3.0, a:.42},
  {name:'near', z:-646, z0:-662, z1:-596, soft:1.7, blur:2.2, a:.52}];
const MIST={z:-610, x0:10, x1:290, y0:-3, y1:9};
const TEX=512, BAND=128;         // four bands of 128 rows: far, mid, near, mist
const COLS=256;                  // profile samples across (interpolated up to the texture's 512)

const V={vis:0,force:null,built:false,mesh:null,mat:null,col:null,want:0,fogK:0,placeK:0,distK:0,why:''};
const _c=new THREE.Color(), _t=new THREE.Color(), _m=new THREE.Color();
const COOL=U.col('#232a3c'), MIST_TINT=U.col('#d8d4e6');

/* ---------------------------------------------------------------- the shape */
function towerInfo(){ const NI=G.northIsle, T=NI&&NI.tower; return T?{x:T.x,z:T.z,base:T.base,top:T.base+T.h}:{x:146,z:TOWER_Z,base:26,top:55.5}; }
/* the island's height seen from the south, per layer: for each column, the highest ground within the layer's z band,
   with the sea stacks standing in it as rounded bumps; then blurred along x */
function profiles(){
  const NI=G.northIsle, H=NI&&NI.height;
  const out=LAYERS.map(()=>new Float32Array(COLS));
  for(let l=0;l<LAYERS.length;l++){ const L=LAYERS[l], p=out[l];
    for(let i=0;i<COLS;i++){ const x=X0+(i+.5)/COLS*(X1-X0); let h=-3;
      if(H)for(let z=L.z0;z<=L.z1;z+=2.5)h=Math.max(h,H(x,z));
      p[i]=h; } }
  // sea stacks (northisle.js fills its rock list in its own init, which runs before ours: order 85 < 88)
  const rocks=(NI&&NI.rocks)||[];
  for(const r of rocks){ if(r.kind!=='stack')continue;
    let l=LAYERS.findIndex(L=>r.z>=L.z0&&r.z<L.z1); if(l<0)l=r.z<LAYERS[0].z0?0:2;
    const p=out[l], R=Math.max(1.5,r.r*.9);
    for(let i=0;i<COLS;i++){ const x=X0+(i+.5)/COLS*(X1-X0), d=Math.abs(x-r.x)/R; if(d<1)p[i]=Math.max(p[i],r.top*Math.sqrt(1-d*d)); } }
  // soften along x (two box passes ≈ a gaussian of the layer's blur, in metres)
  const tmp=new Float32Array(COLS), mpc=(X1-X0)/COLS;
  for(let l=0;l<LAYERS.length;l++){ const p=out[l], r=Math.max(1,Math.round(LAYERS[l].blur/mpc));
    for(let pass=0;pass<2;pass++){ for(let i=0;i<COLS;i++){ let s=0,n=0; for(let k=-r;k<=r;k++){ const j=i+k; if(j<0||j>=COLS)continue; s+=p[j]; n++; } tmp[i]=s/n; } p.set(tmp); } }
  return out;
}
/* the wrecker's tower as a soft upright: its tapering body, the gallery slab, the fire-basket and its hood */
function towerA(x,y,T){
  const t=clamp((y-T.base)/(T.top-T.base),0,1);
  let w=y<T.top?lerp(3.7,2.7,t):y<T.top+.6?3.6:y<T.top+3.6?1.4:y<T.top+5?1.7*(1-(y-T.top-3.6)/1.4):0;
  if(y<T.base-6)w=0;
  const d=Math.abs(x-T.x)-w, soft=.85;
  return (1-smooth(-soft,soft,d))*smooth(T.base-6,T.base+2,y);
}
// a small value noise (same idea as U.vnoise but kept local and seeded, so the haze is the same every load)
const hs=(i,j)=>{ const s=Math.sin(i*127.1+j*311.7)*43758.5453; return s-Math.floor(s); };
function vn(x,y){ const i=Math.floor(x), j=Math.floor(y), fx=x-i, fy=y-j, ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
  return lerp(lerp(hs(i,j),hs(i+1,j),ux),lerp(hs(i,j+1),hs(i+1,j+1),ux),uy); }
function draw(g,s){
  const P=profiles(), T=towerInfo(), img=g.createImageData(s,s), d=img.data;
  const mpx=(X1-X0)/s, mpy=(Y1-Y0)/(BAND-4);
  for(let l=0;l<4;l++){
    for(let r=0;r<BAND;r++){ const row=l*BAND+r, inner=r>=2&&r<BAND-2, y=Y1-(r-2)*mpy;   // canvas top = high
      for(let i=0;i<s;i++){ let a=0;
        if(inner){ const x=X0+(i+.5)*mpx;
          if(l<3){ const L=LAYERS[l], p=P[l], fi=clamp((i+.5)/s*COLS-.5,0,COLS-1), i0=Math.floor(fi), i1=Math.min(COLS-1,i0+1), h=lerp(p[i0],p[i1],fi-i0);
            const e=h-y; a=smooth(-L.soft,L.soft,e);
            if(l===1)a=Math.max(a,towerA(x,y,T));
            // haze: slow streaks of mist across the low ground, a little grain, a lighter foot that melts into the sea mist
            const streak=vn(x*.035+l*7,y*.55+l*3), grain=vn(x*.21+l*11,y*.4);
            a*=1-.32*smooth(.45,.85,streak)*(1-smooth(6,22,y))-.08*grain;
            a*=.3+.7*smooth(-1.5,10,y);
            a*=L.a;
          }else{ // the sea mist: a long low band, thickest just above the water, ragged along its length, gone at both ends
            const wx=MIST.x0+(i+.5)/s*(MIST.x1-MIST.x0), my=MIST.y0+(BAND-2-r)/(BAND-4)*(MIST.y1-MIST.y0);
            const k=Math.exp(-Math.pow((my-1.6)/2.6,2))*(1-smooth(70,140,Math.abs(wx-150)));
            a=k*(.55+.45*vn(wx*.05,3.3))*(.75+.25*vn(wx*.2,7))*.38; }
        }
        const o=(row*s+i)*4; d[o]=d[o+1]=d[o+2]=255; d[o+3]=Math.round(clamp(a,0,1)*255); } } }
  g.putImageData(img,0,0);
}
function build(){
  const tex=G.canvasTex(TEX,draw,false);
  tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;
  // 4 quads in one geometry, far → near → mist, so the index order is back-to-front (one draw call, no self-sorting)
  const pos=[], uv=[], idx=[];
  const quad=(x0,x1,y0,y1,z,band)=>{ const b=pos.length/3, v0=1-(band*BAND+BAND-2)/TEX, v1=1-(band*BAND+2)/TEX;
    pos.push(x0,y0,z, x1,y0,z, x1,y1,z, x0,y1,z); uv.push(0,v0, 1,v0, 1,v1, 0,v1); idx.push(b,b+1,b+2, b,b+2,b+3); };
  LAYERS.forEach((L,k)=>quad(X0,X1,Y0,Y1,L.z,k));
  quad(MIST.x0,MIST.x1,MIST.y0,MIST.y1,MIST.z,3);
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  V.col=new Float32Array(16*3).fill(1); const ca=new THREE.BufferAttribute(V.col,3); ca.setUsage&&ca.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('color',ca); geo.setIndex(idx); geo.computeBoundingSphere();
  V.mat=new THREE.MeshBasicMaterial({map:tex,vertexColors:true,transparent:true,opacity:0,depthWrite:false,depthTest:true,fog:false,side:THREE.DoubleSide,toneMapped:false});
  const m=V.mesh=new THREE.Mesh(geo,V.mat); m.name='northVeil'; m.renderOrder=-5; m.visible=false;
  m.castShadow=m.receiveShadow=false; m.raycast=()=>{};
  G.scene.add(m); V.built=true;
}

/* ---------------------------------------------------------------- when it shows */
function interior(){ return !!((G.cave&&G.cave.inside)||(G.undercroft&&G.undercroft.inside)||(G.temple&&G.temple.inside)||(G.northCave&&G.northCave.inside)||(G.northFire&&G.northFire.inside)); }
/* 0..1: is the camera somewhere the island could be seen from as a far shape (home, or just pushing off from it)? */
function place(){
  if(interior()){ V.why='interior'; return 0; }
  const NI=G.northIsle;
  if(NI){ if(NI.crossing){ if(NI.crossPhase>=1){ V.why='crossing'; return 0; } }
    else if(NI.inside||NI.at==='north'){ V.why='northIsland'; return 0; } }
  V.why=''; return 1;
}
/* 0..1 from the fog: the island's ordinary air (density ~.0105, less inside the light) shows it, thick fog hides it */
function fogK(){ const f=G.scene.fog; if(!f||f.density==null)return 1; const d=f.density; return 1-smooth(.0125,.023,d); }

G.system('northVeil',{order:88,modes:'always',
  init(){ try{ build(); }catch(e){ console.error('northVeil',e); } },
  update(dt){
    if(!V.built)return;
    dt=dt||0;
    const cam=G.camera.position, C=(G.northIsle&&G.northIsle.centre)||{x:150,z:-700};
    const pk=place(), dist=Math.hypot(cam.x-C.x,cam.z-C.z), dk=smooth(400,480,dist), fk=fogK(), dark=clamp(G.atmo.dark||0,0,1);
    V.placeK=pk; V.distK=dk; V.fogK=fk;
    let want=pk*dk*fk*(1-dark);
    if(V.force!=null)want=V.force?1:0;
    V.want=want;
    // snap out for hard cuts (into an interior, onto the island, the crossing's fog leg); otherwise ease
    if(pk===0&&V.force==null)V.vis=0; else V.vis=U.damp(V.vis,want,want>V.vis?.9:2.2,dt);
    const m=V.mesh; m.visible=V.vis>.003; if(!m.visible)return;
    // colour from the scene's own haze: a cooler, darker shade of the fog for the land; a paler one for the sea mist
    const fog=G.scene.fog, fc=fog&&fog.color?fog.color:_c.setRGB(.1,.1,.14);
    const cured=clamp(G.atmo.cured||0,0,1), clear=smooth(.0095,.005,fog&&fog.density!=null?fog.density:.01);
    _t.copy(fc).multiplyScalar(lerp(.6,.5,clear)).lerp(COOL,.18);
    _m.copy(fc).lerp(MIST_TINT,.16+.08*cured);
    const c=V.col;
    for(let v=0;v<16;v++){ const s=v<12?_t:_m; c[v*3]=s.r; c[v*3+1]=s.g; c[v*3+2]=s.b; }
    m.geometry.attributes.color.needsUpdate=true;
    V.mat.opacity=clamp(V.vis*lerp(1,1.18,clear),0,1);
  }
});

G.northVeil={
  get visible(){ return !!(V.mesh&&V.mesh.visible&&V.vis>.05); },
  get opacity(){ return V.vis; },
  get built(){ return V.built; },
  layers:LAYERS.map(L=>({name:L.name,z:L.z})), towerZ:TOWER_Z,
  debug:{ show(on){ V.force=on==null?null:!!on; }, get mesh(){ return V.mesh; },
    state:()=>({vis:+V.vis.toFixed(3),want:+V.want.toFixed(3),fogK:+V.fogK.toFixed(3),placeK:V.placeK,distK:+V.distK.toFixed(3),why:V.why,
      shown:!!(V.mesh&&V.mesh.visible),opacity:V.mat?+V.mat.opacity.toFixed(3):0,density:G.scene.fog?+G.scene.fog.density.toFixed(4):null}) }
};
})();
