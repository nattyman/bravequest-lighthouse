/* =====================================================================
   oils.js — Keeper's Oils: flasks of dressing for the Keeper's Staff
   G.oils {OILS, max, count, total, full, add, take, list, armed, active, fixed, apply, clear,
           has, strength, fix, unfix, burning, slowed, openPicker, debug}
   Carry up to three flasks (any mix), dress the staff in the field (V, or hold the draught action:
   core.js turns a long hold into the 'oil' action while a flask is carried), and the coat lasts a
   while of play. Kilnfire burns, Burst bursts a bolt where it ends, Holly Ward slows. One oil at a time can be
   fixed into the staff (the Temper tab in progression.js charges for it and calls fix()): it then works always, with
   no timer, at the gentler numbers in its row (fixed*); a coat of another oil works on top of it, a coat of the same
   oil is full strength while it lasts. Brewed at the alchemy table (alchemy.js calls G.oils.add).
   Hooks used in player.js: actionLock, speedMul, poseHooks, drawStaff(), staffOil (the tip's look).
   Monsters take a burn tick as a hit of kind 'burn' (monsters.js decides what that does).
   Events: oils:change · oil:apply · oil:on · oil:off · oil:ignite · oil:burn · oil:burst · oil:slow · oil:fixed
   Persist key 'oils'. Spec: OILS.md
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, U=G.U;
const {clamp,smooth,lerp}=U;
const PI=Math.PI, TAU=PI*2;
const col=hex=>U.col(hex);

/* ---------- the oils (one row each; numbers live here) ---------- */
const OILS={
  kilnfire:{id:'kilnfire',name:'Kilnfire Oil',desc:'Every staff blow sets the struck thing burning.',color:'#e3a13a',dur:90,slice:1,
    flame:true,burn:{dmg:1,dps:1,secs:3,fixedSecs:2}},
  burst:{id:'burst',name:'Burst Oil',desc:'A charged bolt bursts where it ends.',color:'#a56cff',dur:90,slice:2,
    burst:{dmg:3,r:2.5,greatDmg:4,greatR:3.5,fixedDmg:2,fixedR:1.8,fixedGreatDmg:3,fixedGreatR:2.5,kb:6}},
  holly:{id:'holly',name:'Holly Ward',desc:'Struck monsters move slower for a while.',color:'#9fc28a',dur:90,slice:2,
    slow:{k:.75,secs:4,fixedK:.85,fixedSecs:3}}
};
const N={
  max:3,          // flasks carried, any mix
  dress:1.2,      // seconds to dress the staff (open to attack)
  slow:.5,        // walk-speed multiplier while dressing
  buffer:.6,      // a press during a roll/swing waits this long for it to end
  fixedK:.45,     // how strongly a fixed oil tints the tip
  // dressing pose: staff upright in the right hand, the left hand works the oil along it
  pose:{shRX:-.6,shRY:-.35,shRZ:.25,elR:-1.55,wrRX:.15,shLX:-.85,shLY:.45,shLZ:-.25,elL:-1.35,hdX:.32,spX:.12}
};
/* which kinds of player blow carry an oil's effect */
const AFFECT_KINDS=new Set(['melee','bolt','shockwave']);

const S={n:{},active:null,fixed:null,hint:false}; // saved
let dressT=-1, dressId=null, bufT=0, bufId=null;
const P=()=>G.player;
const canAct=st=>['idle','move','sprint','exhausted','jump','fall'].includes(st);
const known=id=>!!OILS[id];

