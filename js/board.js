/* =========================================================================
   board.js — the Keepers' Board: public leaderboards for the beta.
   Spec: RECORD.md (section 5). Switched on by window.BQ_CONFIG.api (the release build, test/build_release.py);
   without it (the Claude artifacts, dev.html) this module does nothing. Nothing at all in ?debug / test-save sessions.

   - Button: "Keepers' Board" in the link row beta.js puts on the title and pause cards (.bq-links), after
     "Send feedback". Placed once the page has loaded, so either script order works.
   - Name: chosen on the card (3-16 characters). It belongs to the sync code (the code is the password, the name is
     the username), so the board needs sync on; the card offers to turn it on. The name and crew are sent ONLY in
     the request that sets or changes them (omitting them keeps what the server holds, so an admin's rename sticks).
   - Uploads: G.record.summary() + badge count + rank + build, PUT /v1/record with the sync code. After a milestone,
     a boss win or a badge, once per session after the first cloud save, at most once a minute (GAP), and when the
     tab is hidden (keepalive). Who: every device with sync on. A record without a name is never listed publicly; it
     only tells the studio where players stall. Under Do Not Track nothing is uploaded unless the player has joined
     the board (choosing a name is an explicit opt-in). 404 no_save waits for the next cloud save; 429 honours
     Retry-After; any other failure is silent. Never blocks play.
   - Card: tabs Act 1 / Full game / Bosses / Fewest deaths / Most complete, Everyone / Crew, your row highlighted and
     your place shown even outside the list. Each board is fetched when its tab is opened and kept for a minute.
     Bosses list only the ones this save has beaten (their names would spoil the rest).
   - localStorage 'bq-board': {code, name, crew, asked} (the name and crew of the sync code, or 'a:<account id>', they were set under).
   - With Keeper Accounts on (js/account.js; Spec: ACCOUNTS.md, section 6d) every call goes through G.account.fetch (with accounts
     off that is the same plain call with the sync code, so guests and builds without accounts see no change). Signed in, the
     board belongs to the account: no sync code is needed, the keeper name is the account's (the service keeps the two in step;
     after a change the account is re-read), uploads carry the session cookie, and nothing is uploaded while the active save slot
     (G.slots, if present) is a test save. Signed out with accounts on, a guest with no name is told a new keeper name needs an
     account (Sign in opens the account card; the service's 403 account_needed says the same); a guest who has a name keeps it.
     Signing in or out re-reads the name and the boards.
   API: G.board = { open(from), close(), state, push(), debug }
   ========================================================================= */
