/* =========================================================================
   slots.js — save slots for a signed-in keeper. Spec: ACCOUNTS.md (section 6b).
   Runs only when accounts are on (G.account.on) and the player is signed in. Signed out, or with accounts off,
   every hook here answers "not mine" and the game saves exactly as before: one local save ('bq-save-v1'),
   the optional sync code and automatic backup (cloud.js).

   - Signed in, the title's Continue opens the slot list (ten slots; each used one shows its name, objective,
     rank · time played · completion from the save's `rec`, when it was last played and a "Test" label).
     New game takes the first empty slot (at ten it says so and offers to delete one). Rename; delete (asks first).
   - The slot being played is remembered per account (localStorage 'bq-slot' = {<account id>: n}). Every slot is
     also kept on this device ('bq-save-s<n>-<account id>', with its list details in 'bq-slots-<account id>'),
     so play carries on offline. Save and autosave write the active slot here, then upload it
     (PUT /v1/saves/<n>, through G.account.fetch) with cloud.js's throttle: at most one every 20 s, right away
     when the tab is hidden, one quiet retry, and again when the browser comes back online.
   - Newer wins by the save's `at`, as for guests: the server answers 409 {error:'stale', at}. When this device
     holds progress it has not sent and the account's copy is newer, the player chooses which to keep
     ("This device" / "Your account"); nothing is replaced without asking.
   - First sign-in on a device with a guest save: "Bring this save into your account" (once per account per
     device). With a sync code: POST /v1/saves/claim {code}, then the code is forgotten here and guest sync stops;
     with none: the save is uploaded into the first free slot. Either way the guest save moves into the account.
     Declining leaves it alone: it is what Continue shows again when signed out.
   - Test tools while signed in on a normal slot: the session moves to the first free slot as a copy marked
     test (the original is left as it was); with no free slot, to the old local test slot ('bq-save-test-v1'),
     said in a toast. A test slot uploads with test:true, and continuing one is a test session (G.testSaves).
   - Signing out or an ended session while a slot is being played: the slot is saved on this device (it uploads
     the next time this account signs in here) and the page returns to the title, where Continue is the guest
     save again. Signing in during a guest game leaves that game a guest game until it is quit.
   API: G.slots = { on, list(), active() -> {slot,test,name}|null, open(from), close(), use(slot), newGame(),
                    rename(slot,name), remove(slot), flush(), debug }
        hooks for flow.js / cloud.js / record.js / badges.js: saveKey(), readKey(), owner(), title(), intercept(kind), beginning()
   Events: 'slots:change' {}   'slots:active' {slot, test}
   ========================================================================= */