function total(){ let t=0; for(const k in S.n)t+=S.n[k]|0; return t; }
function changed(id){ G.emit('oils:change',{id:id||null,n:id?(S.n[id]|0):0,total:total()}); }
function add(id,n=1){
  if(!known(id)||!(n>0))return 0;
  const got=Math.max(0,Math.min(n|0,N.max-total())); if(!got)return 0;
  S.n[id]=(S.n[id]|0)+got; changed(id);
  if(!S.hint){ S.hint=true; try{ G.ui.toast(hintText()); }catch(_){} }
  return got;
}
/* the first-flask hint names the control for the device in use */
function hintText(){
  const d=G.input&&G.input.device;
  if(d==='gamepad')return 'Hold D-pad up to dress your staff';
  if(d==='touch')return 'Hold the bottle button to dress your staff';
  return 'Press V (or hold H) to dress your staff';
}
function take(id,n=1){ if((S.n[id]|0)<n)return false; S.n[id]-=n; if(S.n[id]<=0)delete S.n[id]; changed(id); return true; }
function list(){ return Object.keys(OILS).filter(id=>(S.n[id]|0)>0).map(id=>({id,n:S.n[id],name:OILS[id].name})); }
function has(id){ return !!(S.active&&S.active.id===id)||S.fixed===id; }
function strength(id){ return S.active&&S.active.id===id?'coat':S.fixed===id?'fixed':0; }

/* the fixed oil: one at a time, no timer, the gentler numbers (the cost is charged by progression.js, not here) */
function fix(id){ if(!known(id))return false; const prev=S.fixed; S.fixed=id; chipKey=''; G.emit('oil:fixed',{id,prev}); return true; }
function unfix(){ const prev=S.fixed; if(!prev)return false; S.fixed=null; chipKey=''; G.emit('oil:fixed',{id:null,prev}); return true; }

/* ---------- dressing the staff ---------- */
function apply(id,fromInput){
  const p=P();
  if(!known(id)||(S.n[id]|0)<=0)return false;
  if(G.state.mode!=='play'||!p||!p.alive||dressT>=0)return false;
  if(G.potions&&G.potions.drinking)return false;
  if(p.inputEnabled===false||!canAct(p.state)){ if(fromInput){ bufT=N.buffer; bufId=id; } return false; }
  bufT=0; bufId=null;
  take(id,1);                       // the flask is spent when the dressing starts
  dressT=0; dressId=id; p.actionLock=N.dress; p.speedMul=N.slow;
  if(p.drawStaff)p.drawStaff();
  G.emit('oil:apply',{id});
  return true;
}
function finishDress(){
  const id=dressId; stopDress();
  if(S.active)clear('replaced');
  const o=OILS[id]; S.active={id,left:o.dur};
  G.emit('oil:on',{id,dur:o.dur});
}
function stopDress(){ dressT=-1; dressId=null; const p=P(); if(p){ p.actionLock=0; p.speedMul=1; } }
function clear(reason){
  if(!S.active)return false;
  const id=S.active.id; S.active=null;
  G.emit('oil:off',{id,reason:reason||'cleared'});
  return true;
}
function pose(T){
  if(dressT<0)return;
  const d=dressT, Q=N.pose, up=smooth(0,.22,d)*(1-smooth(N.dress-.2,N.dress,d)), rub=Math.sin(d*11)*.28*smooth(.15,.3,d);
  T.shRX=lerp(T.shRX,Q.shRX,up); T.shRY=lerp(T.shRY,Q.shRY,up); T.shRZ=lerp(T.shRZ,Q.shRZ,up); T.elR=lerp(T.elR,Q.elR,up); T.wrRX=lerp(T.wrRX,Q.wrRX,up);
  T.shLX=lerp(T.shLX,Q.shLX+rub,up); T.shLY=lerp(T.shLY,Q.shLY,up); T.shLZ=lerp(T.shLZ,Q.shLZ,up); T.elL=lerp(T.elL,Q.elL-rub*.6,up);
  T.hdX=lerp(T.hdX,Q.hdX,up); T.spX=lerp(T.spX,Q.spX,up);
  return 14;
}
/** the input: one kind carried dresses at once; several open the picker */
function onOilInput(){
  const l=list(); if(!l.length)return;
  if(l.length===1)apply(l[0].id,true); else openPicker();
}

