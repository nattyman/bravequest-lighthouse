/* =====================================================================
   onboarding.js — first-time moments the playtest (2026-11-07) said needed showing, not telling.
   - G.cine.play(id, {dur, shot(k,t,out), onEnd})  a small letterboxed camera shot, skippable with any button,
     each id plays once per save. Runs after player.js's camera (order 84, like the Gloaming's intro).
   - the cure: when the lens catches, the camera steps outside the tower to watch the warm beam go out over the
     water, then drops to the cliff edge where something is starting to climb (the Gloaming's rise spot).
   - the first ether: the lamp flares violet and the camera pulls up and out over the island while the fog wall
     rolls back, so you see what feeding the light does.
   - two nudges: the lantern shutter (what closing it does), and the staff techniques (once you've swung a lot
     and found none).
   - the opening: after Rowan's first thought on the beach (the warm cottage windows), the camera rises off him and
     follows the walkable route up the cliff path and over the edge to the lighthouse and the cottage (flow.js 'wake:done').
     It plays wherever he has got to by then (the sand, partway up, the headland), waiting for a calm moment, until he
     reaches the cottage.
   API: G.cine = {play(id,o), path(id,o), on, id, safe, seen(id), skip()}  (CONTRACT.md: Cut scenes)
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U;
const V=(x,y,z)=>new THREE.Vector3(x||0,y||0,z||0);
const smooth=t=>t<=0?0:t>=1?1:t*t*(3-2*t);

const S={seen:{}, said:{}, strikes:0};
const C={on:false,id:null,t:0,dur:5,shot:null,onEnd:null,skip:false,cp:V(),lp:V(),fov:50,bars:null,prevFov:null,
  safe:false,clean:false,handBack:null,music:null,fadeOut:0,veil:null};
// a clean shot (o.hud===false): the hearts, objective, pause button and quest marker step aside while it plays
function hudClean(on){ if(typeof document==='undefined')return;
  for(const el of [document.querySelector('#hud .hud-top'),document.getElementById('pauseBtn')]){ if(!el)continue;
    el.style.transition='opacity .35s'; el.style.opacity=on?'0':''; } }

function bars(){
  if(C.bars||typeof document==='undefined')return C.bars;
  const wrap=document.createElement('div'); wrap.id='bqCine'; wrap.setAttribute('aria-hidden','true');
  wrap.style.cssText='position:fixed;inset:0;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .35s';
  const bar=top=>{ const b=document.createElement('div'); b.style.cssText='position:absolute;left:0;right:0;height:8vh;background:#05040a;'+(top?'top:0':'bottom:0'); return b; };
  const hint=document.createElement('div'); hint.textContent='Press any button to skip';
  hint.style.cssText='position:absolute;right:18px;bottom:calc(8vh + 10px);font:500 12px/1 system-ui,sans-serif;letter-spacing:.08em;color:#d8d0e8;opacity:.6;text-shadow:0 1px 3px #000';
  // a black veil for shots that dip to black before handing back (o.fadeOut)
  const veil=document.createElement('div'); veil.style.cssText='position:absolute;inset:0;background:#05040a;opacity:0';
  wrap.append(veil,bar(true),bar(false),hint); C.veil=veil;
  const hud=document.getElementById('hud'); if(hud&&hud.parentNode)hud.parentNode.insertBefore(wrap,hud); else document.body.appendChild(wrap);
  C.bars=wrap; return wrap;
}
function setKeys(v){ const k=typeof document!=='undefined'&&document.getElementById('keys'); if(k)k.style.visibility=v?'':'hidden'; }
const skipKey=()=>{ if(C.on&&C.t>.4)C.skip=true; };
const SKIP_ACTS=['attack','jump','interact','roll','lock','sprint','shutter','potion','pause','advance'];

function play(id,o){
  if(C.on||S.seen[id]||G.state.mode!=='play')return false;
  if(G.cineBusy&&G.cineBusy())return false;
  S.seen[id]=1; Object.assign(C,{on:true,id,t:0,dur:o.dur||5,shot:o.shot,onEnd:o.onEnd||null,skip:false,
    safe:!!o.safe,clean:o.hud===false,handBack:o.handBack||null,fadeOut:+o.fadeOut||0,music:null});
  if(C.clean)hudClean(true);
  const P=G.player; try{ P.setControl&&P.setControl(false); }catch(e){}
  const b=bars(); if(b){ b.style.visibility='visible'; b.style.opacity='1'; }
  if(C.veil){ C.veil.style.transition='none'; C.veil.style.opacity='0'; }
  if(o.music){ try{ const M=G.audio&&G.audio.music; if(M&&M.setOverride){ C.music={name:o.music,prev:M.override!=null?M.override:null}; M.setOverride(o.music); } }catch(e){} }
  addEventListener('keydown',skipKey,true); addEventListener('pointerdown',skipKey,true);
  C.prevFov=G.camera.fov; setKeys(false);
  G.emit('cine',{on:true,id});
  return true;
}
function end(){
  if(!C.on)return; C.on=false;
  removeEventListener('keydown',skipKey,true); removeEventListener('pointerdown',skipKey,true);
  if(C.bars){ const w=C.bars; w.style.opacity='0'; setTimeout(()=>{ if(!C.on)w.style.visibility='hidden'; },420); }
  if(C.veil&&C.fadeOut){ const v=C.veil; v.style.transition='none'; v.style.opacity=String(Math.max(.85,+v.style.opacity||0)); void v.offsetWidth; v.style.transition='opacity .6s'; v.style.opacity='0'; }
  if(C.prevFov){ G.camera.fov=C.prevFov; G.camera.updateProjectionMatrix(); }
  setKeys(true);
  // music: back to whatever the game was playing (unless something else took the override meanwhile, e.g. a boss)
  if(C.music){ try{ const M=G.audio.music; if(M.override===C.music.name)M.setOverride(C.music.prev); }catch(e){} C.music=null; }
  C.safe=false; if(C.clean){ C.clean=false; hudClean(false); }
  const P=G.player; try{ P.setControl&&P.setControl(true); }catch(e){}
  try{ const h=typeof C.handBack==='function'?C.handBack():C.handBack;
    if(P.aimCamera){ if(h&&isFinite(h.yaw))P.aimCamera(h.yaw,h.pitch!=null?h.pitch:.26); else P.aimCamera(P.camYaw!=null?P.camYaw:P.heading,.26); } }catch(e){}
  C.handBack=null;
  const f=C.onEnd; C.onEnd=null; try{ f&&f(); }catch(e){ console.error(e); }
  G.emit('cine',{on:false,id:C.id});
}
function update(dt){
  if(!C.on)return;
  if(G.state.mode!=='play'){ end(); return; }
  C.t+=dt;
  if(C.t>.4&&G.input&&G.input.pressed){ for(const a of SKIP_ACTS){ try{ if(G.input.pressed(a)){ C.skip=true; break; } }catch(e){} } }
  if(C.skip||C.t>=C.dur){ end(); return; }
  const k=C.t/C.dur;
  try{ C.shot(k,C.t,C); }catch(e){ console.error('cine',e); end(); return; }
  if(C.fadeOut&&C.veil){ const f=U.clamp((C.t-(C.dur-C.fadeOut))/C.fadeOut,0,1); C.veil.style.opacity=f.toFixed(3); }
  const cam=G.camera;
  cam.position.copy(C.cp); cam.lookAt(C.lp);
  if(Math.abs(cam.fov-C.fov)>.01){ cam.fov=C.fov; cam.updateProjectionMatrix(); }
  cam.updateMatrixWorld();
}
G.system('cine',{order:84,modes:['play','dead'],update:dt=>{ try{ update(dt); }catch(e){ console.error(e); C.on=true; end(); } }});

/* G.cine.path(id, o): a camera move along a spline, built on play().
   o.path: [Vector3] camera points; o.look: [Vector3] look points, one per camera point. o.fromCamera: true puts the
   follow camera's current position (and Rowan's head as the look point) in front of both lists, so the shot leaves
   from where the player was looking. o.fov: number or [per point]. o.dur (s), o.hold (fraction of dur kept still on
   the last point, default .12). Motion: by arc length, easing up over o.accel and down over o.decel (fractions,
   default .2/.25), so speed never jumps at a point; the look follows the same segment as the camera. Everything else
   (safe, hud, music, handBack, fadeOut, onEnd) goes to play(). Returns play()'s answer. */