(function(){
'use strict';
const G=window.G; if(!G)return;
const ON=!!(G.account&&G.account.on);
const MAX=10, LIMIT=240*1024, NAME_MAX=24;
let GAP=20000;                                         // ms between uploads of the slot being played (cloud.js's guest throttle)
const TEST_KEY='bq-save-test-v1', ACTIVE='bq-slot', CLAIM='bq-claim', NOTE='bq-slots-note';
const lsGet=k=>{ try{ return localStorage.getItem(k); }catch(_){ return null; } };
const lsSet=(k,v)=>{ try{ if(v==null)localStorage.removeItem(k); else localStorage.setItem(k,v); return true; }catch(_){ return false; } };
const jget=k=>{ try{ const v=JSON.parse(lsGet(k)||'null'); return v&&typeof v==='object'?v:{}; }catch(_){ return {}; } };
const parse=s=>{ try{ const d=JSON.parse(s); return d&&d.v===1?d:null; }catch(_){ return null; } };
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; };
const emit=(n,d)=>{ try{ G.emit(n,d||{}); }catch(e){ console.error(n,e); } };
const LOG=[];

/* ---- who, and where things are kept ---- */
function acct(){ const A=G.account; return A&&A.state==='in'&&A.me&&A.me.id?String(A.me.id):''; }
const cacheKey=(id,n)=>'bq-save-s'+n+'-'+id;
const metaKey=id=>'bq-slots-'+id;
const MS={};
function metaOf(id){ if(!MS[id]){ const m=jget(metaKey(id)); MS[id]=m.s&&typeof m.s==='object'?m:{s:{}}; } return MS[id]; }
function slotMeta(id,n){ const M=metaOf(id); const m=M.s[n]||(M.s[n]={name:'',test:false,srv:null,sent:0,pend:''}); return m; }
function saveMeta(id){ lsSet(metaKey(id),JSON.stringify(metaOf(id))); }
function clearSlot(id,n){ lsSet(cacheKey(id,n),null); delete metaOf(id).s[n]; saveMeta(id); }
function activeSlot(id){ const a=jget(ACTIVE)[id]; return a>=1&&a<=MAX?a|0:0; }
function setActive(id,n){ const a=jget(ACTIVE); if(n)a[id]=n; else delete a[id]; lsSet(ACTIVE,JSON.stringify(a)); }

/* one slot as the list shows it: the device's copy and the account's, whichever is newer */
function view(id,n){
  const m=slotMeta(id,n), d=parse(lsGet(cacheKey(id,n))), s=m.srv;
  const la=d?+d.at||0:0, sa=s?+s.at||0:0;
  const unsent=!!d&&la>(m.sent||0);
  const cur=d&&la>=sa?{at:la,objective:d.objective||'',rec:d.rec||null,sv:d}:s?{at:sa,objective:s.objective||'',rec:s.rec||null,sv:{rec:s.rec||{}}}:null;
  return {slot:n, used:!!(d||s), name:m.pend||m.name||('Save '+n), test:!!m.test, at:cur?cur.at:0, objective:cur?cur.objective:'', rec:cur?cur.rec:null,
    local:!!d, remote:!!s, unsent, conflict:unsent&&sa>la, newer:!!s&&sa>la&&!unsent, active:activeSlot(id)===n, sv:cur?cur.sv:null, la, sa, big:!!m.big};
}
const views=id=>{ const a=[]; for(let n=1;n<=MAX;n++)a.push(view(id,n)); return a; };
function firstFree(id,except){ for(let n=1;n<=MAX;n++){ if(n===except)continue; if(sess&&sess.acct===id&&sess.slot===n)continue; if(!view(id,n).used)return n; } return 0; }

/* ---- the session: which slot this page's game saves into ---- */
let sess=null;          // {acct, slot, test, local, read} — local: the old local test slot (no free slot for a test copy)
let guestRun=false;     // this page's game began as a guest game: it stays one
function setSess(s){
  sess=s; if(s.slot)setActive(s.acct,s.slot);
  if(s.test&&!G.testSaves)G.testSaves=true;            // continuing a test slot is a test session (no board, no pings)
  emit('slots:active',{slot:s.slot,test:!!s.test});
}
function saveKey(){ if(!sess)return null; return sess.local?TEST_KEY:cacheKey(sess.acct,sess.slot); }
function readKey(){ return sess?(sess.read||saveKey()):null; }
function active(){ if(!sess)return null; return {slot:sess.slot,test:!!sess.test,name:sess.slot?view(sess.acct,sess.slot).name:''}; }
const target=()=>sess&&!sess.local&&sess.slot&&sess.acct===acct()?sess.slot:0;

function toast(a,b){ try{ if(G.ui&&G.ui.toast)G.ui.toast(a,b); }catch(_){} }
function localTest(id,read){
  sess={acct:id,slot:0,test:true,local:true,read:read||null};
  emit('slots:active',{slot:0,test:true});
  setTimeout(()=>toast('No free save slot for a test copy','Test progress stays on this device only'),900);
}
/* the test tools on a normal slot: carry on in a copy marked test in the first free slot */
function testCopy(id,n){
  const free=firstFree(id,n);
  if(!free){ localTest(id,cacheKey(id,n)); return; }
  const from=slotMeta(id,n), raw=lsGet(cacheKey(id,n)), m=slotMeta(id,free);
  Object.assign(m,{name:(from.pend||from.name||('Save '+n)).slice(0,NAME_MAX-7)+' (test)',test:true,srv:null,sent:0,pend:'',big:false});
  lsSet(cacheKey(id,free),raw); saveMeta(id);
  setSess({acct:id,slot:free,test:true});
  emit('slots:change'); schedule();
}
/* a test start point while signed in: the last test slot played, else the first free one */
function freshTest(id){
  const a=activeSlot(id);
  if(a&&view(id,a).test){ setSess({acct:id,slot:a,test:true}); return; }
  const n=firstFree(id); if(!n){ localTest(id); return; }
  Object.assign(slotMeta(id,n),{name:'',test:true,srv:null,sent:0,pend:'',big:false}); lsSet(cacheKey(id,n),null); saveMeta(id);
  setSess({acct:id,slot:n,test:true}); emit('slots:change');
}
function ensureTest(){
  if(!sess||sess.local||sess.test)return;
  testCopy(sess.acct,sess.slot);
}
/* flow.js's begin(): decide where this game saves */
function beginning(){
  if(!ON)return;
  if(sess){ if(G.testSaves)ensureTest(); return; }
  if(guestRun)return;
  const id=acct();
  if(!id){ guestRun=true; return; }
  if(G.testSaves){ freshTest(id); return; }
  const n=firstFree(id);                                   // begun some other way while signed in: a new slot
  if(n){ Object.assign(slotMeta(id,n),{name:'',test:false,srv:null,sent:0,pend:'',big:false}); lsSet(cacheKey(id,n),null); saveMeta(id); setSess({acct:id,slot:n,test:false}); }
  else localTest(id);
}
/* the test tools set G.testSaves (devtools.js); watch it so a signed-in session moves to a test copy at once */
if(ON){
  let flag=!!G.testSaves;
  Object.defineProperty(G,'testSaves',{configurable:true,enumerable:true,get(){ return flag; },
    set(v){ const was=flag; flag=!!v; if(flag&&!was&&G.state&&G.state.mode!=='title'&&acct())ensureTest(); }});
}

/* ---- talking to the service ---- */
async function call(method,path,body,o){
  let r;
  try{ r=await G.account.fetch(path,Object.assign({method,body},o||{})); }
  catch(_){ LOG.push({m:method,p:path,status:0}); return {ok:false,status:0,error:'offline',data:null}; }
  let d=null; try{ d=await r.json(); }catch(_){}
  LOG.push({m:method,p:path,status:r.status,error:d&&d.error||''}); if(LOG.length>80)LOG.shift();
  return {ok:r.ok,status:r.status,error:(d&&d.error)||(r.ok?'':'http_'+r.status),data:d};
}
const offline=r=>r.status===0||r.status>=500||r.status===429;
let reached=true;     // the last list read answered
async function refresh(){
  const id=acct(); if(!id)return false;
  const r=await call('GET','/v1/saves');
  if(acct()!==id)return false;
  if(!r.ok||!r.data||!Array.isArray(r.data.slots)){ reached=false; emit('slots:change'); return false; }
  reached=true;
  const seen=new Set();
  for(const s of r.data.slots){
    const n=s&&s.slot|0; if(n<1||n>MAX)continue; seen.add(n);
    const m=slotMeta(id,n);
    m.srv={at:+s.at||0,objective:String(s.objective||''),rec:s.rec||null,updated:s.updated||0};
    if(!m.pend)m.name=String(s.name||'');
    m.test=!!s.test||(!!m.test&&!m.sent);                      // the account's flag (sticky there); a test copy not sent yet stays test
  }
  for(let n=1;n<=MAX;n++){
    if(seen.has(n))continue;
    const m=metaOf(id).s[n]; if(!m)continue;
    const d=parse(lsGet(cacheKey(id,n)));
    const gone=!!m.srv||m.sent>0;                              // it was in the account and isn't now: deleted elsewhere
    m.srv=null;
    if(gone&&(!d||d.at<=m.sent)&&!(sess&&sess.acct===id&&sess.slot===n))clearSlot(id,n);
    else if(gone){ m.sent=0; }
  }
  saveMeta(id); emit('slots:change');
  sendWaiting(id);
  return true;
}
/* anything this device holds that the account hasn't got yet (played offline, signed out before it went) */
function sendWaiting(id){
  for(let n=1;n<=MAX;n++){ const v=view(id,n); if(v.unsent&&!v.conflict&&!v.big&&n!==target())queue.add(n); }
  pump();
}
const queue=new Set();
async function pump(){ for(const n of [...queue]){ if(U.busy)return; queue.delete(n); await put(n); } }

/* uploads: one at a time, the slot being played at most every GAP ms (as cloud.js does for guests) */
const U={busy:false,dirty:false,lastPut:0,timer:0,retried:false,inflight:null,conflictSaid:{}};
async function put(n){
  const id=acct(); n=n||target(); if(!id||!n)return;
  if(U.busy){ if(n===target())U.dirty=true; else queue.add(n); return; }
  const m=slotMeta(id,n), raw=lsGet(cacheKey(id,n)), d=parse(raw);
  if(!d||d.at<=(m.sent||0))return;
  const v=view(id,n); if(v.conflict)return;                  // waits for the player's choice
  if(raw.length>LIMIT){ m.big=true; saveMeta(id); return; } // too big to send: it stays on this device
  U.busy=true; if(n===target()){ U.dirty=false; clearTimeout(U.timer); U.timer=0; } U.lastPut=Date.now();
  const rec=d.rec&&typeof d.rec==='object'?{play:d.rec.play,pct:d.rec.pct,rank:d.rec.rank,ri:d.rec.ri}:null;
  const body={v:1,at:d.at,objective:String(d.objective||'').slice(0,120),save:raw,rec};
  const nm=m.pend||m.name; if(nm)body.name=nm.slice(0,NAME_MAX); if(m.test)body.test=true;
  let r;
  try{ r=await (U.inflight=call('PUT','/v1/saves/'+n,body,document.hidden&&raw.length<60000?{keepalive:true}:null)); }
  finally{ U.busy=false; U.inflight=null; }
  if(acct()===id){
    if(r.ok){ m.sent=d.at; m.srv={at:d.at,objective:body.objective,rec,updated:Date.now()}; if(m.pend){ m.name=m.pend; m.pend=''; }
      if(r.data&&r.data.test)m.test=true; saveMeta(id); emit('slots:saved',{slot:n,at:d.at}); emit('slots:change'); }
    else if(r.status===409&&r.error==='stale'){
      const at=+(r.data&&r.data.at)||0; m.srv=Object.assign({objective:'',rec:null},m.srv||{},{at}); if(at===d.at)m.sent=d.at;
      saveMeta(id); emit('slots:change');
      if(at>d.at&&n===target()&&!U.conflictSaid[n]){ U.conflictSaid[n]=1; toast('Newer progress in your account','You’ll choose which to keep when you next open this save'); }
    }
    else if(offline(r)){ if(!U.retried){ U.retried=true; setTimeout(()=>{ U.retried=false; put(n); },1500+Math.random()*1500); } }
    else if(r.status===400||r.status===413){ m.big=true; saveMeta(id); }
  }
  if(U.dirty)schedule();
  if(queue.size)pump();
}
function schedule(){
  if(!target()||U.timer)return;
  if(U.busy){ U.dirty=true; return; }
  const ms=Math.max(0,GAP-(Date.now()-U.lastPut));
  U.timer=setTimeout(()=>{ U.timer=0; put(); },ms);
}
async function flush(){
  if(!target())return;
  clearTimeout(U.timer); U.timer=0;
  if(U.busy&&U.inflight){ try{ await U.inflight; }catch(_){} clearTimeout(U.timer); U.timer=0; }
  return put();
}
async function download(id,n){
  const r=await call('GET','/v1/saves/'+n);
  if(!r.ok||!r.data)return false;
  const raw=typeof r.data.body==='string'?r.data.body:typeof r.data.save==='string'?r.data.save:'';
  const d=parse(raw); if(!d)return false;
  if(!lsSet(cacheKey(id,n),raw))return false;
  const m=slotMeta(id,n); m.sent=d.at; m.srv={at:d.at,objective:String(r.data.objective||d.objective||''),rec:r.data.rec||null,updated:r.data.updated||0};
  if(!m.pend&&r.data.name)m.name=String(r.data.name); if(r.data.test)m.test=true;
  saveMeta(id); emit('slots:change'); return true;
}

/* ---- the words ---- */
function ago(t){ if(!t)return ''; const m=Math.round((Date.now()-t)/60000); return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' d ago'; }
function when(t){ if(!t)return ''; const d=new Date(t); let s=''; try{ s=d.toLocaleString(undefined,{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}); }catch(_){ s=d.toString(); } return s+' ('+ago(t)+')'; }
const recHTML=sv=>{ try{ return G.flow&&G.flow.saveRecord&&sv?G.flow.saveRecord(sv):[]; }catch(_){ return []; } };
const cleanName=t=>String(t||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().replace(/\s+/g,' ').slice(0,NAME_MAX);

/* ---- styles ---- */
const STYLE=`
#slotsCard{z-index:7;align-items:flex-start}
#slotsCard .sheet{gap:14px;margin-block:auto;max-width:600px}
#slotsCard [hidden]{display:none!important}
#slotsCard .sl-view{display:grid;gap:14px}
#slotsCard p{font-size:16.5px}
#slotsCard .sl-fine{font-size:13.5px;color:#6c5a5f;line-height:1.45}
#slotsCard .sl-list{list-style:none;margin:0;padding:0;display:grid;border-top:1px solid rgba(60,40,30,.25);max-height:min(52vh,470px);overflow:auto;overscroll-behavior:contain}
#slotsCard .sl-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 10px;padding:8px 6px 8px 0;border-bottom:1px solid rgba(60,40,30,.16)}
#slotsCard .sl-row.cur{background:rgba(145,80,255,.11);box-shadow:inset 3px 0 0 #4b3863}
#slotsCard .sl-main{display:grid;grid-template-columns:2em minmax(0,1fr);gap:1px 10px;text-align:left;background:none;border:0;padding:4px 6px;margin:0;cursor:pointer;color:#3d2f33;font:inherit;border-radius:2px;min-width:0}
#slotsCard .sl-main:hover{background:rgba(75,56,99,.07)}
#slotsCard .sl-main:focus-visible,#slotsCard .sl-tool:focus-visible,#slotsCard .sl-choice:focus-visible{outline:2px solid var(--ether);outline-offset:1px}
#slotsCard .sl-num{grid-row:1 / span 4;font:400 24px/1.1 var(--display);color:#6c3f5f;text-align:center;font-variant-numeric:tabular-nums;padding-top:2px}
#slotsCard .sl-name{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
#slotsCard .sl-name b{font:600 17px var(--body);color:#21161f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
#slotsCard .sl-tag{font:700 10px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;padding:4px 7px 3px;border-radius:9px;white-space:nowrap}
#slotsCard .sl-tag.test{background:#8f2f45;color:#f6eedd}
#slotsCard .sl-tag.last{background:rgba(75,56,99,.16);color:#4b3863}
#slotsCard .sl-obj{font-size:15px;color:#3d2f33;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#slotsCard .sl-rec{display:flex;flex-wrap:wrap;gap:0 10px;font:600 13px var(--body);color:#4b3863;font-variant-numeric:tabular-nums}
#slotsCard .sl-rec span+span::before{content:"·";margin-right:10px;color:#9c90a8}
#slotsCard .sl-rec .sr-rank{font:400 15px var(--display);color:#4b3863}
#slotsCard .sl-when{font-size:12.5px;color:#6c5a5f}
#slotsCard .sl-when i{font-style:normal;color:#8f2f45}
#slotsCard .sl-tools{display:flex;gap:6px}
#slotsCard .sl-tool{font:600 13px var(--body);letter-spacing:.02em;background:none;border:1px solid rgba(60,40,30,.35);color:#4b3863;padding:6px 10px;border-radius:2px;cursor:pointer}
#slotsCard .sl-tool.del{color:#8f2f45;border-color:rgba(143,47,69,.45)}
#slotsCard .sl-row.empty{padding:2px 6px 2px 0}
#slotsCard .sl-row.empty .sl-main{grid-template-columns:2em minmax(0,1fr);align-items:center;padding:6px}
#slotsCard .sl-row.empty .sl-num{grid-row:auto;font-size:18px;color:#9a8a90}
#slotsCard .sl-row.empty .sl-obj{font-style:italic;font-family:var(--serif);color:#6c5a5f;font-size:16px}
#slotsCard label{font:600 13px var(--body);letter-spacing:.06em;color:#6c3f5f;display:grid;gap:6px}
#slotsCard input[type=text]{font:400 17px var(--body);color:#21161f;background:rgba(255,252,244,.75);border:1px solid rgba(60,40,30,.45);
  border-radius:2px;padding:10px 12px;width:100%;box-sizing:border-box;-webkit-user-select:text;user-select:text}
#slotsCard input[type=text]:focus-visible{outline:2px solid var(--ether);outline-offset:2px}
#slotsCard form{display:grid;gap:14px;margin:0}
#slotsCard .sl-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
#slotsCard .sl-choice{display:grid;gap:4px;text-align:left;font:inherit;color:#3d2f33;background:rgba(255,252,244,.5);border:1px solid rgba(60,40,30,.4);border-radius:2px;padding:12px 14px;cursor:pointer;min-width:0}
#slotsCard .sl-choice:hover{border-color:#4b3863}
#slotsCard .sl-choice b{font:600 17px var(--body);color:#21161f}
#slotsCard .sl-choice span{font-size:15px;overflow-wrap:anywhere}
#slotsCard .sl-choice small{font-size:13px;color:#6c5a5f}
#slotsCard .sl-box{display:grid;gap:3px;padding:10px 12px;border:1px solid rgba(60,40,30,.25);border-radius:2px;background:rgba(255,252,244,.45)}
#slotsCard .sl-box b{font:600 16px var(--body);color:#21161f;overflow-wrap:anywhere}
#slotsCard .sl-box small{font-size:13.5px;color:#6c5a5f}
#slotsCard .savenote{font-size:14.5px;color:#6c3f5f;min-height:1.2em}
#slotsCard .savenote:empty{display:none}
#slotsCard .savenote.bad{color:#8f2f45}
#slotsCard .actions{gap:10px}
#slotsCard .btn.sl-danger{background:#8f2f45;border-color:#8f2f45;color:var(--bone)}
#slotsCard .btn:disabled,#slotsCard .sl-tool:disabled{opacity:.5;cursor:default;filter:none}
#title.bq-slots #cloudNote{display:none}
@media (max-width:520px){
  #slotsCard .sheet{padding:22px 14px 20px}
  #slotsCard .sl-list{max-height:none;overflow:visible}
  #slotsCard .sl-row{grid-template-columns:minmax(0,1fr);gap:2px}
  #slotsCard .sl-tools{padding-left:calc(2em + 16px)}
  #slotsCard .sl-row.empty{grid-template-columns:minmax(0,1fr)}
  #slotsCard .sl-two{grid-template-columns:1fr}
  #slotsCard .actions .btn{padding:10px 16px}
}`;

/* ---- the card: the slot list, rename, delete, keep which, bring a guest save in ---- */
let ui=null;
function buildCard(){
  const css=el('style'); css.textContent=STYLE; document.head.appendChild(css);
  const card=el('div','card sub bq-card'); card.id='slotsCard'; card.hidden=true;
  card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true'); card.setAttribute('aria-labelledby','slotsTitle');
  const sheet=el('div','sheet'); card.appendChild(sheet);
  sheet.appendChild(el('span','eyebrow','Brave Quest · Lighthouse'));
  const h=el('h2'); h.id='slotsTitle'; sheet.appendChild(h);
  const V={};
  const view=id=>{ const v=el('div','sl-view'); v.dataset.view=id; sheet.appendChild(v); V[id]=v; return v; };
  const btn=(host,text,cls,id,type)=>{ const b=el('button',cls||'btn',text); b.type=type||'button'; if(id)b.id=id; host.appendChild(b); return b; };

  const L=view('list');
  const lWho=el('p','sl-fine'); const list=el('ol','sl-list'); list.setAttribute('aria-label','Save slots');
  const lAct=el('div','actions'); const lNew=btn(lAct,'New game','btn','slotsNew'); const lBack=btn(lAct,'Back','btn ghost','slotsBack');
  L.append(lWho,list,lAct);

  const R=view('rename');
  const rForm=el('form'); rForm.noValidate=true;
  const rLbl=el('label',null,'Name for this save'); const rIn=el('input'); rIn.type='text'; rIn.maxLength=NAME_MAX; rIn.autocomplete='off'; rIn.spellcheck=false; rIn.name='slotname'; rLbl.appendChild(rIn);
  const rAct=el('div','actions'); const rSave=btn(rAct,'Save name','btn','slRenameSave','submit'); const rBack=btn(rAct,'Cancel','btn ghost','slRenameCancel');
  rForm.append(rLbl,el('p','sl-fine','Up to 24 letters, numbers or spaces.'),rAct); R.append(rForm);

  const D=view('delete');
  const dText=el('p'); const dBox=el('div','sl-box');
  const dAct=el('div','actions'); const dGo=btn(dAct,'Delete this save','btn sl-danger','slDelGo'); const dBack=btn(dAct,'Keep it','btn ghost','slDelNo');
  D.append(dText,dBox,dAct);

  const K=view('keep');
  const kText=el('p'); const kTwo=el('div','sl-two');
  const kDev=btn(kTwo,'','sl-choice','slKeepDevice'), kAcc=btn(kTwo,'','sl-choice','slKeepAccount');
  const kFine=el('p','sl-fine','The one you don’t choose is replaced. Not sure? Pick the one with the later time.');
  const kAct=el('div','actions'); const kBack=btn(kAct,'Back','btn ghost','slKeepBack');
  K.append(kText,kTwo,kFine,kAct);

  const C=view('claim');
  const cText=el('p','','This device has a guest save. Bring it into your account to keep it in a save slot and carry on from any device you sign in on.');
  const cBox=el('div','sl-box');
  const cAct=el('div','actions'); const cGo=btn(cAct,'Bring this save into your account','btn','slClaimGo'); const cNo=btn(cAct,'Not now','btn ghost','slClaimNo');
  const cFine=el('p','sl-fine','Not now leaves it as this device’s guest save: it is what Continue shows when you’re signed out. We won’t ask again on this device.');
  C.append(cText,cBox,cAct,cFine);

  const note=el('p','savenote'); note.setAttribute('role','status'); note.setAttribute('aria-live','polite'); sheet.appendChild(note);
  document.body.appendChild(card);

  const BACK={list:'slotsBack',rename:'slRenameCancel',delete:'slDelNo',keep:'slKeepBack',claim:'slClaimNo'};
  const TITLE={list:'Your saves',rename:'Rename save',delete:'Delete save',keep:'Which one to keep?',claim:'Bring your save along?'};
  let cur='list', from='title', busy=false, pick=0, after=null;
  const tell=(t,bad)=>{ note.textContent=t||''; note.classList.toggle('bad',!!bad); };
  const focus=x=>{ if(x&&!x.hidden&&!x.disabled)try{ x.focus(); }catch(_){} };
  function show(v,o){
    o=o||{}; cur=v; for(const k in V)V[k].hidden=k!==v; card.scrollTop=0; if(!o.keep)tell('');
    card.dataset.padBack=BACK[v]; h.textContent=TITLE[v]; render();
    if(o.focus!==false)focus(o.focus||defaultFocus(v));
  }
  function defaultFocus(v){
    if(v==='list'){ const id=acct(); const a=id&&activeSlot(id); return list.querySelector('[data-slot="'+a+'"] .sl-main')||list.querySelector('.sl-row:not(.empty) .sl-main')||lNew; }
    if(v==='rename')return G.isMobile?rSave:rIn;
    if(v==='delete')return dBack;
    if(v==='keep')return kDev;
    if(v==='claim')return cGo;
    return null;
  }
  function row(v){
    const li=el('li','sl-row'+(v.used?'':' empty')+(v.active&&v.used?' cur':'')); li.dataset.slot=v.slot;
    const main=el('button','sl-main'); main.type='button'; main.dataset.act='use';
    main.appendChild(el('span','sl-num',String(v.slot)));
    if(!v.used){ main.appendChild(el('span','sl-obj','Empty · start a new game here')); main.setAttribute('aria-label','Slot '+v.slot+', empty: start a new game here'); li.appendChild(main); return li; }
    const nm=el('span','sl-name'); nm.appendChild(el('b',null,v.name));
    if(v.test)nm.appendChild(el('span','sl-tag test','Test'));
    if(v.active)nm.appendChild(el('span','sl-tag last','Last played'));
    main.appendChild(nm);
    main.appendChild(el('span','sl-obj',v.objective||'—'));
    const rh=recHTML(v.sv); if(rh.length){ const r=el('span','sl-rec'); r.innerHTML=rh.join(''); main.appendChild(r); }
    const w=el('small','sl-when',v.at?'Played '+ago(v.at):'');
    const flag=v.conflict?'changed on another device too':!v.local?'in your account; not on this device yet':v.big?'too big to send; kept on this device':v.unsent?'not sent to your account yet':'';
    if(flag){ if(w.textContent)w.append(' · '); w.appendChild(el('i',null,flag)); }
    main.appendChild(w);
    main.setAttribute('aria-label','Slot '+v.slot+': '+v.name+(v.test?', test save':'')+'. '+(v.objective||'')+'. '+w.textContent);
    li.appendChild(main);
    const tools=el('div','sl-tools');
    const rn=el('button','sl-tool','Rename'); rn.type='button'; rn.dataset.act='rename'; rn.setAttribute('aria-label','Rename '+v.name);
    const dl=el('button','sl-tool del','Delete'); dl.type='button'; dl.dataset.act='delete'; dl.setAttribute('aria-label','Delete '+v.name);
    tools.append(rn,dl); li.appendChild(tools);
    return li;
  }
  function render(){
    const id=acct();
    if(cur==='list'&&id){
      const vs=views(id), used=vs.filter(v=>v.used).length;
      const keep=document.activeElement&&list.contains(document.activeElement)?[document.activeElement.closest('.sl-row').dataset.slot,document.activeElement.dataset.act]:null;
      list.textContent=''; for(const v of vs)list.appendChild(row(v));
      if(keep){ const b=list.querySelector('[data-slot="'+keep[0]+'"] [data-act="'+keep[1]+'"]')||list.querySelector('[data-slot="'+keep[0]+'"] .sl-main'); if(b)focus(b); }
      lWho.textContent=(G.account.me&&G.account.me.email?'Signed in as '+G.account.me.email+' · ':'')+used+' of '+MAX+' save slots used'+(reached?'':' · couldn’t reach your account just now, so this shows what this device has');
    }
    for(const b of card.querySelectorAll('button,input'))b.disabled=busy;
  }
  async function run(fn){ busy=true; tell('One moment…'); render(); let r; try{ r=await fn(); }catch(e){ console.error(e); r=null; } busy=false; tell(''); render(); return r; }

  list.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b||busy)return;
    const n=+b.closest('.sl-row').dataset.slot, act=b.dataset.act, id=acct(); if(!id)return;
    const v=view(id,n);
    if(act==='use'){ if(!v.used){ startNew(n); return; } chooseSlot(n); }
    else if(act==='rename'){ pick=n; rIn.value=v.name; show('rename'); try{ rIn.select(); }catch(_){} }
    else if(act==='delete'){ pick=n; dText.textContent='Delete '+v.name+'? Its progress is removed from your account and this device. This can’t be undone.';
      dBox.textContent=''; dBox.append(el('b',null,v.objective||v.name),el('small',null,(v.test?'Test save · ':'')+'Played '+ago(v.at))); show('delete'); }
  });
  async function chooseSlot(n){
    const id=acct(); let v=view(id,n);
    if(v.conflict){ showKeep(n); return; }
    if(v.newer||!v.local){
      const ok=await run(()=>download(id,n)); v=view(id,n);
      if(!ok&&!v.local){ tell('Couldn’t reach your account to fetch this save. Check your connection and try again.',true); return; }
    }
    begin(id,n);
  }
  function showKeep(n){
    const id=acct(), v=view(id,n), d=v.sv&&v.local?parse(lsGet(cacheKey(id,n))):null, s=slotMeta(id,n).srv||{};
    pick=n;
    kText.textContent=v.name+' was saved on another device after this one last sent its progress, and this device has progress the account hasn’t got.';
    const fill=(b,head,obj,at)=>{ b.textContent=''; b.append(el('b',null,head),el('span',null,obj||'—'),el('small',null,'Saved '+when(at))); };
    fill(kDev,'This device',d&&d.objective,v.la); fill(kAcc,'Your account',s.objective,v.sa);
    show('keep');
  }
  kDev.addEventListener('click',async()=>{ if(busy)return; const id=acct(), n=pick, m=slotMeta(id,n), d=parse(lsGet(cacheKey(id,n))); if(!d)return;
    d.at=Math.max(Date.now(),((m.srv&&m.srv.at)||0)+1); lsSet(cacheKey(id,n),JSON.stringify(d)); saveMeta(id);
    await run(()=>put(n)); begin(id,n); });
  kAcc.addEventListener('click',async()=>{ if(busy)return; const id=acct(), n=pick;
    const ok=await run(()=>download(id,n)); if(!ok){ tell('Couldn’t reach your account to fetch its copy. Check your connection and try again.',true); return; } begin(id,n); });
  kBack.addEventListener('click',()=>show('list',{focus:list.querySelector('[data-slot="'+pick+'"] .sl-main')}));
  function begin(id,n){
    const m=slotMeta(id,n);
    if(G.testSaves&&!m.test)testCopy(id,n); else setSess({acct:id,slot:n,test:!!m.test});
    close(true); G.flow.begin(true);
  }
  function startNew(n){
    const id=acct(); n=n||firstFree(id);
    if(!n){ show('list',{focus:list.querySelector('.sl-tool.del')||lBack}); tell('All ten save slots are in use. Delete one to make room for a new game.',true); return false; }
    Object.assign(slotMeta(id,n),{name:'',test:!!G.testSaves,srv:null,sent:0,pend:'',big:false}); lsSet(cacheKey(id,n),null); saveMeta(id);
    setSess({acct:id,slot:n,test:!!G.testSaves}); emit('slots:change');
    close(true); G.flow.begin(false); return true;
  }
  lNew.addEventListener('click',()=>{ if(!busy)startNew(0); });
  lBack.addEventListener('click',()=>close());
  rForm.addEventListener('submit',async e=>{ e.preventDefault(); if(busy)return;
    const nm=cleanName(rIn.value); if(!nm){ tell('Give it a name of 1 to 24 characters.',true); focus(rIn); return; }
    const r=await run(()=>rename(pick,nm));
    show('list',{focus:list.querySelector('[data-slot="'+pick+'"] [data-act="rename"]')});
    tell(r&&r.ok?(r.later?'Renamed on this device. Your account gets the new name when it can be reached.':'Renamed to '+nm+'.'):'Couldn’t rename it just now. Try again.',!(r&&r.ok)); });
  rBack.addEventListener('click',()=>show('list',{focus:list.querySelector('[data-slot="'+pick+'"] [data-act="rename"]')}));
  dGo.addEventListener('click',async()=>{ if(busy)return; const n=pick; const r=await run(()=>remove(n));
    show('list',{focus:list.querySelector('[data-slot="'+n+'"] .sl-main')});
    tell(r&&r.ok?'Deleted.':'Couldn’t reach your account, so nothing was deleted. Try again when you’re online.',!(r&&r.ok)); });
  dBack.addEventListener('click',()=>show('list',{focus:list.querySelector('[data-slot="'+pick+'"] [data-act="delete"]')}));

  function fillClaim(){
    const g=parse(lsGet((G.flow&&G.flow.keys&&G.flow.keys.save)||'bq-save-v1'));
    cBox.textContent=''; if(!g)return false;
    cBox.appendChild(el('b',null,g.objective||'Your game'));
    const rh=recHTML(g); if(rh.length){ const r=el('span','sl-rec'); r.innerHTML=rh.join(''); cBox.appendChild(r); }
    cBox.appendChild(el('small',null,'Saved '+ago(g.at)+(G.cloud&&G.cloud.sync&&G.cloud.sync.code&&G.cloud.sync.code()?' · backed up with a sync code':' · on this device only')));
    return true;
  }
  cGo.addEventListener('click',async()=>{ if(busy)return;
    const r=await run(()=>claim());
    if(r&&r.ok){ G.flow.refreshTitle(); show('list'); tell('Your save is in your account now, in slot '+r.slot+'.'); return; }
    const w=r&&r.why;
    tell(w==='full'?'All ten save slots in your account are in use. Delete one from the list, then sign in again on this device to bring the save in.'
      :w==='offline'?'Couldn’t reach your account just now. Your guest save is untouched; we’ll offer this again next time.'
      :w==='nothing'?'There’s no guest save on this device any more.'
      :'That didn’t work. Your guest save is untouched; we’ll offer this again next time.',true);
    if(w==='full'){ offered(true); setTimeout(()=>{ if(cur==='claim')show('list',{keep:true}); },0); } });
  cNo.addEventListener('click',()=>{ offered(true); close(); });

  document.addEventListener('keydown',e=>{ if(card.hidden||e.key!=='Escape')return; e.preventDefault(); e.stopPropagation(); const b=$(BACK[cur]); if(b&&!b.disabled)b.click(); },true);

  function close(starting){
    card.hidden=true; const f=$(from);
    if(!starting&&f&&(from!=='title'||G.state.mode==='title'))f.hidden=false;
    if(!starting){ const c=$('continue'); focus(c&&!c.hidden?c:$('begin')); }
    if(after){ const a=after; after=null; setTimeout(a,0); }
  }
  function open(f,o){
    o=o||{}; from=f||'title'; busy=false;
    const fc=$(from); if(fc)fc.hidden=true; card.hidden=false;
    if(o.view==='claim'){ if(!fillClaim()){ close(); return; } show('claim'); return; }
    show('list');
    if(o.full){ startNew(0); return; }
    run(()=>refresh()).then(()=>{ if(cur==='list'&&!card.hidden){ render(); if(!card.contains(document.activeElement))focus(defaultFocus('list')); } });
  }
  return { open, close, get view(){ return card.hidden?'':cur; }, render:()=>{ if(!card.hidden&&!busy)render(); }, startNew, chooseSlot, set after(f){ after=f; } };
}
function ensureUI(){ if(!ui)ui=buildCard(); return ui; }

