/* =========================================================================
   account.js — Keeper Accounts in the game: signing in and the account card.
   Spec: ACCOUNTS.md (section 6a). Switched on only by window.BQ_CONFIG.api together with
   window.BQ_CONFIG.accounts===true (test/build_release.py --accounts), and only when the page and the save
   service are on the same site (the session cookie is SameSite=Lax: an embedded copy, e.g. on itch.io, can't
   use it, so there the game stays exactly the guest game). Without all that this module shows nothing,
   sends nothing, and G.account.fetch is a plain call to the service with the guest's sync code.
   Quiet in ?headless test sessions unless the test sets window.BQ_ACCOUNTS_TEST=true before the page loads.

   - Sign in: one email field, then "Send link to email" (an email with a link and a six-digit code) or
     "Use password". The way this browser used last is tagged (localStorage 'bq-signin-last').
     A link opened in the browser (?signin=<token>) signs in on load; the token is taken out of the address.
   - The account card: email, keeper name, role (when not a player), set/change password, sign out, sign out
     everywhere, delete the account (type DELETE; a session older than 15 minutes is asked to sign in again
     with a code first), and the privacy page.
   - Button: "Sign in" / "Account" in the link row on the title and pause cards (.bq-links), after the
     Keepers' Board. Placed once the page has loaded and again on 'ready' / 'load', so any script order works.
   API: G.account = { on, available, state:'off'|'checking'|'out'|'in', me, ready, can(group), fetch(path,opts),
                      open(from), close(), signOut(everywhere), refresh(), debug }
   Events: 'account:in' {me, fresh}  'account:out' {why, id}  'account:me' {me} (me changed while signed in)
   ========================================================================= */
