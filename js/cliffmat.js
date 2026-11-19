/* =====================================================================
   cliffmat.js — painted, toon-lit rock for steep cliff faces.
   G.cliffmat.rock(opts) returns a MeshToonMaterial (shared gradient map, fog, shadows and vertex colours
   all keep working) patched to paint itself in world space, so meshes need no UVs:
     - bedding: broad horizontal beds of slate, dark slate and warm grey, gently warped, thin dark partings
       with a lit lip under each;
     - side faces: blocky joints, cracks and chips (one texture, projected along x and along z);
     - up-facing bits: speckled, lichen-spotted stone, then moss and turf, thicker toward the plateau top;
     - the shore: a dark wet band and a thin pale salt line riding just above the water (follows the tide),
       and dark weed on the stone between the tides.
   Two 512² canvas textures (made on first use), five texture reads per pixel, no loops.
   opts: vertexColors (true) multiply by vertex colour, wet, moss, strata (true), scale (1 = default size;
   2 = features twice as big), instanced (false), side, flatShading, blend (false: for ground, keeps the vertex colour and
   paints rock by a per-vertex 'rockw' attribute (0 grass .. 1 rock), with a ragged painted edge).
   Loaded after ink.js, before world.js. G.cliffmat._debug (test tools only) shows it on a test wall.
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U;
const S=512, FACE_M=16, STRATA_V=48, STRATA_U=160; // texture size; metres per tile (side faces, beds up, beds along)

/* ---------- textures ---------- */
// periodic value noise on a cells×cells lattice over the tile, so it wraps
function pnoise(cells,seed){ const r=U.rng(seed), L=new Float32Array(cells*cells); for(let i=0;i<L.length;i++)L[i]=r();
  return (u,v)=>{ const x=u*cells,y=v*cells,xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,a=xf*xf*(3-2*xf),b=yf*yf*(3-2*yf);
    const i0=((xi%cells)+cells)%cells,j0=((yi%cells)+cells)%cells,i1=(i0+1)%cells,j1=(j0+1)%cells;
    return (L[j0*cells+i0]*(1-a)+L[j0*cells+i1]*a)*(1-b)+(L[j1*cells+i0]*(1-a)+L[j1*cells+i1]*a)*b; }; }
function pfbm(c0,seed,oct){ const ns=[]; for(let o=0;o<oct;o++)ns.push(pnoise(c0<<o,seed+o*17));
  return (u,v)=>{ let f=0,a=.5,t=0; for(let o=0;o<oct;o++){f+=a*ns[o](u,v);t+=a;a*=.5;} return f/t; }; }
// sample fn on a coarse n×n grid and stretch it (bilinear, wrapping) to S×S: smooth noise at a fraction of the cost
function field(fn,n=128){ const c=new Float32Array(n*n), out=new Float32Array(S*S), k=n/S;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++)c[j*n+i]=fn(i/n,j/n);
  for(let j=0;j<S;j++){ const y=j*k, y0=y|0, fy=y-y0, r0=y0*n, r1=((y0+1)%n)*n;
    for(let i=0;i<S;i++){ const x=i*k, x0=x|0, fx=x-x0, x1=(x0+1)%n;
      out[j*S+i]=(c[r0+x0]*(1-fx)+c[r0+x1]*fx)*(1-fy)+(c[r1+x0]*(1-fx)+c[r1+x1]*fx)*fy; } }
  return out; }
const grey=l=>{const k=Math.round(U.clamp(l,0,1)*255);return `rgb(${k},${k},${k})`;};
function scratch(){ const c=document.createElement('canvas'); c.width=c.height=S; return c; }
// draw fn at (x,y) and its wrapped copies so the tile repeats seamlessly
const wrap9=(fn,x0=-1e9,y0=-1e9,x1=1e9,y1=1e9)=>{ for(const ox of [-S,0,S])for(const oy of [-S,0,S]){   // skip copies that miss the tile
  if(x1+ox<0||x0+ox>S||y1+oy<0||y0+oy>S)continue; fn(ox,oy); } };

