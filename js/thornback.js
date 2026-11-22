/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — thornback.js
   The Thornback: the fog kept the shape of a wild boar and filled it with ink. Dead bramble has grown over its back and
   flanks like a hide. Three of them roam the deep wood, and only once the core loop has begun.  Spec: THORNBACK.md (OILS.md)
   It is a monsters.js kind (G.monsters.define): lock-on, attack tokens, moths, leash, death, ichor and the shared ink look
   come from there; this file holds its model, animation, behaviour, the hide and the three homes.
   · The hide: while it is on, staff blows and bolts land for half (rounded down, never below 1) and just crackle off it;
     the animal doesn't flinch. It comes off for good (until the animal comes back) after T.hideBurn s of burning in all,
     or after T.hideSlams shockwave blows. Bare, every blow lands in full and makes it flinch.
   · The charge: from T.chargeMin to T.chargeMax m it lowers its head, scrapes a hoof and snorts (T.chargeWind s), then runs
     nearly straight at where you were. Running into a tree, a rock or a wall stuns it for T.stun s (blows x T.stunMul).
   · The tusk swipe: up close, a short wind-up, then a hooking arc in front of it.
   API: G.thornback = {T, homes, list(), startSpot(), debug:{spawnAt, info, pose, fill, homes}}
   Events: thornback:sfx {name, pos, monster, how} · thornback:glance {monster, kind} · thornback:crack {monster, n}
           thornback:hide {monster, how:'burn'|'break'} · thornback:windup {monster, atk} · thornback:charge {monster}
           thornback:stun {monster} · thornback:respawn {id}
   Persist key 'thornback': {v:1, wait:{homeId: seconds of play until it comes back}}
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U, PI=Math.PI, TAU=PI*2;
if(!G.monsters||!G.monsters.define||!G.monsters.fx)return;
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const FX=G.monsters.fx, rnd=U.rng(7741);
const clamp=U.clamp;

/* ---------------------------------------------------------------- the numbers (one table) */
const T={hp:26,radius:.85,height:1.75,aggro:16,walk:2.4,wander:1.05,zoneR:14,
  chargeMin:6,chargeMax:16,chargeWind:.9,chargeSpeed:9.5,chargeLen:14,chargeTurn:.15,chargeDmg:3,chargeKb:15,chargeRecover:1.2,
  swipeRange:2.7,swipeWind:.5,swipeDur:.28,swipeArc:1.1,swipeReach:1.9,swipeDmg:2,swipeKb:7,recover:.85,
  hurt:.3,stun:2.2,stunMul:1.5,hideBurn:3,hideSlams:2,drops:3,respawn:300,respawnAway:45};
// homes: picked by sampling the deep wood for open, level, walkable ground among the trees, at least 25 m from the
// Resisting Tree, the Vigil's hollow, the kiln, the Blighted Grove and every heart shard and cache (thornback_e2e checks it)
const HOMES=[{id:'north',x:-186,z:-43},{id:'southwest',x:-186,z:50},{id:'southeast',x:-150,z:41}];

const cInk=U.col('#06040a'), cMist=U.col('#3a3346'), cDust=U.col('#3b3328'), cBark=U.col('#6b5a47'), cFire=U.col('#ff9a3c'), cFire2=U.col('#ffd27a'), cVio=U.col('#a67dff');
const BRAMBLE=U.col('#6f5d4b'), BRAMBLE_D=U.col('#463728'), THORN=U.col('#b3a184'), CHAR=U.col('#3b302b');

/* ---------------------------------------------------------------- particles (G.ink pools, any colour) */
function spark(x,y,z,vx,vy,vz,life,s,c){
  const I=G.ink; if(!I||!I.embers||!I.embers.vel)return; const Q=I.embers, i=Q.next; Q.next=(Q.next+1)%Q.N;
  Q.pos[i*3]=x;Q.pos[i*3+1]=y;Q.pos[i*3+2]=z;Q.vel[i*3]=vx;Q.vel[i*3+1]=vy;Q.vel[i*3+2]=vz;
  Q.life[i]=life;Q.max[i]=life;Q.s0[i]=s;Q.s1[i]=s*.3;Q.a0[i]=.95;Q.grav[i]=0;Q.drag[i]=.6;Q.rot[i]=0;Q.spin[i]=0;
  Q.color[i*3]=c.r;Q.color[i*3+1]=c.g;Q.color[i*3+2]=c.b;
}
const puff=FX.puff;

/* ---------------------------------------------------------------- model
   Body-local +z is the snout. One swept ink body with the shoulder hump, a long low head with small ears (one mesh), pale
   tusks (one toon mesh), four short legs (one mesh each) and a smoke tail; over the back and flanks two halves of
   bramble hide (dead canes, curled crest canes and thorns, vertex-coloured toon), split along the spine so it can crack
   and fall away to either side. */