/* ---- rename, delete ---- */
async function rename(n,name){
  const id=acct(); if(!id||!(n>=1&&n<=MAX))return {ok:false,why:'signed_out'};
  name=cleanName(name); if(!name)return {ok:false,why:'bad_name'};
  const m=slotMeta(id,n);
  const r=await call('POST','/v1/saves/'+n+'/rename',{name});
  if(r.ok){ m.name=name; m.pend=''; saveMeta(id); emit('slots:change'); return {ok:true}; }
  if(r.status===404||offline(r)){ m.pend=name; saveMeta(id); emit('slots:change'); return {ok:true,later:true}; }   // not in the account yet, or not reachable: sent with the next upload
  return {ok:false,why:r.error};
}
async function remove(n){
  const id=acct(); if(!id||!(n>=1&&n<=MAX))return {ok:false,why:'signed_out'};
  const v=view(id,n);
  const r=await call('DELETE','/v1/saves/'+n);
  if(!r.ok&&!(offline(r)&&!v.remote&&!slotMeta(id,n).sent))return {ok:false,why:r.status===0?'offline':r.error};
  clearSlot(id,n); queue.delete(n);
  if(activeSlot(id)===n)setActive(id,0);
  emit('slots:change'); if(G.state.mode==='title')G.flow.refreshTitle();
  return {ok:true};
}