function path(id,o){
  if(C.on||S.seen[id]||G.state.mode!=='play')return false;
  const P=G.player, cam=G.camera, ps=o.path.slice(), ls=o.look.slice();
  let fv=Array.isArray(o.fov)?o.fov.slice():null;
  if(o.fromCamera){
    ps.unshift(cam.position.clone());
    const head=P&&P.pos?V(P.pos.x,P.pos.y+1.35,P.pos.z):cam.position.clone().add(cam.getWorldDirection(V()).multiplyScalar(6));
    ls.unshift(head); if(fv)fv.unshift(cam.fov);
  }
  const pc=new THREE.CatmullRomCurve3(ps,false,'centripetal'), lc=new THREE.CatmullRomCurve3(ls,false,'centripetal');
  const hold=o.hold==null?.12:o.hold, f0=cam.fov, n=ps.length-1;
  // speed: eases up over the first a, steady, eases down over the last d (a trapezoid; the peak is only ~1.3x the mean)
  const A=o.accel==null?.2:o.accel, D=o.decel==null?.25:o.decel, vmax=1/(1-A/2-D/2);
  const ease=x=>{ if(x<=0)return 0; if(x>=1)return 1;
    if(x<A)return vmax*x*x/(2*A);
    if(x<=1-D)return vmax*(A/2+(x-A));
    const y=1-x; return 1-vmax*y*y/(2*D); };
  const shot=(k,t,out)=>{
    const u=ease(k/(1-hold)), tt=pc.getUtoTmapping(u);
    out.cp.copy(pc.getPoint(tt)); out.lp.copy(lc.getPoint(tt));
    if(fv){ const x=tt*n, i=Math.min(n-1,Math.floor(x)); out.fov=fv[i]+(fv[i+1]-fv[i])*(x-i); }
    else out.fov=o.fov!=null?o.fov:f0;
  };
  shot(0,0,C);
  return play(id,Object.assign({},o,{shot}));
}
// a safe shot: nothing hurts Rowan (player.js asks G.cine.safe) and the prompt rows stay hidden
(G.promptMute=G.promptMute||[]).push(()=>C.on&&C.safe);
G.cine={ play, path, get on(){ return C.on; }, get id(){ return C.on?C.id:null; }, get safe(){ return C.on&&C.safe; },
  get clean(){ return C.on&&C.clean; }, get t(){ return C.on?C.t:0; }, get dur(){ return C.on?C.dur:0; }, seen:id=>!!S.seen[id], skip(){ C.skip=true; } };