const BODY_Y=.82;
const BODY=[[0,.06,-1.24,.12],[0,.05,-1.08,.4,.42],[0,.03,-.7,.5,.5],[0,.08,-.2,.55,.55],[0,.17,.3,.57,.59],[0,.12,.7,.49,.51],[0,0,.98,.35,.37]];
/** a point on (and `off` m outside) the body: th is the angle round the spine from the top (+ to the +x side) */
function surf(z,th,off){
  let i=0; while(i<BODY.length-2&&BODY[i+1][2]<z)i++;
  const a=BODY[i], b=BODY[i+1], f=clamp((z-a[2])/(b[2]-a[2]),0,1), sf=f*f*(3-2*f);
  const y=U.lerp(a[1],b[1],sf), rx=U.lerp(a[3],b[3],sf), ry=U.lerp(a[4]==null?a[3]:a[4],b[4]==null?b[3]:b[4],sf);
  return V(Math.sin(th)*(rx+off),y+Math.cos(th)*(ry+off),z);
}
/** merge geometries with a flat colour each (position, normal, colour) */
function mergeCol(list){
  let nv=0; const P=[],N=[],C=[],I=[];
  for(const {g,c} of list){ const p=g.attributes.position, n=g.attributes.normal;
    for(let i=0;i<p.count;i++){ P.push(p.getX(i),p.getY(i),p.getZ(i)); N.push(n.getX(i),n.getY(i),n.getZ(i)); C.push(c.r,c.g,c.b); }
    const ix=g.index; if(ix)for(let i=0;i<ix.count;i++)I.push(ix.getX(i)+nv); else for(let i=0;i<p.count;i++)I.push(i+nv);
    nv+=p.count; g.dispose(); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(P,3)); g.setAttribute('normal',new THREE.Float32BufferAttribute(N,3));
  g.setAttribute('color',new THREE.Float32BufferAttribute(C,3)); g.setIndex(I); return g;
}
const _up=V(0,1,0), _q=new THREE.Quaternion(), _m4=new THREE.Matrix4(), _one=V(1,1,1);
function thorn(list,p,dir,len,r){
  const g=new THREE.ConeGeometry(r,len,4,1); g.translate(0,len/2,0);
  _q.setFromUnitVectors(_up,dir.clone().normalize()); g.applyMatrix4(_m4.compose(p,_q,_one)); list.push({g,c:THORN});
}
/** one cane along points [x,y,z,r]: the tube, thorns along it, and the points kept for embers and chips */
function cane(list,pts,R,keep,thorns){
  const sw=FX.sweep(pts.map(p=>[p.x,p.y,p.z,p.r]),5,3);
  list.push({g:sw,c:BRAMBLE_D.clone().lerp(BRAMBLE,.35+R()*.65)});
  const curve=new THREE.CatmullRomCurve3(pts.map(p=>V(p.x,p.y,p.z)));
  const n=thorns==null?Math.round(curve.getLength()/.1):thorns;
  for(let k=0;k<n;k++){ const u=(k+.3+R()*.4)/n, p=curve.getPoint(u), tg=curve.getTangent(u);
    const out=V(p.x,p.y-.05,0).normalize();   // away from the spine
    const side=V().crossVectors(tg,out).normalize().multiplyScalar((R()-.5)*1.6);
    const d=out.clone().multiplyScalar(.8).add(side).addScaledVector(tg,(R()-.5)*.6).normalize();
    thorn(list,p,d,.06+R()*.07,.013+R()*.006);
    if(k%2===0)keep.push(p.clone()); }
}
function buildHideHalf(s,keep){
  const R=U.rng(s>0?3301:3307), L=[];
  const P=(z,th,off,r)=>{ const p=surf(z,th,off); p.r=r; return p; };
  // canes that wander over the back from the spine down the flank, unevenly spaced, some short, some long
  for(let i=0;i<9;i++){ const z0=-1.0+(i+R()*.8)*.19, n=6, pts=[], drift=(R()-.5)*.5, reach=.9+R()*.85, th0=s*(.04+R()*.2);
    for(let j=0;j<n;j++){ const f=j/(n-1); pts.push(P(z0+drift*f+(R()-.5)*.07,th0+s*f*reach,.035+R()*.045,.032*(1-f*.4))); }
    cane(L,pts,R,keep,Math.round(5+R()*3)); }
  // long canes along the flank, nose to tail, sagging and wild
  for(const th of [.85,1.45]){ const pts=[], t0=th+(R()-.5)*.2;
    for(let j=0;j<7;j++){ const z=-1.04+j*.27+(R()-.5)*.08; pts.push(P(z,s*(t0+Math.sin(j*1.7+R())*.22),.05+R()*.05,.028)); }
    cane(L,pts,R,keep,9); }
  // the crest: canes rising out of the spine, leaning back at odd angles, tallest over the shoulders, the tips hooked;
  // and a few bare spikes between them, so the outline bristles rather than arches
  for(let i=0;i<5;i++){ const z0=-.86+i*.34+(R()-.5)*.14, hump=Math.exp(-((z0-.2)**2)*3), h=.2+.3*hump+R()*.16, a=s*(.05+R()*.22), back=.1+R()*.28, lean=s*(R()*.25);
    const pts=[P(z0,a,.02,.042),P(z0-back*.35,a+lean*.4,h*.55,.034),P(z0-back*.8,a+lean,h*.95,.025),P(z0-back*1.2,a+lean*1.3+s*.12,h*.88,.017),P(z0-back*1.35,a+lean*1.5+s*.2,h*.66,.01)];
    cane(L,pts,R,keep,4); }
  for(let i=0;i<4;i++){ const z=-.7+i*.42+(R()-.5)*.15, p=surf(z,s*(.08+R()*.2),.02), hump=Math.exp(-((z-.2)**2)*3);
    thorn(L,p,V(s*(.15+R()*.3),1,-.35-R()*.5).normalize(),.22+.22*hump+R()*.12,.028+R()*.01); }
  // a couple of coils on the flank, like a snarl of old briar
  for(let i=0;i<2;i++){ const zc=-.75+i*.8+(R()-.5)*.2, tc=s*(.95+R()*.4), pts=[];
    for(let j=0;j<9;j++){ const a=j/8*TAU*1.1; pts.push(P(zc+Math.cos(a)*.16,tc+s*Math.sin(a)*.32,.06+.05*Math.sin(a*1.5+1),.024)); }
    cane(L,pts,R,keep,7); }
  // dead stubs and long spikes poking out of the flank
  for(let i=0;i<10;i++){ const z=-.95+R()*1.65, th=s*(.3+R()*1.3), p=surf(z,th,.03), out=V(p.x,p.y-.05,0).normalize();
    thorn(L,p,out.clone().add(V((R()-.5)*.5,R()*.4,-.2-R()*.5)).normalize(),.13+R()*.15,.018+R()*.01); }
  return mergeCol(L);
}
function build(S){
  const mat=FX.inkMat(S,{amp:.04,wisp:.85,flow:.4,scale:2.2,mist:.42,rimK:.75});
  const headMat=FX.inkMat(S,{amp:.025,wisp:.75,flow:.4,scale:2.6,rimK:.9});
  const tMat=FX.inkMat(S,{amp:.02,wisp:.95,flow:.7,scale:3,fray:.7,rimK:.5});
  const tuskMat=G.toon('#ddd3bf',{emissive:'#1a1620'});
  const root=new THREE.Group(), body=new THREE.Group(); root.add(body); body.position.y=BODY_Y;
  const add=(par,g,m)=>{ const o=new THREE.Mesh(g,m); par.add(o); return o; };
  add(body,FX.sweep(BODY,16,4),mat);
  // head: a long wedge hanging low from the neck, flat snout disc, small pricked ears
  const head=new THREE.Group(); head.position.set(0,-.02,.92); body.add(head);
  const hg=[FX.sweep([[0,.07,-.12,.31,.33],[0,.02,.14,.28,.28],[0,-.08,.38,.19,.2],[0,-.15,.56,.135,.13],[0,-.17,.66,.125,.115]],12,4)];
  for(const s of [-1,1])hg.push(FX.sweep([[s*.15,.24,.0,.06,.035],[s*.21,.36,-.06,.04,.02],[s*.23,.45,-.1,.004]],6,2));
  add(head,FX.mergeGeos(hg),headMat);
  const tg=[]; for(const s of [-1,1])tg.push(FX.sweep([[s*.09,-.19,.44,.036],[s*.16,-.16,.53,.031],[s*.215,-.06,.59,.024],[s*.22,.06,.56,.013],[s*.2,.11,.5,.003]],7,3));
  const tusks=add(head,FX.mergeGeos(tg),tuskMat); const tuskLine=G.outline(tusks,{thickness:.012,color:'#06040a'});
  const snout=FX.anchor(head,0,-.18,.7);
  // legs: short and thick, the hoof a dark point dissolving into mist
  const legs=[], hooves=[];
  for(const [sx,sz] of [[-1,1],[1,1],[-1,-1],[1,-1]]){
    const hip=new THREE.Group(); hip.position.set(sx*.27,-.16,sz>0?.52:-.78); body.add(hip);
    add(hip,FX.sweep([[0,.18,0,sz>0?.21:.24,.26],[0,-.12,sz>0?.03:-.05,.16],[0,-.4,.02,.11],[0,-.58,.05,.095],[0,-.67,.08,.075,.06]],9,3),mat);
    const hv=FX.anchor(hip,0,-.66,.07); hooves.push(hv);
    legs.push({hip,front:sz>0,side:sx,hoof:hv});
  }
  const tail=FX.anchor(body,0,.18,-1.22);
  const ribbons=[{a:tail,o:{n:7,len:.55,r0:.05,r1:0,dir:V(0,-.4,-1),stiff:6,wave:.12,freq:3.4,lift:-.1},mat:tMat}];
  // the hide, two halves split along the spine
  const hide=[], hidePts=[], hideMats=[], hideLines=[];
  for(const s of [1,-1]){ const keep=[];
    const hm=G.toon('#ffffff',{vertexColors:true,emissive:'#000000'});
    const g=new THREE.Group(); body.add(g);
    const mesh=add(g,buildHideHalf(s,keep),hm); const ol=G.outline(mesh,{thickness:.012,color:'#0a070c'}); if(ol)hideLines.push(ol);
    hide.push({g,mesh,s}); hidePts.push(...keep); hideMats.push(hm); }
  const back=[]; for(let k=0;k<6;k++){ const p=surf(-.9+k*.32,(k%2?1:-1)*1.9,0); back.push(FX.anchor(body,p.x,p.y,p.z)); }
  back.push(FX.anchor(head,0,.1,.1));
  return {root,body,head,tusks,snout,legs,hooves,tail,hide,hidePts,hideMats,lines:[tuskLine].concat(hideLines),back,
    ribbonsDef:ribbons,ribbonMat:tMat,eyes:[],mats:[mat,headMat,tMat],extra:[tuskMat].concat(hideMats),tendrils:[]};
}
function fx(m,I,add){
  const c=m.parts;
  m.fx.body=add(I.emitter(c.back,{rate:9,radius:.2,height:.2,size:[.7,1.8],life:[.9,1.7],rise:.45,drift:.2,trail:.9,alpha:.7,color:'#0b0712'}));
  m.fx.legs=add(I.emitter(c.hooves,{rate:6,radius:.14,size:[.45,1.2],life:[.5,1.0],rise:.15,drift:.25,trail:.9,alpha:.55,color:'#16101f'}));
  m.fx.pool=add(I.pool(m.pos,{radius:1.55,alpha:.7}));
}