/* ---------- the picker: a small card (pauses play; mouse, touch, controller through core's card navigation) ---------- */
let pk=null, pkFrom=false, pkLocked=false;
const PK_CSS=`
#oilPicker{z-index:40}
#oilPicker .sheet{max-width:340px;gap:10px;padding:22px 24px 20px}
#oilPicker .eyebrow{margin:0}
#oilPicker .opts{display:grid;gap:8px}
#oilPicker .opt{display:flex;align-items:center;gap:10px;text-align:left;font:600 16px var(--body);padding:10px 14px;border-radius:2px;cursor:pointer;
  border:1px solid rgba(60,40,30,.45);background:rgba(255,255,255,.28);color:#21161f}
#oilPicker .opt:hover,#oilPicker .opt:focus-visible,#oilPicker .opt.pad-focus{background:rgba(255,255,255,.55);outline:2px solid var(--ether,#a06cff);outline-offset:1px}
#oilPicker .opt i{width:14px;height:14px;border-radius:50%;flex:none;box-shadow:0 0 0 1px rgba(40,25,30,.5),0 0 8px var(--c)}
#oilPicker .opt b{margin-left:auto;font-variant-numeric:tabular-nums;color:#6c3f5f}
#oilPicker .opt kbd{font-size:11px}`;
function buildPicker(){
  if(pk)return pk;
  const st=document.createElement('style'); st.textContent=PK_CSS; document.head.appendChild(st);
  pk=document.createElement('div'); pk.className='card'; pk.id='oilPicker'; pk.hidden=true; pk.dataset.padBack='oilPickerBack';
  pk.setAttribute('role','dialog'); pk.setAttribute('aria-label','Dress the staff');
  pk.innerHTML='<div class="sheet"><p class="eyebrow">Dress the staff</p><div class="opts"></div><div class="actions"><button type="button" class="btn ghost" id="oilPickerBack">Not now</button></div></div>';
  pk.querySelector('#oilPickerBack').addEventListener('click',e=>{ e.preventDefault(); closePicker(); });
  pk.addEventListener('click',e=>{ if(e.target===pk)closePicker(); });
  document.body.appendChild(pk);
  return pk;
}
function openPicker(){
  const l=list(); if(!l.length)return false;
  if(pk&&!pk.hidden)return true;
  if(G.state.mode!=='play'||dressT>=0||(G.talk&&G.talk.isOpen)||(G.map&&G.map.isOpen))return false;
  buildPicker();
  const box=pk.querySelector('.opts'); box.innerHTML='';
  l.forEach((o,i)=>{ const b=document.createElement('button'); b.type='button'; b.className='opt'; b.dataset.oil=o.id;
    b.style.setProperty('--c',OILS[o.id].color);
    b.innerHTML=`<i style="background:${OILS[o.id].color}"></i><span></span><b>×${o.n}</b>`; b.querySelector('span').textContent=o.name;
    b.addEventListener('click',e=>{ e.preventDefault(); pick(o.id); }); box.appendChild(b); });
  pkLocked=!!(G.input&&G.input.locked); pkFrom=true;
  G.setMode('paused'); try{ G.input.unlockPointer(); }catch(_){}
  pk.hidden=false;
  const f=box.querySelector('button'); if(f)try{ f.focus({preventScroll:true}); }catch(_){}
  if(G.headless)G.headless.draw(2);
  return true;
}
function closePicker(){
  if(!pk||pk.hidden)return false;
  pk.hidden=true;
  if(pkFrom&&G.state.mode==='paused'){ G.setMode('play'); if(!G.isMobile&&pkLocked)try{ G.input.lockPointer(); }catch(_){} }
  pkFrom=false;
  if(G.headless)G.headless.draw(2);
  return true;
}
function pick(id){ closePicker(); return apply(id,true); }
addEventListener('keydown',e=>{
  if(!pk||pk.hidden||e.ctrlKey||e.metaKey)return;
  const c=e.code, opts=[...pk.querySelectorAll('.opt')];
  if(/^(Digit|Numpad)[1-3]$/.test(c)){ e.preventDefault(); e.stopPropagation(); const b=opts[+c.slice(-1)-1]; if(b)pick(b.dataset.oil); return; }
  if(c==='Escape'||c==='KeyV'||c==='Backspace'||c==='KeyP'){ e.preventDefault(); e.stopPropagation(); closePicker(); return; }
  if(c==='ArrowUp'||c==='ArrowDown'||c==='KeyW'||c==='KeyS'){ e.preventDefault(); e.stopPropagation();
    const all=[...opts,pk.querySelector('#oilPickerBack')], i=all.indexOf(document.activeElement), d=(c==='ArrowUp'||c==='KeyW')?-1:1;
    const nx=all[(i<0?0:i+d+all.length)%all.length]; if(nx)try{ nx.focus(); }catch(_){} return; }
  if(c==='Enter'||c==='Space'||c==='KeyE'){ e.preventDefault(); e.stopPropagation(); const b=document.activeElement; if(b&&pk.contains(b))b.click(); else if(opts[0])pick(opts[0].dataset.oil); }
},true);

