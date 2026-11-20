/* =====================================================================
   record.js — the Keeper's Record: play time, counters, milestone times, boss attempts, completion.
   Spec: RECORD.md (section 1). Listens to events, keeps everything in the save (persist key 'record'). Draws nothing.

   - Play time: seconds in mode 'play', not during a cut scene (G.cine.on), and not once 120 s have passed without any
     input (it starts again with the next key, click, touch, stick or button).
   - Milestones (MILESTONES, in order): the first reach only; a time never changes once set. Events flagged
     restored/quiet (replays on load) are ignored; whatever an old save or a test start point already holds is
     back-filled with t:null (record:milestone {restored:true}).
   - Boss attempts: start on the fight's own start event, end on the boss's death (a win) or on the player's death /
     the fight's reset (a try). Play seconds, damage taken and draughts drunk are kept for the best win.
   - Completion is read live from the owning modules (the Journal's data, the map's waystones, the companions).
   - A new game in the same browser pushes the finished run into runs[] and keeps runs, combos, days, sessions, first.

   API: G.record = {state, MILESTONES, BOSSES, play(), ms(id), split(id), best(id), boss(id), completion(), summary(),
        fmt(s), debug:{reach(id,t), addPlay(s), set(path,v), reset(), idle}}
   Events: record:milestone {id,t,restored} · record:boss {id,win,time,hurt,draughts,tries} · record:change {} (≤1/s)
           record:newgame {run} (a new game started on this device; the previous run was pushed into runs[])
   ===================================================================== */