(function(){
'use strict';
const G=window.G; if(!G)return;
const CFG=window.BQ_CONFIG||{};
const API=String(CFG.api||'').replace(/\/+$/,'');
if(!API)return;
const VERSION=String(CFG.version||'').slice(0,40);
const LS='bq-board';
let GAP=60000;                 // ms: at most one routine upload this often
let CACHE=60000;               // ms: a fetched board is kept this long
const LIMIT=25, TIMEOUT=15000;
const quiet=()=>!!(G.testSaves||G.debugUrl);                   // test tools and ?debug sessions: nothing at all
const dnt=()=>navigator.doNotTrack==='1'||window.doNotTrack==='1';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; };
const sync=()=>G.cloud&&G.cloud.sync||null;
const code=()=>{ try{ const s=sync(); return s&&s.code?String(s.code()||'').replace(/[^0-9A-Z]/gi,'').toUpperCase():''; }catch(_){ return ''; } };
const syncAvailable=()=>{ try{ const s=sync(); return !!(s&&s.available); }catch(_){ return false; } };
/* Keeper Accounts (account.js loads after this file: always look it up when needed) */
const acct=()=>G.account||null;
const accountsOn=()=>{ const a=acct(); return !!(a&&a.on); };
const signedIn=()=>{ const a=acct(); return !!(a&&a.on&&a.state==='in'&&a.me&&a.me.id); };
const acctMe=()=>signedIn()?acct().me:null;
/* whose board entry this device speaks for: the account when signed in, else the sync code ('' = nobody) */
const owner=()=>{ const m=acctMe(); return m?'a:'+String(m.id):code(); };
/* the active save slot is a test save (G.slots comes with save slots; without it there is no such thing) */
const testSlot=()=>{ if(!signedIn()||!G.slots||typeof G.slots.active!=='function')return false; try{ const a=G.slots.active(); return !!(a&&a.test); }catch(_){ return false; } };
/* a guest in a build with accounts: a NEW keeper name needs an account */
const needsAccount=()=>accountsOn()&&!signedIn()&&!mine().name;
const fmt=s=>{ try{ if(G.record&&G.record.fmt)return G.record.fmt(s); }catch(_){}
  s=Math.max(0,Math.floor(+s||0)); const h=Math.floor(s/3600), m=Math.floor(s/60)%60, x=s%60, p=n=>(n<10?'0':'')+n; return h?h+':'+p(m)+':'+p(x):m+':'+p(x); };
const build=()=>String((G.beta&&G.beta.version)||VERSION||'dev').slice(0,40);

/* ---- what this device knows about its board entry ---- */
function load(){ try{ const d=JSON.parse(localStorage.getItem(LS)||'{}'); return d&&typeof d==='object'?d:{}; }catch(_){ return {}; } }
let st=Object.assign({code:'',name:'',crew:'',asked:0},load());
function save(){ try{ localStorage.setItem(LS,JSON.stringify({code:st.code,name:st.name,crew:st.crew,asked:st.asked?1:0})); }catch(_){} }
/* the name and crew are the sync code's: another code (joined, turned off and on) starts with neither until the server says */
function mine(){ const c=owner(); if(st.code!==c){ st.code=c; const m=acctMe(); st.name=m&&m.name?String(m.name):''; st.crew=''; R.fetched=''; save(); } return st; }
const joined=()=>!!(owner()&&mine().name);

/* ---- the save service ---- */
async function call(method,path,body,o){
  o=o||{}; const A=acct();
  let r;
  if(A&&typeof A.fetch==='function'){
    /* the one way to the service: cookie + X-BQ-Client with accounts on, the sync code as Bearer unless signed in */
    try{ r=await A.fetch(path,{method,body:body||undefined,keepalive:!!o.keepalive,auth:o.auth,timeout:TIMEOUT}); }
    catch(_){ return {ok:false,status:0,error:'offline'}; }
  }else{
    /* account.js missing (a build without it): the same call by hand */
    const h={}, k=o.auth===false?'':code();
    if(k)h.Authorization='Bearer '+k;
    if(body)h['Content-Type']='application/json';
    const ac=typeof AbortController==='function'&&!o.keepalive?new AbortController():null;
    const t=ac?setTimeout(()=>ac.abort(),TIMEOUT):0;
    try{ r=await fetch(API+path,{method,headers:h,body:body?JSON.stringify(body):undefined,cache:'no-store',keepalive:!!o.keepalive,signal:ac?ac.signal:undefined}); }
    catch(_){ clearTimeout(t); return {ok:false,status:0,error:'offline'}; }
    clearTimeout(t);
  }
  let d=null; try{ d=await r.json(); }catch(_){}
  return {ok:r.ok,status:r.status,error:(d&&d.error)||(r.ok?'':'http_'+r.status),data:d,retry:Math.max(1,+(r.headers.get('Retry-After')||0)||60)};
}

/* ---- uploads ---- */
const R={gen:0,idGen:0,log:[],busy:null,dirty:false,lastTry:0,blockedUntil:0,waitSave:false,timer:0,sessionSent:false,bad:false,uploads:0,last:null,fetched:''};
function payload(){
  const Rec=G.record; if(!Rec||!Rec.summary)return null;
  let s; try{ s=Rec.summary(); }catch(_){ return null; }
  if(!s)return null;
  const int=(v,lo,hi)=>Math.max(lo,Math.min(hi,Math.round(+v||0)));
  const play=int(s.play,0,5e7);
  const ids=(Rec.MILESTONES||[]).map(m=>m.id), bossIds=Rec.BOSSES||[];
  const splits={}, bosses={};
  for(const id of ids){ if(!s.splits||!(id in s.splits))continue; const v=s.splits[id];
    if(v==null){ splits[id]=null; continue; }
    const t=int(v,0,play);
    if(id==='gloaming'&&t<300||id==='giant'&&t<1200)continue;      // the service's floors: a time under them is not a run it accepts
    splits[id]=t; }
  for(const id of bossIds){ const v=s.bosses&&s.bosses[id]; if(v!=null&&+v>=10)bosses[id]=int(v,10,5e7); }
  let badges=0, rank=0;
  try{ if(G.badges){ badges=int(G.badges.count(),0,1000); rank=int(G.badges.rank().i,0,20); } }catch(_){}
  return {build:build(),play,deaths:int(s.deaths,0,1e6),pct:int(s.pct,0,100),days:int(s.days,0,10000),badges,rank,splits,bosses};
}
function canUpload(){ return !quiet()&&!!owner()&&!testSlot()&&!!(G.record&&G.record.summary)&&!R.bad&&(!dnt()||joined()); }
function arm(ms){ if(R.timer)return; R.timer=setTimeout(()=>{ R.timer=0; if(R.dirty)push(); },Math.max(50,ms)); }
/* one PUT; extra = {name} / {crew} for the player's own changes */
async function send(extra,keepalive){
  const body=payload(); if(!body)return {ok:false,status:0,error:'no_record'};
  if(extra)Object.assign(body,extra);
  R.lastTry=Date.now(); const gen=R.gen, id=R.idGen;
  const p=call('PUT','/v1/record',body,{keepalive});
  R.busy=p; let r;
  try{ r=await p; }finally{ R.busy=null; }
  R.last={status:r.status,error:r.error,named:!!(extra&&'name' in extra),at:Date.now()};
  R.log.push({at:R.last.at,status:r.status,error:r.error,extra:!!extra,acct:signedIn()}); if(R.log.length>40)R.log.shift();
  if(id!==R.idGen){ R.dirty=true; return r; }      // signed in or out meanwhile (a 401 signed_out does that): the answer was for someone else
  if(r.ok){ R.uploads++; R.sessionSent=true; R.waitSave=false; if(R.gen===gen)R.dirty=false; else arm(GAP-(Date.now()-R.lastTry)); G.emit('board:uploaded',{status:r.status}); }
  else if(r.status===404&&r.error==='no_save'){ R.waitSave=true; R.dirty=true; }   // the save (an account: a save slot that isn't a test) hasn't reached the service yet: after the next one
  else if(r.status===403&&r.error==='account_needed'){ if(!extra)R.bad=true; }      // only a name change can get this; never retried
  else if(r.status===429){ R.blockedUntil=Date.now()+r.retry*1000; R.dirty=true; if(!extra)arm(r.retry*1000); }
  else if(r.status===401||r.status===404||r.status===400&&!extra){ R.bad=true; }   // a code or data the service won't take, or a service without boards: stop trying
  else if(!extra){ R.dirty=true; arm(GAP); }                                 // unreachable: quietly again in a minute
  if(R.dirty&&!R.waitSave&&!R.timer&&r.ok===false&&extra)arm(GAP);
  return r;
}
/* a routine upload: throttled, silent */
function push(o){
  o=o||{};
  if(!canUpload()){ if(testSlot()&&!quiet())R.dirty=true; return Promise.resolve(false); }   // a test slot: sent once a real slot is active (slots:active)
  R.dirty=true; R.gen++;
  if(R.busy)return R.busy.then(()=>false,()=>false);
  const now=Date.now();
  if(now<R.blockedUntil){ arm(R.blockedUntil-now); return Promise.resolve(false); }
  if(!o.now&&R.lastTry&&now-R.lastTry<GAP){ arm(GAP-(now-R.lastTry)); return Promise.resolve(false); }
  clearTimeout(R.timer); R.timer=0;
  return send(null,!!o.keepalive).then(r=>r.ok,()=>false);
}
function wire(){
  const fresh=e=>!(e&&(e.restored||e.quiet));
  G.on('record:milestone',e=>{ if(fresh(e))push(); });
  G.on('record:boss',e=>{ if(e&&e.win)push(); });
  G.on('badge:earned',e=>{ if(fresh(e))push(); });
  const saved=()=>{ if(R.waitSave||!R.sessionSent||R.dirty){ R.waitSave=false; push(); } };
  G.on('cloud:saved',saved);                     // a guest save, or (save slots) a slot upload, reached the service
  G.on('slots:saved',saved); G.on('slots:uploaded',saved);
  G.on('slots:active',()=>{ if(!testSlot()&&(R.waitSave||R.dirty))saved(); });
  /* signed in or out: another owner, another name, other boards */
  const swap=e=>{
    R.idGen++; R.bad=false; R.waitSave=false; R.sessionSent=false; R.fetched=''; R.blockedUntil=0;
    clearTimeout(R.timer); R.timer=0; dropCache(); mine();
    if(e&&e.me&&signedIn()){ st.name=String(e.me.name||''); if(st.name)st.asked=1; save(); }
    if(ui)ui.reload();
  };
  G.on('account:in',swap); G.on('account:out',swap);
  G.on('account:me',e=>{ if(!signedIn())return; mine(); const n=String(e&&e.me&&e.me.name||''); if(n!==st.name){ st.name=n; if(n)st.asked=1; save(); dropCache(); if(ui)ui.reload(); } });
  const away=()=>{ if(R.dirty&&canUpload()&&!R.busy&&Date.now()>=R.blockedUntil)push({now:true,keepalive:true}); };
  document.addEventListener('visibilitychange',()=>{ if(document.hidden)away(); });
  window.addEventListener('pagehide',away);
}

/* ---- the player's own changes: name, crew ---- */
const NAME_RE=/^[A-Za-z0-9 _'\-]{3,16}$/;
function cleanName(t){ return String(t||'').replace(/[‘’]/g,"'").trim().replace(/\s+/g,' '); }
function cleanCrew(t){ return String(t||'').toUpperCase().replace(/[^0-9A-Z]/g,''); }
/* PUT with the change; a missing save is uploaded first and the change tried once more */
async function change(extra){
  if(quiet())return {ok:false,why:'quiet'};
  if(!owner())return {ok:false,why:accountsOn()?'account_needed':'no_code'};
  if(signedIn()&&testSlot())return {ok:false,why:'test_slot'};
  if(R.busy){ try{ await R.busy; }catch(_){} }
  if(Date.now()<R.blockedUntil)return {ok:false,why:'rate',wait:Math.ceil((R.blockedUntil-Date.now())/1000)};
  const id=R.idGen;
  let r=await send(extra);
  if(!r.ok&&r.status===404&&r.error==='no_save'&&G.cloud&&G.cloud.flush&&id===R.idGen){ try{ await G.cloud.flush(); }catch(_){} r=await send(extra); }
  if(id!==R.idGen)return {ok:false,why:'swapped'};
  if(r.ok){ const d=r.data||{}; mine();
    if('name' in extra)st.name=typeof d.name==='string'?d.name:cleanName(extra.name);
    if('crew' in extra)st.crew=cleanCrew(extra.crew);
    st.asked=1; save();
    if('name' in extra&&signedIn()){ try{ const p=acct().refresh(); if(p&&p.catch)p.catch(()=>{}); }catch(_){} }   // the account card shows the same name
    return {ok:true}; }
  const why=r.status===0?'offline':r.status===429?'rate':r.error==='account_needed'?'account_needed':r.error==='name_taken'?'name_taken':r.error==='name_invalid'?'name_invalid'
    :r.error==='no_save'?'no_save':r.error==='no_record'?'no_save':r.status===400&&'crew' in extra?'crew_invalid':r.status===401?'bad_key':'unavailable';
  return {ok:false,why,wait:r.status===429?r.retry:0};
}
/* what the server holds for this code (the name may have been chosen on another device) */
async function fetchMine(){
  const c=owner(); if(!c||R.fetched===c)return;
  const r=await call('GET','/v1/record');
  if(owner()!==c)return;
  const m=acctMe();          // signed in, the account's keeper name is the one that counts
  if(r.ok&&r.data){ mine(); st.name=m?String(m.name||''):String(r.data.name||''); st.crew=String(r.data.crew||''); if(st.name)st.asked=1; save(); R.fetched=c; }
  else if(r.status===404){ mine(); st.name=m?String(m.name||''):''; st.crew=''; save(); R.fetched=c; }
}

/* ---- boards ---- */
const cache={};
async function board(b,crew){
  const k=b+'|'+(crew||'')+'|'+owner(), c=cache[k];
  if(c&&Date.now()-c.at<CACHE)return c.r;
  const r=await call('GET','/v1/board?b='+encodeURIComponent(b)+(crew?'&crew='+encodeURIComponent(crew):'')+'&limit='+LIMIT);
  if(r.ok)cache[k]={at:Date.now(),r};
  return r;
}
const TABS=[{id:'act1',name:'Act 1'},{id:'full',name:'Full game'},{id:'boss',name:'Bosses'},{id:'deaths',name:'Fewest deaths'},{id:'pct',name:'Most complete'}];
/* bosses this save has beaten, by the milestone of the same id; names come from the Record's milestone list */
function beaten(){
  const Rec=G.record; if(!Rec)return [];
  const names={}; for(const m of Rec.MILESTONES||[])names[m.id]=m.name;
  const out=[];
  for(const id of Rec.BOSSES||[]){ let won=false; try{ won=!!Rec.ms(id)||!!(Rec.boss(id)&&Rec.boss(id).best!=null); }catch(_){}
    if(won)out.push({id,name:names[id]||id}); }
  return out;
}
function valueText(b,v){
  if(v==null)return '–';
  if(b==='pct')return Math.round(v)+'%';
  if(b==='deaths')return v+(v===1?' death':' deaths');
  return fmt(v);
}
/* this device's own value for a board, from the Record (shown when the service has none, or there's no code) */
function localValue(b){
  const Rec=G.record; if(!Rec)return null;
  try{
    if(b==='act1'){ const m=Rec.ms('gloaming'); return m&&m.t!=null?m.t:null; }
    if(b==='full'){ const m=Rec.ms('giant'); return m&&m.t!=null?m.t:null; }
    if(b==='pct')return Rec.completion().pct;
    if(b==='deaths'){ const s=Rec.summary(); return s.full?s.deaths:null; }
    if(b.indexOf('boss:')===0){ const x=Rec.boss(b.slice(5)); return x&&x.best!=null?Math.round(x.best):null; }
  }catch(_){}
  return null;
}
const rankName=i=>{ const n=G.badges&&G.badges.RANKS; return n&&n[i]||''; };

/* ---- the card ---- */
const css=el('style');
css.textContent=`
#boardCard{z-index:7;align-items:flex-start}            /* above the round pause button; a tall card scrolls from its top */
#boardCard .sheet{gap:14px;margin-block:auto}
#boardCard .kb-body{display:grid;gap:14px}
#boardCard [hidden]{display:none!important}
#boardCard label{font:600 13px var(--body);letter-spacing:.06em;color:#6c3f5f;display:grid;gap:6px}
#boardCard input[type=text]{font:400 17px var(--body);color:#21161f;background:rgba(255,252,244,.75);border:1px solid rgba(60,40,30,.45);
  border-radius:2px;padding:10px 12px;width:100%;box-sizing:border-box}
#boardCard input[type=text]:focus-visible{outline:2px solid var(--ether);outline-offset:2px}
#boardCard form{display:grid;gap:14px;margin:0}
#boardCard .seg button:focus-visible{outline:2px solid var(--ether);outline-offset:2px}
#boardCard .kb-who-line b{color:#21161f}
#boardCard .kb-fine{font-size:13px;color:#6c5a5f;line-height:1.45}
#boardCard .kb-list{list-style:none;margin:0;padding:0;display:grid;align-content:start;border-top:1px solid rgba(60,40,30,.25)}
#boardCard .kb-list.rows{max-height:min(46vh,430px);overflow:auto;overscroll-behavior:contain}
#boardCard .kb-list.mine{border-top:0}
#boardCard .kb-list.mine:empty{display:none}
#boardCard .savenote{font-size:14.5px;color:#6c3f5f;min-height:1.2em}
#boardCard .savenote:empty{display:none}
#boardCard .kb-row{display:grid;grid-template-columns:2.4em minmax(0,1fr) auto;align-items:center;gap:4px 12px;padding:7px 10px;
  border-bottom:1px solid rgba(60,40,30,.16);color:#3d2f33}
#boardCard .kb-pos{font:600 14px var(--body);color:#6c3f5f;text-align:right;font-variant-numeric:tabular-nums}
#boardCard .kb-name{min-width:0}
#boardCard .kb-name b{display:block;font:600 16px var(--body);color:#21161f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#boardCard .kb-name small{display:block;font-size:12.5px;color:#6c5a5f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#boardCard .kb-val{font:600 16px var(--body);color:#21161f;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
#boardCard .kb-row.me{background:rgba(145,80,255,.13);box-shadow:inset 3px 0 0 #4b3863}
#boardCard .kb-gap{padding:2px 10px;color:#8a7a86;text-align:center;letter-spacing:.3em}
#boardCard .kb-empty{padding:14px 10px;color:#6c5a5f;font-style:italic;font-family:var(--serif);font-size:17px}
#boardCard .kb-code{font:600 22px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;color:#21161f;user-select:all;-webkit-user-select:all}
.bq-links button[data-board-link]{font:600 12.5px var(--body);letter-spacing:.12em;text-transform:uppercase;background:none;border:0;
  border-bottom:1px dashed rgba(108,63,95,.6);color:#6c3f5f;padding:2px 0;cursor:pointer}
.bq-links button[data-board-link]:focus-visible{outline:2px solid var(--ether);outline-offset:3px}
#title .bq-links button[data-board-link]{color:#cbbfd6;border-bottom-color:rgba(203,191,214,.5)}
@media (max-width:520px){
  #boardCard .sheet{padding:22px 16px 20px}
  #boardCard .seg{gap:5px} #boardCard .seg button{padding:6px 9px;font-size:13px}
  #boardCard .kb-row{padding:7px 6px;gap:2px 8px;grid-template-columns:2em minmax(0,1fr) auto}
  #boardCard .actions{gap:8px} #boardCard .actions .btn{padding:10px 16px}
}`;

let ui=null;
function buildCard(){
  const card=el('div','card sub bq-card'); card.id='boardCard'; card.hidden=true; card.dataset.padBack='boardBack';
  const sheet=el('div','sheet'); card.appendChild(sheet);
  sheet.appendChild(el('span','eyebrow','Brave Quest · Lighthouse beta'));
  sheet.appendChild(el('h2',null,'Keepers’ Board'));
  const body=el('div','kb-body'); sheet.appendChild(body);
  const sec=()=>{ const s=el('div','kb-body'); body.appendChild(s); return s; };
  const btn=(host,t,ghost,id)=>{ const b=el('button','btn'+(ghost?' ghost':''),t); b.type='button'; if(id)b.id=id; host.appendChild(b); return b; };

  /* join / change name */
  const J=sec(); J.dataset.view='join';
  const jIntro1=el('p'), jIntro2=el('p'), jSync=el('p'), jSent=el('p','kb-fine');
  const form=el('form'); form.noValidate=true; form.setAttribute('autocomplete','off');
  const lbl=el('label',null,'Keeper name'); const input=el('input'); input.type='text'; input.maxLength=16; input.autocomplete='off'; input.spellcheck=false;
  input.setAttribute('autocapitalize','words'); input.placeholder='3 to 16 letters or numbers'; lbl.appendChild(input);
  const jAct=el('div','actions');
  const joinB=el('button','btn','Join the board'); joinB.type='submit'; joinB.id='boardJoin'; jAct.appendChild(joinB);
  const signInB=btn(jAct,'Sign in',false,'boardSignIn');     // accounts on, a guest: a new keeper name needs an account
  const notNow=btn(jAct,'Not now',true,'boardNotNow');
  const leaveB=btn(jAct,'Leave the board',true,'boardLeave');
  form.append(lbl,jAct);
  J.append(jIntro1,jIntro2,jSync,form,jSent);

  /* the boards */
  const B=sec(); B.dataset.view='board';
  const who=el('p','kb-who-line');
  const tabs=el('div','seg'); tabs.setAttribute('role','group'); tabs.setAttribute('aria-label','Board');
  const tabBtn={}; for(const t of TABS){ const b=el('button',null,t.name); b.type='button'; b.dataset.tab=t.id; tabs.appendChild(b); tabBtn[t.id]=b; }
  const bossSeg=el('div','seg'); bossSeg.setAttribute('role','group'); bossSeg.setAttribute('aria-label','Boss');
  const scope=el('div','seg'); scope.setAttribute('role','group'); scope.setAttribute('aria-label','Whose times');
  const allB=el('button',null,'Everyone'); allB.type='button'; const crewB=el('button',null,'Crew'); crewB.type='button'; scope.append(allB,crewB);
  const status=el('p','kb-fine'); status.setAttribute('role','status');
  const list=el('ol','kb-list rows'), meList=el('ol','kb-list mine');   // your own row outside the top 25 stays in view under the scrolling list
  const yours=el('p','kb-fine');
  const fine=el('p','kb-fine','Times are reported by each player’s browser.');
  const bSent=el('p','kb-fine');
  const bAct=el('div','actions');
  const nameB=btn(bAct,'Join the board',false,'boardName'), crewOpen=btn(bAct,'Crew',true,'boardCrew');
  B.append(who,tabs,bossSeg,scope,status,list,meList,yours,fine,bSent,bAct);

  /* crew */
  const C=sec(); C.dataset.view='crew';
  const cIntro=el('p','', 'A crew is a board for you and your friends. Make a code and share it, or enter one a friend gave you; then switch the board to Crew.');
  const cHave=el('p'); const cCode=el('span','kb-code');
  const cForm=el('form'); cForm.noValidate=true;
  const cLbl=el('label',null,'Crew code'); const cInput=el('input'); cInput.type='text'; cInput.maxLength=14; cInput.autocomplete='off'; cInput.spellcheck=false;
  cInput.setAttribute('autocapitalize','characters'); cInput.placeholder='4 to 12 letters or numbers'; cLbl.appendChild(cInput);
  const cAct=el('div','actions');
  const cJoin=el('button','btn','Join crew'); cJoin.type='submit'; cJoin.id='boardCrewJoin'; cAct.appendChild(cJoin);
  const cMake=btn(cAct,'Make a crew',true,'boardCrewMake'), cLeave=btn(cAct,'Leave crew',true,'boardCrewLeave');
  cForm.append(cLbl,cAct);
  C.append(cIntro,cHave,cForm);

  const note=el('p','savenote'); note.setAttribute('role','status'); body.appendChild(note);
  const act=el('div','actions'); const back=btn(act,'Back',true,'boardBack'); body.appendChild(act);
  document.body.appendChild(card);

  let from='title', opener=null, view='board', tab='act1', boss='', crewView=false, editing=false, busy=false, req=0, needAcct=false, stale=false;
  const V={join:J,board:B,crew:C};
  const sentText=()=>dnt()
    ?(joined()?'Your browser asks sites not to track it. You joined the board, so your times are sent with your name; leave the board to stop that.'
      :'Your browser asks sites not to track it, so nothing is sent from this device unless you join the board.')
    :(joined()?'Your times, deaths, completion, badge count and rank are sent with your name.'
      :signedIn()?'Signed in, your times are kept with your account, without a name unless you join; unnamed times are never shown on the board.'
      :'With sync on, your times are sent without a name unless you join; unnamed times are never shown on the board.');
  function focus(x){ if(!x||x.hidden||x.disabled)return; try{ x.focus({preventScroll:false}); }catch(_){} }
  function show(v,keepNote){
    view=v; for(const k in V)V[k].hidden=k!==v; card.scrollTop=0;
    if(!keepNote)note.textContent='';
    card.dataset.padBack=v==='join'&&!editing?'boardNotNow':'boardBack';
    render();
  }
  function render(){
    const c=owner(), s=mine(), inAcct=signedIn(), on=inAcct||syncAvailable();
    const guestAcc=accountsOn()&&!inAcct, ask=guestAcc&&(!s.name||needAcct);     // a guest who would need an account for a new name
    back.hidden=view==='join'&&!editing;
    if(view==='join'){
      jIntro1.textContent='The Keepers’ Board lists the beta’s fastest and most thorough keepers: Act 1 and full-game times, boss fights, fewest deaths, most complete.';
      jIntro2.textContent=inAcct?'Pick a keeper name to appear on it. It’s your account’s keeper name: the same one is on your account card, on every device you sign in on.'
        :ask?(s.name?'A new keeper name needs an account. Sign in, or make an account with just your email address, to choose another. You can keep the name you have.'
          :'A keeper name needs an account. Sign in, or make an account with just your email address, and pick your name. You can still look at the board as a guest.')
        :'Pick a keeper name to appear on it. The name belongs to your sync code: the code is your password, the name is yours while you keep it.';
      jSync.hidden=!!c||guestAcc; jSync.textContent=on?'The board needs sync turned on, so your times have a save to belong to. Joining turns it on.'
        :'Sync isn’t available in this browser, so you can look at the board but not join it.';
      joinB.textContent=editing?'Save name':c?'Join the board':'Turn on sync and join';
      joinB.hidden=!on&&!c||guestAcc&&!s.name; lbl.hidden=joinB.hidden;
      signInB.hidden=!ask;
      notNow.hidden=editing; leaveB.hidden=!editing||!s.name;
      jSent.textContent=sentText();
    }else if(view==='board'){
      who.innerHTML='';
      if(s.name&&c){ who.append('You’re on the board as '); who.appendChild(el('b',null,s.name)); who.append(s.crew?' in crew '+s.crew+'.':'.'); }
      else who.textContent=guestAcc?'You’re not on the board: a keeper name needs an account. Your own times are shown under each list.'
        :c?'You’re not on the board. Your own times are shown under each list.':'Sync is off on this device, so you’re not on the board. Your own times are shown under each list.';
      nameB.textContent=s.name&&c?'Change name':'Join the board';
      nameB.hidden=!c&&!on;
      crewOpen.hidden=!c;
      crewOpen.textContent=s.crew?'Crew '+s.crew:'Crew';
      for(const t of TABS)tabBtn[t.id].setAttribute('aria-pressed',String(t.id===tab));
      const bs=beaten();
      bossSeg.innerHTML=''; bossSeg.hidden=tab!=='boss'||!bs.length;
      if(tab==='boss'){ if(!bs.some(x=>x.id===boss))boss=bs.length?bs[0].id:'';
        for(const x of bs){ const b=el('button',null,x.name); b.type='button'; b.dataset.boss=x.id; b.setAttribute('aria-pressed',String(x.id===boss));
          b.addEventListener('click',()=>{ boss=x.id; render(); fetchNow(); focus(bossSeg.querySelector('[data-boss="'+x.id+'"]')); }); bossSeg.appendChild(b); } }
      scope.hidden=!s.crew||!c; if(!s.crew)crewView=false;
      allB.setAttribute('aria-pressed',String(!crewView)); crewB.setAttribute('aria-pressed',String(crewView)); crewB.textContent=s.crew?'Crew '+s.crew:'Crew';
      bSent.textContent=sentText();
    }else if(view==='crew'){
      cHave.hidden=!s.crew; cHave.innerHTML=''; if(s.crew){ cHave.append('Your crew: '); cCode.textContent=s.crew; cHave.appendChild(cCode); cHave.append('. Share the code with your friends.'); }
      cLbl.hidden=!!s.crew; cJoin.hidden=!!s.crew; cMake.hidden=!!s.crew; cLeave.hidden=!s.crew;
    }
    for(const x of [joinB,signInB,notNow,leaveB,nameB,crewOpen,cJoin,cMake,cLeave,input,cInput])x.disabled=busy;
  }
  const curBoard=()=>tab==='boss'?(boss?'boss:'+boss:''):tab;
  async function fetchNow(){
    const b=curBoard(), n=++req; list.innerHTML=''; meList.innerHTML=''; list.scrollTop=0; yours.textContent='';
    if(!b){ status.textContent=''; const li=el('li','kb-empty','Beat a boss and its board opens here. Bosses you haven’t met stay a surprise.'); list.appendChild(li); return; }
    const crew=crewView&&mine().crew?mine().crew:'';
    status.textContent='Fetching the board…';
    const r=await board(b,crew);
    if(n!==req||view!=='board'||card.hidden)return;
    status.textContent='';
    if(!r.ok){
      list.appendChild(el('li','kb-empty',r.status===429?'The board is busy. Try again in a minute.':r.status===0?'Couldn’t reach the board just now. Your game is fine; try again in a minute.':'The board isn’t available just now. Try again in a minute.'));
      ownLine(b,null); return; }
    const d=r.data||{}, rows=Array.isArray(d.rows)?d.rows:[], you=d.you||null, me=(mine().name||'').toLowerCase();
    if(!rows.length)list.appendChild(el('li','kb-empty',crew?'No keepers in this crew yet.':'No keepers here yet.'));
    let shownMe=false;
    const row=(x,isMe)=>{ const li=el('li','kb-row'+(isMe?' me':'')); if(isMe)li.setAttribute('aria-current','true');
      li.appendChild(el('span','kb-pos',x.pos!=null?String(x.pos):'–'));
      const nm=el('span','kb-name'); nm.appendChild(el('b',null,String(x.name||'You')));
      const bits=[rankName(x.rank|0), x.badges!=null?(x.badges|0)+((x.badges|0)===1?' badge':' badges'):''].filter(Boolean).join(' · ');
      if(bits)nm.appendChild(el('small',null,bits)); li.appendChild(nm);
      li.appendChild(el('span','kb-val',valueText(b,x.value))); return li; };
    for(const x of rows){ const isMe=!!(you&&you.pos!=null&&x.pos===you.pos)||(!!me&&String(x.name||'').toLowerCase()===me); if(isMe)shownMe=true; list.appendChild(row(x,isMe)); }
    if(you&&you.pos!=null&&!shownMe){
      let rk=0, bc=null; try{ if(G.badges){ rk=G.badges.rank().i; bc=G.badges.count(); } }catch(_){}
      meList.appendChild(el('li','kb-gap','· · ·'));
      meList.appendChild(row({pos:you.pos,name:mine().name||'You',value:you.value,rank:rk,badges:bc},true));
    }
    ownLine(b,you);
  }
  function ownLine(b,you){
    if(you&&you.pos!=null){ yours.textContent=''; return; }
    const v=you&&you.value!=null?you.value:localValue(b);
    if(v==null){ yours.textContent=b==='deaths'?'This board counts finished full games only.':''; return; }
    yours.textContent='Yours: '+valueText(b,v)+(joined()?(crewView?' (not in this crew’s list)':' (not listed yet)'):' · not on the board'+(owner()||accountsOn()?'':' (sync is off)'));
  }
  function why(w,wait){
    return w==='account_needed'?'A new keeper name needs an account. Sign in to choose one.'
      :w==='test_slot'?'You’re playing a test save, and test saves stay off the board. Change your keeper name on your account card, or play one of your other saves.'
      :w==='no_save'&&signedIn()?'Your save hasn’t reached your account yet. Play a minute or two, then try again.'
      :w==='name_taken'?'That name is taken. Try another.'
      :w==='name_invalid'?'That name isn’t allowed. Use 3 to 16 letters, numbers, spaces, - _ or \', and nothing rude.'
      :w==='crew_invalid'?'A crew code is 4 to 12 letters or numbers.'
      :w==='rate'?'Too many tries in a short time. Wait '+(wait>90?Math.ceil(wait/60)+' minutes':(wait||60)+' seconds')+' and try again.'
      :w==='no_save'?'Your save hasn’t reached the save service yet. Play a minute or two, then try again.'
      :w==='no_code'?'Turn on sync first.'
      :w==='storage'?'This browser is blocking storage, so sync can’t be turned on here.'
      :w==='bad_key'?'The save service didn’t accept this device’s sync code.'
      :'Couldn’t reach the board just now. Check your connection and try again in a minute.';
  }
  async function run(fn){ busy=true; note.textContent='One moment…'; render(); let r; try{ r=await fn(); }catch(_){ r={ok:false,why:'offline'}; } busy=false; render(); if(stale)setTimeout(reload,0); return r; }
  async function ensureCode(){
    if(owner())return {ok:true};             // signed in, or a sync code already
    if(accountsOn())return {ok:false,why:'account_needed'};
    const S=sync(); if(!S||!S.available)return {ok:false,why:'no_code'};
    const r=await S.enable();
    if(r&&r.ok)return {ok:true,turned:true};
    return {ok:false,why:r&&r.why==='storage'?'storage':'offline'};
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault(); if(busy)return;
    const n=cleanName(input.value);
    if(!NAME_RE.test(n)||!/[A-Za-z0-9]/.test(n)){ note.textContent=n.length<3||n.length>16?'A keeper name is 3 to 16 characters.':why('name_invalid'); focus(input); return; }
    if(editing&&n===mine().name){ editing=false; show('board'); fetchNow(); return; }
    const r=await run(async()=>{ const s=await ensureCode(); if(!s.ok)return s; R.fetched=owner(); return change({name:n}); });
    if(r.ok){ const was=editing; editing=false; needAcct=false; dropCache(); show('board',true); note.textContent=(was?'Your name is now ':'Welcome to the board, ')+mine().name+'.'; fetchNow(); focus(tabBtn[tab]); }
    else if(r.why==='swapped'){ reload(); }
    else if(r.why==='account_needed'){ needAcct=true; render(); note.textContent=why(r.why); focus(signInB); }
    else { note.textContent=why(r.why,r.wait); focus(input); }
  });
  notNow.addEventListener('click',()=>{ st.asked=1; save(); needAcct=false; show('board'); fetchNow(); focus(tabBtn[tab]); });
  /* the account card opens over this one and comes back to it; signing in there refreshes this card (reload) */
  signInB.addEventListener('click',()=>{ const A=acct(); if(busy||!A||!A.open)return; st.asked=1; save(); stale=true; A.open('boardCard',signInB); });
  leaveB.addEventListener('click',async()=>{
    const r=await run(()=>change({name:''}));
    if(r.ok){ editing=false; dropCache(); show('board',true); note.textContent='You’ve left the board. Your times are still kept in your save.'; fetchNow(); focus(nameB); }
    else note.textContent=why(r.why,r.wait);
  });
  for(const t of TABS)tabBtn[t.id].addEventListener('click',()=>{ tab=t.id; note.textContent=''; render(); fetchNow(); });
  allB.addEventListener('click',()=>{ crewView=false; render(); fetchNow(); });
  crewB.addEventListener('click',()=>{ crewView=true; render(); fetchNow(); });
  nameB.addEventListener('click',()=>{ editing=!!mine().name&&!!owner(); needAcct=false; input.value=mine().name||''; show('join');
    focus(!signInB.hidden&&joinB.hidden?signInB:G.isMobile?joinB:input); });
  crewOpen.addEventListener('click',()=>{ cInput.value=''; show('crew'); focus(mine().crew?cLeave:(G.isMobile?cMake:cInput)); });
  async function setCrew(c,made){
    const r=await run(()=>change({crew:c}));
    if(r.ok){ dropCache(); if(c){ crewView=true; show('board',true); note.textContent=(made?'Crew '+c+' made. Share the code with your friends.':'You’ve joined crew '+c+'.'); fetchNow(); focus(crewB); }
      else { crewView=false; show('crew',true); note.textContent='You’ve left the crew.'; focus(cMake); } }
    else note.textContent=why(r.why,r.wait);
  }
  cForm.addEventListener('submit',e=>{ e.preventDefault(); if(busy)return; const c=cleanCrew(cInput.value);
    if(c.length<4||c.length>12){ note.textContent=why('crew_invalid'); focus(cInput); return; } setCrew(c,false); });
  cMake.addEventListener('click',()=>{ if(busy)return; const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ', a=new Uint8Array(6); try{ crypto.getRandomValues(a); }catch(_){ for(let i=0;i<6;i++)a[i]=Math.random()*256; }
    let c=''; for(const x of a)c+=A[x&31]; setCrew(c,true); });
  cLeave.addEventListener('click',()=>{ if(!busy)setCrew('',false); });
  back.addEventListener('click',()=>{ if(view!=='board'){ editing=false; show('board'); fetchNow(); focus(tabBtn[tab]); return; } close(); });
  document.addEventListener('keydown',e=>{ if(!card.hidden&&e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); (back.hidden?notNow:back).click(); } },true);
  G.on('mode',e=>{ if(e&&e.mode==='play'&&!card.hidden){ card.hidden=true; } });   // the game resumed underneath (a key the pause menu answers): just go

  function close(){ card.hidden=true; stale=false; const f=$(from); if(f&&(from!=='pause'||G.state.mode==='paused'))f.hidden=false; if(opener)focus(opener); }
  async function open(f,b){
    from=f||'title'; opener=b||null; editing=false; busy=false; needAcct=false; stale=false;
    const fc=$(from); if(fc)fc.hidden=true; card.hidden=false;
    const first=!st.asked||mine().code!==owner();
    if(owner()&&R.fetched!==owner()){ note.textContent='One moment…'; for(const k in V)V[k].hidden=true; back.hidden=false;
      await fetchMine(); if(card.hidden)return; note.textContent=''; }
    if(!mine().name&&!st.asked&&first){ input.value=''; show('join'); focus(!signInB.hidden&&joinB.hidden?signInB:G.isMobile?joinB:input); }
    else { show('board'); fetchNow(); focus(tabBtn[tab]); }
  }
  /* signed in or out (or the keeper name changed on the account card): read the name again, then show what is true now.
     While the card is hidden (the account card is over it) this waits until it shows again. */
  let reloading=false;
  async function reload(){
    if(card.hidden){ stale=true; return; }
    if(busy||reloading){ stale=true; return; }
    reloading=true; stale=false;
    try{
      if(owner()&&R.fetched!==owner()){ await fetchMine(); if(card.hidden){ stale=true; return; } }
      const s=mine();
      if(signedIn()||s.name)needAcct=false;
      if(view==='join'){
        if(editing&&!s.name)editing=false;
        input.value=editing?s.name:(signedIn()?input.value:'');
        if(!editing&&joined()){ show('board',true); fetchNow(); return; }
        show('join',true); return;
      }
      if(view==='crew'){ render(); return; }
      render(); fetchNow();
    }finally{ reloading=false; if(stale&&!card.hidden)setTimeout(reload,0); }
  }
  try{ new MutationObserver(()=>{ if(!card.hidden&&stale)reload(); }).observe(card,{attributes:true,attributeFilter:['hidden']}); }catch(_){}
  return {open,close,reload,get view(){ return card.hidden?'':view; }, get tab(){ return tab; }, get boss(){ return boss; }, get crewView(){ return crewView; },
    tabTo(t,b){ tab=t; if(b)boss=b; if(view!=='board')show('board'); else render(); return fetchNow(); }};
}
function dropCache(){ for(const k in cache)delete cache[k]; }