// the Gloaming has its own intro shot: never start ours on top of it
G.cineBusy=()=>!!(G.finaleBoss&&G.finaleBoss.state==='intro');

/* ---------------------------------------------------------------- shots */
const LH=()=>G.world.lighthouse;
function riseSpot(){ // where the Gloaming climbs over the edge (finale_boss.js: walk WNW from the arena until the plateau ends)
  const A=G.world.landmarks.finale||{x:165,z:0}; const d=V(-.5,0,-.87).normalize(); let x=A.x, z=A.z;
  for(let r=0;r<70;r+=1){ const xx=A.x+d.x*r, zz=A.z+d.z*r; if(G.world.onPlateau&&!G.world.onPlateau(xx,zz))break; x=xx; z=zz; }
  return V(x,42,z);
}

// the cure: the lens catches (lighthouse.js stage 2, 9.5 s in) — outside, round the tower, then down to the cliff edge
let cureWatch=true;
function cureShot(){
  const L=LH(); if(!L)return;
  const lc=L.lampCenter?L.lampCenter.clone():V(180,58,0), edge=riseSpot();
  const a0=Math.atan2(edge.z-lc.z,edge.x-lc.x)+1.15;
  play('cure',{dur:7.5,shot(k,t,o){
    const k1=smooth(Math.min(1,k/.5)), k2=smooth((k-.45)/.38); // hold the last framing ~1 s
    // orbit at lamp height, a little above, looking at the lens and the beam going out to sea
    const a=a0+.75*k1, R=19-4*k1;
    const orb=V(lc.x+Math.cos(a)*R,lc.y+3.5-1.5*k1,lc.z+Math.sin(a)*R);
    // then down the cliff top toward the edge, looking at the drop where the fog is thickest
    // out past the edge, over the drop, looking back down the cliff face (where it climbs)
    const A=G.world.landmarks.finale||{x:165,z:0}, ox=edge.x-A.x, oz=edge.z-A.z, ol=Math.hypot(ox,oz)||1;
    const low=V(edge.x+ox/ol*26,42+6,edge.z+oz/ol*26+4);
    o.cp.copy(orb).lerp(low,k2);
    o.lp.copy(lc).lerp(V(edge.x,33,edge.z),k2);
    o.fov=48+6*k2;
  }});
}