/* side faces: natural fracture rock, not masonry. A coarse Voronoi gives a few big blocks; a finer one splits only some of
   them. Joints fade in and out along their length (a noise mask), so most blocks run into their neighbours; big calm facets
   of flat tone sit between the clusters of detail; long vertical fractures and soft weathering streaks run down the face */
function vor(GX,GY,AY,r,jit){ const NS=GX*GY, sx=new Float32Array(NS), sy=new Float32Array(NS);
  for(let k=0;k<NS;k++){ const i=k%GX, j=k/GX|0; sx[k]=(i+.5+(r()-.5)*jit)/GX; sy[k]=(j+.5+(r()-.5)*jit)/GY; }
  const XS=GX, YS=GX*AY;
  return (u,v,o)=>{ const ci=Math.floor(u*GX), cj=Math.floor(v*GY); let e1=1e9,e2=1e9,b=0;
    for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){ const ii=ci+di, jj=cj+dj, k=((jj%GY+GY)%GY)*GX+((ii%GX+GX)%GX);
      const dx=(u-(sx[k]+Math.floor(ii/GX)))*XS, dy=(v-(sy[k]+Math.floor(jj/GY)))*YS, d=dx*dx+dy*dy;
      if(d<e1){e2=e1;e1=d;b=k;}else if(d<e2)e2=d; }
    o.b=b; o.e=Math.sqrt(e2)-Math.sqrt(e1); return o; }; }