/* ---- a guest save on this device, at first sign-in ---- */
const asked=id=>!!jget(CLAIM)[id];
function offered(v){ const id=acct(); if(!id)return; const a=jget(CLAIM); if(v)a[id]=1; else delete a[id]; lsSet(CLAIM,JSON.stringify(a)); }
const guestKey=()=>(G.flow&&G.flow.keys&&G.flow.keys.save)||'bq-save-v1';
async function claim(){
  const id=acct(); if(!id)return {ok:false,why:'signed_out'};
  const raw=lsGet(guestKey()), g=parse(raw); if(!g)return {ok:false,why:'nothing'};
  const S=G.cloud&&G.cloud.sync, code=S&&S.code?String(S.code()||'').replace(/[^0-9A-Z]/gi,''):'';
  let n=0;
  if(code){
    try{ if(G.cloud.flush)await Promise.race([G.cloud.flush(),new Promise(r=>setTimeout(r,5000))]); }catch(_){}   // send the guest's newest first
    const r=await call('POST','/v1/saves/claim',{code});
    if(r.ok&&r.data){ n=r.data.slot|0; }
    else if(r.status===409&&r.error==='full')return {ok:false,why:'full'};
    else if(offline(r))return {ok:false,why:'offline'};
    else if(!(r.status===404||r.status===401))return {ok:false,why:r.error||'server'};
    // 404 no_save / 401 bad_key: nothing under that code; upload the save on this device instead (below)
  }
  if(!n){
    await refresh();
    n=firstFree(id); if(!n)return {ok:false,why:'full'};
    const body={v:1,at:g.at,objective:String(g.objective||'').slice(0,120),save:raw,rec:g.rec||null};
    const r=await call('PUT','/v1/saves/'+n,body);
    if(r.status===409&&r.error==='stale'){ await refresh(); return {ok:false,why:'server'}; }   // the slot was taken meanwhile
    if(!r.ok)return {ok:false,why:offline(r)?'offline':r.error};
    Object.assign(slotMeta(id,n),{name:'',test:false,srv:{at:g.at,objective:body.objective,rec:body.rec,updated:Date.now()},sent:g.at,pend:'',big:false});
  }else{
    Object.assign(slotMeta(id,n),{name:'',test:false,srv:null,sent:0,pend:'',big:false});
  }
  lsSet(cacheKey(id,n),raw); saveMeta(id);
  if(code&&S.forget)S.forget();                // the code is retired: forget it here, guest sync stops
  lsSet(guestKey(),null);                      // the save has moved into the account
  offered(true); setActive(id,n);
  if(code)refresh();                           // the claimed slot: the device's copy uploads if newer, else stale tells us the account's time
  emit('slots:change');
  return {ok:true,slot:n};
}
let offerT=0;
function maybeOffer(){
  clearTimeout(offerT); offerT=0;
  const id=acct(); if(!id||asked(id)||guestRun||sess)return;
  if(!parse(lsGet(guestKey())))return;
  if(G.state.mode!=='title'){ return; }
  const busyCard=(G.account.debug&&G.account.debug.view)||(ui&&ui.view)||[...document.querySelectorAll('.card')].some(c=>!c.hidden&&c.id!=='title');
  if(busyCard||$('title').hidden){ offerT=setTimeout(maybeOffer,700); return; }
  ensureUI().open('title',{view:'claim'});
}