// the first ether: the light flares, the camera rises out over the island and watches the fog wall roll back
function etherShot(){
  const L=LH(); if(!L||!G.fog)return;
  const lc=L.lampCenter?L.lampCenter.clone():V(180,58,0);
  play('ether',{dur:7,shot(k,t,o){
    const k1=smooth(Math.min(1,k/.35)), k2=smooth((k-.25)/.75);
    const r=G.fog.radius, c=G.fog.centre||{x:180,z:0};
    // the fog edge, west along the island (where most of it lies)
    const fe=V(c.x-r,10,c.z+8);
    const near=V(lc.x-7,lc.y+1.5,lc.z+5), high=V(lc.x+16,lc.y+34,lc.z+34);
    o.cp.copy(near).lerp(high,k2);
    o.lp.copy(lc).lerp(fe,Math.max(k1*.15,k2));
    o.fov=50+8*k2;
  }});
}

// the opening: Rowan's first thought on the beach has ended (flow.js 'wake:done'). The camera leaves him, rises and follows
// the real route (the trail data in G.world.landmarks.path: the cliff path's switchbacks) up and over the edge, and comes
// to rest on the goal: the dark lighthouse and the cottage with its warm windows. Then a dip to black and the follow camera
// is back behind him, facing on along the route. It plays wherever he is by then (a playtester ran straight off the sand
// and never saw it): on the sand or the turf it leaves from him and joins the climb at its foot; partway up the path it
// picks the climb up where he stands; up on the headland it is only the reveal. Once he is at the cottage (or has the
// cloak) there is nothing left to show, and it is let go. Not at a bad moment: it waits out a card, a boss, a fall,
// a death or the pause, and starts as soon as it can.
function routeUp(){ // the walkable climb, bottom to top, from the trail polyline between the cliff path's two ends
  const L=G.world.landmarks, pts=L.path||[], b=L.cliffPathBottom, t=L.cliffPathTop;
  const near=(p,q)=>q&&Math.hypot(p.x-q.x,p.z-q.z)<.5, ib=pts.findIndex(p=>near(p,b)), it=pts.findIndex(p=>near(p,t));
  if(ib<0||it<0)return null;
  const seg=pts.slice(Math.min(ib,it),Math.max(ib,it)+1); if(ib>it)seg.reverse();
  return seg.map(p=>V(p.x,G.floorAt(p.x,p.z,60),p.z));
}
// a point against the climb: s = metres up the route from its foot, d = how far off it (the two legs run side by side
// below the switchback, a few metres apart in plan and well apart in height, so height counts toward d)
function alongRoute(R,p){
  let best={d:1e9,s:0,i:0}, acc=0;
  for(let i=0;i<R.length-1;i++){ const a=R[i], b=R[i+1], dx=b.x-a.x, dz=b.z-a.z, l=Math.hypot(dx,dz)||1;
    const u=U.clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/(l*l),0,1), d=Math.hypot(p.x-a.x-dx*u,p.z-a.z-dz*u)+Math.abs(p.y-(a.y+(b.y-a.y)*u))*.7;
    if(d<best.d)best={d,s:acc+u*l,i}; acc+=l; }
  best.len=acc; return best;
}
function routeAt(R,s){ // the point s metres up the route
  for(let i=0;i<R.length-1;i++){ const l=Math.hypot(R[i+1].x-R[i].x,R[i+1].z-R[i].z); if(s<=l||i===R.length-2)return R[i].clone().lerp(R[i+1],U.clamp(s/(l||1),0,1)); s-=l; }
  return R[R.length-1].clone();
}
// where he is, as the shot sees it: 'top' (on the headland), 'path' (on the climb, s metres up), or 'below' (the sand,
// the turf, anywhere else under the edge)
function openingWhere(R,p){
  const W=G.world; if(p.y>W.plateauY-3&&W.onPlateau&&W.onPlateau(p.x,p.z))return {at:'top'};
  const r=alongRoute(R,p); return r.d<9&&r.s>2?{at:'path',s:r.s,len:r.len}:{at:'below',len:r.len};
}
// near enough to the cottage (or in it) that the reveal has nothing left to tell him
function atCottage(p){
  const L=G.world.landmarks, d=L.cottageDoor||L.cottage, C=G.world.cottage;
  return !!((C&&C.inside&&C.inside(p))||(d&&Math.hypot(p.x-d.x,p.z-d.z)<14&&p.y>G.world.plateauY-3));
}
// what can stand in the camera's way: the rock skin and the sculpted pieces over the cliffs (cliffs.js, cliffkit.js),
// which stand proud of the ground the height field describes
const _rc=new THREE.Raycaster();
function rocks(){ const a=[]; try{ for(const m of (G.cliffs&&G.cliffs.meshes)||[])if(m&&m.visible!==false)a.push(m);
  for(const m of (G.cliffkit&&G.cliffkit.group&&G.cliffkit.group.children)||[])a.push(m); }catch(e){} return a; }