/* ---- the button in beta.js's link row (title and pause cards) ---- */
function place(){
  if(quiet())return;
  for(const [sel,from] of [['#title .title-sheet','title'],['#pause .sheet','pause']]){
    const host=document.querySelector(sel); if(!host)continue;
    let row=host.querySelector(':scope > .bq-links'); if(!row){ row=el('div','bq-links'); host.appendChild(row); }
    let b=row.querySelector('[data-board-link]');
    if(!b){ b=el('button',null,'Keepers’ Board'); b.type='button'; b.dataset.boardLink=from; const me=b; b.addEventListener('click',()=>open(from,me)); }
    const btns=[...row.querySelectorAll(':scope > button:not([data-board-link])')], fb=btns.find(x=>/feedback/i.test(x.textContent)), ver=row.querySelector(':scope > .bq-ver');
    if(fb){ if(fb.nextElementSibling!==b)fb.after(b); }                  // placed (again) after beta.js's buttons, whichever ran first
    else if(ver)row.insertBefore(b,ver); else if(!b.parentNode)row.appendChild(b);
  }
}
function open(from,btn){ if(quiet())return; if(!ui)ui=buildCard(); return ui.open(from,btn); }
function close(){ if(ui&&ui.view)ui.close(); }

document.head.appendChild(css);
if(!quiet())wire();
const later=()=>setTimeout(place,0);            // after every DOMContentLoaded handler, so beta.js's row (if any) is there
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',later); else later();
G.on('ready',place); window.addEventListener('load',place);