(function(){
'use strict';
const G=window.G;
if(!G)return;

const MILESTONES=[
  {id:'ashore',name:'Washed ashore'},
  {id:'plain-flame',name:'The plain flame fails'},
  {id:'stag',name:'The Hollow Stag'},
  {id:'lantern',name:'Hesper’s lantern'},
  {id:'staff',name:'The Keeper’s Staff'},
  {id:'lamp-cured',name:'The light restored'},
  {id:'gloaming',name:'The Gloaming'},
  {id:'undertow',name:'The Undertow'},
  {id:'crane',name:'The Tithe-Keeper'},
  {id:'answer',name:'The Answer'},
  {id:'sailed',name:'Sailed north'},
  {id:'giant',name:'The Wreck Giant'}
];
const MS_IDS=MILESTONES.map(m=>m.id);
const BOSSES=['stag','gloaming','undertow','crane','answer','giant'];
const IDLE_MAX=120;           // seconds without input after which play time stops counting
const DAYS_CAP=400, RUNS_CAP=100;
const ACTIONS=['forward','back','left','right','jump','sprint','roll','attack','lock','interact','shutter','potion','pause','advance','glass','fox','raven'];

const now=()=>Date.now();
const today=()=>{ const d=new Date(), p=n=>(n<10?'0':'')+n; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
const r1=s=>Math.round((+s||0)*10)/10;
const num=(v,d)=>typeof v==='number'&&isFinite(v)?v:d;
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const skip=e=>!!(e&&(e.restored||e.quiet));

function defaults(){
  return {v:1,play:0,sessions:0,days:[],first:0,last:0,
    n:{deaths:0,kills:0,killsBy:{},freed:0,draughts:0,travels:0,hurt:0,moves:{}},
    ms:{},boss:{},combos:[],run:1,runs:[]};
}
/* a saved record (any age) -> a clean live object with every field present */
function normalise(d){
  const s=defaults(); d=obj(d);
  s.play=Math.max(0,num(d.play,0)); s.sessions=Math.max(0,num(d.sessions,0)|0);
  s.days=Array.isArray(d.days)?d.days.filter(x=>typeof x==='string').slice(-DAYS_CAP):[];
  s.first=num(d.first,0); s.last=num(d.last,0);
  const n=obj(d.n);
  for(const k of ['deaths','kills','freed','draughts','travels','hurt'])s.n[k]=Math.max(0,num(n[k],0));
  for(const k of ['killsBy','moves']){ const o=obj(n[k]); for(const x in o)if(typeof o[x]==='number'&&isFinite(o[x]))s.n[k][x]=o[x]; }
  const ms=obj(d.ms);
  for(const id of MS_IDS){ const m=ms[id]; if(m&&typeof m==='object')s.ms[id]={t:typeof m.t==='number'&&isFinite(m.t)?m.t:null,at:typeof m.at==='number'&&isFinite(m.at)?m.at:null}; }
  const bo=obj(d.boss);
  for(const id of BOSSES){ const b=bo[id]; if(b&&typeof b==='object')s.boss[id]={tries:Math.max(0,num(b.tries,0)|0),best:typeof b.best==='number'&&isFinite(b.best)?b.best:null,
    hurt:typeof b.hurt==='number'?b.hurt:null,draughts:typeof b.draughts==='number'?b.draughts:null}; }
  s.combos=Array.isArray(d.combos)?[...new Set(d.combos.filter(x=>typeof x==='string'))]:[];
  s.run=Math.max(1,num(d.run,1)|0);
  s.runs=Array.isArray(d.runs)?d.runs.filter(r=>r&&typeof r==='object').map(r=>({play:Math.max(0,num(r.play,0)),ms:Object.fromEntries(Object.entries(obj(r.ms)).filter(([k,v])=>MS_IDS.includes(k)&&typeof v==='number'&&isFinite(v))),
    deaths:Math.max(0,num(r.deaths,0)|0),at:num(r.at,0)})).slice(-RUNS_CAP):[];
  return s;
}

let S=defaults();
let cur=null;               // the boss attempt in progress: {id,t0,hurt,draughts}
let idle=0;                 // seconds of play without input
let dirty=false, lastChange=0;
let loadedHere=false;       // the record was loaded from a save on this page
let pending=false;          // a game began (left the title): sessions/days/new-run/back-fill on the next update
let beginKind=null;         // 'new' | 'continue' | 'start' (how the game began, if known)
let backfillDue=false;
let dayT=0;

const changed=()=>{ dirty=true; };
const playNow=()=>S.play;

/* ---------------------------------------------------------------- techniques found (localStorage 'bq-combos', combat.js) */
function mergeCombos(){
  const M=G.moves, found=M&&M.found, T=M&&M.T;
  const set=new Set(S.combos);
  if(found&&found.forEach)found.forEach(k=>set.add(k));
  let ls=[]; try{ const a=JSON.parse(localStorage.getItem('bq-combos')||'[]'); if(Array.isArray(a))ls=a; }catch(_){}
  ls.forEach(k=>typeof k==='string'&&set.add(k));
  S.combos=[...set];
  // and back the other way: what the save knows, this device now knows too
  if(found&&found.add){ let grew=false; for(const k of S.combos){ if((!T||T[k])&&!found.has(k)){ found.add(k); grew=true; } }
    if(grew||ls.length!==found.size){ try{ localStorage.setItem('bq-combos',JSON.stringify([...found])); }catch(_){} } }
}

/* ---------------------------------------------------------------- milestones */
function reach(id,o){
  o=o||{}; if(!MS_IDS.includes(id)||S.ms[id])return false;
  const restored=!!o.restored, t=restored?null:(o.t!=null?r1(o.t):r1(S.play));
  S.ms[id]={t,at:restored?null:now()};
  changed();
  G.emit('record:milestone',{id,t,restored});
  return true;
}
/* what a save (or a start point) already holds: each milestone's own state, then the story order fills the gaps */
const has=(o,k)=>!!(o&&o[k]);
function stateHas(id){
  const I=G.items||{}, L=I.lantern||{}, T=I.storm||{}, F=G.flow||{}, fl=k=>!!(G.flag&&G.flag(k));
  switch(id){
    case 'ashore': return has(I.cloak,'owned')||has(T,'found')||!!(G.quest&&G.quest.step&&!['start','cottage','door'].includes(G.quest.step));
    case 'plain-flame': return has(T,'failed')||fl('stormFailed');
    case 'stag': return !!F.stagDead||fl('stagDead');
    case 'lantern': return has(L,'found')||has(L,'cured')||fl('lanternBeat');
    case 'staff': return has(I.staff,'owned');
    case 'lamp-cured': return has(G.lighthouse,'cured');
    case 'gloaming': return !!F.bossDead||!!(G.finaleBoss&&G.finaleBoss.defeated);
    case 'undertow': return has(G.caveBoss,'defeated')||fl('undertowDead');
    case 'crane': return has(G.undercroftBoss,'defeated')||fl('craneDead');
    case 'answer': return has(G.templeBoss,'defeated')||fl('answerDead');
    case 'sailed': { const N=G.northIsle; return !!(N&&(N.landed||(N.at&&N.at!=='home'))); }
    case 'giant': return !!(G.northFire&&G.northFire.state&&G.northFire.state.done);
  }
  return false;
}
/* what each milestone implies came before it in the story (Act 1 v12: the staff is taken on the climb, before or after the
   plain flame fails; the Stag only fights an armed Rowan; everything after Act 1 needs the Gloaming down) */
const BEFORE={'plain-flame':['ashore'],staff:['ashore'],stag:['plain-flame','staff'],lantern:['stag'],'lamp-cured':['lantern'],gloaming:['lamp-cured'],
  undertow:['gloaming'],crane:['gloaming'],answer:['gloaming'],sailed:['gloaming'],giant:['sailed']};
function backfill(){
  backfillDue=false;
  const got={};
  for(const id of MS_IDS){ let v=!!S.ms[id]; if(!v){ try{ v=stateHas(id); }catch(_){ v=false; } } got[id]=v; }
  if(G.loop&&G.loop.active)got.gloaming=true;          // the core loop only begins once Act 1 is over
  const imply=id=>{ for(const b of BEFORE[id]||[]){ if(!got[b]){ got[b]=true; } imply(b); } };
  for(const id of MS_IDS)if(got[id])imply(id);
  for(const id of MS_IDS)if(got[id]&&!S.ms[id])reach(id,{restored:true});
}

/* ---------------------------------------------------------------- boss attempts */
function bossEntry(id){ return S.boss[id]||(S.boss[id]={tries:0,best:null,hurt:null,draughts:null}); }
function startAttempt(id){
  if(cur&&cur.id===id)return;
  if(cur)endAttempt(cur.id,false);
  cur={id,t0:S.play,hurt:0,draughts:0};
}
function endAttempt(id,win){
  const b=bossEntry(id);
  let time=null, hurt=null, dr=null;
  if(cur&&cur.id===id){ time=r1(S.play-cur.t0); hurt=cur.hurt; dr=cur.draughts; cur=null; }
  else if(!win)return;                     // nothing was running: a reset with no attempt is no try
  b.tries++;
  if(win&&time!=null&&(b.best==null||time<b.best)){ b.best=time; b.hurt=hurt; b.draughts=dr; }
  changed();
  G.emit('record:boss',{id,win:!!win,time,hurt,draughts:dr,tries:b.tries});
}
const failIf=id=>()=>{ if(cur&&cur.id===id)endAttempt(id,false); };

/* ---------------------------------------------------------------- the run, a new game */
function storedRecord(){
  try{
    const F=G.flow; if(!F||!F.readSave)return null;
    const key=G.testSaves&&F.keys?F.keys.test:(F.keys&&F.keys.save);
    const d=F.readSave(key); return d&&d.mods&&d.mods.record?normalise(d.mods.record):null;
  }catch(_){ return null; }
}
function newRun(){
  const touched=loadedHere||S.play>0||Object.keys(S.ms).length>0||S.runs.length>0;
  // signed in, a new game goes into an empty save slot (slots.js): nothing is replaced, so no run is finished — the slot starts its own record
  const prev=G.slots&&G.slots.active&&G.slots.active()?null:touched?S:storedRecord();
  const s=defaults();
  if(prev){
    s.runs=prev.runs.slice();
    const ms={}; for(const id of MS_IDS){ const m=prev.ms[id]; if(m&&m.t!=null)ms[id]=m.t; }
    const pushed=prev.play>=1||Object.keys(prev.ms).length>0;
    if(pushed)s.runs.push({play:r1(prev.play),ms,deaths:prev.n.deaths|0,at:prev.last||now()});
    s.runs=s.runs.slice(-RUNS_CAP);
    s.run=(prev.run||1)+(pushed?1:0);
    s.combos=prev.combos.slice(); s.days=prev.days.slice(); s.sessions=prev.sessions; s.first=prev.first; s.last=prev.last;
  }
  S=s; API.state=S; cur=null; idle=0;
  mergeCombos(); changed();
  G.emit('record:newgame',{run:S.run});
}
function markDay(){ const d=today(); if(S.days[S.days.length-1]!==d&&!S.days.includes(d)){ S.days.push(d); if(S.days.length>DAYS_CAP)S.days=S.days.slice(-DAYS_CAP); changed(); } }
function began(){
  pending=false;
  const kind=beginKind; beginKind=null;
  if(kind==='new')newRun();
  S.sessions++; if(!S.first)S.first=now(); S.last=now(); markDay();
  mergeCombos();
  backfill();
  changed();
}

/* ---------------------------------------------------------------- persistence */
const PERSIST={
  save(){ S.last=now(); return JSON.parse(JSON.stringify(S)); },
  load(d){
    if(!d)return;
    S=normalise(d); API.state=S; cur=null; idle=0; loadedHere=true;
    mergeCombos();
    backfillDue=true;        // after every other module has loaded (the next update)
    changed();
  }
};
if(G.persist&&G.persist.register)G.persist.register('record',PERSIST);
else G.on('ready',()=>{ if(G.persist&&G.persist.register)G.persist.register('record',PERSIST); });

/* how the game began: flow.js's begin(true|false|saveObject). The title buttons call it directly, so listen to them too. */
function wrapBegin(){
  const F=G.flow; if(!F||!F.begin||F.begin.__record)return;
  const b0=F.begin;
  const w=function(s){ beginKind=s===true?'continue':(s&&typeof s==='object')?'start':'new'; return b0.apply(this,arguments); };
  w.__record=true; F.begin=w;
}
wrapBegin();

/* ---------------------------------------------------------------- listeners */
const on=(ev,fn)=>G.on(ev,e=>{ try{ fn(e||{}); }catch(err){ console.error('record '+ev,err); } });
on('mode',e=>{ if(e.prev==='title'&&e.mode!=='title')pending=true; });
// milestones
on('wake:done',e=>{ if(!skip(e))reach('ashore'); });
on('lamp:failed',e=>{ if(!skip(e))reach('plain-flame'); });
on('lantern:pickup',e=>{ if(!skip(e)&&!e.devtools)reach('lantern'); });
on('staff:pickup',e=>{ if(skip(e)){ backfillDue=true; return; } reach('staff'); });
on('lamp:cured',e=>{ if(skip(e)){ backfillDue=true; return; } reach('lamp-cured'); });
on('boss:dead',e=>{ if(skip(e))return; if(e.who==='stag'){ reach('stag'); endAttempt('stag',true); } else if(e.who==='gloaming'){ reach('gloaming'); endAttempt('gloaming',true); } });
on('cave:bossDead',e=>{ if(skip(e))return; reach('undertow'); endAttempt('undertow',true); });
on('undercroft:bossDead',e=>{ if(skip(e)){ backfillDue=true; return; } reach('crane'); endAttempt('crane',true); });
on('temple:bossDead',e=>{ if(skip(e)){ backfillDue=true; return; } reach('answer'); endAttempt('answer',true); });
on('boat:sail',e=>{ if(skip(e)||e.ready===false)return; reach('sailed'); });
on('northFire:finish',e=>{ if(skip(e))return; reach('giant'); endAttempt('giant',true); });
on('loop:start',e=>{ if(e.restored)backfillDue=true; });
// boss fights: start / reset (a death ends any attempt below)
on('stag:engage',()=>startAttempt('stag'));
on('gloaming:start',()=>startAttempt('gloaming'));
on('cave:bossStart',()=>startAttempt('undertow'));
on('undercroft:bossStart',()=>startAttempt('crane'));
on('temple:bossStart',()=>startAttempt('answer'));
on('northFire:fightStart',()=>startAttempt('giant'));
on('cave:bossEnd',failIf('undertow'));
on('undercroft:bossReset',failIf('crane'));
on('temple:bossReset',failIf('answer'));
on('northFire:reset',failIf('giant'));
// counters
on('player:dead',()=>{ S.n.deaths++; changed(); if(cur)endAttempt(cur.id,false); });
on('player:hurt',e=>{ const d=+e.damage||0; if(d<=0)return; S.n.hurt+=d; if(cur)cur.hurt+=d; changed(); });
on('potion:drink',()=>{ S.n.draughts++; if(cur)cur.draughts++; changed(); });
on('monster:killed',e=>{ if(skip(e))return; S.n.kills++; const k=String(e.kind||'?'); S.n.killsBy[k]=(S.n.killsBy[k]||0)+1; changed(); });
on('negative:freed',e=>{ if(skip(e))return; S.n.freed++; changed(); });
on('map:travel',e=>{ if(e.phase==='done'){ S.n.travels++; changed(); } });
on('player:combo',e=>{ const id=e.id; if(!id)return; S.n.moves[id]=(S.n.moves[id]||0)+1; if(!S.combos.includes(id))S.combos.push(id); changed(); });
on('game:reset',()=>{ beginKind='new'; pending=true; });

/* input: any key, click, touch or wheel on the page, and (per frame) the stick, look and every action */
const poke=()=>{ idle=0; };
try{ ['keydown','pointerdown','mousedown','mousemove','wheel','touchstart'].forEach(t=>addEventListener(t,poke,{capture:true,passive:true})); }catch(_){}
function inputNow(){
  const I=G.input; if(!I)return false;
  try{ const m=I.move&&I.move(); if(m&&m.mag>.05)return true; }catch(_){}
  try{ const l=I.look&&I.look(); if(l&&(Math.abs(l.x)+Math.abs(l.y))>.5)return true; }catch(_){}
  for(const a of ACTIONS){ try{ if(I.down(a))return true; }catch(_){} }
  return false;
}

G.system('record',{order:96,modes:'always',
  init(){
    wrapBegin(); mergeCombos();
    const b=document.getElementById('begin'), c=document.getElementById('continue');
    // flow.js's own click listener runs first (it was added first): begin() has run, the record follows on the next update
    if(b)b.addEventListener('click',()=>{ beginKind='new'; });
    if(c)c.addEventListener('click',()=>{ beginKind='continue'; });
  },
  update(dt){
    dt=+dt||0;
    try{
      const mode=G.state.mode;
      if(pending&&mode!=='title')began();
      if(backfillDue)backfill();
      if(mode==='play'){
        if(inputNow())idle=0; else idle+=dt;
        if(!(G.cine&&G.cine.on)&&idle<IDLE_MAX){ S.play+=dt; }
        S.last=now();
        if((dayT+=dt)>30){ dayT=0; markDay(); }
      }
      if(dirty){ const t=now(); if(t-lastChange>=1000){ lastChange=t; dirty=false; G.emit('record:change',{}); } }
    }catch(e){ if(!this._err){ console.error('record',e); this._err=1; } }
  }
});

/* ---------------------------------------------------------------- read-outs */
function splitIn(msT,id){   // msT: {id:t}; the time since the previous reached milestone (by time), or since 0
  const t=msT[id]; if(t==null)return null;
  let prev=0; for(const k in msT){ if(k===id)continue; const u=msT[k]; if(u!=null&&u<=t&&u>prev)prev=u; }
  return r1(t-prev);
}
const liveTimes=()=>{ const o={}; for(const id of MS_IDS){ const m=S.ms[id]; if(m&&m.t!=null)o[id]=m.t; } return o; };
function completion(){
  const parts={};
  const P=G.progress, J=P&&P.journal&&P.journal.data;
  let d=null; try{ d=J?J():null; }catch(_){ d=null; }
  if(d){
    if(Array.isArray(d.bosses))parts.bosses=[d.bosses.filter(b=>b.done).length,d.bosses.length];
    if(d.shardTotal!=null)parts.shards=[Math.min(d.shards|0,d.shardTotal),d.shardTotal];
    if(d.cacheTotal!=null)parts.caches=[Math.min(d.caches|0,d.cacheTotal),d.cacheTotal];
    if(d.freedTotal!=null)parts.negatives=[Math.min(d.freed|0,d.freedTotal),d.freedTotal];
    if(Array.isArray(d.blights))parts.blights=[d.blights.filter(b=>b.cured).length,d.blights.length];
    if(Array.isArray(d.upgrades)){ const tot=P.UPGRADES&&P.UPGRADES.length; parts.tempered=[d.upgrades.length,tot||d.upgrades.length]; }
  }
  try{ const W=G.map&&G.map.waypoints; if(Array.isArray(W)&&W.length)parts.waystones=[W.filter(w=>w.unlocked).length,W.length]; }catch(_){}
  try{ const C=G.companions; if(C&&C.has){ const ids=Object.keys(C.names||{ember:1,corvin:1}); parts.companions=[ids.filter(id=>C.has(id)).length,ids.length]; } }catch(_){}
  let done=0,total=0; for(const k in parts){ done+=parts[k][0]; total+=parts[k][1]; }
  return {done,total,pct:total?Math.min(100,Math.floor(done/total*100)):0,parts};
}
function fmt(s){
  s=Math.max(0,Math.floor(+s||0));
  const h=Math.floor(s/3600), m=Math.floor(s/60)%60, x=s%60, p=n=>(n<10?'0':'')+n;
  return h?h+':'+p(m)+':'+p(x):m+':'+p(x);
}
const API=G.record={
  state:S, MILESTONES:MILESTONES.map(m=>Object.assign({},m)), BOSSES:BOSSES.slice(), IDLE_MAX,
  play:()=>playNow(),
  ms:id=>{ const m=S.ms[id]; return m?{t:m.t,at:m.at}:null; },
  split:id=>splitIn(liveTimes(),id),
  best:id=>{ let b=null; for(const r of S.runs){ const v=splitIn(r.ms||{},id); if(v!=null&&(b==null||v<b))b=v; } return b; },
  boss:id=>{ const b=S.boss[id]; return b?{tries:b.tries,best:b.best,hurt:b.hurt,draughts:b.draughts}:null; },
  get attempt(){ return cur?{id:cur.id,time:r1(S.play-cur.t0),hurt:cur.hurt,draughts:cur.draughts}:null; },
  completion,
  summary(){
    const splits={}, bosses={};
    for(const id of MS_IDS){ const m=S.ms[id]; if(m&&m.t!=null)splits[id]=Math.round(m.t); }
    for(const id of BOSSES){ const b=S.boss[id]; if(b&&b.best!=null)bosses[id]=Math.round(b.best); }
    return {play:Math.round(S.play),deaths:S.n.deaths|0,pct:completion().pct,days:S.days.length,splits,bosses,act1:!!S.ms.gloaming,full:!!S.ms.giant};
  },
  fmt,
  debug:{
    reach:(id,t)=>{ if(!S.ms[id])return reach(id,{t:t==null?S.play:t}); return false; },
    addPlay:s=>{ S.play=Math.max(0,S.play+(+s||0)); changed(); return S.play; },
    set:(path,v)=>{ const ks=String(path).split('.'); let o=S; for(let i=0;i<ks.length-1;i++){ if(!o[ks[i]]||typeof o[ks[i]]!=='object')o[ks[i]]={}; o=o[ks[i]]; } o[ks[ks.length-1]]=v; changed(); return v; },
    reset:()=>{ S=defaults(); API.state=S; cur=null; idle=0; loadedHere=false; changed(); return S; },
    get idle(){ return idle; }, backfill:()=>backfill(), newRun:()=>newRun()
  }
};
})();