/* ---------------------------------------------------------------- the hide */
function hideState(m){ return m.hide||(m.hide={on:true,burn:0,slams:0,how:null,offT:0,shiver:0,burning:false,crack:0}); }
function emitAt(m,name,o){ G.emit('thornback:sfx',Object.assign({name,pos:V(m.pos.x,m.pos.y+1,m.pos.z),monster:m},o||{})); }
const _w=V();
function hidePoint(m,i){ const c=m.parts, p=c.hidePts[(i==null?(rnd()*c.hidePts.length):i)|0]; return c.body.localToWorld(_w.copy(p)); }
function chips(m,dir,n){ // dry bramble bits knocked off by a glancing blow
  if(m.fxK<=0)return;
  for(let k=0;k<n;k++){ const p=hidePoint(m); const s=1+rnd()*2.5;
    puff(p.x,p.y,p.z,-dir.x*s*.4+(rnd()-.5)*2,1+rnd()*2,-dir.z*s*.4+(rnd()-.5)*2,1.1,.12,.08,1,cBark,9,.4); }
}
function burnOff(m){
  const H=hideState(m); if(!H.on)return;
  H.on=false; H.how='burn'; H.offT=0;
  G.emit('thornback:hide',{monster:m,how:'burn'}); emitAt(m,'hide',{how:'burn'});
}
function breakOff(m,dir){
  const H=hideState(m); if(!H.on)return;
  H.on=false; H.how='break'; H.offT=0;
  const c=m.parts; c.root.updateMatrixWorld(true);
  for(const h of c.hide){ // each half slides off its own side and falls to the ground, then sinks
    G.scene.attach(h.g); const fallSide=h.s;
    falls.push({g:h.g,mesh:h.mesh,mat:h.mesh.material,t:0,s:fallSide,yaw:m.heading,q0:h.g.quaternion.clone(),p0:h.g.position.clone(),
      ground:G.floorAt(h.g.position.x,h.g.position.z,h.g.position.y+1),spin:(rnd()-.5)*.6}); }
  c.hide.length=0;
  for(let k=0;k<22;k++){ const a=rnd()*TAU; puff(m.pos.x+Math.cos(a)*.8,m.pos.y+1.1+rnd()*.5,m.pos.z+Math.sin(a)*.8,Math.cos(a)*2.4,1.5+rnd()*2,Math.sin(a)*2.4,1.3,.14,.09,1,cBark,9,.4); }
  G.ui.shake&&G.ui.shake(.25);
  G.emit('thornback:hide',{monster:m,how:'break'}); emitAt(m,'hide',{how:'break'});
}
const falls=[];
const _ax=V(0,0,1), _fq=new THREE.Quaternion();
function stepFalls(dt){
  for(let i=falls.length-1;i>=0;i--){ const f=falls[i]; f.t+=dt;
    const k=U.smooth(0,.7,f.t), drop=Math.min(1,f.t/.7);
    const fx=Math.cos(f.yaw), fz=-Math.sin(f.yaw);   // the animal's +x side in the world
    _fq.setFromAxisAngle(_ax,-f.s*1.45*k); f.g.quaternion.copy(f.q0).multiply(_fq);
    f.g.rotateY(f.spin*k);
    const sink=f.t>4?Math.min(1.1,(f.t-4)*.36):0;
    f.g.position.set(f.p0.x+fx*f.s*1.35*k,U.lerp(f.p0.y,f.ground+.5,drop*drop)-sink,f.p0.z+fz*f.s*1.35*k);
    if(f.t>.62&&!f.landed){ f.landed=true; for(let n=0;n<8;n++)puff(f.g.position.x+(rnd()-.5),f.ground+.1,f.g.position.z+(rnd()-.5),(rnd()-.5)*2,.6+rnd(),(rnd()-.5)*2,1,.4,1.1,.5,cDust,0,1.2); }
    if(f.t>7.2){ G.scene.remove(f.g); f.mesh.geometry.dispose(); f.mat.dispose(); falls.splice(i,1); }
  }
}
function clearFalls(){ for(const f of falls){ G.scene.remove(f.g); f.mesh.geometry.dispose(); f.mat.dispose(); } falls.length=0; }
function stepHide(m,dt){
  const H=hideState(m);
  H.shiver=Math.max(0,H.shiver-dt*4);
  if(!H.on){ H.offT+=dt; H.burning=false; return; }
  let b=false; try{ b=!!(G.oils&&G.oils.burning&&G.oils.burning(m)); }catch(e){}
  H.burning=b;
  if(b){ H.burn+=dt; if(H.burn>=T.hideBurn-.04)burnOff(m); }   // a frame's grace: one full Kilnfire burn is exactly the threshold
}