/* ---------- effects ----------
   Each oil id may have an entry in FX: onHit(hb, strength, strikeEvent) for every hurtbox a player staff blow
   (melee, technique, bolt) hits, and/or onBoltEnd(projectile, hits, strength) when a player bolt ends.
   strength is 'coat' or 'fixed'. A new oil is a row in OILS plus an entry here. */
const keyOf=hb=>hb.oilKey||hb.monster||hb;
const liveEnemy=hb=>!!hb&&hb.team==='enemy'&&!(hb.alive&&!hb.alive());
const canBurn=hb=>liveEnemy(hb)&&!!(hb.oil&&hb.oil.burn===true);   // opt-in: hb.oil={burn:true} (monsters.js, each boss file)
const canSlow=hb=>liveEnemy(hb)&&!!(hb.oil&&hb.oil.slow===true&&hb.monster&&!hb.monster.boss);
const playerBolt=p=>!!p&&p.team==='player'&&p.kind==='bolt';
function playerBlow(e){
  if(!e||e.team!=='player'||!AFFECT_KINDS.has(e.kind))return false;
  const s=e.source, p=P();
  return s===p||playerBolt(s);   // the Traveler's own staff, or one of its bolts (not a companion, not an oil's own blast)
}
const midOf=hb=>{ const v=hb.pos.clone(); v.y+=(hb.height||1.6)*.55; return v; };

/* Kilnfire: burning. One burn per target (key), ticking on the part last struck that can burn. */
const burns=new Map();   // target key -> {hb, left (ticks), t (to the next tick), fx}
function ignite(hb,st){
  const o=OILS.kilnfire; if(!canBurn(hb))return;   // the part struck can't burn (a fire-giant, a root, an inked hand): no ignition
  const k=keyOf(hb), secs=st==='coat'?o.burn.secs:o.burn.fixedSecs;
  let b=burns.get(k); const fresh=!b;
  if(!b){ b={hb,left:0,t:0,fx:null}; burns.set(k,b); }
  b.hb=hb; b.left=Math.round(secs*o.burn.dps); b.t=1/o.burn.dps;   // a new blow restarts it; never stacks
  G.emit('oil:ignite',{pos:midOf(hb),target:k,fresh});
}
function stepBurns(dt){
  for(const [k,b] of burns){
    const hb=b.hb;
    if(!hb||(hb.alive&&!hb.alive())||b.left<=0){ endBurn(k,b); continue; }
    b.t-=dt;
    if(b.t<=0){
      b.t+=1/OILS.kilnfire.burn.dps; b.left--;
      if(canBurn(hb)){   // re-read each tick: a part can stop taking fire (a hand's ink skin comes back)
        const p=P(), dir=new THREE.Vector3(hb.pos.x-(p?p.pos.x:0),0,hb.pos.z-(p?p.pos.z:0)); if(dir.lengthSq()<1e-6)dir.set(0,0,1); dir.normalize();
        try{ hb.hit({damage:OILS.kilnfire.burn.dmg||1,kind:'burn',element:'fire',knockback:0,dir,source:'oil'}); }catch(e){ console.error('oil burn',e); }
        G.emit('oil:burn',{pos:midOf(hb),target:k,damage:OILS.kilnfire.burn.dmg||1});
      }
      if(b.left<=0||(hb.alive&&!hb.alive()))endBurn(k,b);
    }
  }
}
function endBurn(k,b){ burns.delete(k); if(b.fx)b.fx.visible=false; }

