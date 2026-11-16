/* =========================================================================
   cloud.js — saves that follow the player across devices.
   When the game runs as a published Claude artifact and the viewer is signed
   in with write access, the save ('bq-save-v1' in localStorage, see flow.js)
   is mirrored to the artifact's per-person store at data/users/<id>/save.
   Each person's document is private to them (the owner can't read it either).

   On load:  the newer of the local and cloud saves wins (by its `at` time).
             A newer cloud save is copied into localStorage before Continue,
             so Continue/applySave need no changes.
   In play:  every save flow.js writes is uploaded, at most one every 20 s,
             plus right away when the tab is hidden or the player quits.
   Outside Claude (the public beta on itch.io or its own page), the same mirror
   runs against the Lighthouse save service (server/, see its README) when the
   page sets window.BQ_CONFIG.api. There is no account: the save is kept under a
   random 12-character sync code kept in localStorage ('bq-sync-key'); entering
   that code on another device joins it. The service only ever sees the code
   (it stores a hash) and the save.
   Automatic backup: a device with no code starts on its own once the player has
   had AUTO_AFTER seconds of actual play this page load (mode 'play', no cut
   scene) and there is a local save to send. It makes a code and uploads the save
   in one PUT; only when that lands is the code kept and sync shown as on, so a
   failed try leaves nothing behind (the Sync card still offers "Turn on sync").
   A failed try is silent and is repeated at a later save, at most once a minute.
   The first time it starts, one caption says so at a quiet moment
   ('bq-sync-auto': 'new' until said, then 'told'). "Turn off on this device"
   remembers the choice ('bq-sync-off'), so it never switches itself back on;
   turning sync on by hand or joining a code clears it. Never in Claude mode,
   ?debug / test-save sessions, or when localStorage can't be written.
   With neither (a saved file, tests, the test-save slot) it stays off and the
   game saves to the browser exactly as before.
   API: G.cloud = { state: 'off'|'checking'|'on'|'local-only', mode: ''|'claude'|'sync', flush(),
                    sync: { available, code(), off, enable(), join(code), disable(),
                            auto: { after, played, trying } (read-only, for the Sync card and tests) } }   (sync UI: beta.js)
   ========================================================================= */