/* ---------------------------------------------------------------- behaviour */
let L=null;   // monsters.js helpers (G.monsters.define)
const ATTACK=new Set(['windCharge','charge','swipeWind','swipe','recover']);
function go(m,s){ if(ATTACK.has(m.state)&&!ATTACK.has(s))L.dropToken(m); m.state=s; m.st=0; }
function slowK(m){ const o=m.oilSlow; return o&&o.t>0&&o.k>0?o.k:1; }   // Holly Ward (oils slice 2 sets m.oilSlow)
function init(m,opts){
  hideState(m); m.hold=false; m.chargeV=0; m.swipeSide=1; m.hurtSide=1; m.sfxT=0; m.home.y=m.pos.y;
  m.hb.oil={burn:true}; m.hb.lockOffset=1.05;
  m.thornHome=opts.thornHome||null;
}
function update(m,dt){
  if(m.hold){ m.speedNow=m.holdSpeed||0; if(m.state==='charge')m.flare=1; const H=hideState(m); if(!H.on)H.offT+=dt; return; }   // debug.pose: held in a state for pictures
  const pp=L.playerPos(), alive=L.playerAlive(), dP=pp?Math.hypot(pp.x-m.pos.x,pp.z-m.pos.z):1e9, dy=pp?Math.abs(pp.y-m.pos.y):99;
  const slow=slowK(m);
  stepHide(m,dt);
  m.flare=U.damp(m.flare,0,4,dt);
  switch(m.state){
    case 'idle':
      L.wander(m,dt,T);
      if(alive&&!L.playerFar(m)&&dP<T.aggro&&dy<5)go(m,'chase');
      break;
    case 'chase':{
      if(!alive||L.playerFar(m)||Math.hypot(m.pos.x-m.home.x,m.pos.z-m.home.z)>m.zone.r+L.LEASH+5){ go(m,'return'); break; }
      m.cool-=dt;
      const toP=Math.atan2(pp.x-m.pos.x,pp.z-m.pos.z), facing=Math.abs(U.angDiff(toP,m.heading))<.45;
      L.faceTo(m,pp.x,pp.z,2.6,dt);
      if(m.cool<=0&&facing&&dy<2.5){
        if(dP<T.swipeRange&&L.takeToken(m)){ m.swipeSide=rnd()<.5?1:-1; go(m,'swipeWind'); G.emit('thornback:windup',{monster:m,atk:'swipe'}); break; }
        if(dP>=T.chargeMin&&dP<=T.chargeMax&&L.takeToken(m)){ go(m,'windCharge'); G.emit('thornback:windup',{monster:m,atk:'charge'}); emitAt(m,'snort'); break; }
      }
      if(dP>T.swipeRange*.8){ const s=T.walk*slow; if(!L.moveDir(m,m.heading,s,dt))m.heading+=.5*dt*(m.orbit||1); m.speedNow=s; }
      else m.speedNow=0;
      break;}
    case 'windCharge':
      m.speedNow=0; m.flare=Math.min(1,m.st/T.chargeWind*1.2);
      if(pp&&m.st<T.chargeWind*.72)L.faceTo(m,pp.x,pp.z,4.5,dt);   // locks in for the last part: a roll then gets you clear
      if(m.st>=T.chargeWind/slow){ m.dashDir.set(Math.sin(m.heading),0,Math.cos(m.heading)); m.travel=0; m.hitSet.clear(); m.didHit=false; m.chargeV=T.chargeSpeed*.35;
        go(m,'charge'); G.emit('thornback:charge',{monster:m}); }
      break;
    case 'charge':{
      m.flare=1;
      const top=T.chargeSpeed*slow; m.chargeV=Math.min(top,m.chargeV+top*dt/.16);
      if(pp&&alive&&!m.didHit&&Math.hypot(pp.x-m.pos.x,pp.z-m.pos.z)>5){ const want=Math.atan2(pp.x-m.pos.x,pp.z-m.pos.z), d=U.angDiff(want,m.heading); m.heading+=clamp(d,-T.chargeTurn*dt,T.chargeTurn*dt); }
      const fx=Math.sin(m.heading), fz=Math.cos(m.heading), step=m.chargeV*dt, x0=m.pos.x, z0=m.pos.z;
      const ok=L.stepMove(m,fx*step,fz*step);
      const prog=(m.pos.x-x0)*fx+(m.pos.z-z0)*fz;
      m.travel+=Math.max(0,prog); m.speedNow=m.chargeV;
      if(L.strikeAt(m,m.pos.x+fx*1.35,m.pos.y+.9,m.pos.z+fz*1.35,1.15,T.chargeDmg,T.chargeKb,'charge').length)m.didHit=true;
      if((!ok||prog<step*.4)&&m.travel>.5&&step>1e-4){ stun(m); break; }   // ran head-on into something solid
      if(m.travel>=T.chargeLen){ m.skid=true; go(m,'recover'); }
      break;}
    case 'stunned':
      m.speedNow=0; m.flare=0;
      if(m.st>=T.stun){ m.cool=.5+rnd()*.5; go(m,'chase'); }
      break;
    case 'swipeWind':
      m.speedNow=0; m.flare=Math.min(1,m.st/T.swipeWind*1.25);
      if(pp&&m.st<T.swipeWind*.7)L.faceTo(m,pp.x,pp.z,3.5,dt);
      if(m.st>=T.swipeWind/slow){ m.hitSet.clear(); go(m,'swipe'); emitAt(m,'tusk'); }
      break;
    case 'swipe':{
      m.flare=1;
      const f=Math.min(1,m.st/T.swipeDur), a=m.heading+m.swipeSide*(-1+2*f)*T.swipeArc;
      L.strikeAt(m,m.pos.x+Math.sin(a)*T.swipeReach,m.pos.y+.8,m.pos.z+Math.cos(a)*T.swipeReach,1.0,T.swipeDmg,T.swipeKb,'melee');
      L.moveDir(m,m.heading,1.6,dt); m.speedNow=0;
      if(m.st>T.swipeDur){ m.skid=false; go(m,'recover'); }
      break;}
    case 'recover':{
      const dur=m.skid?T.chargeRecover:T.recover;
      if(m.skid&&m.chargeV>0){ m.chargeV=Math.max(0,m.chargeV-T.chargeSpeed*dt/.35); const sv=m.chargeV*dt; L.stepMove(m,Math.sin(m.heading)*sv,Math.cos(m.heading)*sv); }
      m.speedNow=m.skid?m.chargeV:0;
      if(m.st>dur){ m.cool=m.skid?1.2+rnd()*1.2:.9+rnd()*.9; m.skid=false; go(m,'chase'); }
      break;}
    case 'hurt':
      m.speedNow=0;
      if(m.st>T.hurt){ m.cool=Math.max(m.cool,.35); go(m,'chase'); }
      break;
    case 'return':
      L.goHome(m,dt,T.walk*1.25);
      if(m.state==='return'&&alive&&!L.playerFar(m)&&dP<T.aggro*.6)go(m,'chase');
      break;
    default: go(m,'idle');
  }
  if(m.state!=='charge')L.separation(m,dt);
}
function stun(m){
  m.chargeV=0; go(m,'stunned'); m.kv.set(-Math.sin(m.heading)*2.5,0,-Math.cos(m.heading)*2.5);   // bounces back off the trunk
  const fx=Math.sin(m.heading), fz=Math.cos(m.heading);
  for(let k=0;k<16;k++)puff(m.pos.x+fx*1.5+(rnd()-.5)*.6,m.pos.y+.6+rnd()*1.2,m.pos.z+fz*1.5+(rnd()-.5)*.6,(rnd()-.5)*3,1+rnd()*2,(rnd()-.5)*3,1.2,.12,.08,1,cBark,9,.4);
  const P=G.player; if(P&&P.pos&&Math.hypot(P.pos.x-m.pos.x,P.pos.z-m.pos.z)<25&&G.ui.shake)G.ui.shake(.4);
  G.emit('thornback:stun',{monster:m}); emitAt(m,'stun');
}
function hit(m,info){
  if(!m.alive||m.dying)return;
  const kind=info.kind||'melee', H=hideState(m), dir=info.dir||V(0,0,1);
  m.center.set(m.pos.x,m.pos.y+1,m.pos.z);
  if(m.state==='return'&&kind!=='swarm'){ m.flash=.5; FX.splash(m.center,dir,.4); go(m,'chase'); m.aggro=true; return; }   // like the others: no farming it while it walks home
  if(m.hold){ m.hold=false; }
  if(m.state==='intro'){ m.fade=1; m.mat.uniforms.uFade.value=1; }
  let d=info.damage||1, glance=false;
  if(H.on){
    if(kind==='melee'||kind==='bolt'){ d=Math.max(1,Math.floor(d/2)); glance=true; }
    else if(kind==='shockwave'){ H.slams++;
      if(H.slams>=T.hideSlams)breakOff(m,dir); else { chips(m,dir,14); G.emit('thornback:crack',{monster:m,n:H.slams}); emitAt(m,'hide',{how:'crack'}); } }
  }
  if(m.state==='stunned')d*=T.stunMul;
  m.hp-=d; m.flash=glance?.4:1; m.lastHit=G.time; m.aggro=true;
  if(glance){ H.shiver=1; chips(m,dir,6); FX.splash(m.center,dir,.3); G.emit('thornback:glance',{monster:m,kind}); emitAt(m,'glance'); }
  else { FX.splash(m.center,dir,kind==='swarm'?.3:1); L.ash(m.center,kind==='swarm'?2:5,1); if(kind!=='swarm')emitAt(m,'hurt'); }
  if(m.state!=='charge'){ const kb=(info.knockback==null?5:info.knockback)*(glance?.05:.2); m.kv.x+=dir.x*kb; m.kv.z+=dir.z*kb; }
  if(m.hp<=0){ L.die(m,info); emitAt(m,'death'); return; }
  // bare, it flinches like the others; never out of a charge in full flight, a tusk swing already falling, or a stun
  if(!glance&&kind!=='swarm'&&m.state!=='charge'&&m.state!=='swipe'&&m.state!=='stunned'){ m.hurtSide=(dir.x*Math.cos(m.heading)-dir.z*Math.sin(m.heading))>0?1:-1; go(m,'hurt'); }
}