/* ---- the title ---- */
function noteEl(){ let n=$('slotNote'); if(!n){ const info=$('saveInfo'); if(!info)return null; n=el('p','savenote'); n.id='slotNote'; n.hidden=true; info.after(n); } return n; }
function title(){
  if(!ON)return false;
  const t=$('title'), id=guestRun?'':acct(); if(t)t.classList.toggle('bq-slots',!!id);
  const nn=noteEl(); if(nn){ let s=''; try{ s=sessionStorage.getItem(NOTE)||''; }catch(_){} nn.hidden=!s||!!id; nn.textContent=id?'':s; }
  if(!id)return false;
  const c=$('continue'), b=$('begin'), info=$('saveInfo'), rec=$('saveRec'); if(!c||!b||!info)return true;
  const vs=views(id).filter(v=>v.used), a=activeSlot(id);
  const last=vs.find(v=>v.slot===a)||vs.slice().sort((x,y)=>y.at-x.at)[0]||null;
  c.hidden=!vs.length; b.textContent=vs.length?'New game':'Begin'; b.classList.toggle('ghost',!!vs.length);
  info.hidden=false;
  info.textContent=last?'Last played: '+last.name+(last.test?' (test)':'')+' · '+(last.objective||'')+' · '+ago(last.at)+'. '+vs.length+' of '+MAX+' save slots used.'
    :'Signed in. Your games are kept in your account, in up to '+MAX+' save slots.';
  if(rec){ const parts=last?recHTML(last.sv):[]; rec.hidden=!parts.length; rec.innerHTML=parts.join(''); }
  return true;
}
/* the title's Continue / New game while signed in */
function intercept(kind){
  if(!ON||guestRun)return false;
  const st=G.account.state;
  if(st==='checking'){ Promise.resolve(G.account.ready).then(()=>{ if(G.state.mode!=='title')return; if(!intercept(kind))G.flow.begin(kind==='continue'); }); return true; }
  if(!acct())return false;
  if(kind==='continue')open('title'); else newGame();
  return true;
}
function open(from,o){ if(!ON||!acct())return false; ensureUI().open(from||'title',o); return true; }
function close(){ if(ui&&ui.view)ui.close(); }
function newGame(){ if(!ON||!acct())return false; const u=ensureUI(); if(firstFree(acct()))return u.startNew(0); u.open('title',{full:true}); return false; }
async function use(n){ if(!ON||!acct()||!(n>=1&&n<=MAX))return false; const u=ensureUI(); if(!u.view)u.open('title'); await u.chooseSlot(n); return true; }

