/* =========================================================================
   beta.js — the public beta's extras. Everything here is switched on by
   window.BQ_CONFIG, which only the release build sets (test/build_release.py):
     { api, version, devtools:false, direct }
   Without it (the Claude artifact, dev.html, tests) this module does nothing.

   - Build tag:  the version, small, on the title and pause cards.
   - Sync:       "Sync devices" on the title and pause cards. Shows the code of the
                 sync-code cloud save (cloud.js; it starts by itself after a minute of
                 play), turns it on now or off on this device, or (title only: it
                 replaces the game on this device) joins a code from another device.
   - Feedback:   "Send feedback" on the title, pause and ending cards. Posts the
                 text with the build, input type and current objective.
   - Progress:   a few anonymous milestone pings (started, bosses, deaths, the
                 Keeper's Record milestones) so we
                 can see where players stop. No names, no ids kept between
                 sessions, and none at all if the browser sends Do Not Track.
   API: G.beta = { version, openSync(from), openFeedback(from), ping(name) }
   ========================================================================= */
(function(){
'use strict';
const G=window.G; if(!G)return;
const CFG=window.BQ_CONFIG||{};
const API=String(CFG.api||'').replace(/\/+$/,''), VERSION=String(CFG.version||'').slice(0,40);
if(!API&&!VERSION)return;
const $=id=>document.getElementById(id);
const el=(tag,cls,html)=>{ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; };
const framed=(()=>{ try{ return window.top!==window.self; }catch(_){ return true; } })();
const quiet=()=>G.testSaves||G.debugUrl;                       // test tools and ?debug sessions send nothing
let device=G.isMobile?'touch':'keyboard';
G.on('input:device',e=>{ if(e&&e.device)device=e.device; });
const platform=()=>device==='gamepad'?'pad':device==='touch'?'touch':device==='keyboard'?'keyboard':'unknown';
function post(path,body,keepalive){
  return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:!!keepalive,cache:'no-store'});
}

const css=el('style',null,`
.bq-links{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}
.bq-links button{font:600 12.5px var(--body);letter-spacing:.12em;text-transform:uppercase;background:none;border:0;border-bottom:1px dashed rgba(108,63,95,.6);
  color:#6c3f5f;padding:2px 0;cursor:pointer}
.bq-links button:focus-visible{outline:2px solid var(--ether);outline-offset:3px}
.bq-links .bq-ver{font:500 12px var(--body);letter-spacing:.08em;color:#8a7a86}
#title .bq-links button{color:#cbbfd6;border-bottom-color:rgba(203,191,214,.5)} #title .bq-links .bq-ver{color:#9c90a8}
.bq-card .sheet{gap:14px}
.bq-card textarea,.bq-card input[type=text]{font:400 17px var(--body);color:#21161f;background:rgba(255,252,244,.75);border:1px solid rgba(60,40,30,.45);
  border-radius:2px;padding:10px 12px;width:100%;box-sizing:border-box}
.bq-card textarea{min-height:130px;resize:vertical}
.bq-card textarea:focus-visible,.bq-card input:focus-visible{outline:2px solid var(--ether);outline-offset:2px}
.bq-card label{font:600 13px var(--body);letter-spacing:.06em;color:#6c3f5f;display:grid;gap:6px}
.bq-code{font:600 clamp(24px,6vw,34px) ui-monospace,Menlo,Consolas,monospace;letter-spacing:.1em;color:#21161f;user-select:all;-webkit-user-select:all;
  padding:10px 14px;border:1px dashed rgba(60,40,30,.5);border-radius:2px;text-align:center;background:rgba(255,252,244,.6)}
.bq-card .savenote{min-height:1.3em}
`);
document.head.appendChild(css);