/* Burst: a blast where a player bolt ends; never to anything the bolt itself hit (or another part of the same target) */
function burstAt(p,st){
  const B=OILS.burst.burst, g=!!p.great, fx=st==='fixed';
  const dmg=fx?(g?B.fixedGreatDmg:B.fixedDmg):(g?B.greatDmg:B.dmg), radius=fx?(g?B.fixedGreatR:B.fixedR):(g?B.greatR:B.r);
  const exclude=new Set(p.exclude||[]), keys=new Set();
  for(const hb of exclude)if(hb.oilKey)keys.add(hb.oilKey);
  if(keys.size)for(const hb of G.hurtboxes)if(hb.oilKey&&keys.has(hb.oilKey))exclude.add(hb);
  const pos=p.pos.clone();
  const hits=G.combat.strike({x:pos.x,y:pos.y,z:pos.z,radius,team:'player',damage:dmg,knockback:B.kb||6,kind:'blast',element:'burst',source:'oil',exclude});
  try{ const gy=G.floorAt?G.floorAt(pos.x,pos.z,pos.y+1):pos.y; if(G.moves&&G.moves.burst)G.moves.burst({x:pos.x,y:Math.min(pos.y,gy+.3),z:pos.z},{radius,color:OILS.burst.color,light:false,life:.45}); }catch(e){ console.error('oil burst fx',e); }
  G.emit('oil:burst',{pos,radius,great:g,hits});
}

/* Holly Ward: struck monsters move slower for a while (monsters.js reads m.oilSlow); bosses are never slowed */
function slow(hb,st){
  if(!canSlow(hb))return;
  const H=OILS.holly.slow, m=hb.monster, k=st==='coat'?H.k:H.fixedK, t=st==='coat'?H.secs:H.fixedSecs;
  m.oilSlow={t,k};   // a new blow restarts it
  G.emit('oil:slow',{pos:midOf(hb),target:keyOf(hb)});
}
function slowed(t){ const m=t&&(t.monster||t); return !!(m&&m.oilSlow&&m.oilSlow.t>0); }

const FX={
  kilnfire:{onHit:ignite},
  burst:{onBoltEnd:burstAt},
  holly:{onHit:slow}
};
G.on('strike',e=>{
  if(!playerBlow(e)||!e.hits)return;
  for(const id in FX){ const f=FX[id].onHit, st=f&&strength(id); if(!st)continue;
    for(const hb of e.hits){ try{ f(hb,st,e); }catch(err){ console.error('oil '+id,err); } } }
});
G.on('projectile:end',e=>{
  const p=e&&e.p; if(!playerBolt(p))return;
  for(const id in FX){ const f=FX[id].onBoltEnd, st=f&&strength(id); if(!st)continue;
    try{ f(p,e.hits||[],st); }catch(err){ console.error('oil '+id,err); } }
});

/* flames on burning things: a small pool of sprites (no lights) */
const fxPool=[];
function flameFx(){ let s=fxPool.find(f=>!f.visible); if(s)return s; if(fxPool.length>=12)return null;
  s=new THREE.Sprite(new THREE.SpriteMaterial({map:G.tex.flame,color:col('#ffa040'),transparent:true,opacity:.8,depthWrite:false,blending:THREE.AdditiveBlending}));
  s.renderOrder=4; s.visible=false; G.scene.add(s); fxPool.push(s); return s; }