/* ---------------------------------------------------------------- animation */
const _h=V();
function anim(m,dt){
  const c=m.parts, t=G.time, s=m.state, k=m.fxK, H=hideState(m);
  const sp=m.speedNow||0, gallop=s==='charge'||(s==='recover'&&m.skid)||sp>4;
  m.phase+=dt*sp*(gallop?1.45:2.9);
  const amp=Math.min(1,sp/1.4)*(gallop?.8:.42);
  c.legs.forEach((l,i)=>{ const off=gallop?[0,.55,PI,PI+.55][i]:[0,PI,PI,0][i], sn=Math.sin(m.phase+off);
    let rx=sn*amp;
    if(s==='windCharge'&&i===1&&m.st>.1)rx=-.1-Math.max(0,Math.sin(m.st*15))*.8;    // the right fore hoof scrapes back, again and again
    else if(s==='windCharge')rx=l.front?-.12:.22;                                    // weight back on the haunches
    else if(s==='stunned')rx=l.front?-.3+Math.sin(t*2.3+i)*.05:.38;
    else if(m.dying)rx=l.front?-.5:.5;
    l.hip.rotation.x=U.damp(l.hip.rotation.x,rx,gallop||s==='windCharge'?32:16,dt);
    l.hip.rotation.z=U.damp(l.hip.rotation.z,s==='stunned'?l.side*.12:0,8,dt);
    l.footfall=sp>.5&&l.prevS!=null&&l.prevS<0&&sn>=0; l.prevS=sn; });
  let by=BODY_Y+Math.abs(Math.sin(m.phase))*(gallop?.07:.022), pitch=0, roll=0, hx=.08, hy=0, hz=0, hr=10;
  if(s==='idle'&&sp<.2){ hx=.22+Math.sin(t*.9+m.id)*.16; hy=Math.sin(t*.37+m.id*2)*.22; }    // rooting about
  else if(s==='windCharge'){ const q=Math.min(1,m.st/.3); hx=.55*q; pitch=.1*q; by-=.1*q; roll=Math.sin(t*11)*.02*q; hy=Math.sin(t*7)*.05; }
  else if(s==='charge'){ hx=.42; pitch=.05+Math.sin(m.phase*2)*.04; }
  else if(s==='swipeWind'){ const q=Math.min(1,m.st/T.swipeWind); hx=.32*q; hy=-m.swipeSide*.8*q; hz=m.swipeSide*.3*q; by-=.05*q; }
  else if(s==='swipe'){ const f=Math.min(1,m.st/T.swipeDur); hy=m.swipeSide*(-.8+1.7*f); hx=.3-.55*f; hz=-m.swipeSide*.35*f; hr=30; }
  else if(s==='stunned'){ hx=.62+Math.sin(t*2.2)*.08; hy=Math.sin(t*2.7)*.42; roll=Math.sin(t*1.9)*.09; by-=.16; pitch=-.06; }
  else if(s==='hurt'){ const q=Math.max(0,1-m.st/T.hurt); roll=m.hurtSide*.16*q; hx=-.2*q; hr=20; }
  else if(s==='recover'){ hx=m.skid?-.05:.0; pitch=m.skid?-.07:0; hy=Math.sin(t*6)*.12*(m.skid?1:0); }
  else if(s==='intro'){ hx=.3; }
  if(m.dying){ hx=.75; by=BODY_Y-.25*Math.min(1,m.st/1.2); roll=.15*Math.min(1,m.st); }
  c.body.position.y=U.damp(c.body.position.y,by,10,dt);
  c.body.rotation.x=U.damp(c.body.rotation.x,pitch,8,dt); c.body.rotation.z=U.damp(c.body.rotation.z,roll,8,dt);
  c.head.rotation.x=U.damp(c.head.rotation.x,hx,hr,dt); c.head.rotation.y=U.damp(c.head.rotation.y,hy,hr,dt); c.head.rotation.z=U.damp(c.head.rotation.z,hz,hr,dt);
  // the hide: crack (halves part along the spine), shiver on a glance, char and glow while it burns, burn away
  const wob=H.shiver*Math.sin(t*60)*.03;
  c.hide.forEach(h=>{ h.g.rotation.z=U.damp(h.g.rotation.z,-h.s*(.07*H.slams)+wob,12,dt); });
  if(c.hide.length){
    const p=clamp(H.burn/T.hideBurn,0,1), fl=.55+.3*Math.sin(t*23+m.id)+.15*Math.sin(t*41);
    let glow=H.burning?(.35+.45*p)*fl:p*.12, sc=1-p*.12;
    if(!H.on&&H.how==='burn'){ const q=Math.min(1,H.offT/.8); glow=(1.2-q)*fl; sc=(1-p*.12)*(1-q); if(q>=1)c.hide.forEach(h=>h.g.visible=false); }
    for(const mt of c.hideMats){ mt.color.setRGB(1,1,1).lerp(CHAR,p*.85); mt.emissive.copy(cFire).multiplyScalar(glow); if(m.flash>0)mt.emissive.r+=m.flash*.25,mt.emissive.b+=m.flash*.35; }
    c.hide.forEach(h=>h.g.scale.setScalar(Math.max(.001,sc)));
    if(k>0&&(H.burning||(!H.on&&H.offT<.8))){ const n=H.on?2:6;
      for(let q=0;q<n;q++){ const w=hidePoint(m); spark(w.x,w.y,w.z,(rnd()-.5)*.8,1.2+rnd()*1.6,(rnd()-.5)*.8,.6+rnd()*.6,.14+rnd()*.08,rnd()<.4?cFire2:cFire);
        if(rnd()<.3)puff(w.x,w.y,w.z,(rnd()-.5)*.3,.9,(rnd()-.5)*.3,1.2,.2,.7,.35,cMist,0,1); } }
  }
  if(m.dying&&c.lines)c.lines.forEach(o=>{ if(o)o.visible=false; });
  // tail and fx
  if(c.tendrils.length)stepTails(m,dt,1+(gallop?1:0));
  if(m.fx.body)m.fx.body.intensity=k*(.8+m.flare*1.2+(s==='charge'?1:0));
  if(m.fx.legs)m.fx.legs.intensity=k*(sp>.5?1+sp*.1:.5);
  if(m.fx.pool)m.fx.pool.intensity=Math.min(1,k*m.fade);
  if(k<=0||m.dying)return;
  // snorts: ink blown from the snout twice in the charge wind-up (and now and then while rooting)
  const snort=(s==='windCharge'&&(cross(m,.04,dt)||cross(m,.5,dt)))||(s==='idle'&&rnd()<dt*.12);
  if(snort){ c.snout.getWorldPosition(_h); const fx=Math.sin(m.heading), fz=Math.cos(m.heading);
    for(let n=0;n<9;n++)puff(_h.x,_h.y,_h.z,fx*(2+rnd()*2)+(rnd()-.5),-.3+rnd()*.6,fz*(2+rnd()*2)+(rnd()-.5),.7+rnd()*.4,.2,.8,.6,cMist,0,2.2); }
  if(s==='windCharge'){ const l=c.legs[1]; if(rnd()<dt*26){ l.hoof.getWorldPosition(_h); const y=G.floorAt(_h.x,_h.z,_h.y+1), fx=Math.sin(m.heading), fz=Math.cos(m.heading);
      puff(_h.x,y+.08,_h.z,-fx*(2.5+rnd()*2)+(rnd()-.5),.6+rnd()*1.2,-fz*(2.5+rnd()*2)+(rnd()-.5),.9,.25,.8,.55,cDust,1,1.5); }
    if(rnd()<dt*12*m.flare)FX.gather(m.pos.x,m.pos.y+1,m.pos.z,1.6,1); }
  if(gallop&&sp>3)c.legs.forEach(l=>{ if(!l.footfall)return; l.hoof.getWorldPosition(_h); const y=G.floorAt(_h.x,_h.z,_h.y+1);
    for(let n=0;n<3;n++)puff(_h.x,y+.06,_h.z,(rnd()-.5)*1.6,.4+rnd(),(rnd()-.5)*1.6,.8,.3,.9,.45,cDust,1,1.5);
    if(s==='charge'&&t-m.sfxT>.17){ m.sfxT=t; emitAt(m,'gallop'); } });
  if(s==='charge'&&rnd()<dt*30)puff(m.pos.x+(rnd()-.5),m.pos.y+.5+rnd()*1.2,m.pos.z+(rnd()-.5),0,.3,0,.9+rnd()*.5,.7,1.6,.5,cInk,0,2);
  if(s==='stunned'){ c.head.getWorldPosition(_h); const a=t*4.5+(((t*30)|0)%3)*TAU/3;
    spark(_h.x+Math.cos(a)*.5,_h.y+.75,_h.z+Math.sin(a)*.5,0,.1,0,.35,.16,cVio); }
}
function cross(m,at,dt){ return m.st>=at&&m.st-dt<at; }
function stepTails(m,dt,agit){ const c=m.parts; c.root.updateMatrixWorld(true); for(const Tn of c.tendrils)FX.stepTendril(Tn,dt,G.time,agit,0); }

