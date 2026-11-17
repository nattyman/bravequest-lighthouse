/* =====================================================================
   badges.js — the Keeper's Record badges and the keeper rank.
   Spec: RECORD.md (section 2). Holds the badge table, checks it against G.record and events, shows the earned
   moment, and derives the rank (nothing about rank is saved; it is cosmetic only).

   - Persist key 'badges': {v:1, got:{id:ms}, seen:{id:1}}. Earned badges are never taken away: a save loaded on top
     of them, a new game, or an older save is merged in (union). A copy is also kept in this browser
     (localStorage 'bq-badges', 'bq-badges-test' for test-tools saves), so loading an older save keeps them.
   - Story, collection and hidden badges that an existing save already holds are granted quietly on load
     (badge:earned {restored:true}, no card, no ping). Skill badges never are: they need a live, timed moment.
   - The earned moment: queued, one at a time, as a toast ("Keeper's record · Badge n of m"; the description goes in
     the message log), only at a quiet moment: in play, no boss fight, cut scene, talk card, reward card (or one
     about to come), other toast, or monster on the hunt nearby, for CALM seconds in a row. A rank-up gets one toast,
     queued the same way. (Not the shared reward card: its lift takes control away, and a badge is not an item.)
   - The two father badges: unearned, each is a hidden "???" slot; once one is earned the other leaves list()
     and total() until it is earned too (on another run).
   API: G.badges = {list(), has(id), count(), total(), nearest(), rank(), RANKS, BADGES, state, markSeen(ids?),
        SWIFT_MINUTES, debug:{grant(id,o), revoke(id), reset(), queue, settle(), flush()}}
   Events: badge:earned {id,name,restored} · rank:up {i,name}
   ===================================================================== */