/* ---- a parchment sub-card that returns to whichever card opened it ---- */
function makeCard(id,eyebrow,title){
  const card=el('div','card sub bq-card'); card.id=id; card.hidden=true;
  const sheet=el('div','sheet'); card.appendChild(sheet);
  sheet.appendChild(el('span','eyebrow',eyebrow)); sheet.appendChild(el('h2',null,title));
  const body=el('div'); body.style.display='grid'; body.style.gap='14px'; sheet.appendChild(body);
  document.body.appendChild(card);
  let from='title', opener=null;
  const close=()=>{ card.hidden=true; const f=$(from); if(f)f.hidden=false; if(opener)try{opener.focus();}catch(_){} };
  const open=(fromId,btn)=>{ from=fromId||'title'; opener=btn||null; const f=$(from); if(f)f.hidden=true; card.hidden=false; };
  document.addEventListener('keydown',e=>{ if(!card.hidden&&e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); close(); } },true);
  return {card,body,open,close};
}
function linksRow(host){ let r=host.querySelector(':scope > .bq-links'); if(!r){ r=el('div','bq-links'); host.appendChild(r); } return r; }
function link(row,text,fn){ const b=el('button',null,text); b.type='button'; b.addEventListener('click',()=>fn(b)); row.appendChild(b); return b; }

/* ---- sync devices ---- */
const WHY={ format:'That doesn’t look like a sync code. It is 12 letters and numbers, like ABCD-1234-EFGH.',
  no_save:'There’s no save under that code yet. Check it for typos, or play a little on the other device first so it has something to send.',
  storage:'This browser is blocking storage, so sync can’t be turned on here.',
  unavailable:'Couldn’t reach the save service just now. Your game still saves in this browser; try again in a minute.',
  timeout:'Couldn’t reach the save service just now. Your game still saves in this browser; try again in a minute.',
  bad_key:'The save service didn’t accept that code.' };
let syncUI=null;
function buildSync(){
  const C=makeCard('syncCard','Brave Quest · Lighthouse','Sync devices');
  const b=C.body;
  const intro=el('p'); const code=el('div','bq-code'); const how=el('p'); const titleOnly=el('p');
  const joinLbl=el('label',null,'Sync code from your other device'); const input=el('input'); input.type='text'; input.autocomplete='off'; input.autocapitalize='characters'; input.spellcheck=false; input.maxLength=20; input.placeholder='ABCD-1234-EFGH'; joinLbl.appendChild(input);
  const note=el('p','savenote'); note.setAttribute('role','status');
  const actions=el('div','actions');
  const mk=(t,ghost)=>{ const x=el('button','btn'+(ghost?' ghost':''),t); x.type='button'; actions.appendChild(x); return x; };
  const on=mk('Turn on sync'), have=mk('I have a code',true), use=mk('Use this code'), copy=mk('Copy code'), offBtn=mk('Turn off on this device',true), back=mk('Back',true);
  b.append(intro,code,how,titleOnly,joinLbl,note,actions);
  let joining=false, busy=false, inGame=false;
  /* no code yet: either automatic backup hasn't started (or couldn't reach the service: nothing was kept, so this is shown too),
     or the player turned it off here. Opened from the pause menu, joining a code is not offered: it would replace the game in progress. */
  function render(){
    const S=G.cloud.sync, c=S.code(), off=S.off;
    intro.hidden=!!c||joining; code.hidden=!c; how.hidden=!c; joinLbl.hidden=!joining||!!c; titleOnly.hidden=!!c||!inGame;
    on.hidden=!!c||joining; have.hidden=!!c||joining||inGame; use.hidden=!joining||!!c; copy.hidden=!c; offBtn.hidden=!c;
    intro.textContent=(off
      ?'Sync is off on this device, so your game saves in this browser only. Turn on sync to keep a copy online and carry on from another phone or computer.'
      :'Your game saves in this browser, and after a minute of play it also keeps a copy online, so you can carry on from another phone or computer. Turn on sync to start that now.')
      +' There’s no account: you get a short code, and any device with the code shares the save.'
      +(framed?' Because this page runs inside another site, some browsers (Safari especially) forget saves here when you close them, so sync is worth turning on.':'');
    titleOnly.textContent='Have a code from another device? Enter it from Sync devices on the title screen. It replaces the game on this device, so it can’t be done mid-game.';
    code.textContent=c;
    how.textContent='On your other device, open the game, choose Sync devices, then “I have a code”, and enter this. Keep the code somewhere safe: anyone who has it can load this save.';
    [on,have,use,copy,offBtn,back,input].forEach(x=>x.disabled=busy);
  }
  const run=async(fn)=>{ busy=true; note.textContent='One moment…'; render(); let r; try{ r=await fn(); }catch(_){ r={ok:false,why:'unavailable'}; } busy=false; return r; };
  on.addEventListener('click',async()=>{ const r=await run(()=>G.cloud.sync.enable());
    note.textContent=r.ok?'Sync is on.':(r.code?'Sync is set up, but the save service couldn’t be reached just now. It will try again next time you open the game.':WHY[r.why]||WHY.unavailable); render(); if(r.ok||r.code)try{copy.focus();}catch(_){} });
  have.addEventListener('click',()=>{ joining=true; note.textContent=''; render(); try{input.focus();}catch(_){} });
  use.addEventListener('click',async()=>{ const r=await run(()=>G.cloud.sync.join(input.value));
    if(r.ok){ joining=false; input.value=''; note.textContent='Linked. Your save from the other device is ready: go back and choose Continue.'; }
    else note.textContent=WHY[r.why]||WHY.unavailable;
    render(); });
  copy.addEventListener('click',async()=>{ try{ await navigator.clipboard.writeText(G.cloud.sync.code()); note.textContent='Copied.'; }catch(_){ note.textContent='Couldn’t copy automatically. Press and hold the code to select it.'; } });
  offBtn.addEventListener('click',()=>{ G.cloud.sync.disable(); note.textContent='Sync is off on this device, and it stays off until you turn it on again. The save in this browser is untouched, and the online copy stays for your other devices.'; render(); });
  back.addEventListener('click',()=>{ if(joining&&!G.cloud.sync.code()){ joining=false; note.textContent=''; render(); return; } C.close(); });
  return { open(from,btn){ joining=false; inGame=(from||'title')!=='title'; note.textContent=''; render(); C.open(from,btn); try{ (G.cloud.sync.code()?copy:on).focus(); }catch(_){} } };
}
function openSync(from,btn){ if(!G.cloud||!G.cloud.sync||!G.cloud.sync.available)return; if(!syncUI)syncUI=buildSync(); syncUI.open(from,btn); }