function rockHit(from,to,objs){ const d=to.clone().sub(from), l=d.length(); if(l<.01||!objs.length)return false;
  _rc.set(from,d.multiplyScalar(1/l)); _rc.near=0; _rc.far=l; return _rc.intersectObjects(objs,false).length>0; }
function openingShot(){
  const L=G.world.landmarks, P=G.player, R=routeUp(); if(!R||!P||!P.pos||!L.cottage||!L.lighthouse)return false;
  const H=(x,z)=>Math.max(G.world.height(x,z),G.floorAt(x,z,1e9)), at=(p,dy)=>V(p.x,H(p.x,p.z)+dy,p.z), flat=v=>{ v.y=0; return v.lengthSq()>1e-6?v.normalize():V(1,0,0); };
  const me=P.pos.clone(), foot=R[0], top=R[R.length-1], w=openingWhere(R,me);
  // the climb's landmarks along the route: the first leg, the switchback at its north end, the second leg, the top
  let sw=0; for(let i=1;i<R.length;i++)if(R[i].z<R[sw].z)sw=i;
  const leg1=R[1].clone().lerp(R[sw],.5), leg2=R[sw].clone().lerp(R[Math.min(R.length-1,sw+3)],.55);
  const lh=V(L.lighthouse.x,L.lighthouse.y,L.lighthouse.z), cot=V(L.cottage.x,L.cottage.y,L.cottage.z), door=L.cottageDoor||L.cottage;
  const goal=lh.clone().lerp(cot,.42).setY(lh.y+10);                // between the tower and the cottage, a little up
  const sOf=p=>alongRoute(R,p).s;
  // the climb, as beats out in the air west of it (the open side, over the lowland): [camera, look, fov, metres up the route]
  const beats=[
    [at(foot,20).add(V(-14,0,12)), at(leg1,5), 56, 0],                    // west of the path's foot, looking up the first leg
    [at(leg1,30).add(V(-16,0,-4)), at(R[sw],1), 56, sOf(leg1)],           // alongside the first leg, rising with it
    [at(R[sw],26).add(V(-12,0,8)), at(leg2,1), 56, sOf(R[sw])],           // level with the switchback, looking back up the second leg
    [at(leg2,22).add(V(-8,0,10)), at(top,1.5), 54, sOf(leg2)]             // over the second leg, near the edge
  ];
  const cams=[], look=[], fov=[]; const add=(c,l,f)=>{ cams.push(c); look.push(l); fov.push(f); };
  // which way is "on" from where he stands, and which way is behind him
  let on, yaw;
  if(w.at==='below'){ on=flat(foot.clone().sub(me)); if(Math.hypot(foot.x-me.x,foot.z-me.z)<4)on=flat(R[1].clone().sub(me)); }
  else if(w.at==='path')on=flat(routeAt(R,w.s+6).sub(routeAt(R,Math.max(0,w.s-2))));
  else on=flat(V(door.x,0,door.z).sub(me));
  yaw=Math.atan2(on.x,on.z);
  // 1. a crane up off him, from behind: he stays in frame. On the climb, it also leans out over the open side (the
  //    lower ground beside the path), away from the face he is climbing
  const crane=me.clone().addScaledVector(on,-9).setY(me.y+10);
  if(w.at==='path'){ const sx=V(on.z,0,-on.x), lo=H(me.x+sx.x*10,me.z+sx.z*10)<H(me.x-sx.x*10,me.z-sx.z*10)?1:-1; crane.addScaledVector(sx,6*lo); }
  add(crane,me.clone().addScaledVector(on,5).setY(me.y+1),52);
  if(w.at==='below'){
    // 2. over the ground between him and the path's foot, heading for it (one point every ~40 m when he has wandered far)
    const d=Math.hypot(foot.x-me.x,foot.z-me.z), m=Math.max(1,Math.round(d/40));
    for(let j=1;j<=m;j++){ const q=me.clone().lerp(foot,j/(m+1)*(m===1?.8:1)), aw=flat(q.clone().sub(foot)); add(at(q,14).addScaledVector(aw,6),at(foot,8),54); }
  }
  // 3. the climb from wherever he is on it: the beats still ahead of him
  if(w.at!=='top')for(const b of beats)if(w.at==='below'||b[3]>w.s+8)add(b[0].clone(),b[1].clone(),b[2]);
  // 4. over the edge: the goal ahead
  add(at(top,15).add(V(-17,0,5)),goal,50);
  // never inside the ground or the rock: every camera point keeps 6 m over the highest ground within 9 m of it, sits
  // above any rock over it, and sees its look point past the rock (raised until it does)
  const objs=rocks(), up=V(0,80,0), clearOf=(c,r,m)=>{ let h=-1e9; for(let a=0;a<8;a++)for(const q of r)h=Math.max(h,H(c.x+Math.cos(a)*q,c.z+Math.sin(a)*q)); return Math.max(c.y,h+m); };
  const sees=(c,l)=>{ for(let k=1;k<12;k++){ const t=k/12, x=l.x+(c.x-l.x)*t, z=l.z+(c.z-l.z)*t; if(l.y+(c.y-l.y)*t<H(x,z)+.5)return false; } return !rockHit(l,c,objs); };
  for(let i=0;i<cams.length;i++){ const c=cams[i];
    c.y=clearOf(c,[0,3,6,9],6);
    if(rockHit(c.clone().add(up),c.clone().add(V(0,-4,0)),objs)){ _rc.set(c.clone().add(up),V(0,-1,0)); _rc.far=84; const h=_rc.intersectObjects(objs,false)[0]; if(h)c.y=Math.max(c.y,h.point.y+5); }
    for(let k=0;k<8&&!sees(c,look[i]);k++)c.y+=4;
  }
  // and between the points: walk the curve the shot will fly (it starts at the follow camera) and lift whichever point
  // a low or blocked stretch belongs to, until the whole flight is clear
  const cam=G.camera, all=()=>[cam.position.clone()].concat(cams), lAll=()=>[V(me.x,me.y+1.35,me.z)].concat(look);
  for(let pass=0;pass<5;pass++){
    const pc=new THREE.CatmullRomCurve3(all(),false,'centripetal'), lc=new THREE.CatmullRomCurve3(lAll(),false,'centripetal'), n=cams.length; let bad=-1, need=0;
    for(let k=4;k<=40&&bad<0;k++){ const t=k/40, c=pc.getPoint(t), l=lc.getPoint(t), g=clearOf(c,[0,2.5,5],3.5)-c.y;
      if(g>.01||(k%2===0&&!sees(c,l))){ bad=Math.max(0,Math.min(n-1,Math.round(t*n)-1)); need=Math.max(g,2.5); } }
    if(bad<0)break; cams[bad].y+=need+1;
  }
  // the time it takes grows with the flight (the full climb from the sand ~14 s; the reveal alone from the headland ~7 s)
  let len=0; { const A=all(); for(let i=1;i<A.length;i++)len+=A[i].distanceTo(A[i-1]); }
  const dur=U.clamp(4+len/26,7,16);
  return path('opening',{dur,path:cams,look,fromCamera:true,fov,hold:.14,fadeOut:.6,
    safe:true,hud:false,music:'wistful',handBack:{yaw,pitch:.22}});
}
// owed from 'wake:done' (the beach start's last line has gone) until it plays or there is nothing left to show
let owed=false;
const openingCan=()=>{ const P=G.player;
  return G.state.mode==='play'&&!C.on&&P&&P.alive&&P.grounded&&P.state!=='hurt'&&P.state!=='roll'&&!P.gliding
    &&!(G.talk&&G.talk.isOpen)&&!(G.monsters&&G.monsters.boss)&&!(G.finaleBoss&&G.finaleBoss.active)&&!(G.map&&G.map.isOpen)&&!(G.cineBusy&&G.cineBusy()); };