/* ---------------------------------------------------------------- homes, spawning, coming back */
const homes=HOMES.map(h=>({id:h.id,x:h.x,z:h.z,m:null,wait:0,filled:false}));
const looping=()=>!!(G.loop&&G.loop.active);
function spawnHome(h,intro){
  const m=G.monsters.spawn('thornback',{x:h.x,z:h.z},{zone:{name:'thornback-'+h.id,x:h.x,z:h.z,r:T.zoneR},thornHome:h.id,intro:!!intro});
  h.m=m; h.filled=true; return m;
}
function updateHomes(dt){
  if(!looping())return;
  const P=G.player&&G.player.pos;
  for(const h of homes){
    if(h.m&&!h.m.alive){ h.wait=h.m.hp<=0?T.respawn:0; h.m=null; }
    if(h.m)continue;
    if(h.wait>0){ h.wait-=dt; continue; }
    // the first time (a new loop, a load) they are simply there; after a kill one comes back only out of sight
    const far=!P||Math.hypot(P.x-h.x,P.z-h.z)>T.respawnAway;
    if(!h.filled||far){ const back=h.filled; spawnHome(h,back); if(back)G.emit('thornback:respawn',{id:h.id}); }
  }
}
function clearAll(){ for(const h of homes){ if(h.m&&h.m.alive)L.despawn(h.m,false); h.m=null; h.wait=0; h.filled=false; } clearFalls(); }
function startSpot(){ // the Test tools start point: 20 m east of the north home, facing it
  const h=homes[0];
  for(let k=0;k<16;k++){ const a=PI/2+(k%2?1:-1)*Math.ceil(k/2)*.3, x=h.x+Math.sin(a)*20, z=h.z+Math.cos(a)*20;
    if(G.world.walkable&&!G.world.walkable(x,z))continue;
    const y=G.floorAt(x,z,G.world.height(x,z)+2); return {x,y,z,yaw:Math.atan2(h.x-x,h.z-z)}; }
  return {x:h.x+20,y:G.world.height(h.x+20,h.z),z:h.z,yaw:-PI/2};
}