/* ---- signing in and out ---- */
if(ON){
  G.on('account:in',()=>{
    if(G.state.mode==='title'&&!sess){ G.flow&&G.flow.refreshTitle&&G.flow.refreshTitle(); }
    try{ sessionStorage.removeItem(NOTE); }catch(_){}
    refresh().then(()=>{ if(G.state.mode==='title'&&!sess&&G.flow)G.flow.refreshTitle(); maybeOffer(); });
  });
  G.on('account:out',()=>{
    if(sess){
      // the slot being played stays on this device (it uploads the next time this account signs in here); back to the title
      try{ if(['play','paused','ending','dead'].includes(G.state.mode)&&G.flow)G.flow.writeSave(); }catch(_){}
      clearTimeout(U.timer); U.timer=0; sess=null;
      try{ sessionStorage.setItem(NOTE,'You’re signed out. Your account’s saves stay in your account; Continue here is this device’s guest game.'); }catch(_){}
      setTimeout(()=>location.reload(),400);
      return;
    }
    if(ui&&ui.view)ui.close();
    if(G.state.mode==='title'&&G.flow)G.flow.refreshTitle();
  });
  G.on('save:written',()=>{ if(target())schedule(); });
  G.on('slots:change',()=>{ if(ui)ui.render(); });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden)setTimeout(flush,50); });
  window.addEventListener('pagehide',()=>{ flush(); });
  window.addEventListener('online',()=>{ if(acct()){ flush(); refresh(); } });
}

G.slots={
  on:ON,
  list(){ const id=acct(); return id?views(id).map(v=>({slot:v.slot,used:v.used,name:v.name,test:v.test,at:v.at,objective:v.objective,rec:v.rec,
    local:v.local,remote:v.remote,unsent:v.unsent,conflict:v.conflict,active:v.active})):[]; },
  active, open, close, use, newGame, rename, remove, flush,
  saveKey, readKey, owner(){ return sess&&sess.acct||null; }, title, intercept, beginning,
  get uploading(){ return !!target(); },
  debug:{
    get sess(){ return sess?Object.assign({},sess):null; }, get guestRun(){ return guestRun; },
    meta(id){ return JSON.parse(JSON.stringify(metaOf(id||acct()))); }, view(n){ return view(acct(),n); },
    gap(ms){ if(ms!=null)GAP=Math.max(0,+ms||0); return GAP; }, refresh, claim, maybeOffer,
    get ui(){ return ui?ui.view:''; }, get log(){ return LOG.slice(); }, cacheKey, metaKey, get queue(){ return [...queue]; }
  }
};
})();