(function(){
'use strict';
const G=window.G; if(!G)return;
const CFG=window.BQ_CONFIG||{};
const API=String(CFG.api||'').replace(/\/+$/,'');
const LAST='bq-signin-last', TIMEOUT=15000, FIRST_TIMEOUT=30000;
let RESEND=30000;                                  // ms before "Send it again" wakes
const lsGet=k=>{ try{ return localStorage.getItem(k); }catch(_){ return null; } };
const lsSet=(k,v)=>{ try{ if(v==null)localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(_){} };

/* the session cookie only travels between the page and the service when both are on the same site */
function siteOf(host){ host=String(host||'').toLowerCase(); if(!host||/^[\d.]+$/.test(host)||host.indexOf(':')>=0)return host; const p=host.split('.'); return p.slice(-2).join('.'); }
const sameSite=(()=>{ try{ return !!API&&siteOf(new URL(API).hostname)===siteOf(location.hostname); }catch(_){ return false; } })();
const quiet=!!G.headless&&!window.BQ_ACCOUNTS_TEST;
const ON=!!API&&CFG.accounts===true&&sameSite&&!quiet;

const A={state:ON?'checking':'off',me:null,svcOff:false,offline:false,log:[]};
let readyDone=null; const ready=ON?new Promise(r=>{ readyDone=r; }):Promise.resolve('off');

/* the guest's sync code (cloud.js keeps it in localStorage 'bq-sync-key') */
function syncCode(){
  let c='';
  try{ if(G.cloud&&G.cloud.sync&&G.cloud.sync.code)c=String(G.cloud.sync.code()||''); }catch(_){}
  if(!c)c=lsGet('bq-sync-key')||'';
  return c.replace(/[^0-9A-Z]/gi,'').toUpperCase();
}

/* ---- the one way the game calls the service ---- */
function plainBody(b){ return b!=null&&typeof b==='object'&&!(typeof Blob!=='undefined'&&b instanceof Blob)&&!(typeof FormData!=='undefined'&&b instanceof FormData)
  &&!(typeof URLSearchParams!=='undefined'&&b instanceof URLSearchParams)&&!(b instanceof ArrayBuffer)&&!ArrayBuffer.isView(b); }
async function afetch(path,opts){
  opts=opts||{};
  const url=/^https?:\/\//.test(String(path))?String(path):API+String(path||'');
  const h=new Headers(opts.headers||{});
  let body=opts.body;
  if(plainBody(body)){ body=JSON.stringify(body); if(!h.has('Content-Type'))h.set('Content-Type','application/json'); }
  if(ON)h.set('X-BQ-Client','1');
  if(A.state!=='in'&&opts.auth!==false&&!h.has('Authorization')){ const c=syncCode(); if(c)h.set('Authorization','Bearer '+c); }
  const init={method:opts.method||'GET',headers:h,body,cache:'no-store',keepalive:!!opts.keepalive};
  if(ON)init.credentials='include';
  let ac=null, t=0;
  if(opts.signal)init.signal=opts.signal;
  else if(!opts.keepalive&&typeof AbortController==='function'&&opts.timeout!==0){
    ac=new AbortController(); init.signal=ac.signal;
    /* a page frozen by the island build wakes with the timer and the answer both waiting: give the answer two more turns */
    const late=n=>{ if(!ac)return; if(n<=0)ac.abort(); else t=setTimeout(()=>late(n-1),250); };
    t=setTimeout(()=>late(2),opts.timeout||TIMEOUT);
  }
  let r;
  try{ r=await fetch(url,init); }
  finally{ clearTimeout(t); ac=null; }
  if(ON&&r.status===401&&A.state==='in'){
    let d=null; try{ d=await r.clone().json(); }catch(_){}
    if(d&&d.error==='signed_out')setOut('expired');
  }
  return r;
}
/* a call with the answer read: {ok,status,error,data,retry} (status 0 = no connection) */
async function call(method,path,body,o){
  let r;
  try{ r=await afetch(path,Object.assign({method,body},o||{})); }
  catch(_){ A.log.push({m:method,p:path,status:0}); return {ok:false,status:0,error:'offline',data:null,retry:0}; }
  let d=null; try{ d=await r.json(); }catch(_){}
  A.log.push({m:method,p:path,status:r.status,error:d&&d.error||''}); if(A.log.length>60)A.log.shift();
  const ra=+(r.headers.get('Retry-After')||0);
  return {ok:r.ok,status:r.status,error:(d&&d.error)||(r.ok?'':'http_'+r.status),data:d,retry:ra>0?Math.ceil(ra):60};
}

/* ---- state ---- */
function setIn(me,fresh){
  const was=A.state; A.me=me; A.state='in'; A.offline=false; place();
  if(was!=='in')G.emit('account:in',{me,fresh:!!fresh}); else G.emit('account:me',{me});
}
function setMe(me){ if(A.state!=='in'||!me)return; A.me=me; place(); G.emit('account:me',{me}); }
/* why: 'expired' (the service no longer knows the session: signed out elsewhere, ended or disabled by the studio), 'signout',
   'deleted', 'off' (the service switched accounts off); id: the account that was signed in */
function setOut(why){
  const was=A.state, id=A.me&&A.me.id?String(A.me.id):''; A.me=null; A.state='out'; place();
  if(was==='in'){ G.emit('account:out',{why:why||'',id}); if(ui)ui.signedOut(why); }
}
const done=()=>{ if(readyDone){ const f=readyDone; readyDone=null; f(A.state); } };
async function refresh(){
  if(!ON)return A.state;
  const r=await call('GET','/v1/me',null,{timeout:FIRST_TIMEOUT});
  if(r.ok&&r.data&&r.data.id){ A.svcOff=false; setIn(r.data,false); }
  else if(r.status===401){ A.svcOff=false; A.offline=false; setOut('expired'); }
  else if(r.status===503){ A.svcOff=true; setOut('off'); }            // the service has accounts switched off: no button
  else { A.offline=true; if(A.state==='checking'){ A.state='out'; place(); } }   // unreachable: a signed-in player stays in
  return A.state;
}
const can=g=>!!(A.state==='in'&&A.me&&Array.isArray(A.me.tools)&&A.me.tools.indexOf(g)>=0);
async function signOut(everywhere){
  if(!ON)return {ok:false,why:'off'};
  const r=await call('POST','/v1/auth/signout',everywhere?{everywhere:true}:{});
  if(r.ok||r.status===401){ setOut('signout'); return {ok:true}; }
  return {ok:false,why:why(r),wait:r.retry};
}

/* ---- the words ---- */
function waitText(s){ s=Math.max(1,s|0); return s>90?Math.ceil(s/60)+' minutes':s+(s===1?' second':' seconds'); }
function why(r){
  if(r.status===0)return 'offline';
  if(r.status===429)return 'rate';
  if(r.status===503)return 'accounts_off';
  if(r.status>=500)return 'server';
  return r.error||'server';
}
const SAY={
  offline:'Couldn’t reach the save service. Check your connection and try again.',
  server:'The save service isn’t answering properly just now. Try again in a minute.',
  accounts_off:'Accounts aren’t available just now. You can keep playing as a guest.',
  bad_email:'That doesn’t look like an email address.',
  bad_code:'That code isn’t right.',
  expired:'That code has expired or has already been used. Send yourself a new one.',
  bad_login:'That email and password don’t match. If you’ve forgotten the password, sign in with an emailed link instead.',
  disabled:'This account is switched off. If that seems wrong, tell us through Send feedback.',
  bad_origin:'This copy of the game can’t sign in. Open the game from its own page.',
  name_taken:'That name is taken. Try another.',
  name_invalid:'That name isn’t allowed. Use 3 to 16 letters, numbers, spaces, - _ or \', and nothing rude.',
  weak_password:'Choose a longer password: at least 10 characters, and not a common one.',
  bad_current:'Your current password isn’t right.',
  signed_out:'You’ve been signed out. Sign in again to carry on.',
  bad_request:'That didn’t work. Please try again.'
};
const say=(w,r)=>w==='rate'?'Too many tries in a short time. Wait '+waitText(r&&r.retry||60)+' and try again.'
  :w==='bad_code'&&r&&r.data&&r.data.left!=null?'That code isn’t right. '+(+r.data.left)+((+r.data.left)===1?' try':' tries')+' left.'
  :SAY[w]||SAY.server;

/* ---- styles: only in a build with accounts on ---- */
const STYLE=`
#accountCard{z-index:7;align-items:flex-start}
#accountCard .sheet{gap:14px;margin-block:auto;max-width:480px}
#accountCard [hidden]{display:none!important}
#accountCard .ac-body,#accountCard form{display:grid;gap:14px;margin:0}
#accountCard p{font-size:16.5px}
#accountCard label{font:600 13px var(--body);letter-spacing:.06em;color:#6c3f5f;display:grid;gap:6px}
#accountCard .ac-field{position:relative;display:block}
#accountCard .ac-field>svg{position:absolute;left:12px;top:50%;width:18px;height:18px;margin-top:-9px;color:#6c3f5f;pointer-events:none}
#accountCard input{font:400 17px var(--body);color:#21161f;background:rgba(255,252,244,.75);border:1px solid rgba(60,40,30,.45);
  border-radius:2px;padding:10px 12px;width:100%;box-sizing:border-box;-webkit-user-select:text;user-select:text}
#accountCard .ac-field input{padding-left:40px}
#accountCard .ac-field.eye input{padding-right:46px}
#accountCard input:focus-visible{outline:2px solid var(--ether);outline-offset:2px}
#accountCard .ac-eye{position:absolute;right:4px;top:50%;margin-top:-17px;width:38px;height:34px;display:grid;place-items:center;background:none;border:0;
  color:#6c3f5f;cursor:pointer;border-radius:2px;padding:0}
#accountCard .ac-eye svg{width:20px;height:20px}
#accountCard .ac-eye:focus-visible{outline:2px solid var(--ether);outline-offset:1px}
#accountCard .ac-two{display:grid;grid-template-columns:1.2fr 1fr;gap:10px}
#accountCard .ac-two .btn,#accountCard .ac-wide{position:relative;padding:12px 10px;font-size:15.5px;line-height:1.2;text-align:center}
#accountCard .ac-wide{width:100%}
#accountCard .ac-last{position:absolute;top:-9px;right:8px;font:700 10px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;
  background:#c8a24c;color:#21161f;padding:4px 7px 3px;border-radius:9px;box-shadow:0 1px 2px rgba(0,0,0,.25);pointer-events:none}
#accountCard .ac-links{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 22px}
#accountCard .ac-links.ac-end{justify-content:flex-end;margin-top:-6px}
#accountCard .ac-link{font:600 14.5px var(--body);letter-spacing:.02em;background:none;border:0;border-bottom:1px dashed rgba(108,63,95,.6);color:#6c3f5f;
  padding:2px 0;cursor:pointer;text-decoration:none}
#accountCard .ac-link:disabled{color:#9a8a90;border-bottom-color:rgba(108,63,95,.25);cursor:default}
#accountCard .ac-link:focus-visible{outline:2px solid var(--ether);outline-offset:3px}
#accountCard .ac-code{font:600 30px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.42em;text-align:center;padding:10px 0 10px .42em;max-width:270px;justify-self:center}
#accountCard .savenote{font-size:14.5px;color:#6c3f5f;min-height:1.2em}
#accountCard .savenote:empty{display:none}
#accountCard .savenote.bad{color:#8f2f45}
#accountCard .ac-fine{font-size:13.5px;color:#6c5a5f;line-height:1.45}
#accountCard .ac-who{display:grid;gap:4px;padding:10px 12px;border:1px solid rgba(60,40,30,.25);border-radius:2px;background:rgba(255,252,244,.45)}
#accountCard .ac-who b{font:600 17px var(--body);color:#21161f;overflow-wrap:anywhere}
#accountCard .ac-who small{font-size:13.5px;color:#6c5a5f}
#accountCard .ac-role{justify-self:start;font:700 11px var(--body);letter-spacing:.14em;text-transform:uppercase;color:#4b3863;background:rgba(75,56,99,.14);padding:3px 8px;border-radius:9px}
#accountCard .ac-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
#accountCard .ac-row .btn{padding:10px 16px}
#accountCard .btn.ac-danger{color:#8f2f45;border-color:rgba(143,47,69,.55)}
#accountCard .btn.ac-danger.solid{background:#8f2f45;color:var(--bone);border-color:#8f2f45}
#accountCard .btn:disabled{opacity:.5;cursor:default;filter:none}
#accountCard .actions{gap:10px}
#accountCard .rule{margin:2px 0}
.bq-links button[data-account-link]{font:600 12.5px var(--body);letter-spacing:.12em;text-transform:uppercase;background:none;border:0;
  border-bottom:1px dashed rgba(108,63,95,.6);color:#6c3f5f;padding:2px 0;cursor:pointer}
.bq-links button[data-account-link]:focus-visible{outline:2px solid var(--ether);outline-offset:3px}
#title .bq-links button[data-account-link]{color:#cbbfd6;border-bottom-color:rgba(203,191,214,.5)}
@media (max-width:520px){
  #accountCard .sheet{padding:22px 16px 20px}
  #accountCard .ac-two{gap:8px} #accountCard .ac-two .btn{padding:12px 6px;font-size:15px}
  #accountCard .actions .btn{padding:10px 14px}
  #accountCard .ac-row{grid-template-columns:1fr} #accountCard .ac-row .btn{justify-self:start}
}`;

/* ---- icons (inline, stroke follows currentColor) ---- */
const svg=p=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
const ICON={
  mail:svg('<rect x="3" y="5.5" width="18" height="13" rx="1.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  lock:svg('<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  eye:svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:svg('<path d="M3 3l18 18"/><path d="M10.6 5.6A10.6 10.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.3 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>')
};

const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; };
const EMAIL_RE=/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const NAME_RE=/^[A-Za-z0-9 _'\-]{3,16}$/;
const cleanEmail=t=>String(t||'').trim();
const cleanName=t=>String(t||'').replace(/[‘’]/g,"'").trim().replace(/\s+/g,' ');
const roleName=r=>r==='admin'?'Admin':r==='tester'?'Tester':'';
function dateText(v){ if(v==null||v==='')return ''; const d=new Date(typeof v==='number'?v:String(v)); if(isNaN(d))return '';
  try{ return d.toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'}); }catch(_){ return d.toDateString(); } }

/* ---- the card ---- */
let ui=null;
function buildCard(){
  const card=el('div','card sub bq-card'); card.id='accountCard'; card.hidden=true;
  card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true');
  const sheet=el('div','sheet'); card.appendChild(sheet);
  sheet.appendChild(el('span','eyebrow','Brave Quest · Lighthouse'));
  const h=el('h2'); h.id='accountTitle'; sheet.appendChild(h); card.setAttribute('aria-labelledby','accountTitle');
  const body=el('div','ac-body'); sheet.appendChild(body);
  const V={};
  const view=(id,tag)=>{ const v=el(tag||'div','ac-body'); v.dataset.view=id; body.appendChild(v); V[id]=v; if(tag==='form')v.noValidate=true; return v; };
  const btn=(host,text,cls,id,type)=>{ const b=el('button',cls||'btn',text); b.type=type||'button'; if(id)b.id=id; host.appendChild(b); return b; };
  const linkB=(host,text,id)=>btn(host,text,'ac-link',id);
  const field=(labelText,icon,input,eye)=>{ const l=el('label',null,labelText); const f=el('span','ac-field'+(eye?' eye':'')); f.innerHTML=icon; f.appendChild(input); l.appendChild(f); return {label:l,wrap:f}; };
  const textInput=(o)=>{ const i=el('input'); i.type=o.type||'text'; for(const k in o.attrs||{})i.setAttribute(k,o.attrs[k]); return i; };   // core.js keeps typed keys from the game
  const eyeToggle=(wrap,input)=>{ const b=el('button','ac-eye'); b.type='button'; b.setAttribute('aria-label','Show password'); b.innerHTML=ICON.eye; wrap.appendChild(b);
    b.addEventListener('click',()=>{ const show=input.type==='password'; input.type=show?'text':'password'; b.innerHTML=show?ICON.eyeOff:ICON.eye;
      b.setAttribute('aria-label',show?'Hide password':'Show password'); b.setAttribute('aria-pressed',String(show)); }); return b; };
  const lastTag=()=>{ const s=el('span','ac-last','Last used'); return s; };

  /* -- email: the first view -- */
  const E=view('email','form');
  const eIntro=el('p',null,'An account keeps your saves and your keeper name with you on any device. You don’t need one to play.');
  const eMail=textInput({attrs:{inputmode:'email',autocomplete:'email',autocapitalize:'off',autocorrect:'off',spellcheck:'false',maxlength:'254',placeholder:'you@example.com',name:'email'}});
  const eF=field('Email address',ICON.mail,eMail);
  const eTwo=el('div','ac-two');
  const eLink=btn(eTwo,'Send link to email','btn','acSendLink','submit'), ePw=btn(eTwo,'Use password','btn ghost','acUsePw');
  const eLinks=el('div','ac-links'); const eGuest=linkB(eLinks,'Keep playing as a guest','acGuest');
  E.append(eIntro,eF.label,eTwo,eLinks);

  /* -- password -- */
  const P=view('password','form');
  const pMail=textInput({attrs:{inputmode:'email',autocomplete:'username',autocapitalize:'off',autocorrect:'off',spellcheck:'false',maxlength:'254',name:'email'}});
  const pF=field('Email address',ICON.mail,pMail);
  const pPw=textInput({type:'password',attrs:{autocomplete:'current-password',maxlength:'200',name:'password'}});
  const pPF=field('Password',ICON.lock,pPw,true); const pEye=eyeToggle(pPF.wrap,pPw);
  const pEnd=el('div','ac-links ac-end'); const pForgot=linkB(pEnd,'Forgot password?','acForgot');
  const pSign=btn(P,'Sign in','btn ac-wide','acPwSignIn','submit'); P.removeChild(pSign);
  const pLinks=el('div','ac-links'); const pInstead=linkB(pLinks,'Email me a sign-in link instead','acInstead'); const pBack=linkB(pLinks,'Back','acPwBack');
  P.append(pF.label,pPF.label,pEnd,pSign,pLinks);

  /* -- check your email: the code -- */
  const C=view('code','form');
  const cIntro=el('p'); const cFine=el('p','ac-fine','The email has a link and a six-digit code; either signs you in, once, within 15 minutes. Opened the link on another device? Enter the code here instead.');
  const cCode=textInput({attrs:{inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]*',maxlength:'7',placeholder:'••••••','aria-label':'Six-digit code',name:'code'}});
  cCode.classList.add('ac-code');
  const cLbl=el('label',null,'Six-digit code'); cLbl.appendChild(cCode);
  const cSign=btn(C,'Sign in','btn ac-wide','acCodeSignIn','submit'); C.removeChild(cSign);
  const cLinks=el('div','ac-links'); const cResend=linkB(cLinks,'Send it again','acResend'); const cOther=linkB(cLinks,'Use a different email','acOther');
  C.append(cIntro,cLbl,cSign,cLinks,cFine);

  /* -- a link opened in the browser: signed in / expired -- */
  const L=view('linked');
  const lText=el('p'); const lAct=el('div','actions'); const lGo=btn(lAct,'Carry on','btn','acLinkedGo'); const lNew=btn(lAct,'Not now','btn ghost','acLinkedNo');
  L.append(lText,lAct);

  /* -- the account -- */
  const M=view('account');
  const mWho=el('div','ac-who'); const mEmail=el('b'); const mRole=el('span','ac-role'); const mSince=el('small');
  mWho.append(el('small',null,'Signed in as'),mEmail,mRole,mSince);
  const mForm=el('form'); mForm.noValidate=true;
  const mName=textInput({attrs:{maxlength:'16',autocomplete:'off',spellcheck:'false',autocapitalize:'words',placeholder:'3 to 16 letters or numbers',name:'keeper'}});
  const mNameL=el('label',null,'Keeper name'); const mRow=el('div','ac-row'); mRow.appendChild(mName); const mNameB=btn(mRow,'Save name','btn ghost','acSaveName','submit');
  mNameL.appendChild(mRow); const mNameFine=el('p','ac-fine','Shown on the Keepers’ Board when you join it. Leave it empty to have none.');
  mForm.append(mNameL,mNameFine);
  const mAct=el('div','actions');
  const mPw=btn(mAct,'Set a password','btn ghost','acPassword'), mOut=btn(mAct,'Sign out','btn ghost','acSignOut'), mAll=btn(mAct,'Sign out everywhere','btn ghost','acSignOutAll');
  const mRule=el('div','rule');
  const mEnd=el('div','actions'); const mBack=btn(mEnd,'Back','btn','acBack'); const mDel=btn(mEnd,'Delete my account','btn ghost ac-danger','acDelete');
  const mPriv=el('p','ac-fine'); const privA=el('a','ac-link','Privacy: what an account stores'); privA.href='privacy.html'; privA.target='_blank'; privA.rel='noopener'; mPriv.appendChild(privA);
  M.append(mWho,mForm,mAct,mRule,mEnd,mPriv);

  /* -- set / change password -- */
  const S=view('setpw','form');
  const sIntro=el('p');
  const sCur=textInput({type:'password',attrs:{autocomplete:'current-password',maxlength:'200',name:'current'}});
  const sCurF=field('Current password',ICON.lock,sCur,true); eyeToggle(sCurF.wrap,sCur);
  const sNew=textInput({type:'password',attrs:{autocomplete:'new-password',maxlength:'200',name:'new-password'}});
  const sNewF=field('New password',ICON.lock,sNew,true); eyeToggle(sNewF.wrap,sNew);
  const sFine=el('p','ac-fine','At least 10 characters. A few unrelated words make a good one.');
  const sAct=el('div','actions'); const sSave=btn(sAct,'Save password','btn','acPwSave','submit'); const sBack=btn(sAct,'Back','btn ghost','acPwCancel');
  S.append(sIntro,sCurF.label,sNewF.label,sFine,sAct);

  /* -- delete -- */
  const D=view('delete','form');
  const dText=el('p',null,'This deletes your account for good: its save slots, its record and its keeper name. It can’t be undone. You can still play as a guest afterwards.');
  const dIn=textInput({attrs:{autocomplete:'off',spellcheck:'false',autocapitalize:'characters',maxlength:'12',name:'confirm'}});
  const dL=el('label',null,'Type DELETE to confirm'); dL.appendChild(dIn);
  const dAct=el('div','actions'); const dGo=btn(dAct,'Delete my account','btn ac-danger solid','acDelGo','submit'); const dBack=btn(dAct,'Back','btn ghost','acDelBack');
  D.append(dText,dL,dAct);

  /* -- sign in again (a set-password or delete that needs a fresh session) -- */
  const R=view('reauth');
  const rText=el('p'); const rAct=el('div','actions'); const rGo=btn(rAct,'Email me a code','btn','acReGo'); const rBack=btn(rAct,'Back','btn ghost','acReBack');
  R.append(rText,rAct);

  const note=el('p','savenote'); note.setAttribute('role','status'); note.setAttribute('aria-live','polite'); body.appendChild(note);
  document.body.appendChild(card);

  let cur='email', from='title', opener=null, busy=false, chal=null, email='', reauthFor='', resendAt=0, tick=0, lastSent='';
  const BACK={email:'acGuest',password:'acPwBack',code:'acOther',linked:'acLinkedNo',account:'acBack',setpw:'acPwCancel',delete:'acDelBack',reauth:'acReBack'};
  const TITLE={email:'Sign in',password:'Sign in',code:'Check your email',account:'Your account',delete:'Delete account',reauth:'Sign in again'};
  /* the status line sits under the control it answers (the name field, the code, the buttons), not at the foot of the card */
  const NOTE_AT={email:eTwo,password:pSign,code:cLbl,linked:lText,account:mForm,setpw:sFine,delete:dL,reauth:rText};
  const noteAt=x=>{ if(x&&x.parentNode&&x.nextSibling!==note)x.after(note); };
  const tell=(t,bad,at)=>{ note.textContent=t||''; note.classList.toggle('bad',!!bad); if(at)noteAt(at); };
  function focus(x){ if(!x||x.hidden||x.disabled)return; try{ x.focus({preventScroll:false}); }catch(_){} }
  const mobile=()=>!!G.isMobile;
  function show(v,o){
    o=o||{}; cur=v; for(const k in V)V[k].hidden=k!==v; card.scrollTop=0;
    noteAt(NOTE_AT[v]);
    if(!o.keep)tell('');
    card.dataset.padBack=BACK[v];
    if(TITLE[v])h.textContent=v==='code'&&reauthFor?'Sign in again':TITLE[v];
    render();
    if(o.focus!==false)focus(o.focus||defaultFocus(v));
  }
  function defaultFocus(v){
    if(v==='email')return mobile()||cleanEmail(eMail.value)?eLink:eMail;
    if(v==='password')return mobile()?pSign:cleanEmail(pMail.value)?pPw:pMail;
    if(v==='code')return mobile()?cSign:cCode;
    if(v==='linked')return lGo;
    if(v==='account')return mBack;
    if(v==='setpw')return mobile()?sSave:A.me&&A.me.hasPassword?sCur:sNew;
    if(v==='delete')return mobile()?dBack:dIn;
    if(v==='reauth')return rGo;
    return null;
  }
  function tags(){
    const last=lsGet(LAST);
    for(const [b,k] of [[eLink,'link'],[ePw,'password']]){ const t=b.querySelector('.ac-last'); if(last===k&&!t)b.appendChild(lastTag()); else if(last!==k&&t)t.remove(); }
  }
  function render(){
    tags();
    if(cur==='code'){
      cIntro.textContent=''; cIntro.append('If that address is right, an email is on its way to ');
      cIntro.appendChild(el('b',null,email)); cIntro.append('. It can take a minute; check the spam folder too.');
      cOther.textContent=reauthFor?'Back':'Use a different email';
      const left=Math.ceil((resendAt-Date.now())/1000);
      cResend.disabled=busy||left>0; cResend.textContent=left>0?'Send it again in '+left+' s':'Send it again';
    }
    if(cur==='account'&&A.me){
      const me=A.me; mEmail.textContent=me.email||'';
      const rn=roleName(me.role); mRole.hidden=!rn; mRole.textContent=rn?'Role: '+rn:'';
      const d=dateText(me.created); mSince.hidden=!d; mSince.textContent=d?'Account since '+d:'';
      mPw.textContent=me.hasPassword?'Change password':'Set a password';
    }
    if(cur==='setpw'){
      const has=!!(A.me&&A.me.hasPassword);
      h.textContent=has?'Change password':'Set a password';
      sIntro.textContent=has?'Enter your current password, then the new one. Signing in with an emailed link keeps working too.'
        :'A password lets you sign in without waiting for an email. Emailed links keep working too.';
      sCurF.label.hidden=!has;
    }
    if(cur==='delete')dGo.disabled=busy||dIn.value.trim().toUpperCase()!=='DELETE';
    if(cur==='reauth')rText.textContent='For your safety, '+(reauthFor==='delete'?'deleting your account':'setting a password')+' needs a sign-in from the last few minutes. We’ll email a code to '+(A.me&&A.me.email||'you')+'.';
    for(const x of [eLink,ePw,eGuest,pSign,pForgot,pInstead,pBack,cSign,cOther,lGo,lNew,mNameB,mPw,mOut,mAll,mDel,mBack,sSave,sBack,dBack,rGo,rBack,eMail,pMail,pPw,cCode,mName,sCur,sNew,dIn])x.disabled=busy;
    if(cur==='delete')dGo.disabled=busy||dIn.value.trim().toUpperCase()!=='DELETE';
    if(cur==='code'){ const left=Math.ceil((resendAt-Date.now())/1000); cResend.disabled=busy||left>0; }
  }
  async function run(fn){ busy=true; tell('One moment…'); render(); let r; try{ r=await fn(); }catch(_){ r={ok:false,status:0,error:'offline'}; } busy=false; tell(''); render(); return r; }
  function startTick(){ clearInterval(tick);
    const step=()=>{ if(card.hidden||cur!=='code'){ clearInterval(tick); tick=0; return; } render(); if(Date.now()>=resendAt){ clearInterval(tick); tick=0; } };
    tick=setInterval(step,1000); setTimeout(step,Math.max(0,resendAt-Date.now())+30); }
  function signedIn(me,how){
    lsSet(LAST,how);
    if(!me||!me.id){ refresh().then(()=>afterSignIn()); return; }
    const again=A.state==='in';
    setIn(me,true); afterSignIn(again);
  }
  function afterSignIn(again){
    if(A.state!=='in'){ show('email'); tell(SAY.server,true); return; }
    if(reauthFor){ const v=reauthFor; reauthFor=''; mName.value=A.me.name||''; show(v==='delete'?'delete':'setpw'); tell('Thanks. Now '+(v==='delete'?'type DELETE to confirm.':'choose your password.')); return; }
    mName.value=A.me.name||''; show('account'); tell(again?'Signed in again.':'You’re signed in. Welcome, keeper.',false,mWho);
  }

  /* send a link + code to an address */
  async function sendLink(addr,o){
    o=o||{};
    addr=cleanEmail(addr);
    if(!EMAIL_RE.test(addr)){ tell(SAY.bad_email,true); focus(o.field||eMail); return; }
    const r=await run(()=>call('POST','/v1/auth/start',{email:addr}));
    if(r.ok&&r.data&&r.data.id){ chal=String(r.data.id); email=addr; eMail.value=addr; pMail.value=addr; cCode.value=''; lastSent='';
      resendAt=Date.now()+RESEND; show('code'); startTick(); if(o.again)tell('Sent again. Use the code from the newest email.'); return true; }
    tell(say(why(r),r),true); focus(o.field||(cur==='code'?cResend:eMail)); return false;
  }
  E.addEventListener('submit',e=>{ e.preventDefault(); if(!busy)sendLink(eMail.value); });
  ePw.addEventListener('click',()=>{ pMail.value=cleanEmail(eMail.value); pPw.value=''; show('password'); });
  eGuest.addEventListener('click',()=>close());
  P.addEventListener('submit',async e=>{ e.preventDefault(); if(busy)return;
    const addr=cleanEmail(pMail.value), pw=pPw.value;
    if(!EMAIL_RE.test(addr)){ tell(SAY.bad_email,true); focus(pMail); return; }
    if(!pw){ tell('Enter your password.',true); focus(pPw); return; }
    const r=await run(()=>call('POST','/v1/auth/password',{email:addr,password:pw}));
    if(r.ok){ pPw.value=''; eMail.value=addr; signedIn(r.data&&r.data.me,'password'); return; }
    tell(say(why(r),r),true); focus(pPw); });
  pForgot.addEventListener('click',()=>{ if(!busy)sendLink(pMail.value,{field:pMail}); });
  pInstead.addEventListener('click',()=>{ if(!busy)sendLink(pMail.value,{field:pMail}); });
  pBack.addEventListener('click',()=>{ eMail.value=cleanEmail(pMail.value)||eMail.value; show('email'); });
  async function sendCode(){
    const code=cCode.value.replace(/\D/g,'');
    if(!/^\d{6}$/.test(code)){ tell('The code is six digits.',true); focus(cCode); return; }
    if(!chal){ tell(SAY.expired,true); return; }
    lastSent=code;
    const r=await run(()=>call('POST','/v1/auth/code',{id:chal,code}));
    if(r.ok){ chal=null; clearInterval(tick); signedIn(r.data&&r.data.me,'link'); return; }
    const w=why(r);
    if(w==='expired'||r.status===410){ chal=null; resendAt=0; render(); tell(SAY.expired,true); focus(cResend); return; }
    tell(say(w,r),true); cCode.value=''; focus(cCode);
  }
  C.addEventListener('submit',e=>{ e.preventDefault(); if(!busy)sendCode(); });
  cCode.addEventListener('input',()=>{ const d=cCode.value.replace(/\D/g,'').slice(0,6); if(cCode.value!==d)cCode.value=d;
    if(d.length===6&&!busy&&d!==lastSent)sendCode(); });
  cResend.addEventListener('click',()=>{ if(!busy&&Date.now()>=resendAt)sendLink(email,{again:true}); });
  cOther.addEventListener('click',()=>{ clearInterval(tick); chal=null;
    if(reauthFor){ const v=reauthFor; reauthFor=''; show(v==='delete'?'delete':'setpw'); return; }
    show('email',{focus:eMail}); try{ eMail.select(); }catch(_){} });
  lGo.addEventListener('click',()=>{ if(lGo.dataset.act==='new'){ show('email'); return; } close(); });
  lNew.addEventListener('click',()=>close());

  /* account */
  mForm.addEventListener('submit',async e=>{ e.preventDefault(); if(busy||!A.me)return;
    const n=cleanName(mName.value);
    if(n===(A.me.name||'')){ tell(n?'That’s already your keeper name.':'You have no keeper name.'); return; }
    if(n&&(!NAME_RE.test(n)||!/[A-Za-z0-9]/.test(n))){ tell(n.length<3||n.length>16?'A keeper name is 3 to 16 characters.':SAY.name_invalid,true); focus(mName); return; }
    const r=await run(()=>call('PUT','/v1/me',{name:n}));
    if(r.ok){ const me=r.data&&r.data.me&&r.data.me.id?r.data.me:Object.assign({},A.me,{name:r.data&&typeof r.data.name==='string'?r.data.name:n});
      setMe(me); mName.value=me.name||''; tell(me.name?'Your keeper name is now '+me.name+'.':'Your keeper name is cleared.'); return; }
    tell(say(why(r),r),true); focus(mName); });
  mPw.addEventListener('click',()=>{ sCur.value=''; sNew.value=''; show('setpw'); });
  mOut.addEventListener('click',async()=>{ const r=await run(()=>signOut(false)); if(r.ok){ show('email'); tell('You’re signed out. The game carries on as a guest.'); } else tell(say(r.why,{retry:r.wait}),true,mAct); });
  mAll.addEventListener('click',async()=>{ const r=await run(()=>signOut(true)); if(r.ok){ show('email'); tell('You’re signed out on every device.'); } else tell(say(r.why,{retry:r.wait}),true,mAct); });
  mDel.addEventListener('click',()=>{ dIn.value=''; show('delete'); });
  mBack.addEventListener('click',()=>close());
  S.addEventListener('submit',async e=>{ e.preventDefault(); if(busy||!A.me)return;
    const has=!!A.me.hasPassword, nw=sNew.value, cu=sCur.value;
    if(has&&!cu){ tell('Enter your current password.',true); focus(sCur); return; }
    if(nw.length<10){ tell(SAY.weak_password,true); focus(sNew); return; }
    const pw={new:nw}; if(has)pw.current=cu;
    const r=await run(()=>call('PUT','/v1/me',{password:pw}));
    if(r.ok){ sCur.value=''; sNew.value=''; const me=r.data&&r.data.me&&r.data.me.id?r.data.me:Object.assign({},A.me,{hasPassword:true}); setMe(me);
      show('account'); tell(has?'Password changed. Other devices have been signed out.':'Password set. You can sign in with it from now on.',false,mAct); return; }
    if(r.status===403&&r.error==='reauth'){ reauthFor='setpw'; show('reauth'); return; }
    const w=why(r); tell(say(w==='bad_login'?'bad_current':w,r),true); focus(w==='bad_login'?sCur:sNew); });
  sBack.addEventListener('click',()=>{ sCur.value=''; sNew.value=''; show('account'); });
  dIn.addEventListener('input',render);
  D.addEventListener('submit',async e=>{ e.preventDefault(); if(busy||!A.me)return;
    if(dIn.value.trim().toUpperCase()!=='DELETE'){ tell('Type DELETE to confirm.',true); focus(dIn); return; }
    const r=await run(()=>call('DELETE','/v1/me'));
    if(r.ok){ dIn.value=''; setOut('deleted'); show('email'); eMail.value=''; tell('Your account is deleted. You can keep playing as a guest.'); return; }
    if(r.status===403&&r.error==='reauth'){ reauthFor='delete'; show('reauth'); return; }
    tell(r.status===409||r.error==='super'?'This account can’t be deleted from the game.':say(why(r),r),true); });
  dBack.addEventListener('click',()=>{ dIn.value=''; show('account'); });
  rGo.addEventListener('click',()=>{ if(!busy&&A.me)sendLink(A.me.email,{field:rGo}); });
  rBack.addEventListener('click',()=>{ const v=reauthFor; reauthFor=''; show(v==='delete'?'delete':'setpw'); });

  /* Escape = the view's back button (text fields keep their own keys: core.js stops them before this) */
  document.addEventListener('keydown',e=>{ if(card.hidden||e.key!=='Escape')return; e.preventDefault(); e.stopPropagation(); const b=$(BACK[cur]); if(b&&!b.disabled)b.click(); },true);
  G.on('mode',e=>{ if(e&&e.mode==='play'&&!card.hidden){ card.hidden=true; clearInterval(tick); } });   // the game resumed underneath

  function close(){
    card.hidden=true; clearInterval(tick); tick=0;
    const f=$(from); if(f&&(from!=='pause'||G.state.mode==='paused'))f.hidden=false;
    if(opener&&opener.isConnected)focus(opener);
  }
  function open(f,b,o){
    o=o||{};
    from=f||(G.state.mode==='paused'?'pause':'title'); opener=b||null; busy=false;
    const fc=$(from); if(fc)fc.hidden=true; card.hidden=false;
    if(o.view==='linked'){ h.textContent=o.ok?'Signed in':'That link has expired';
      lText.textContent=o.ok?'Welcome, keeper. You’re signed in as '+(A.me&&A.me.email||'')+'.'
        :o.why==='offline'?'Couldn’t reach the save service to finish signing in. Check your connection, then open the link again or ask for a new one.'
        :o.why==='rate'?'Too many tries in a short time. Wait '+waitText(o.wait||60)+', then send yourself a new link.'
        :'Sign-in links work once, within 15 minutes. Send yourself a new one: it only takes a moment.';
      lGo.textContent=o.ok?'Carry on':'Send a new link'; lGo.dataset.act=o.ok?'':'new'; lNew.hidden=!!o.ok;
      show('linked'); card.dataset.padBack=o.ok?'acLinkedGo':'acLinkedNo'; return; }
    if(A.state==='in'){ mName.value=A.me&&A.me.name||''; show('account'); }
    else { if(!o.keepEmail)pPw.value=''; show('email'); if(A.offline)tell('Couldn’t reach the save service just now; you can still try.'); }
  }
  return {
    open, close, get view(){ return card.hidden?'':cur; },
    signedOut(w){ if(card.hidden)return; reauthFor=''; if(w==='deleted')return; show('email'); tell(SAY.signed_out,true); },
    refreshView(){ if(!card.hidden&&!busy)render(); }
  };
}

/* ---- the button in the link row (title and pause cards) ---- */
function place(){
  if(!ON)return;
  for(const [sel,from] of [['#title .title-sheet','title'],['#pause .sheet','pause']]){
    const host=document.querySelector(sel); if(!host)continue;
    let row=host.querySelector(':scope > .bq-links'); if(!row){ row=el('div','bq-links'); host.appendChild(row); }
    let b=row.querySelector('[data-account-link]');
    if(!b){ b=el('button'); b.type='button'; b.dataset.accountLink=from; const me=b; b.addEventListener('click',()=>open(from,me)); }
    b.textContent=A.state==='in'?'Account':'Sign in';
    b.hidden=A.svcOff;
    /* Sync devices, Send feedback, Keepers' Board, then this: after the board button, else after feedback, else before the version */
    const board=row.querySelector(':scope > [data-board-link]');
    const fb=[...row.querySelectorAll(':scope > button')].find(x=>/feedback/i.test(x.textContent));
    const ver=row.querySelector(':scope > .bq-ver');
    const after=board||fb;
    if(after){ if(after.nextElementSibling!==b)after.after(b); }
    else if(ver){ if(ver.previousElementSibling!==b)row.insertBefore(b,ver); }
    else if(b.parentNode!==row||row.lastElementChild!==b)row.appendChild(b);
  }
  if(ui)ui.refreshView();
}

async function open(from,btn){
  if(!ON)return false;
  if(!ui)ui=buildCard();
  if(A.state==='checking'){ await ready; }
  else if(A.offline){ await refresh(); }
  ui.open(from,btn);
  return true;
}
function close(){ if(ui&&ui.view)ui.close(); }

/* ---- start: the link in the address, else the session ---- */
let linkToken='';
if(ON){
  try{
    const t=new URLSearchParams(location.search).get('signin');
    if(t!=null){ linkToken=t.slice(0,200);       // the rest of the address stays exactly as it was (?debug, ?headless have no '=')
      const q=location.search.replace(/^\?/,'').split('&').filter(x=>x&&!/^signin(=|$)/.test(x)).join('&');
      history.replaceState(history.state,'',location.pathname+(q?'?'+q:'')+location.hash); }
  }catch(_){}
}
let booted=false;
async function boot(){
  if(booted||!ON)return; booted=true;
  if(linkToken){
    const t=linkToken; linkToken='';
    const r=await call('POST','/v1/auth/link',{token:t},{timeout:FIRST_TIMEOUT});
    if(r.ok&&r.data&&r.data.me&&r.data.me.id){ lsSet(LAST,'link'); setIn(r.data.me,true); done(); showLinked({ok:true}); return; }
    if(r.ok){ lsSet(LAST,'link'); await refresh(); done(); showLinked({ok:A.state==='in'}); return; }
    const w=why(r);
    await refresh(); done();
    if(A.state==='in'){ showLinked({ok:true}); return; }    // an old link, but this browser was signed in already
    showLinked({ok:false,why:w,wait:r.retry});
    return;
  }
  await refresh(); done();
}
function showLinked(o){
  const go=()=>{ if(!ui)ui=buildCard(); ui.open(G.state.mode==='paused'?'pause':'title',null,Object.assign({view:'linked'},o)); };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go); else go();
}

if(ON){
  const css=el('style'); css.textContent=STYLE; document.head.appendChild(css);
  const later=()=>setTimeout(place,0);          // after every DOMContentLoaded handler, so beta.js's row (if any) is there
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',later); else later();
  G.on('ready',()=>{ place(); boot(); });
  window.addEventListener('load',()=>{ place(); setTimeout(boot,4000); });   // in case 'ready' never comes
  window.addEventListener('online',()=>{ if(A.offline)refresh(); });
}

G.account={
  on:ON,
  get available(){ return ON&&!A.svcOff; },      // on, and the service has accounts switched on (it answered 503 accounts_off otherwise)
  get state(){ return A.state; },
  get me(){ return A.me; },
  ready, can, fetch:afetch, open, close, signOut, refresh,
  debug:{
    get view(){ return ui?ui.view:''; },
    get log(){ return A.log.slice(); },
    get last(){ return lsGet(LAST); },
    resend(ms){ if(ms!=null)RESEND=Math.max(0,+ms||0); return RESEND; },
    get offline(){ return A.offline; }, get svcOff(){ return A.svcOff; },
    sameSite, quiet, siteOf, syncCode
  }
};
})();