/* ---------------------------------------------------------------- registration, save, system */
L=G.monsters.define('thornback',{params:T,name:'Thornback',lockOffset:1.05,build,fx,init,update,anim,hit});
const regSave=()=>G.persist.register('thornback',{
  save:()=>{ if(!looping())return null; const wait={}; for(const h of homes){ const w=h.m?(h.m.dying?T.respawn:0):Math.max(0,h.wait); if(w>0||(!h.m&&h.filled))wait[h.id]=Math.ceil(w); } return {v:1,wait}; },
  load:d=>{ const w=(d&&d.wait)||{}; for(const h of homes){ if(w[h.id]!=null){ if(h.m&&h.m.alive)L.despawn(h.m,false); h.m=null; h.wait=+w[h.id]||0; h.filled=true; } } }});
if(G.persist&&G.persist.register)regSave(); else G.on('ready',regSave);   // flow.js (G.persist) loads after this file
G.system('thornback',{order:43,modes:['play','dead'],
  update(dt){
    try{ if(G.state.mode==='play')updateHomes(dt); }catch(e){ console.error('thornback homes',e); }
    stepFalls(dt);
  }});
G.on('player:respawn',()=>{ for(const h of homes)if(h.m&&h.m.alive){ const m=h.m; m.chargeV=0; m.skid=false; m.hold=false; } });