/* ---- feedback ---- */
let fbUI=null;
function buildFeedback(){
  const C=makeCard('feedbackCard','Brave Quest · Lighthouse beta','Send feedback');
  const b=C.body;
  const intro=el('p',null,'What worked, what confused you, where you got stuck, what broke. A sentence is plenty. This goes straight to Numinex Studio.');
  const tl=el('label',null,'Your feedback'); const text=el('textarea'); text.maxLength=4000; tl.appendChild(text);
  const cl=el('label',null,'Email or handle, only if you’d like a reply (optional)'); const contact=el('input'); contact.type='text'; contact.maxLength=200; contact.autocomplete='off'; cl.appendChild(contact);
  const note=el('p','savenote'); note.setAttribute('role','status');
  const actions=el('div','actions');
  const send=el('button','btn','Send'); send.type='button'; const back=el('button','btn ghost','Back'); back.type='button'; actions.append(send,back);
  b.append(intro,tl,cl,note,actions);
  send.addEventListener('click',async()=>{
    const t=text.value.trim(); if(!t){ note.textContent='Write a line or two first.'; try{text.focus();}catch(_){} return; }
    send.disabled=true; note.textContent='Sending…';
    const o=$('obj');
    try{
      const r=await post('/v1/feedback',{text:t.slice(0,4000),build:VERSION||'dev',platform:platform(),progress:String(o?o.textContent:'').slice(0,120),contact:contact.value.trim().slice(0,200)});
      if(r.ok){ text.value=''; note.textContent='Sent. Thank you for carrying a lantern into the fog for us.'; G.emit('beta:feedback',{}); }
      else note.textContent=r.status===429?'That’s a lot of feedback in one hour. Give it a little while and try again.':'That didn’t go through. Please try again in a minute.';
    }catch(_){ note.textContent='Couldn’t reach us just now. Check your connection and try again.'; }
    send.disabled=false;
  });
  back.addEventListener('click',C.close);
  return { open(from,btn){ note.textContent=''; C.open(from,btn); try{text.focus();}catch(_){} } };
}
function openFeedback(from,btn){ if(!API)return; if(!fbUI)fbUI=buildFeedback(); fbUI.open(from,btn); }