function drawFace(g,r){
  const im=g.createImageData(S,S), o=im.data;
  const big=vor(3,2,.55,r,.9), small=vor(7,5,.5,r,.95), bt=[], stn=[];
  for(let k=0;k<6;k++)bt.push(.46+r()*.1); for(let k=0;k<35;k++)stn.push((r()-.5)*.05);
  const n3=pnoise(3,511), n6=pnoise(6,512), n12=pnoise(12,513), n24=pnoise(24,514);
  const fac=field((u,v)=>n3(u,v)*.6+n6(u,v)*.4,64), msk=field((u,v)=>n6(u,v)*.55+n12(u,v)*.45,128), sub=field((u,v)=>n3(u+.3,v+.6),64), wob=field((u,v)=>n24(u,v),128);
  const A={}, B={};
  for(let py=0;py<S;py++){ const v=(py+.5)/S;
    for(let px=0;px<S;px++){ const p=py*S+px, u=(px+.5)/S, w=(wob[p]-.5)*.018;
      big(u+w,v-w*.6,A); small(u+w*.7,v+w,B);
      let l=bt[A.b]+(sub[p]>.55?stn[B.b]:0);
      const f=fac[p]; l+=f>.62?.06:f<.36?-.05:0;                            // broad calm facets
      const m=msk[p], vb=U.smooth(.36,.5,m), vs=U.smooth(.55,.66,m)*U.smooth(.45,.6,sub[p]);   // where each joint shows
      const wb=.012+.02*m, ws=.008+.012*m;
      if(A.e<wb*2.6)l+=.06*vb*(1-A.e/(wb*2.6));                             // a soft lit edge beside the open joints
      if(A.e<wb)l=U.lerp(l,.12+A.e*3,vb);
      else if(B.e<ws)l=U.lerp(l,.2+B.e*4,vs*.85);
      const a=p*4; o[a]=o[a+1]=o[a+2]=(l<0?0:l>1?1:l)*255; o[a+3]=255; } }
  g.putImageData(im,0,0); g.lineJoin='round'; g.lineCap='round';
  // weathering streaks running down from ledges and cracks
  for(let i=0;i<16;i++){ const x=r()*S, y=r()*S, w=4+r()*16, h=90+r()*260, dark=r()<.7;
    wrap9((ox,oy)=>{ const gr=g.createLinearGradient(0,y+oy,0,y+oy+h); gr.addColorStop(0,dark?'rgba(30,30,30,.22)':'rgba(220,220,220,.12)'); gr.addColorStop(1,'rgba(128,128,128,0)');
      g.fillStyle=gr; g.fillRect(x+ox-w/2,y+oy,w,h); },x-w,y,x+w,y+h); }
  // long vertical fractures that come and go
  for(let i=0;i<7;i++){ const pts=[]; let px=r()*S, py=r()*S; const len=160+r()*300, steps=8+(r()*6|0);
    for(let k=0;k<=steps;k++){ pts.push([px,py]); px+=(r()-.5)*14; py+=len/steps; }
    const lw=1.2+r()*1.6, al=[]; for(let k=0;k<steps;k++)al.push(r()<.3?0:.35+r()*.65);
    const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
    wrap9((ox,oy)=>{ for(let k=0;k<steps;k++){ if(!al[k])continue; g.globalAlpha=al[k]; g.beginPath(); g.moveTo(pts[k][0]+ox,pts[k][1]+oy); g.lineTo(pts[k+1][0]+ox,pts[k+1][1]+oy);
      g.strokeStyle=grey(.1); g.lineWidth=lw; g.stroke(); } g.globalAlpha=1; },
      Math.min(...xs)-6,Math.min(...ys)-6,Math.max(...xs)+6,Math.max(...ys)+6); }
  // a few chips and pits
  for(let i=0;i<40;i++){ const x=r()*S,y=r()*S,rad=1.5+r()*3,dark=r()<.6,rot=r()*3;
    wrap9((ox,oy)=>{ g.fillStyle=grey(dark?.3:.66); g.beginPath(); g.ellipse(x+ox,y+oy,rad*1.4,rad,rot,0,6.283); g.fill(); },x-8,y-8,x+8,y+8); }
}
/* up-facing stone: speckle, lichen rosettes, a few cracks */
function drawTop(g,r){
  g.fillStyle=grey(.5); g.fillRect(0,0,S,S);
  for(let i=0;i<70;i++){ const x=r()*S,y=r()*S,rad=10+r()*36,L=.4+r()*.22;           // broad, flat weathering patches
    const ry=rad*(.6+r()*.4), rot=r()*3;
    wrap9((ox,oy)=>{ g.fillStyle=grey(L); g.beginPath(); g.ellipse(x+ox,y+oy,rad,ry,rot,0,6.283); g.fill(); },x-rad,y-rad,x+rad,y+rad); }
  for(let i=0;i<18;i++){ const pts=[]; let px=r()*S,py=r()*S,a=r()*6.283; for(let k=0;k<7;k++){pts.push([px,py]); a+=(r()-.5)*1.2; px+=Math.cos(a)*22; py+=Math.sin(a)*22;}
    const lw=1.5+r()*1.5, xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
    wrap9((ox,oy)=>{ g.beginPath(); pts.forEach(([a2,b],k)=>k?g.lineTo(a2+ox,b+oy):g.moveTo(a2+ox,b+oy)); g.strokeStyle=grey(.08); g.lineWidth=lw; g.stroke(); },
      Math.min(...xs)-4,Math.min(...ys)-4,Math.max(...xs)+4,Math.max(...ys)+4); }
  for(let i=0;i<1600;i++){ const x=r()*S,y=r()*S,rad=.8+r()*1.8,l=r()<.55?.2:.8;
    wrap9((ox,oy)=>{ g.fillStyle=grey(l); g.fillRect(x+ox,y+oy,rad,rad); },x-3,y-3,x+3,y+3); }
  for(let i=0;i<30;i++){ const x=r()*S,y=r()*S,rad=8+r()*18;                            // lichen: loose clusters of pale dots
    for(let k=0;k<26;k++){ const a=r()*6.283, q=Math.sqrt(r())*rad, dx=x+Math.cos(a)*q, dy=y+Math.sin(a)*q, rr=1.2+r()*3.2;
      const l=.8+r()*.15; wrap9((ox,oy)=>{ g.fillStyle=grey(l); g.beginPath(); g.arc(dx+ox,dy+oy,rr,0,6.283); g.fill(); },dx-rr,dy-rr,dx+rr,dy+rr); } }
}
let TEX=null, BYTES=0, MS=0;
function build(){
  if(TEX)return TEX;
  const t0=performance.now();
  const r=U.rng(4242), cF=scratch(), cT=scratch();
  drawFace(cF.getContext('2d'),r); drawTop(cT.getContext('2d'),r);
  const dF=cF.getContext('2d').getImageData(0,0,S,S).data, dT=cT.getContext('2d').getImageData(0,0,S,S).data;
  const nB=field(pfbm(4,77,4)), nG=field(pnoise(64,91),256);
  // face: R side-face detail, G up-face detail, B mid-scale noise (moss breakup, wet edge)
  const face=G.canvasTex(S,(g)=>{ const im=g.createImageData(S,S), o=im.data;
    for(let p=0;p<S*S;p++){ const a=p*4, grain=(nG[p]-.5)*18;   // Uint8ClampedArray clamps for us
      o[a]=dF[a]+grain; o[a+1]=dT[a]+grain; o[a+2]=nB[p]*255; o[a+3]=255; }
    g.putImageData(im,0,0); },false);
  // beds: R tone (flat per bed, also shifts the joint pattern per bed), G parting (dark <.5, lit lip >.5), B broad noise
  const strata=G.canvasTex(S,(g)=>{ const im=g.createImageData(S,S), o=im.data, rs=U.rng(1717), nM=field(pfbm(3,33,3)), nS=pnoise(7,34);
    const th=[]; let tot=0; while(tot<S-14){ const t=Math.min(24+Math.pow(rs(),1.3)*72,S-tot); th.push(t); tot+=t; } th[th.length-1]+=S-tot;
    const n=th.length, b0=[], amp=[], f1=[], f2=[], ph=[], tone=[], seam=[]; let acc=0, prev=.5;
    for(let k=0;k<n;k++){ b0.push(acc); acc+=th[k]; const lo=Math.min(th[k],th[(k+n-1)%n]);
      amp.push(lo*.22+rs()*10); f1.push(1+(rs()*3|0)); f2.push(2+(rs()*4|0)); ph.push(rs()*6.283);
      prev=(prev+.22+rs()*.56)%1; tone.push(prev); seam.push(.45+rs()*.55); }
    const bb=new Float32Array(n+1);
    for(let i=0;i<S;i++){ const u=i/S*6.283;
      for(let k=0;k<n;k++)bb[k]=b0[k]+amp[k]*(.65*Math.sin(u*f1[k]+ph[k])+.35*Math.sin(u*f2[k]+ph[k]*2.3));
      bb[n]=bb[0]+S;
      let k=0;
      for(let j=0;j<S;j++){ let v=j+.5; if(v<bb[0])v+=S; while(k>0&&v<bb[k])k--; while(k<n-1&&v>=bb[k+1])k++;
        const dTop=v-bb[k], dBot=bb[k+1]-v, a=(j*S+i)*4;   // image rows run downward = world y down
        const sf=U.smooth(.42,.62,nS(i/S,k/n+.13));   // partings fade in and out along the bed
        let gch=.5; if(dTop<2.2)gch=.5-.5*seam[k]*sf*U.clamp(2.2-dTop,0,1.4)/1.4;          // parting above this bed
        else if(dTop<4.6)gch=.5+.3*seam[k]*sf*U.clamp((4.6-dTop)/2,0,1);                     // lit lip just under it
        if(dBot<.9)gch=Math.min(gch,.5-.25*seam[(k+1)%n]*sf);
        o[a]=tone[k]*255; o[a+1]=gch*255; o[a+2]=nM[j*S+i]*255; o[a+3]=255; }
      if(k>=n)k=0; }
    g.putImageData(im,0,0); },false);
  for(const t of [face,strata]){ t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=Math.min(8,G.renderer.capabilities.getMaxAnisotropy()||4); t.needsUpdate=true; }
  TEX={face,strata}; BYTES=2*S*S*4*4/3|0; MS=Math.round(performance.now()-t0);  // RGBA8 with mip chain
  return TEX;
}