function openingTick(){
  if(!owed)return;
  if(S.seen.opening||G.quest.step!=='cottage'||!G.player||!G.player.pos||atCottage(G.player.pos)){ owed=false; return; }
  if(!openingCan())return;
  owed=false; openingShot();   // (a world without the route or the goal has no shot to give: let it go)
}
G.on('wake:done',e=>{ if(!e||!e.windows||S.seen.opening)return; owed=true; openingTick(); });
G.system('openingWatch',{order:83,update:openingTick});

G.on('lamp:fed',()=>{ // fog.js marks itself fed just after this event: before that, this is the first feed
  try{ const fed=G.fog&&G.fog._persist&&G.fog._persist.save().fed; if(fed||!G.lamp||!G.lamp.active)return; }catch(e){ return; }
  if(S.seen.ether)return;
  setTimeout(()=>etherShot(),350); // let the flash land first
});
G.system('cineWatch',{order:83,update(){
  const L=G.lighthouse; if(!cureWatch||!L)return;
  if(L.cured&&!L.cure){ cureWatch=false; return; }         // already cured (save, test start): nothing to show
  if(L.cure&&L.cure.t>9.3&&!S.seen.cure){ cureWatch=false; cureShot(); }
}});

/* ---------------------------------------------------------------- nudges */
function say(key,text,o){ if(S.said[key])return; S.said[key]=1; try{ G.ui.say(text,Object.assign({key:'onb-'+key},o||{})); }catch(e){} }
G.on('lantern:shutter',e=>{
  if(!e||!e.shut||(G.cave&&G.cave.inside)||(G.undercroft&&G.undercroft.inside))return;
  say('shutter','The shutter drops and the dark closes in. Keep it shut a while and the moths lose the scent and drift away — open it to call them back.');
});
G.on('player:attack',e=>{
  if(!e||e.charged||e.move||e.shove)return; S.strikes++;
  if(S.strikes<30||S.said.combos)return;
  let found=0; try{ const m=G.moves; if(m&&m.isFound)found=['lunge','sweep','slam','spin','plunge'].filter(k=>m.isFound(k)).length; }catch(e){}
  if(found>0){ S.said.combos=1; return; }
  say('combos','The staff remembers more than a plain swing. Strike out of a roll, a sprint, a jump — or a jump on top of a jump. The pause menu keeps what you find.');
});

/* ---------------------------------------------------------------- save */
G.persist&&G.persist.register('onboarding',{
  save:()=>({v:1,seen:Object.assign({},S.seen),said:Object.assign({},S.said),strikes:S.strikes|0}),
  load:d=>{ if(!d||typeof d!=='object')return; S.seen=Object.assign({},d.seen||{}); S.said=Object.assign({},d.said||{}); S.strikes=d.strikes|0; cureWatch=!S.seen.cure; }
});
// a save from before this module: an already-fed lamp or a cured lighthouse means those moments have passed
G.on('loop:start',e=>{ try{ if(G.fog&&G.fog._persist&&G.fog._persist.save().fed)S.seen.ether=1; }catch(_){} });

if(G.debug)G._onb={S,C,cureShot,etherShot,riseSpot,openingShot,routeUp,alongRoute,openingWhere,atCottage,get owed(){ return owed; }};
})();