G.board={
  open, close, push:()=>push({now:false}),
  get state(){ const s=mine(); return {enabled:!quiet(),name:s.name,crew:s.crew,asked:!!s.asked,joined:joined(),code:!!code(),dnt:dnt(),
    signedIn:signedIn(),needsAccount:needsAccount(),testSlot:testSlot(),
    view:ui?ui.view:'',tab:ui?ui.tab:'',boss:ui?ui.boss:'',crewView:ui?ui.crewView:false,
    uploads:R.uploads,dirty:R.dirty,waitSave:R.waitSave,blocked:Math.max(0,R.blockedUntil-Date.now()),bad:R.bad,last:R.last?Object.assign({},R.last):null,log:R.log.slice(-6),timer:!!R.timer,sinceTry:R.lastTry?Date.now()-R.lastTry:null}; },
  debug:{
    gap(ms){ if(ms!=null)GAP=Math.max(0,+ms||0); return GAP; },
    cache(ms){ if(ms!=null)CACHE=Math.max(0,+ms||0); return CACHE; },
    payload, beaten, dropCache, canUpload, get log(){ return R.log.slice(); }, get timer(){ return !!R.timer; },
    tab:(t,b)=>ui?ui.tabTo(t,b):null,
    reset(){ clearTimeout(R.timer); Object.assign(R,{gen:0,idGen:R.idGen+1,log:[],busy:null,dirty:false,lastTry:0,blockedUntil:0,waitSave:false,timer:0,sessionSent:false,bad:false,uploads:0,last:null,fetched:''});
      st={code:'',name:'',crew:'',asked:0}; try{ localStorage.removeItem(LS); }catch(_){} dropCache(); return true; }
  }
};
})();