function drawBurns(){
  for(const b of burns.values()){
    if(!b.fx){ b.fx=flameFx(); if(!b.fx)continue; }
    const hb=b.hb, h=hb.height||1.6, r=hb.radius||.5, f=.85+.15*Math.sin(G.time*19+h)+.1*Math.sin(G.time*31);
    b.fx.visible=true; b.fx.position.set(hb.pos.x,hb.pos.y+h*.5,hb.pos.z);
    b.fx.scale.set(r*1.6*f,h*.75*f,1); b.fx.material.opacity=.55+.2*Math.sin(G.time*13);
  }
}

/* ---------- the staff's look ---------- */
const look={color:'#e3a13a',k:0,flame:false}; let lookOn=false;
function updateLook(){
  const p=P(); if(!p)return;
  let id=null, k=0;
  if(dressT>=0){ id=dressId; k=smooth(.1,N.dress,dressT); if(S.fixed&&S.fixed!==id&&k<N.fixedK)id=S.fixed, k=N.fixedK; }   // the fixed oil's faint tint holds until the new coat outshines it
  else if(S.active){ id=S.active.id; k=1; if(S.active.left<8)k=.55+.45*(.5+.5*Math.cos(G.time*(S.active.left<3?14:7))); } // gutters near the end
  if(!id&&S.fixed){ id=S.fixed; k=N.fixedK; }
  if(!id){ if(lookOn){ lookOn=false; p.staffOil=null; } return; }
  look.color=OILS[id].color; look.k=k; look.flame=!!OILS[id].flame; p.staffOil=look; lookOn=true;
}