/* ---- anonymous progress pings ---- */
const sid=(()=>{ const a=new Uint8Array(8); try{ crypto.getRandomValues(a); }catch(_){} return [...a].map(x=>(x%36).toString(36)).join('')+Date.now().toString(36).slice(-4); })();
const sent=new Set(); let count=0;
const dnt=()=>navigator.doNotTrack==='1'||window.doNotTrack==='1';
function ping(name,repeat){
  if(!API||quiet()||dnt()||count>=60)return;
  name=String(name).toLowerCase().replace(/[^a-z0-9_.:-]/g,'_').slice(0,48); if(!name)return;
  if(!repeat){ if(sent.has(name))return; sent.add(name); }
  count++;
  try{ post('/v1/event',{name,build:VERSION||'dev',platform:platform(),sid},true).catch(()=>{}); }catch(_){}
}
function wirePings(){
  ping('session');
  G.on('mode',e=>{ if(e&&e.mode==='play')ping('play'); });
  const once=(ev,name)=>G.on(ev,d=>{ if(!(d&&d.restored))ping(typeof name==='function'?name(d||{}):name); });
  once('lantern:pickup','lantern'); once('staff:pickup','staff'); once('lamp:cured','lamp_cured');
  once('boss:dead',d=>'boss:'+(d.who||'unknown'));
  once('undercroft:enter','undercroft_enter'); once('undercroft:saved','undercroft_saved');
  once('temple:hesper',d=>'temple_hesper:'+(d.state||''));
  once('boat:sail',d=>d.ready?'boat_sail':'boat_not_ready');
  once('record:milestone',d=>'milestone:'+(d.id||'unknown'));   // the Keeper's Record: once per save, never for back-filled ones
  G.on('player:respawn',d=>{ if(!(d&&d.restored))ping('death',true); });
}

/* ---- wire into the cards ---- */
function init(){
  const title=document.querySelector('#title .title-sheet'), pause=document.querySelector('#pause .sheet'), ending=document.querySelector('#ending .sheet');
  if(title){ const r=linksRow(title);
    if(API&&G.cloud&&G.cloud.sync&&G.cloud.sync.available)link(r,'Sync devices',b=>openSync('title',b)).dataset.syncLink='title';
    if(API)link(r,'Send feedback',b=>openFeedback('title',b));
    if(VERSION){ const v=el('span','bq-ver'); v.textContent=VERSION; r.appendChild(v); } }
  if(pause){ const r=linksRow(pause);
    if(API&&G.cloud&&G.cloud.sync&&G.cloud.sync.available)link(r,'Sync devices',b=>openSync('pause',b)).dataset.syncLink='pause';
    if(API)link(r,'Send feedback',b=>openFeedback('pause',b));
    if(VERSION){ const v=el('span','bq-ver'); v.textContent=VERSION; r.appendChild(v); } }
  if(ending&&API){ const r=linksRow(ending); link(r,'Send feedback',b=>openFeedback('ending',b)); }
  if(API)wirePings();
  syncLinks();
}
/* signed in to an account (js/account.js), saves follow the account: Sync devices only governs the guest save, so it is
   hidden while signed in and comes back on sign-out */
function syncLinks(){ const hide=!!(G.account&&G.account.state==='in');
  for(const b of document.querySelectorAll('[data-sync-link]'))b.hidden=hide; }
G.on('account:in',syncLinks); G.on('account:out',syncLinks);
G.beta={ version:VERSION, openSync, openFeedback, ping };
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init); else init();
})();