(function(){
'use strict';
const G=window.G;
if(!G)return;

const SWIFT_MINUTES=45;        // "Left the Oven On": the Gloaming down in under this many minutes of play
const SETTLE=2.5;              // seconds after a load / a new game during which what is found is granted quietly
const CALM=2;                  // seconds of quiet before a queued card is shown
const POLL=1;                  // seconds between collection / rank checks
const EYEBROW='Keeper’s record';
const TOAST_GAP=4;            // seconds between two badge toasts (hud.js shows one for 3.2 s)

/* the table: ids, categories and names are fixed (RECORD.md). desc is shown once earned; hint while not earned
   (never for hidden badges). ms = the milestone that earns a story badge; part = the completion part of a collection. */
const BADGES=[
  {id:'ashore',cat:'story',ms:'ashore',name:'Worst Docking Ever',desc:'Arrived by boat. Technically.',hint:'Wake up. It’s a start.'},
  {id:'staff',cat:'story',ms:'staff',name:'Big Stick Energy',desc:'Speak softly. You won’t need to.',hint:'The lighthouse stair keeps something for whoever climbs it.'},
  {id:'stag',cat:'story',ms:'stag',name:'Oh Deer',desc:'It had antlers. It had it coming.',hint:'Something in the old wood won’t give up what it guards.'},
  {id:'light',cat:'story',ms:'lamp-cured',name:'Tried Turning It Off and On',desc:'The great lamp works again. Nobody needs to know how.',hint:'Finish the job at the top of the tower.'},
  {id:'gloaming',cat:'story',ms:'gloaming',name:'Lights Out',desc:'For once, the night was the one that ended.',hint:'See the first night through to its end.'},
  {id:'undertow',cat:'story',ms:'undertow',name:'Not Today, Tide',desc:'The sea asked for you. You declined.',hint:'Go where the tide goes when it leaves.'},
  {id:'crane',cat:'story',ms:'crane',name:'Tax Evasion',desc:'Account settled. Amount paid: nothing.',hint:'Someone under the hamlet is still collecting.'},
  {id:'answer',cat:'story',ms:'answer',name:'Wrong Answer',desc:'It asked. You argued. You won.',hint:'Something deep in the old wood is waiting to be asked.'},
  {id:'giant',cat:'story',ms:'giant',name:'Some Disassembly Required',desc:'Flat-packed. No instructions. Some fire.',hint:'Sail north and find where the fire is kept.'},
  {id:'wren',cat:'hidden',name:'Sorry, Who Are You Again?',desc:'She got herself back. The name came with her.'},
  {id:'father-died',cat:'hidden',name:'Dad to the Rescue',desc:'He came back for you. That was the whole plan, apparently.'},
  {id:'father-lived',cat:'hidden',name:'Thanks, I Got It',desc:'Nobody needed saving. He keeps the light now, and the told-you-so.'},
  {id:'untouched',cat:'skill',name:'Not a Scratch',desc:'A whole boss fight and not one mark on you. Smugness permitted.',hint:'Win a boss fight without taking a hit.'},
  {id:'dry',cat:'skill',name:'Designated Driver',desc:'Beat a boss stone-cold sober.',hint:'Win a boss fight without drinking a draught.'},
  {id:'surefooted',cat:'skill',name:'Unbothered. Alive.',desc:'Lit the great lamp without a single trip back from the dead.',hint:'Get the great lamp lit again without dying once.'},
  {id:'repertoire',cat:'skill',name:'Stick Tricks',desc:'Every trick the staff knows. It’s a little impressed.',hint:'Find every staff technique (the pause menu keeps count).'},
  {id:'swift',cat:'skill',name:'Left the Oven On',desc:'The first night, done in under '+SWIFT_MINUTES+' minutes. Somewhere to be?',hint:'See the first night through in under '+SWIFT_MINUTES+' minutes of play.'},
  {id:'firsttry',cat:'skill',name:'No Notes',desc:'The Gloaming, first take.',hint:'Win the first night’s last fight on your first try.'},
  {id:'shards',cat:'collect',part:'shards',name:'Heart Hoarder',desc:'Every heart shard on the island. Greedy, but healthy.',hint:'Find every heart shard.',noun:['heart shard','heart shards']},
  {id:'caches',cat:'collect',part:'caches',name:'Finders Keepers',desc:'Every keeper’s cache, opened. The keeper would like a word.',hint:'Open every Keeper’s Cache.',noun:['Keeper’s Cache','Keeper’s Caches']},
  {id:'freed',cat:'collect',part:'negatives',name:'Animal Control',desc:'Every corrupted creature, freed. Not one of them said thanks.',hint:'Free every corrupted creature.',noun:['creature','creatures']},
  {id:'blights',cat:'collect',part:'blights',name:'Stain Remover',desc:'Every blight cured. Tough on stains.',hint:'Cure every blight.',noun:['blight','blights']},
  {id:'tempered',cat:'collect',part:'tempered',name:'Staff Benefits',desc:'Every temper upgrade. The staff has a better package than you.',hint:'Temper every upgrade at a keeper’s bench.',noun:['upgrade','upgrades']},
  {id:'stones',cat:'collect',part:'waystones',name:'Rock Collector',desc:'Every waystone woken. They’re still rocks.',hint:'Wake every waystone.',noun:['waystone','waystones']},
  {id:'company',cat:'collect',part:'companions',name:'Emotional Support Animals',desc:'A fox and a raven. Neither is house-trained.',hint:'Make two unlikely friends.',noun:['companion','companions']}
];
const BY=Object.fromEntries(BADGES.map(b=>[b.id,b]));
const BY_MS=Object.fromEntries(BADGES.filter(b=>b.ms).map(b=>[b.ms,b.id]));
const FATHER=['father-died','father-lived'];
const RANKS=['Castaway','Lamplighter','Keeper','Warden of the Isle','Keeper of Two Lights','Moth-Crowned'];

const now=()=>Date.now();
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const R=()=>G.record||null;
const msOf=id=>{ try{ const r=R(); return r&&r.ms?r.ms(id):null; }catch(_){ return null; } };
const parts=()=>{ try{ const r=R(); return r&&r.completion?r.completion().parts||{}:{}; }catch(_){ return {}; } };
const pct=()=>{ try{ const r=R(); return r&&r.completion?r.completion().pct|0:0; }catch(_){ return 0; } };

let S={v:1,got:{},seen:{}};
function normalise(d){
  d=obj(d); const s={v:1,got:{},seen:{}};
  const g=obj(d.got); for(const k in g)if(BY[k]&&typeof g[k]==='number'&&isFinite(g[k])&&g[k]>0)s.got[k]=g[k];
  const n=obj(d.seen); for(const k in n)if(BY[k]&&n[k])s.seen[k]=1;
  return s;
}
/* union: a badge earned anywhere stays earned (the earliest date wins) */
function merge(d){
  const o=normalise(d); let grew=false;
  for(const k in o.got){ if(!S.got[k]){ S.got[k]=o.got[k]; grew=true; } else if(o.got[k]<S.got[k])S.got[k]=o.got[k]; }
  for(const k in o.seen)S.seen[k]=1;
  return grew;
}

/* ---------------------------------------------------------------- the copy kept in this browser */
const localKey=()=>G.testSaves?'bq-badges-test':'bq-badges';
function readLocal(){ try{ return JSON.parse(localStorage.getItem(localKey())||'null'); }catch(_){ return null; } }
function writeLocal(){ try{ localStorage.setItem(localKey(),JSON.stringify(S)); }catch(_){} }
function storedSave(){
  try{
    const F=G.flow; if(!F||!F.readSave)return null;
    const key=G.testSaves&&F.keys?F.keys.test:(F.keys&&F.keys.save);
    const d=F.readSave(key); return d&&d.mods&&d.mods.badges||null;
  }catch(_){ return null; }
}
/* what this browser already knows: its own copy and the stored save (a new game is about to overwrite it) */
function mergeKnown(){ const a=merge(readLocal()), b=merge(storedSave()); if(a||b)changed(); writeLocal(); }

/* ---------------------------------------------------------------- earning */
let settle=0;              // > 0: just loaded / just began; the sweep at its end grants what the save holds, quietly
let queue=[];              // [{kind:'badge',id} | {kind:'rank',i}]
let shown=[];              // what has been shown, in order (tests)
let calm=0, toastCool=0, pollT=0, lastRank=-1;
const changed=()=>{};   // (a hook for a later change event; badge:earned covers the Journal today)

function grant(id,o){
  o=o||{}; const b=BY[id]; if(!b||S.got[id])return false;
  const quiet=!!o.restored;
  S.got[id]=now(); if(quiet)S.seen[id]=1;
  writeLocal(); changed();
  try{ G.emit('badge:earned',{id,name:b.name,restored:quiet}); }catch(e){ console.error('badge:earned',e); }
  if(!quiet){
    try{ if(G.beta&&G.beta.ping)G.beta.ping('badge:'+id); }catch(_){}
    queue.push({kind:'badge',id});
  }
  return true;
}

/* everything an existing save can show: story milestones, collections, the hidden ones with a state to read */
function sweep(quiet){
  const o={restored:!!quiet};
  for(const b of BADGES){
    if(S.got[b.id])continue;
    if(b.ms){ if(msOf(b.ms))grant(b.id,o); }
  }
  checkCollections(o);
  try{ const U=G.undercroftPeople; if(U&&U.state&&U.state.wren&&U.state.wren.saved)grant('wren',o); }catch(_){}
  try{ const N=G.northFire&&G.northFire.state; if(N&&N.done&&(N.outcome==='died'||N.outcome==='lived'))grant('father-'+N.outcome,o); }catch(_){}
}
function checkCollections(o){
  const P=parts();
  for(const b of BADGES){
    if(b.cat!=='collect'||S.got[b.id])continue;
    const p=P[b.part]; if(Array.isArray(p)&&p[1]>0&&p[0]>=p[1])grant(b.id,o);
  }
}
/* "Stick Tricks": every technique the pause menu lists, found (this browser's knowledge and the save's) */
function techniques(){
  const M=G.moves; if(!M)return null;
  const order=Array.isArray(M.order)&&M.order.length?M.order:Object.keys(M.T||{}).filter(k=>M.T[k]&&M.T[k].name);
  if(!order.length)return null;
  const r=R(), saved=r&&r.state&&Array.isArray(r.state.combos)?r.state.combos:[];
  const has=k=>(M.isFound&&M.isFound(k))||saved.includes(k);
  return {done:order.filter(has).length,total:order.length};
}
/* the skill badges that need the whole run seen by the record (it began at the opening, with a real time) */
const wholeRun=()=>{ const a=msOf('ashore'); return !!(a&&a.t!=null); };

const on=(ev,fn)=>G.on(ev,e=>{ try{ fn(e||{}); }catch(err){ console.error('badges '+ev,err); } });
on('record:milestone',e=>{
  const id=BY_MS[e.id];
  if(id)grant(id,{restored:!!e.restored});
  if(e.restored||e.t==null)return;            // a back-filled milestone never earns a skill badge
  if(e.id==='lamp-cured'&&wholeRun()){ const r=R(); if(r&&r.state&&r.state.n&&(r.state.n.deaths|0)===0)grant('surefooted'); }
  if(e.id==='gloaming'&&wholeRun()&&e.t<SWIFT_MINUTES*60)grant('swift');
});
on('record:boss',e=>{
  if(!e.win||e.time==null)return;              // only a real, timed winning attempt
  if(e.hurt===0)grant('untouched');
  if(e.draughts===0)grant('dry');
  if(e.id==='gloaming'&&e.tries===1&&wholeRun())grant('firsttry');
});
on('player:combo',()=>{ const t=techniques(); if(t&&t.total&&t.done>=t.total)grant('repertoire'); });
on('undercroft:saved',e=>{ if(e.who&&e.who!=='wren')return; grant('wren',{restored:!!(e.restored||e.quiet)}); });
on('northFire:finish',e=>{ const o=e.outcome==='died'?'died':e.outcome==='lived'?'lived':null; if(!o)return; grant('father-'+o,{restored:!!e.restored}); });
// collections: check soon after anything that can move a count (and on a slow poll as well)
['progress:shard','progress:cache','progress:upgrade','negative:freed','map:waypoint','companion:earned','record:change','blight:cured'].forEach(n=>on(n,()=>{ pollT=Math.min(pollT,.2); }));
// a load, a game leaving the title, a new game: merge what is known, then settle
on('mode',e=>{ if(e.prev==='title'&&e.mode!=='title'){ mergeKnown(); settle=SETTLE; } });
on('record:newgame',()=>{ mergeKnown(); settle=SETTLE; lastRank=-1; });

/* boss fights, if the record is missing: its own start / end events */
let fight=null;
['stag:engage','gloaming:start','cave:bossStart','undercroft:bossStart','temple:bossStart','northFire:fightStart'].forEach(n=>on(n,()=>{ fight=n; }));
['boss:dead','cave:bossDead','cave:bossEnd','undercroft:bossDead','undercroft:bossReset','temple:bossDead','temple:bossReset','northFire:finish','northFire:reset','player:dead'].forEach(n=>on(n,()=>{ fight=null; }));
function inFight(){ const r=R(); if(r&&'attempt' in r){ try{ return !!r.attempt; }catch(_){ return false; } } return !!fight; }

/* ---------------------------------------------------------------- persistence */
const PERSIST={
  save(){ return JSON.parse(JSON.stringify(S)); },
  load(d){ merge(d); mergeKnown(); settle=SETTLE; lastRank=-1; changed(); }
};
if(G.persist&&G.persist.register)G.persist.register('badges',PERSIST);
else G.on('ready',()=>{ if(G.persist&&G.persist.register)G.persist.register('badges',PERSIST); });

/* ---------------------------------------------------------------- the list, totals, nearest, rank */
function visible(){
  const d=!!S.got['father-died'], l=!!S.got['father-lived'];
  return BADGES.filter(b=>!(b.id==='father-lived'&&d&&!l)&&!(b.id==='father-died'&&l&&!d));
}
function entry(b){
  const got=S.got[b.id]||0, hidden=b.cat==='hidden', shown=!!got||b.cat==='skill'||b.cat==='collect';
  return {id:b.id,cat:b.cat,name:shown?b.name:'???',desc:got?b.desc:'',hint:hidden&&!got?null:(b.hint||null),hidden,got,shown,seen:!!(got&&S.seen[b.id])};
}
const list=()=>visible().map(entry);
const count=()=>visible().filter(b=>S.got[b.id]).length;
const total=()=>visible().length;
function nearest(){
  const P=parts(); let best=null;
  const consider=(b,gap)=>{ if(!(gap>0))return; if(!best||gap<best.gap)best={b,gap}; };
  for(const b of BADGES){
    if(S.got[b.id])continue;
    if(b.cat==='collect'){ const p=P[b.part]; if(Array.isArray(p)&&p[1]>0)consider(b,p[1]-p[0]); }
    else if(b.id==='repertoire'){ const t=techniques(); if(t)consider(b,t.total-t.done); }
  }
  if(!best)return null;
  const b=best.b, n=best.gap, noun=b.noun?b.noun[n===1?0:1]:(n===1?'technique':'techniques');
  return {id:b.id,name:b.name,text:n+' '+noun+' from '+b.name};
}
/* the ladder: each rank needs its own step and every one below it */
function steps(){
  const c=count(), p=pct(), has=id=>!!msOf(id);
  const unearned=visible().filter(b=>b.cat!=='hidden'&&!S.got[b.id]).length;
  return [null,
    {ok:has('lamp-cured'),need:()=>'Get the great lamp lit again'},
    {ok:has('gloaming')&&c>=8,need:()=>[!has('gloaming')&&'See the first night through',c<8&&'earn 8 badges ('+c+' so far)'].filter(Boolean).join(', and ')},
    {ok:has('answer')&&p>=50,need:()=>[!has('answer')&&'Face what waits in the Vigil',p<50&&'reach 50% complete ('+p+'% now)'].filter(Boolean).join(', and ')},
    {ok:has('giant')&&p>=75,need:()=>[!has('giant')&&'Settle things in the north',p<75&&'reach 75% complete ('+p+'% now)'].filter(Boolean).join(', and ')},
    {ok:p>=100&&unearned===0,need:()=>[p<100&&'Reach 100% complete ('+p+'% now)',unearned>0&&'earn every badge you can see ('+unearned+' to go)'].filter(Boolean).join(', and ')}
  ];
}
function rank(){
  const st=steps(); let i=0;
  while(i+1<st.length&&st[i+1].ok)i++;
  const nx=i+1<st.length?{name:RANKS[i+1],need:(s=>s.charAt(0).toUpperCase()+s.slice(1))(st[i+1].need())}:null;
  return {i,name:RANKS[i],next:nx};
}
function rankI(){ try{ return rank().i; }catch(_){ return 0; } }

/* ---------------------------------------------------------------- the earned moment */
function threatened(){
  const P=G.player, M=G.monsters; if(!P||!P.pos||!M||!Array.isArray(M.list))return false;
  for(const m of M.list){ if(!m||!m.alive||!m.pos||m.state==='idle'||m.state==='return'||m.state==='dying')continue;
    if(Math.hypot(m.pos.x-P.pos.x,m.pos.z-P.pos.z)<22)return true; }
  return false;
}
function toastUp(){ const t=document.getElementById('toast'); return !!(t&&t.classList.contains('show')); }
function quietNow(){
  if(!G.state||G.state.mode!=='play')return false;
  if(G.cine&&G.cine.on)return false;
  if(G.talk&&G.talk.isOpen)return false;
  if(inFight())return false;
  const Pr=G.progress;
  if(Pr&&(Pr.busy||(Pr.debug&&Pr.debug.pend&&Pr.debug.pend.length)))return false;
  const P=G.player; if(P&&(P.alive===false||P.grounded===false))return false;
  if(threatened())return false;
  return true;
}
function chime(){
  const A=G.audio; if(!A||!A.ready||!A.S||!A.context)return;
  try{ A.S.chime(A.context.currentTime,[74,78,81],{g:.05,step:.09,decay:1.2}); }catch(_){}
}
function show(item){
  if(item.kind==='rank'){
    if(G.ui&&G.ui.toast)G.ui.toast(RANKS[item.i]||'',EYEBROW+' · New rank');
    try{ if(G.ui&&G.ui.logLine)G.ui.logLine('New rank: '+(RANKS[item.i]||'')+'.',EYEBROW); }catch(_){}
    shown.push('rank:'+item.i); toastCool=TOAST_GAP; chime(); return;
  }
  const b=BY[item.id]; if(!b)return;
  // a toast, not the reward card: the reward card takes control away for its lift, and a badge is not an item to hold up
  if(G.ui&&G.ui.toast)G.ui.toast(b.name,EYEBROW+' · Badge '+count()+' of '+total());
  // the description goes in the message log (pause menu > Messages) and the Journal
  try{ if(G.ui&&G.ui.logLine)G.ui.logLine(b.name+'. '+b.desc,EYEBROW); }catch(_){}
  shown.push('badge:'+b.id); toastCool=TOAST_GAP; chime();
}
const nextUp=()=>queue.length>0&&toastCool<=0&&!toastUp();

G.system('badges',{order:97,modes:'always',
  init(){ /* nothing to build: the card is progression.js's */ },
  update(dt){
    dt=+dt||0;
    try{
      const mode=G.state&&G.state.mode;
      if(mode==='title')return;
      if(toastCool>0)toastCool-=dt;
      if(settle>0){
        settle-=dt;
        if(settle<=0){ settle=0; sweep(true); lastRank=rankI(); pollT=POLL; }
        else return;
      }
      if((pollT-=dt)<=0){
        pollT=POLL;
        if(mode==='play'||mode==='paused'){
          checkCollections({});
          const r=rankI();
          if(lastRank<0||r<lastRank)lastRank=r;           // a new game (or a load) starts the ladder again, silently
          else if(r>lastRank){ lastRank=r; try{ G.emit('rank:up',{i:r,name:RANKS[r]}); }catch(_){} queue.push({kind:'rank',i:r}); }
        }
      }
      if(queue.length&&quietNow()){ calm+=dt; if(calm>=CALM&&nextUp()){ show(queue.shift()); calm=0; } }
      else calm=0;
    }catch(e){ if(!this._err){ console.error('badges',e); this._err=1; } }
  }
});

/* ---------------------------------------------------------------- API */
const API=G.badges={
  BADGES:BADGES.map(b=>({id:b.id,cat:b.cat,name:b.name})), RANKS:RANKS.slice(), SWIFT_MINUTES,
  get state(){ return S; },
  list, has:id=>!!S.got[id], count, total, nearest, rank,
  /** the Journal: mark earned badges as seen (all of them when no ids are given) */
  markSeen(ids){ const a=ids==null?Object.keys(S.got):[].concat(ids); let n=0; for(const k of a)if(S.got[k]&&!S.seen[k]){ S.seen[k]=1; n++; } if(n){ writeLocal(); changed(); } return n; },
  debug:{
    grant:(id,o)=>grant(id,o),
    revoke:id=>{ if(!S.got[id])return false; delete S.got[id]; delete S.seen[id]; queue=queue.filter(q=>q.id!==id); writeLocal(); changed(); return true; },
    reset:()=>{ S={v:1,got:{},seen:{}}; queue=[]; calm=0; settle=0; lastRank=-1; toastCool=0; try{ localStorage.removeItem('bq-badges'); localStorage.removeItem('bq-badges-test'); }catch(_){} return S; },
    get queue(){ return queue.map(q=>Object.assign({},q)); },
    get settle(){ return settle; },
    get calm(){ return calm; },
    get shown(){ return shown.slice(); },
    quiet:()=>quietNow(),
    sweep:q=>sweep(q!==false),
    flush:()=>{ let n=0; while(queue.length&&n++<64)show(queue.shift()); return n; }
  }
};
})();