/* ---------- shader ---------- */
const lin=h=>{const c=U.col(h);return `vec3(${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)})`;};
const uniforms={uTide:{value:0},uTime:{value:0}};
const VERT_HEAD='varying vec3 vBqW;\n';
const VERT_BODY=`
  { vec4 bqW=vec4(transformed,1.);
    #ifdef USE_INSTANCING
    bqW=instanceMatrix*bqW;
    #endif
    vBqW=(modelMatrix*bqW).xyz; }`;
const FRAG_HEAD=`varying vec3 vBqW; uniform sampler2D uBqFace,uBqStrata; uniform float uTide,uTime;\n`;
function fragBody(o){ return `
  { vec3 P=vBqW, N=normalize((vec4(normal,0.)*viewMatrix).xyz);
    vec3 bw=N*N; bw*=bw; bw/=bw.x+bw.y+bw.z;                       // triplanar weights, fairly sharp
    float far=smoothstep(30.,140.,length(vViewPosition));            // fade fine detail with distance
    float sc=${(1/(FACE_M*o.scale)).toFixed(5)};
    vec2 sw=vec2(sin(P.x*.11+P.z*.05)*.7+sin(P.z*.19-P.x*.07)*.45, 0.);
    vec3 st=texture2D(uBqStrata,vec2((P.x*.6+P.z*.8)/${(STRATA_U*o.scale).toFixed(1)},(P.y+sw.x)/${(STRATA_V*o.scale).toFixed(1)})).rgb;
    vec2 ux=vec2(P.z*sc,P.y*sc), uz=vec2(P.x*sc+.43,P.y*sc+.37);
    vec3 fx=texture2D(uBqFace,ux).rgb, fz=texture2D(uBqFace,uz).rgb;
    vec3 fy=texture2D(uBqFace,P.xz*sc*.8+vec2(.31,.67)).rgb;
    float up=smoothstep(.35,.8,N.y), dn=1.-smoothstep(-.75,-.3,N.y);
    float side=fx.r*bw.x+fz.r*bw.z, topd=mix(fy.r,fy.g,step(0.,N.y));
    float det=mix(side+topd*bw.y,.52,far*.75);
    float mb=fx.b*bw.x+fz.b*bw.z+fy.b*bw.y;                          // mid-scale breakup noise
    vec3 c=${lin('#5d6372')};
    ${o.strata?`float sf=1.-far*.6;                                                // beds read softer far away (no candy stripes)
    c=mix(c,${lin('#434957')},(1.-smoothstep(.18,.34,st.r))*.4*sf);
    c=mix(c,${lin('#6c665f')},smoothstep(.6,.72,st.r)*.35*sf);
    c=mix(c,${lin('#757782')},smoothstep(.86,.92,st.r)*.3*sf);
    float pt=(st.g-.5)*2.*(1.-up);                                    // bed partings / lit lips (vertical-ish faces)
    c*=1.+(pt<0.?pt*.38:pt*.12)*(1.-far*.5);`:''}
    c*=.86+.28*st.b;                                                  // broad patchy tone
    c*=.6+.8*det;
    vec3 lich=mix(${lin('#686c6a')},${lin('#8d8c78')},smoothstep(.75,.95,fy.g));
    c=mix(c,lich*(.6+.7*det),up*.55);
    c*=1.-dn*.08;
    ${o.moss?`{ float hk=smoothstep(4.,40.,P.y);
      float m=up*(1.-smoothstep(.5,.62,mb-hk*.38+(1.-up)*.3))*smoothstep(uTide+2.,uTide+5.,P.y)${o.blend?'*.3':''};
      vec3 mc=mix(${lin('#34472b')},${lin('#22301f')},smoothstep(.45,.7,fy.b));
      mc=mix(mc,${lin('#5c7550')},hk*smoothstep(.45,.75,fy.g)*.8);
      c=mix(c,mc*(.75+.4*det),m);
      float lip=smoothstep(40.7,41.75,P.y)*(1.-smoothstep(.5,.58,mb+det*.3+(41.8-P.y)*.12));   // turf tufts on the very rim, rock breaking through between
      c=mix(c,${lin('#4d6a3f')}*(.8+.3*det),lip*${o.blend?'0.':'.6'}); }`:''}
    ${o.wet?`{ float wv=sin(P.x*.075+uTime*.7)*.32+sin(P.z*.11+uTime*.55)*.24;         // the sea's swell, so the wet edge breathes with it
      float yw=P.y-uTide;
      float itz=(1.-smoothstep(.2,.45,P.y))*smoothstep(-2.2,-1.6,P.y)*smoothstep(.3,.5,mb+.1); // weed between the tides
      c=mix(c,${lin('#2b2e22')}*(.7+.5*det),itz*.75);
      float edge=1.05+(mb-.5)*.6+wv*.3;
      float wet=1.-smoothstep(edge-.05,edge+.05,yw);
      c*=mix(vec3(1.),vec3(.48,.53,.6),wet);
      float tw=.07+(fx.b*bw.x+fz.b*bw.z)*.1, tl=smoothstep(edge,edge+.04,yw)*(1.-smoothstep(edge+tw,edge+tw+.04,yw))*smoothstep(.34,.44,mb)*(1.-up);
      c=mix(c,${lin('#7f8584')},tl*.5*(1.-far*.5)); }                // a thin, broken pale salt line along the top of the wet`:''}
    ${o.blend?`{ float hn=(mb-.5)*.4+(det-.5)*.25;                   // ground: rock shows where it is steep, with a ragged edge
      float rk=smoothstep(.42,.62,vBqR+hn);
      diffuseColor.rgb=mix(diffuseColor.rgb,min(c,vec3(.42))*mix(1.,.82,smoothstep(.1,.02,diffuseColor.g)),rk); }`:'diffuseColor.rgb*=min(c,vec3(.42));'} }`; }

const cache={};
function rock(opts){
  const o=Object.assign({vertexColors:true,wet:true,moss:true,strata:true,blend:false,scale:1,instanced:false,side:THREE.FrontSide,flatShading:false},opts||{});
  o.scale=+o.scale||1;
  const key=['cm',o.vertexColors?1:0,o.wet?1:0,o.moss?1:0,o.strata?1:0,o.scale.toFixed(3),o.instanced?1:0,o.side,o.flatShading?1:0,o.blend?'b':''].join('');
  if(cache[key])return cache[key];
  const T=build();
  const m=G.toon('#ffffff',{vertexColors:!!o.vertexColors,side:o.side,flatShading:!!o.flatShading});
  const body=fragBody(o);
  m.onBeforeCompile=sh=>{
    sh.uniforms.uTide=uniforms.uTide; sh.uniforms.uTime=uniforms.uTime;
    sh.uniforms.uBqFace={value:T.face}; sh.uniforms.uBqStrata={value:T.strata};
    sh.vertexShader=(o.blend?'attribute float rockw; varying float vBqR;\n':'')+VERT_HEAD+sh.vertexShader.replace('#include <project_vertex>','#include <project_vertex>'+VERT_BODY+(o.blend?' vBqR=rockw;':''));
    sh.fragmentShader=(o.blend?'varying float vBqR;\n':'')+FRAG_HEAD+sh.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>'+body);
  };
  m.customProgramCacheKey=()=>key;
  m.name='cliffRock';
  return cache[key]=m;
}
G.system('cliffmat',{order:2,modes:'always',update(){
  uniforms.uTide.value=(G.world&&G.world.tide)||0; uniforms.uTime.value=G.time; }});

G.cliffmat={
  rock, uniforms,
  get tex(){ return build(); },
  get stats(){ build(); return {textures:2,bytes:BYTES,ms:MS,materials:Object.keys(cache).length}; },
};

/* ---------- test tools: a temporary wall + boulders under the south cliff, and the sea stacks ---------- */
if(G.debug){
  const D=G.cliffmat._debug={group:null,stackMat:null,
    /** wall({mat:'rock'|'toon', x, z}) builds (or rebuilds) a dense test wall standing in the sea and returns its stats */
    wall(a={}){
      D.clear(); const W=G.world, H=W.height, x0=a.x!=null?a.x:174;
      let z0=a.z; if(z0==null){ z0=30; while(z0<120&&H(x0,z0)>-1.5)z0+=.5; z0+=9; }
      const g=new THREE.PlaneGeometry(34,50,136,200), P=g.attributes.position, col=new Float32Array(P.count*3);
      for(let i=0;i<P.count;i++){ const x=P.getX(i), y=P.getY(i)+21;
        let d=2.2*(U.fbm(x*.09+3,y*.07,4)-.5)+.6*(U.vnoise(x*.6,y*.6)-.5);
        const yl=y+U.vnoise(x*.15,9)*2, k=yl/5.3, f=k-Math.floor(k);                        // ledges every few metres
        d-=Math.floor(k)*1.1+U.smooth(.8,.9,f)*(.6+1.2*U.vnoise(x*.12+Math.floor(k)*7,3));     // each tier steps back: a ledge on top
        d+=Math.max(0,1-Math.abs(x+8)/3)*2.5*U.smooth(10,14,y)*(1-U.smooth(26,30,y));           // a buttress
        P.setXYZ(i,x,y,d); }
      g.computeVertexNormals(); const N=g.attributes.normal, c=new THREE.Color();
      const cR=U.col('#5d6372'),cR2=U.col('#434957'),cM=U.col('#34472b');
      for(let i=0;i<P.count;i++){ const x=P.getX(i),y=P.getY(i),z=P.getZ(i);
        if(a.mat==='toon'){ c.copy(cR).lerp(cR2,(Math.sin(y*1.15+U.fbm(x*.045,y*.045,3)*5)*.5+.5)*.8); if(N.getZ(i)<.5&&N.getY(i)>.5)c.lerp(cM,.7); }
        else{ const ao=U.clamp(.9+z*.05,.8,1.02); c.setRGB(ao,ao,ao*1.02); }   // only a soft recess shade
        col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b; }
      g.setAttribute('color',new THREE.BufferAttribute(col,3));
      g.translate(x0,-4,z0-3);
      const mat=a.mat==='toon'?G.toon('#ffffff',{vertexColors:true}):rock({wet:true,moss:true,strata:true});
      const grp=D.group=new THREE.Group(); grp.name='cliffmatDebug';
      const m=new THREE.Mesh(g,mat); m.receiveShadow=m.castShadow=true; grp.add(m);
      // boulders, instanced, to check the instanced path
      const bg=new THREE.IcosahedronGeometry(1,3), BP=bg.attributes.position;
      for(let i=0;i<BP.count;i++){ const v=new THREE.Vector3().fromBufferAttribute(BP,i), k=1+(U.vnoise(v.x*2+5,v.z*2+v.y)-.5)*.5; BP.setXYZ(i,v.x*k,v.y*k*.7,v.z*k); }
      bg.computeVertexNormals(); const bc=new Float32Array(BP.count*3).fill(a.mat==='toon'?.35:1); bg.setAttribute('color',new THREE.BufferAttribute(bc,3));
      const im=new THREE.InstancedMesh(bg,a.mat==='toon'?G.toon('#5d6372',{vertexColors:true}):rock({instanced:true}),7), M=new THREE.Matrix4(), q=new THREE.Quaternion();
      for(let i=0;i<7;i++){ const s=1.2+((i*37)%5)*.5; q.setFromEuler(new THREE.Euler(.2*i,i*1.3,0));
        M.compose(new THREE.Vector3(x0-13+i*4.2,-.6+(i%3)*.4,z0+1.5+(i%2)*1.5),q,new THREE.Vector3(s*1.3,s,s)); im.setMatrixAt(i,M); }
      im.receiveShadow=im.castShadow=true; grp.add(im);
      G.scene.add(grp); return {x:x0,z:z0,verts:P.count};
    },
    /** stacks(true) puts the rock material on the existing sea stacks; stacks(false) restores theirs */
    stacks(on=true){ const s=G.scene.getObjectByName('seaStacks'); if(!s)return false;
      if(on){ if(!D.stackMat)D.stackMat=s.material; s.material=rock({vertexColors:false}); }
      else if(D.stackMat){ s.material=D.stackMat; D.stackMat=null; }
      return true; },
    clear(){ if(D.group){ G.scene.remove(D.group); D.group.traverse(o=>{if(o.geometry)o.geometry.dispose();}); D.group=null; } },
    /** cam(px,py,pz,tx,ty,tz): freeze the game clock and frame a shot (sun shadows follow the target) */
    cam(px,py,pz,tx,ty,tz){ if(G.headless)G.headless.hold=true;
      const c=G.camera, d=G.lights.sunDir, sun=G.lights.sun; c.position.set(px,py,pz); c.lookAt(tx,ty,tz); c.updateMatrixWorld();
      G.focus.set(tx,ty,tz); sun.position.set(tx+d.x*120,ty+d.y*120,tz+d.z*120); sun.target.position.set(tx,ty,tz); sun.target.updateMatrixWorld();
      if(G.headless)G.headless.draw(3); return true; },
  };
}
})();