(function(){
'use strict';
const G=window.G; if(!G)return;
const AUTO_AFTER=60;            // seconds of actual play (this page load) before automatic backup starts on a device with no code
const AUTO_RETRY=60000;         // ms: a failed automatic start is tried again at a later save, at most this often
const GAP=20000, DOC_LIMIT=240*1024;
const API=String((window.BQ_CONFIG&&window.BQ_CONFIG.api)||'').replace(/\/+$/,''), KEY_NAME='bq-sync-key', OFF_NAME='bq-sync-off', AUTO_NAME='bq-sync-auto';
const S={state:'off',mode:'',ref:null,busy:false,dirty:false,lastPut:0,timer:0,remoteAt:0,
  played:0,reached:false,autoBusy:false,autoAt:0,autoCancel:false,tell:false,calmT:0};
const $=id=>document.getElementById(id);
function note(t){ const el=$('cloudNote'); if(!el)return; el.hidden=!t; el.textContent=t||''; }
/* give up on a read after ms. A page that was frozen (building the island, a backgrounded tab) wakes with the timer and the
   answer both waiting, so after the timer fires the answer gets two more short turns to land before it counts as a timeout. */
const wait=(p,ms)=>new Promise((res,rej)=>{ let done=false; p.then(v=>{ done=true; res(v); },e=>{ done=true; rej(e); });
  const late=n=>{ if(done)return; if(n<=0)rej({code:'timeout'}); else setTimeout(()=>late(n-1),250); };
  setTimeout(()=>late(2),ms); });
function key(){ return G.flow&&G.flow.keys?G.flow.keys.save:'bq-save-v1'; }
function localRaw(){ try{ return localStorage.getItem(key()); }catch(_){ return null; } }
function parse(s){ try{ const d=JSON.parse(s); return d&&d.v===1?d:null; }catch(_){ return null; } }

/* ---- sync-code backend (the Lighthouse save service). Same shape as the Claude document ref: get() / set(body) ---- */
const ALPHA='0123456789ABCDEFGHJKMNPQRSTVWXYZ';            // Crockford base32: no I, L, O, U
function normKey(t){ const k=String(t||'').toUpperCase().replace(/[IL]/g,'1').replace(/O/g,'0').replace(/[^0-9A-Z]/g,''); return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(k)?k:''; }
function fmtKey(k){ return k?k.replace(/(.{4})(?=.)/g,'$1-'):''; }
function newKey(){ const a=new Uint8Array(12); crypto.getRandomValues(a); let k=''; for(const b of a)k+=ALPHA[b&31]; return k; }
function storedKey(){ try{ return normKey(localStorage.getItem(KEY_NAME)); }catch(_){ return ''; } }
function httpRef(k){
  const auth={'Authorization':'Bearer '+k};
  const call=async(opt)=>{ try{ return await fetch(API+'/v1/save',Object.assign({cache:'no-store'},opt)); }catch(_){ throw {code:'unavailable'}; } };
  return {
    async get(){ const r=await call({headers:auth});
      if(r.status===404)return {exists:false,data:()=>null};
      if(r.status===401)throw {code:'bad_key'};
      if(!r.ok)throw {code:'unavailable',status:r.status};
      const d=await r.json(); return {exists:true,data:()=>d}; },
    async set(body){ const s=JSON.stringify(body);       // keepalive lets a small save finish while the tab closes (browsers cap it at 64 KB)
      const r=await call({method:'PUT',headers:Object.assign({'Content-Type':'application/json'},auth),body:s,keepalive:s.length<60000});
      if(r.ok)return;
      if(r.status===409){ let d={}; try{ d=await r.json(); }catch(_){} throw {code:'stale',at:d.at}; }
      if(r.status===400||r.status===413)throw {code:'invalid_argument'};
      if(r.status===401)throw {code:'bad_key'};
      throw {code:'unavailable',status:r.status}; } };
}
const where=()=>S.mode==='sync'?'on any device that has your sync code':'wherever you’re signed in to Claude';

async function start(){
  // tests run without the platform; ?cloud lets a debug page opt in
  if(G.debug&&!/[?&]cloud(=|&|$)/.test(location.search))return;
  const C=window.claude;
  if(C&&typeof C.use==='function'){
    S.state='checking';
    let user=null, db=null;
    try{ [user,db]=await Promise.all([C.use('user'),C.use('db')]); }catch(_){}
    let id=null; if(user&&db){ try{ id=await user.id(); }catch(_){} }
    let ref=null; if(id){ try{ ref=db.doc('data/users/'+id+'/save'); }catch(_){} }
    if(ref){ S.mode='claude'; return connect(ref); }         // signed out, or no identity for this viewer: fall through
    S.state='off';
  }
  if(API){ S.mode='sync'; const k=storedKey(); if(k){ S.tell=autoNew(); return connect(httpRef(k)); } }
}
/* read the cloud copy, let the newer of the two win, then mirror. Returns '' or an error code. */
async function connect(ref){
  S.ref=ref; S.state='checking'; S.remoteAt=0;
  let snap=null;
  try{ snap=await wait(S.ref.get(),10000); }
  catch(e){ S.state='off'; note('Couldn’t reach your cloud save just now, so this session saves on this device.'); return (e&&e.code)||'unavailable'; }
  const body=snap&&snap.exists?snap.data():null;
  const cloud=body&&typeof body.save==='string'?parse(body.save):null;
  const local=parse(localRaw());
  S.remoteAt=cloud?cloud.at:0;
  S.state='on';
  if(cloud&&(!local||cloud.at>local.at)){
    if(G.state.mode==='title'){
      try{ localStorage.setItem(key(),body.save); }catch(_){}
      if(G.flow&&G.flow.refreshTitle)G.flow.refreshTitle();
      note('Your save from another device is ready. Saves follow you '+where()+'.');
    }else note('');
    return '';
  }
  note(local?'Cloud saves are on. Your progress follows you '+where()+'.':'Cloud saves are on. Once you’ve played a little, your progress will follow you to any device '+(S.mode==='sync'?'that has your sync code.':'where you’re signed in to Claude.'));
  if(local&&(!cloud||local.at>cloud.at))put();
  return '';
}
/* sync codes: turn on (new code), join (a code from another device), turn off (this device only) */
const sync={
  get available(){ return !!API&&S.mode!=='claude'&&!(G.debug&&!/[?&]cloud(=|&|$)/.test(location.search)); },
  code(){ return fmtKey(storedKey()); },
  get off(){ try{ return !!localStorage.getItem(OFF_NAME); }catch(_){ return false; } },
  async enable(){ clearOff(); if(S.autoBusy)S.autoCancel=true; let k=storedKey(); if(!k){ k=newKey(); try{ localStorage.setItem(KEY_NAME,k); }catch(_){ return {ok:false,why:'storage'}; } if(storedKey()!==k)return {ok:false,why:'storage'}; }
    S.mode='sync'; const err=await connect(httpRef(k)); return err?{ok:false,why:err,code:fmtKey(k)}:{ok:true,code:fmtKey(k)}; },
  async join(text){ const k=normKey(text); if(!k)return {ok:false,why:'format'};
    let snap; try{ snap=await wait(httpRef(k).get(),10000); }catch(e){ return {ok:false,why:(e&&e.code)||'unavailable'}; }
    if(!snap.exists)return {ok:false,why:'no_save'};        // nothing under that code: a typo, or the other device hasn't saved yet
    try{ localStorage.setItem(KEY_NAME,k); }catch(_){ return {ok:false,why:'storage'}; }
    clearOff(); if(S.autoBusy)S.autoCancel=true;
    S.mode='sync'; const err=await connect(httpRef(k)); return err?{ok:false,why:err}:{ok:true,code:fmtKey(k)}; },
  disable(){ try{ localStorage.removeItem(KEY_NAME); localStorage.setItem(OFF_NAME,'1'); }catch(_){}   // remembered: automatic backup stays off here
    if(S.autoBusy)S.autoCancel=true; S.tell=false;
    clearTimeout(S.timer); S.timer=0; S.ref=null; S.state='off'; note(''); },
  auto:{ get after(){ return AUTO_AFTER; }, get played(){ return S.played; }, get trying(){ return S.autoBusy; } }
};
function clearOff(){ try{ localStorage.removeItem(OFF_NAME); }catch(_){} }

/* ---- automatic backup: a device with no code starts on its own after AUTO_AFTER s of play (see the header) ---- */
function autoOK(){
  if(!sync.available||S.mode==='claude'||G.testSaves||G.debug)return false;
  if(S.ref||S.autoBusy||S.state==='checking'||storedKey())return false;
  try{ if(localStorage.getItem(OFF_NAME))return false;                       // the player turned it off on this device
    localStorage.setItem(AUTO_NAME+'-probe','1'); localStorage.removeItem(AUTO_NAME+'-probe'); }
  catch(_){ return false; }                                                  // no storage: nothing automatic
  return true;
}
async function autoStart(){
  if(!S.reached||!autoOK())return;
  const raw=localRaw(), d=parse(raw); if(!d||raw.length>DOC_LIMIT)return;   // nothing to protect yet: the next save tries again
  if(S.autoAt&&performance.now()-S.autoAt<AUTO_RETRY)return;
  S.autoAt=performance.now(); S.autoBusy=true; S.autoCancel=false;
  const k=newKey(), ref=httpRef(k);
  let ok=false;
  try{ await ref.set({v:1,at:d.at,objective:String(d.objective||'').slice(0,120),save:raw}); ok=true; }catch(_){}   // a brand-new code: nothing to read first
  S.autoBusy=false;
  if(!ok||S.autoCancel||storedKey()||sync.off||S.ref)return;               // failed (silently), or the player chose for themselves meanwhile
  try{ localStorage.setItem(KEY_NAME,k); if(localStorage.getItem(AUTO_NAME)!=='told')localStorage.setItem(AUTO_NAME,'new'); }catch(_){}
  if(storedKey()!==k)return;
  S.mode='sync'; S.ref=ref; S.remoteAt=d.at; S.state='on';
  note('Cloud saves are on. Your progress follows you '+where()+'.');
  G.emit('cloud:saved',{at:d.at}); G.emit('cloud:auto',{});
  S.tell=autoNew();
  const now=parse(localRaw()); if(now&&now.at>d.at)schedule();            // saved again while the first upload was in flight
}
function autoNew(){ try{ return localStorage.getItem(AUTO_NAME)==='new'&&!!storedKey(); }catch(_){ return false; } }
const TELL='Your progress is now also backed up online, anonymously. To carry on from another device, or to turn this off, open Sync devices on the title screen or in the pause menu.';
/* the one-time line: a caption at a quiet moment (calm for 2 s, no caption showing or waiting), never a card */
function tellWhenQuiet(dt){
  const T=G.talk, cap=$('cap'), st=G.ui&&G.ui.captionStack?G.ui.captionStack():null;
  const quietNow=(T&&T.calm?T.calm():true)&&!(cap&&cap.classList.contains('show'))&&!(st&&(st.depth||st.count));
  S.calmT=quietNow?S.calmT+dt:0; if(S.calmT<2)return;
  if(!autoNew()){ S.tell=false; return; }
  S.tell=false; try{ localStorage.setItem(AUTO_NAME,'told'); }catch(_){}
  if(G.ui&&G.ui.say)G.ui.say(TELL,'',{priority:'normal',key:'cloud:auto'});
}
if(API)G.system('cloudAuto',{order:96,modes:['play'],update(dt){
  if(!(G.cine&&G.cine.on))S.played+=dt;                                      // play only: not the title, pause, cards or cut scenes
  if(!S.reached&&S.played>=AUTO_AFTER){ S.reached=true; autoStart(); }
  if(S.tell)tellWhenQuiet(dt);
}});
if(API)G.on('save:written',()=>{ if(S.reached)autoStart(); });

/* one upload at a time; anything saved while one is in flight goes up next */
async function put(){
  if(S.state!=='on'||G.testSaves)return;
  if(S.busy){ S.dirty=true; return; }
  const raw=localRaw(), d=parse(raw); if(!d||d.at<=S.remoteAt)return;
  if(raw.length>DOC_LIMIT){ return; }                      // too big for one document: stay local
  S.busy=true; S.dirty=false; clearTimeout(S.timer); S.timer=0; S.lastPut=Date.now();
  try{
    await (S.inflight=S.ref.set({v:1,at:d.at,objective:String(d.objective||'').slice(0,120),save:raw}));
    S.remoteAt=d.at; G.emit('cloud:saved',{at:d.at});
  }catch(e){
    const c=e&&e.code;
    if(c==='stale'){ S.remoteAt=Math.max(d.at,+e.at||0); }       // another device saved later than this one: leave its save alone
    else if(c==='bad_key'){ S.state='off'; G.emit('cloud:off',{code:c}); }
    else if(c==='invalid_argument'||c==='not_granted'||c==='revoked'||c==='capability_disabled'||c==='capability_removed'){
      S.state='local-only'; G.emit('cloud:off',{code:c});    // view-only on this artifact: the device save carries on
    }else if(c==='unavailable'&&!S.retried){ S.retried=true; setTimeout(()=>{ S.retried=false; put(); },1500+Math.random()*1500); }
  }finally{ S.busy=false; }
  if(S.dirty)schedule();
}
function schedule(){
  if(S.state!=='on'||G.testSaves||S.timer)return;
  if(S.busy){ S.dirty=true; return; }                      // the upload in flight schedules the next one when it lands
  const ms=Math.max(0,GAP-(Date.now()-S.lastPut));
  S.timer=setTimeout(()=>{ S.timer=0; put(); },ms);
}
/* waits for an upload already in flight, then sends whatever is newer than it */
async function flush(){
  if(S.state!=='on')return; clearTimeout(S.timer); S.timer=0;
  if(S.busy&&S.inflight){ try{ await S.inflight; }catch(_){} clearTimeout(S.timer); S.timer=0; }
  return put();
}

G.cloud={ get state(){ return S.state; }, get mode(){ return S.mode; }, flush, sync };
G.on('save:written',schedule);
document.addEventListener('visibilitychange',()=>{ if(document.hidden)setTimeout(flush,50); });
window.addEventListener('pagehide',()=>{ flush(); });
// after the island is built: building blocks the page for seconds on a slow device, which would eat the 10 s the first read is given
let started=false; const go=()=>{ if(!started){ started=true; start(); } };
G.on('ready',go); window.addEventListener('load',()=>setTimeout(go,4000));
})();