/* ---------- HUD: the coat chip (oil name and time left) and the flask count by the draught ---------- */
let chip=null, chipTxt=null, chipKey='', flaskEl=null, flaskN=null, flaskKey='', fxEl=null;
const CHIP_CSS=`
.oil-chip{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--bone,#f1e9d8);text-shadow:0 1px 3px #000;white-space:nowrap;transition:opacity .4s;opacity:0}
.oil-chip.show{opacity:1}
.oil-chip svg{width:12px;height:16px;flex:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}
.oil-chip b{font-weight:700;font-variant-numeric:tabular-nums}
.oil-chip.low b{animation:oilLow .8s ease-in-out infinite alternate}
.oil-chip .fx{display:none;align-items:center;gap:4px;font:600 11.5px var(--body);letter-spacing:.04em;opacity:.85}
.oil-chip .fx.on{display:inline-flex}
.oil-chip .fx svg{width:11px;height:11px}
.oil-chip .fx.solo+.ic:empty+.txt:empty{display:none}
@keyframes oilLow{to{opacity:.4}}
.oil-flasks{display:inline-flex;align-items:center;gap:3px;font:700 14px var(--body);color:var(--bone);text-shadow:0 1px 3px #000;font-variant-numeric:tabular-nums}
.oil-flasks[hidden]{display:none}
.oil-flasks svg{width:13px;height:20px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))}`;
const FIXED_SVG=c=>`<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8 11.2 6 6 11.2.8 6z" fill="${c}" stroke="#f1e3cf" stroke-width="1"/><circle cx="6" cy="6" r="1.4" fill="#1a110c" opacity=".55"/></svg>`;
const FLASK_SVG=c=>`<svg viewBox="0 0 13 20" aria-hidden="true"><path d="M4.6 1.2h3.8v2h-.4v3.6l3.3 9.4a1.6 1.6 0 0 1-1.5 2.2H3.2a1.6 1.6 0 0 1-1.5-2.2L5 6.8V3.2h-.4z" fill="rgba(255,236,214,.2)" stroke="#f1e3cf" stroke-width="1" stroke-linejoin="round"/><path d="M3.1 12.4h6.8l1.6 4.2a.9.9 0 0 1-.8 1.2H2.3a.9.9 0 0 1-.8-1.2z" fill="${c}"/><rect x="4.9" y=".4" width="3.2" height="1.8" rx=".5" fill="#7a5638"/></svg>`;
function buildHud(){
  const host=document.querySelector('#hud .vitals'); if(!host)return false;
  const st=document.createElement('style'); st.textContent=CHIP_CSS; document.head.appendChild(st);
  chip=document.createElement('div'); chip.className='oil-chip'; chip.hidden=true; chip.setAttribute('aria-live','off');
  chip.innerHTML='<span class="fx" id="oilFixed"></span><span class="ic"></span><span class="txt"></span>'; chipTxt=chip.querySelector('.txt'); fxEl=chip.querySelector('.fx');
  host.appendChild(chip);
  flaskEl=document.createElement('div'); flaskEl.className='oil-flasks'; flaskEl.id='oilFlasks'; flaskEl.hidden=true; flaskEl.setAttribute('role','status');
  flaskEl.innerHTML='<span class="ic"></span><span class="on">0</span>'; flaskN=flaskEl.querySelector('.on');
  const pot=document.getElementById('potions'), row=pot&&pot.parentNode;
  if(row&&row.classList.contains('hp-row'))row.insertBefore(flaskEl,pot.nextSibling); else host.insertBefore(flaskEl,host.children[1]||null);
  return true;
}
const mmss=s=>{s=Math.ceil(s); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
function updateHud(){
  if(!chip&&!buildHud())return;
  // the coat, and the fixed oil's small mark in front of it (shown on its own when no coat is on)
  const a=S.active, dressing=dressT>=0, fx=S.fixed&&OILS[S.fixed];
  const coat=!!a||dressing, show=coat||!!fx;
  if(chip.hidden===show){ chip.hidden=!show; if(show)requestAnimationFrame(()=>chip.classList.add('show')); else chip.classList.remove('show'); }
  if(show){
    const o=coat&&OILS[dressing?dressId:a.id], k=(fx?fx.id:'')+'#'+(!o?'':dressing?o.id+'|d':o.id+'|'+Math.ceil(a.left));
    if(k!==chipKey){ chipKey=k;
      fxEl.className='fx'+(fx?' on':'')+(fx&&!o?' solo':'');
      fxEl.innerHTML=fx?FIXED_SVG(fx.color)+(o?'':`<span style="color:${fx.color}">${fx.name.replace(/ Oil$/,'')}</span>`):'';
      fxEl.title=fx?'Fixed in the staff: '+fx.name:''; fxEl.setAttribute('aria-label',fxEl.title);
      chip.querySelector('.ic').innerHTML=o?FLASK_SVG(o.color):'';
      chipTxt.innerHTML=o?`<span style="color:${o.color}">${o.name}</span> <b style="color:${o.color}">${dressing?'…':mmss(a.left)}</b>`:'';
      chip.classList.toggle('low',!!o&&!dressing&&a.left<=10); }
  }
  // the flasks
  const t=total(), l=list(), c=l.length?OILS[l[0].id].color:'#e3a13a', fk=t+'|'+c;
  if(fk!==flaskKey){ flaskKey=fk; flaskEl.hidden=t<=0; flaskN.textContent=t; flaskEl.querySelector('.ic').innerHTML=FLASK_SVG(c);
    flaskEl.setAttribute('aria-label','Staff oils: '+l.map(o=>o.n+' '+o.name).join(', ')); }
}

/* ---------- per frame ---------- */
function update(dt){
  const p=P(); if(!p)return;
  if(dressT>=0){
    if(!p.alive){ stopDress(); }
    else{ dressT+=dt; p.actionLock=Math.max(0,N.dress-dressT)+.001; p.speedMul=N.slow;   // a blow taken while dressing does not stop it
      if(dressT>=N.dress)finishDress(); }
  }
  if(G.state.mode!=='play')return;
  if(S.active){ S.active.left-=dt; if(S.active.left<=0)clear('expired'); }
  stepBurns(dt);
  if(G.input.pressed('oil'))onOilInput();
  else if(bufT>0){ bufT-=dt; if(bufT>0&&canAct(p.state)&&p.inputEnabled!==false&&bufId)apply(bufId,false); }
}

/* ---------- saves ---------- */
const PERSIST={
  save:()=>{
    const active=S.active?{id:S.active.id,left:+S.active.left.toFixed(1)}:dressT>=0&&dressId?{id:dressId,left:OILS[dressId].dur}:null; // a dressing in progress keeps its coat
    return {v:1,n:Object.assign({},S.n),active,fixed:S.fixed,hint:S.hint};
  },
  load:d=>{
    d=d||{};   // null (a new game, or a save from before oils): nothing carried, no coat, nothing fixed
    stopDress(); bufT=0; bufId=null; burns.forEach((b,k)=>endBurn(k,b)); closePicker();
    S.n={}; let room=N.max;
    for(const id of Object.keys(OILS)){ const n=Math.min(room,Math.max(0,(d.n&&d.n[id])|0)); if(n>0){ S.n[id]=n; room-=n; } }
    const a=d.active; S.active=a&&known(a.id)&&+a.left>0?{id:a.id,left:Math.min(OILS[a.id].dur,+a.left)}:null;
    S.fixed=known(d.fixed)?d.fixed:null; S.hint=!!d.hint||total()>0;
    changed(null);
  }
};
G.on('game:reset',()=>PERSIST.load(null));
if(G.persist&&G.persist.register)G.persist.register('oils',PERSIST);
else G.on('ready',()=>{ if(G.persist&&G.persist.register)G.persist.register('oils',PERSIST); });

G.system('oils',{order:26,modes:['play','dead','paused','menu'],
  init(){
    if(G.player&&G.player.poseHooks)G.player.poseHooks.push(pose);
    G.on('player:respawn',()=>{ stopDress(); });
    G.on('mode',e=>{ if(pk&&!pk.hidden&&e&&e.mode!=='paused'){ pk.hidden=true; pkFrom=false; } });
    changed(null);
  },
  update(dt){
    const mode=G.state.mode;
    if(mode==='play'||mode==='dead')update(dt);
    updateLook(); drawBurns(); updateHud();
  }
});

/* ---------- API ---------- */
G.oils={
  OILS, get max(){ return N.max; }, N,
  count:id=>S.n[id]|0, total, full:()=>total()>=N.max, add, take, list,
  armed:()=>total()>0,
  get active(){ return S.active; },
  get fixed(){ return S.fixed; },
  get dressing(){ return dressT>=0; },
  apply:id=>apply(id,false), clear, has, strength,
  fix, unfix,
  burning:t=>!!t&&(burns.has(t)||burns.has(keyOf(t))),
  slowed,
  openPicker, closePicker,
  debug:{
    give(id,n=1){ return add(id||'kilnfire',n); },
    coat(id,secs){ id=id||'kilnfire'; if(!known(id))return false; stopDress(); if(S.active)clear('replaced');
      const dur=secs==null?OILS[id].dur:+secs; S.active={id,left:dur}; G.emit('oil:on',{id,dur}); return true; },
    expire(){ if(S.active)S.active.left=0; return clear('expired'); },
    state(){ return {n:Object.assign({},S.n),total:total(),active:S.active&&Object.assign({},S.active),fixed:S.fixed,hint:S.hint,
      dressing:dressT>=0?{id:dressId,t:dressT}:null,burning:[...burns.values()].map(b=>({name:b.hb.name||null,left:b.left,t:+b.t.toFixed(2)})),
      picker:!!(pk&&!pk.hidden)}; },
    save:()=>PERSIST.save(), load:d=>PERSIST.load(d)
  }
};
})();