const list=()=>G.monsters.list.filter(m=>m.kind==='thornback');
G.thornback={T,homes,list,startSpot,
  debug:{
    /** a Thornback at (x,z) with its own little home there; {hide:false} spawns it bare, {hold:state} poses it */
    spawnAt:(x,z,o)=>{ o=o||{}; const m=G.monsters.spawn('thornback',{x,z},{zone:{name:'thornback-test',x,z,r:o.r||T.zoneR},heading:o.heading});
      if(o.hide===false){ const H=hideState(m); H.on=false; H.how='test'; m.parts.hide.forEach(h=>h.g.visible=false); }
      if(o.cool!=null)m.cool=o.cool; return m; },
    info:m=>{ const H=hideState(m); return {state:m.state,st:+m.st.toFixed(2),hp:+m.hp.toFixed(2),maxHp:m.maxHp,alive:m.alive,dying:m.dying,
      hide:{on:H.on,burn:+H.burn.toFixed(2),slams:H.slams,how:H.how},pos:[+m.pos.x.toFixed(2),+m.pos.y.toFixed(2),+m.pos.z.toFixed(2)],heading:+m.heading.toFixed(3),home:m.thornHome}; },
    /** hold a Thornback in a state (for screenshots): pose(m,'windCharge',.6) */
    pose:(m,state,st,speed)=>{ m.state=state; m.st=st||0; m.hold=true; m.holdSpeed=speed||0; return m; },
    release:m=>{ m.hold=false; },
    burnOff:m=>burnOff(m), breakOff:m=>breakOff(m,V(1,0,0)),
    fill:()=>{ for(const h of homes)if(!h.m){ h.wait=0; h.filled=false; } updateHomes(0); return homes.map(h=>!!h.m); },
    clear:()=>clearAll(), falls:()=>falls.length,
    homes:()=>homes.map(h=>({id:h.id,x:h.x,z:h.z,alive:!!(h.m&&h.m.alive&&!h.m.dying),wait:+h.wait.toFixed(1),filled:h.filled}))
  }};
})();
