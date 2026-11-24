(function(){
'use strict';
/* ---------- constants ---------- */
var SIZE=25, AP_MIN=20*60, WIN_END=22*60+15, START_STABILITY=3, EXTEND_COST=2;
var TZS=[['America/Chicago','Central US (Chicago)'],['America/New_York','Eastern US (New York)'],['America/Denver','Mountain US (Denver)'],['America/Los_Angeles','Pacific US (Los Angeles)'],['UTC','UTC'],['Europe/London','United Kingdom (London)'],['Europe/Berlin','Central Europe (Berlin)'],['Asia/Kolkata','India (Kolkata)'],['Asia/Tokyo','Japan (Tokyo)'],['Australia/Sydney','Australia (Sydney)']];
var DEFAULT_TZ='America/Chicago';
var ALPHA='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var dn=null; try{dn=new Intl.DisplayNames(['en'],{type:'region'})}catch(e){}
function cname(cc){try{return (dn&&dn.of(cc))||cc}catch(e){return cc}}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function colL(i){return String.fromCharCode(65+i)}
function coord(x,y){return colL(x)+(y+1)}
var skew=0;
function now(){return Date.now()+skew}

/* ---------- codes ---------- */
function normCode(s){return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
function fmtCode(s){return (s.match(/.{1,5}/g)||[]).join('-')}
function validChars(n){return n.split('').every(function(c){return ALPHA.indexOf(c)>=0})}

/* ---------- time helpers (the game runs in its own time zone) ---------- */
var fmtCache={};
function parts(ms,tz){
  var f=fmtCache[tz]; if(!f) f=fmtCache[tz]=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'});
  var o={}; f.formatToParts(ms).forEach(function(p){if(p.type!=='literal')o[p.type]=+p.value});
  if(o.hour===24)o.hour=0; return o;
}
function dayIdx(ms,tz){var p=parts(ms,tz);return Math.floor(Date.UTC(p.year,p.month-1,p.day)/864e5)}
function minsOf(ms,tz){var p=parts(ms,tz);return p.hour*60+p.minute+p.second/60}
function grantDay(ms,tz){return dayIdx(ms,tz)-(minsOf(ms,tz)<AP_MIN?1:0)}
function wallToEpoch(day,mins,tz){var base=day*864e5+mins*6e4,t=base;for(var i=0;i<3;i++){var p=parts(t,tz);t+=base-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)}return t}
function windowInfo(ms,tz){
  var d=dayIdx(ms,tz),m=minsOf(ms,tz);
  if(m>=AP_MIN&&m<WIN_END) return {open:true,closeAt:wallToEpoch(d,WIN_END,tz),nextAp:wallToEpoch(d+1,AP_MIN,tz)};
  var next=m<AP_MIN?wallToEpoch(d,AP_MIN,tz):wallToEpoch(d+1,AP_MIN,tz);
  return {open:false,opensAt:next,nextAp:next};
}
function tzAbbr(tz,ms){try{var p=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'short'}).formatToParts(ms).find(function(x){return x.type==='timeZoneName'});return p?p.value:tz}catch(e){return tz}}
function hms(ms){var s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);s%=60;return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
function timeIn(ms,tz){return new Date(ms).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:tz})}
function stamp(ms){return new Date(ms).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function dist(a,b){return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))}

/* ---------- app state ---------- */
var session=null;      /* {lobby, p, m, entered} */
var st=null;           /* what the server lets this viewer see */
var version=0,loaded=false,notFound=false,offline=false,rateLimited=false,busy=false,pollTimer=null,pollGen=0;
var tab=null,filter='all',zoom=false,sel=null,armed=null,armTimer=null,note=null,lastSeen=null,lastKey='';
var lobbyTz=null,codeText='',codeErr=null,fresh=null,codesOpen=false,createErr=null;
var elStatus=document.getElementById('status'),elBoard=document.getElementById('boardPanel'),elSide=document.getElementById('side');

function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}}
function savedMap(){try{return JSON.parse(lsGet('alliances:codes')||'{}')||{}}catch(e){return {}}}
function saveCodes(lobby,patch){
  var m=savedMap(),e=m[lobby]||{};
  Object.keys(patch).forEach(function(k){if(patch[k]==null)delete e[k];else e[k]=patch[k]});
  if(e.p||e.m)m[lobby]=e;else delete m[lobby];
  lsSet('alliances:codes',JSON.stringify(m));
}

/* ---------- talking to the server ---------- */
async function api(method,path,body){
  var h={'Content-Type':'application/json'};
  if(session&&session.p)h['X-Player-Code']=session.p;
  if(session&&session.m)h['X-Master-Code']=session.m;
  var r=await fetch(path,{method:method,headers:h,body:body?JSON.stringify(body):undefined,cache:'no-store'});
  var ts=r.headers.get('X-Server-Time'); if(ts)skew=+ts-Date.now();
  if(r.status===304)return {notModified:true};
  var j={};try{j=await r.json()}catch(e){}
  if(!r.ok){var err=new Error(j.error||'Something went wrong.');err.status=r.status;throw err}
  return j;
}
function apply(v){
  version=v.version;
  var s={code:v.code,phase:v.phase,tz:v.tz,winner:v.winner,players:{},jury:{},log:v.log,me:v.me,isMaster:v.isMaster,host:v.host||null};
  Object.keys(v.players).forEach(function(c){s.players[c]=Object.assign({},v.players[c])});
  if(v.me&&v.mine&&s.players[v.me])Object.assign(s.players[v.me],v.mine);
  if(v.me&&v.myVote)s.jury[v.me]=v.myVote;
  st=s;loaded=true;notFound=false;offline=false;
  if(session){
    if(session.p&&v.codes.player==='invalid'){session.p=null;saveCodes(session.lobby,{p:null});if(session.entered)codeErr='That player code does not match any country in lobby '+session.lobby+'.'}
    if(session.m&&v.codes.master==='invalid'){session.m=null;saveCodes(session.lobby,{m:null});if(session.entered)codeErr='That master code does not match lobby '+session.lobby+'.'}
    session.entered=false;
  }
}
/* Polling is the main request cost on Cloudflare's free plan (100,000 Functions requests per day),
   so it slows right down whenever nothing can change: orders only happen during the 8:00 to 10:15 pm window. */
function pollDelay(){
  var base;
  if(offline)base=10000;
  else if(!st||st.phase==='lobby')base=5000;
  else if(st.phase==='over')base=60000;
  else base=windowInfo(now(),st.tz).open?3000:30000;
  return document.hidden?Math.max(base*3,30000):base;
}
function schedulePoll(delay){
  clearTimeout(pollTimer);var gen=pollGen;
  pollTimer=setTimeout(function(){if(gen===pollGen)poll()},delay);
}
async function poll(force){
  if(!session)return;
  var gen=pollGen,lobby=session.lobby;
  try{
    var wantHost=tab==='master'&&st&&st.isMaster;
    var q='?since='+(force?0:version)+(wantHost?'&host=1':'');
    var r=await api('GET','/api/lobbies/'+lobby+q);
    if(gen!==pollGen)return;
    rateLimited=false;
    if(!r.notModified){apply(r);render()}else if(offline){offline=false;render()}
  }catch(e){
    if(gen!==pollGen)return;
    if(e.status===404){loaded=true;notFound=true;st=null;render();return}
    if(e.status===429){rateLimited=true;note={ok:false,text:e.message};render();schedulePoll(60000);return}
    if(!offline){offline=true;render()}
  }
  schedulePoll(rateLimited?60000:pollDelay());
}
async function openLobby(lobby,opts){
  opts=opts||{};pollGen++;clearTimeout(pollTimer);
  var sv=savedMap()[lobby]||{};
  session={lobby:lobby,p:opts.p||sv.p||null,m:opts.m||sv.m||null,entered:!!opts.entered};
  if(opts.p)saveCodes(lobby,{p:opts.p});if(opts.m)saveCodes(lobby,{m:opts.m});
  st=null;version=0;loaded=false;notFound=false;tab=null;sel=null;note=null;armed=null;lastSeen=null;fresh=null;codeErr=null;
  lsSet('alliances:last',lobby);
  render();
  await poll(true);
}
function leaveView(){
  pollGen++;clearTimeout(pollTimer);
  session=null;st=null;loaded=false;note=null;fresh=null;codeErr=null;tab=null;lsSet('alliances:last',null);render();
}
async function handleCode(text){
  var n=normCode(text);codeErr=null;note=null;
  if([5,15,20].indexOf(n.length)<0||!validChars(n)){
    codeErr='That code is not valid. Lobby codes have 5 characters, player codes 15 and master codes 20. The letters I, L and O and the digits 0 and 1 are never used.';
    render();return;
  }
  codeText='';
  await openLobby(n.slice(0,5),n.length===15?{p:n,entered:true}:n.length===20?{m:n,entered:true}:{});
}
async function createLobby(tz){
  busy=true;createErr=null;render();
  try{
    var r=await api('POST','/api/lobbies',{tz:tz});
    var master=normCode(r.master);busy=false;
    await openLobby(r.lobby,{m:master});
    fresh={kind:'master',code:fmtCode(master)};render();return;
  }catch(e){createErr=e.message||'Could not create a lobby.'}
  busy=false;render();
}

/* ---------- rendering ---------- */
function alives(){return Object.keys(st.players).filter(function(c){return st.players[c].alive})}
function occupied(x,y){return alives().some(function(c){var q=st.players[c];return q.x===x&&q.y===y})}
function chip(cc,me){return '<span class="chip"><i class="flag f-'+cc+'"></i>'+esc(cname(cc))+(me&&cc===me?' (you)':'')+'</span>'}

function statusHTML(){
  var h='';
  if(!session)return '<div class="pill"><b>Welcome</b><small>Create a lobby, or enter a code to join one.</small></div>';
  h+='<div class="pill"><small>Lobby</small><b class="mono" style="letter-spacing:.1em">'+esc(session.lobby)+'</b><button class="btn small" data-act="refresh" data-fid="refresh">Refresh</button><button class="btn small" data-act="leave-view" data-fid="leave-view">Switch lobby</button></div>';
  if(offline)h+='<div class="pill closed"><b>Offline</b><small>Cannot reach the server. Retrying.</small></div>';
  if(!loaded)return h+'<div class="pill"><small>Connecting to the game</small></div>';
  if(!st)return h+'<div class="pill closed"><b>Not found</b></div>';
  if(st.phase==='lobby')h+='<div class="pill"><b>Lobby</b><small>'+Object.keys(st.players).length+' joined</small></div>';
  else if(st.phase==='over')h+='<div class="pill over"><b>Game over</b>'+(st.winner?'<small>'+esc(cname(st.winner))+' won</small>':'')+'</div>';
  else h+='<div class="pill"><b>Live</b><small>'+alives().length+' of '+Object.keys(st.players).length+' countries in play</small></div>';
  var t=now(),w=windowInfo(t,st.tz),ab=tzAbbr(st.tz,t),d=dayIdx(t,st.tz);
  var s1=wallToEpoch(d,AP_MIN,st.tz),s2=wallToEpoch(d,WIN_END,st.tz);
  var local=timeIn(s1,undefined)!==timeIn(s1,st.tz)?' Your clock: '+timeIn(s1)+' to '+timeIn(s2)+'.':'';
  if(st.phase==='running')h+='<div class="pill '+(w.open?'open':'closed')+'"><span class="dot"></span><b>'+(w.open?'Action window open':'Action window closed')+'</b><span class="mono" data-bind="winclock">'+(w.open?'closes in '+hms(w.closeAt-t):'opens in '+hms(w.opensAt-t))+'</span></div>';
  h+='<div class="pill"><small>+1 AP daily at 8:00 pm '+ab+'. Action window 8:00 to 10:15 pm '+ab+'.'+esc(local)+'</small></div>';
  return h;
}
function tickStatus(){
  if(!st||st.phase!=='running')return;
  var t=now(),w=windowInfo(t,st.tz),a=document.querySelector('[data-bind="winclock"]');
  if(a)a.textContent=w.open?'closes in '+hms(w.closeAt-t):'opens in '+hms(w.opensAt-t);
  var b=document.querySelector('[data-bind="apclock"]');if(b)b.textContent=hms(w.nextAp-t);
}

function boardHTML(){
  var me=st&&st.me,p=me&&st.players[me],inPlay=!!(p&&p.alive&&st.phase==='running'&&p.lives!=null);
  var occ={},wreck={};
  if(st&&st.phase!=='lobby'){Object.keys(st.players).forEach(function(c){var q=st.players[c];if(q.x==null)return;if(q.alive)occ[q.y*SIZE+q.x]=c;else wreck[q.y*SIZE+q.x]=c})}
  var open=st&&st.phase==='running'&&windowInfo(now(),st.tz).open,canMove=inPlay&&open&&p.ap>=1&&!busy;
  var g='<div class="lab"></div>';for(var x=0;x<SIZE;x++)g+='<div class="lab">'+colL(x)+'</div>';
  for(var y=0;y<SIZE;y++){
    g+='<div class="lab">'+(y+1)+'</div>';
    for(x=0;x<SIZE;x++){
      var k=y*SIZE+x,c=occ[k],cls='cell',inner='',tag='div',attrs='';
      var d=inPlay?Math.max(Math.abs(x-p.x),Math.abs(y-p.y)):99;
      if(inPlay&&d<=p.reach&&d>0)cls+=' rng';
      if(c){
        var tc='nation f-'+c+(c===me?' me':'')+(c===sel?' sel':'')+(inPlay&&c!==me&&d<=p.reach?' hot':'');
        inner='<span class="'+tc+'" role="img" aria-label="'+esc(cname(c))+' at '+coord(x,y)+(c===me?' (you)':'')+'" title="'+esc(cname(c))+' · '+coord(x,y)+'"></span>';
      }else{
        if(wreck[k])inner='<span class="wreck" title="Fallen: '+esc(cname(wreck[k]))+'" aria-hidden="true">×</span>';
        if(canMove&&d===1){tag='button';cls+=' mv';attrs=' data-act="move" data-dx="'+(x-p.x)+'" data-dy="'+(y-p.y)+'" data-fid="cell-'+x+'-'+y+'" aria-label="Move to '+coord(x,y)+'"'}
      }
      g+='<'+tag+' class="'+cls+'"'+attrs+'>'+inner+'</'+tag+'>';
    }
  }
  var h='<div class="panel-head"><h2>Map</h2><div class="seg" role="group" aria-label="Map size"><button data-act="zoom" data-v="0" aria-pressed="'+(!zoom)+'">Fit</button><button data-act="zoom" data-v="1" aria-pressed="'+zoom+'">Large</button></div></div>';
  h+='<div class="boardscroll'+(zoom?' zoom':'')+'"><div class="board" role="group" aria-label="25 by 25 map, columns A to Y, rows 1 to 25">'+g+'</div></div>';
  h+='<div class="legend">';
  if(inPlay)h+='<span><i class="key me"></i>You</span><span><i class="key rng"></i>Your reach</span><span><i class="key hot"></i>Country in your reach</span>'+(canMove?'<span><i class="key mv"></i>Click to move</span>':'');
  h+='<span>× Fallen country</span></div>';
  h+='<p class="fogline">You can see where every country is. Stability, action points, reach and orders stay private to each player.</p>';
  if(st&&st.phase==='lobby')h+='<div class="notice info" style="margin-top:10px">Countries are placed on random squares when the host starts the game.</div>';
  return h;
}

function shields(n){var h='';for(var i=0;i<START_STABILITY;i++)h+='<svg class="shield'+(i<n?' on':'')+'" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l7.5 2.8v6c0 4.8-3.2 8.6-7.5 10.2-4.3-1.6-7.5-5.4-7.5-10.2v-6z"/></svg>';return h}

function mineHTML(me){
  var p=st.players[me],w=windowInfo(now(),st.tz);
  var h='<div class="panel mine"><div class="mine-top"><i class="bigflag f-'+me+'" role="img" aria-label="Your flag"></i><div><h2>'+esc(cname(me))+'</h2><div class="where mono">'+(p.alive?'Square '+coord(p.x,p.y):'Collapsed at '+coord(p.x,p.y))+'</div></div></div>';
  if(p.alive&&p.lives!=null){
    h+='<div class="stats"><div class="stat"><div class="k">Stability</div><div class="hearts" role="img" aria-label="'+p.lives+' of '+START_STABILITY+' stability">'+shields(p.lives)+'</div></div>';
    h+='<div class="stat"><div class="k">Action points</div><div class="v">'+p.ap+'</div></div>';
    h+='<div class="stat"><div class="k">Reach</div><div class="v">'+p.reach+'</div></div></div>';
    if(st.phase==='running')h+='<p class="private-note">Next +1 AP in <span class="mono" data-bind="apclock">'+hms(w.nextAp-now())+'</span>. Only you can see these numbers.</p>';
  }else if(!p.alive)h+='<div class="notice info">Your country has collapsed, but you still have a say. Use the Orders tab to vote on who receives bonus AP.</div>';
  return h+'</div>';
}

function ordersHTML(me){
  var p=st.players[me],t=now(),w=windowInfo(t,st.tz),h='<div class="stack">';
  if(st.phase==='over')return '<div class="empty">The game is over.</div>';
  if(!p.alive){
    var vote=st.jury[me];
    h+='<div><h3>Council vote</h3><p class="private-note">Each day the country with the most council votes receives +1 AP at 8:00 pm. A tie gives nobody the point. Votes reset daily and nobody sees how you voted.</p></div>';
    if(note)h+='<div class="notice '+(note.ok?'good':'bad')+'" role="status">'+esc(note.text)+'</div>';
    h+='<ul class="list">';
    alives().forEach(function(c){h+='<li><span class="chip"><i class="flag f-'+c+'"></i>'+esc(cname(c))+'</span><button class="btn small'+(vote===c?' primary':'')+'" data-act="vote" data-cc="'+c+'" data-fid="vote-'+c+'" '+(busy?'disabled':'')+'>'+(vote===c?'Your vote':'Vote')+'</button></li>'});
    return h+'</ul></div>';
  }
  var can=w.open&&p.ap>=1&&!busy;
  if(!w.open)h+='<div class="notice warn">The action window is closed. The next one opens at 8:00 pm '+tzAbbr(st.tz,t)+'. Your action points are safe until then.</div>';
  else if(p.ap<1)h+='<div class="notice warn">You are out of action points. The next one arrives at 8:00 pm tomorrow.</div>';
  else h+='<div class="notice good">The action window is open. Moving, sanctioning and sending aid cost 1 AP. Extending your reach costs '+EXTEND_COST+' AP.</div>';
  if(note)h+='<div class="notice '+(note.ok?'good':'bad')+'" role="status">'+esc(note.text)+'</div>';
  var dirs=[[-1,-1,'↖','north-west'],[0,-1,'↑','north'],[1,-1,'↗','north-east'],[-1,0,'←','west'],[0,0],[1,0,'→','east'],[-1,1,'↙','south-west'],[0,1,'↓','south'],[1,1,'↘','south-east']];
  h+='<div><h3>Move</h3><div class="move-wrap"><div class="pad">';
  dirs.forEach(function(d){
    if(!d[3]){h+='<div class="mid">You</div>';return}
    var nx=p.x+d[0],ny=p.y+d[1],ok=nx>=0&&ny>=0&&nx<SIZE&&ny<SIZE&&!occupied(nx,ny);
    h+='<button data-act="move" data-dx="'+d[0]+'" data-dy="'+d[1]+'" data-fid="pad-'+d[0]+'-'+d[1]+'" aria-label="Move '+d[3]+(ok?' to '+coord(nx,ny):' (blocked)')+'" '+(can&&ok?'':'disabled')+'>'+d[2]+'</button>';
  });
  h+='</div><p class="private-note" style="flex:1;min-width:140px">Move one square in any direction, diagonals included. You can also click a highlighted square on the map.</p></div></div>';
  var tg=alives().filter(function(c){return c!==me&&dist(p,st.players[c])<=p.reach}).sort(function(a,b){return dist(p,st.players[a])-dist(p,st.players[b])});
  h+='<div><h3>Countries in reach ('+p.reach+')</h3>';
  if(!tg.length)h+='<div class="empty">No country is within '+p.reach+' squares of you.</div>';
  else{
    h+='<ul class="list">';
    tg.forEach(function(c){var q=st.players[c],ks='sanction:'+c,kg='aid:'+c;
      h+='<li class="'+(c===sel?'sel-row':'')+'"><div>'+chip(c)+'<div class="meta">'+coord(q.x,q.y)+' · '+dist(p,q)+' square'+(dist(p,q)>1?'s':'')+' away</div></div><div class="row">'+
      '<button class="btn small danger'+(armed===ks?' armed':'')+'" data-act="sanction" data-cc="'+c+'" data-fid="'+ks+'" '+(can?'':'disabled')+'>'+(armed===ks?'Confirm sanction':'Sanction')+'</button>'+
      '<button class="btn small'+(armed===kg?' armed':'')+'" data-act="aid" data-cc="'+c+'" data-fid="'+kg+'" '+(can?'':'disabled')+'>'+(armed===kg?'Confirm aid':'Send 1 AP')+'</button></div></li>';});
    h+='</ul>';
  }
  h+='</div>';
  var canUp=can&&p.ap>=EXTEND_COST;
  h+='<div><h3>Extend reach ('+EXTEND_COST+' AP)</h3><div class="row"><button class="btn small'+(armed==='up'?' armed':'')+'" data-act="extend" data-fid="up" '+(canUp?'':'disabled')+'>'+(armed==='up'?'Confirm':'Extend reach to '+(p.reach+1))+'</button><span class="private-note">Costs '+EXTEND_COST+' AP. Permanent. Reaches one more square in every direction.</span></div></div>';
  return h+'</div>';
}

function lobbyHTML(me){
  var ids=Object.keys(st.players),h='<div class="stack">';
  if(note)h+='<div class="notice '+(note.ok?'good':'bad')+'" role="status">'+esc(note.text)+'</div>';
  if(me)h+='<div class="notice good"><div class="row"><i class="bigflag f-'+me+'" style="width:48px;height:34px" role="img" aria-label="Your flag"></i><div><b>You are '+esc(cname(me))+'.</b><br>Keep your player code safe. The host starts the game when everyone is in.</div></div></div>';
  else h+='<div class="notice info">Join to receive a random country flag and a personal player code. Your flag is your identity for the whole game.</div>';
  h+='<div class="row">';
  if(!me)h+='<button class="btn primary" data-act="join" data-fid="join" '+(busy?'disabled':'')+'>Join game</button>';
  else h+='<button class="btn" data-act="leave" data-fid="leave" '+(busy?'disabled':'')+'>Leave lobby</button>';
  h+='</div><div><h3>Joined ('+ids.length+')</h3>';
  if(ids.length){h+='<div class="lobby-grid" style="margin-top:8px">';ids.forEach(function(c){h+=chip(c,me)});h+='</div>'}else h+='<div class="empty">Nobody has joined yet. Share the lobby code <b class="mono">'+esc(session.lobby)+'</b> with your players.</div>';
  h+='</div>';
  if(st.isMaster){
    var tz=lobbyTz||st.tz,opts=TZS.slice();if(!opts.some(function(o){return o[0]===tz}))opts.unshift([tz,tz]);
    h+='<div class="panel" style="background:var(--surface-2)"><h3>Host controls</h3><div class="stack" style="margin-top:8px"><label for="tzSel" style="font-size:14px">Game time zone. Action points arrive at 8:00 pm here.</label><select id="tzSel" data-fid="tz">'+opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===tz?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select>'+
      '<div class="row"><button class="btn primary" data-act="start" data-fid="start" '+(ids.length<2||busy?'disabled':'')+'>Start game</button>'+(ids.length<2?'<span class="private-note">Needs at least 2 countries.</span>':'')+'</div></div></div>';
  }else h+='<p class="private-note">Waiting for the host to start the game.</p>';
  return h+'</div>';
}

function rosterHTML(me){
  var ids=Object.keys(st.players).sort(function(a,b){return (st.players[b].alive-st.players[a].alive)||cname(a).localeCompare(cname(b))});
  var h='<p class="private-note" style="margin-bottom:6px">Positions are public. Select a country to find it on the map.</p><ul class="list">';
  ids.forEach(function(c){var q=st.players[c];
    h+='<li class="'+(q.alive?'':'dead')+(c===sel?' sel-row':'')+'"><div>'+chip(c,me)+'<div class="meta">'+(q.alive?'Square '+coord(q.x,q.y):'Collapsed')+'</div></div>'+(q.alive?'<button class="btn small" data-act="sel" data-cc="'+c+'" data-fid="sel-'+c+'" aria-pressed="'+(c===sel)+'">'+(c===sel?'Hide':'Find')+'</button>':'')+'</li>';});
  return h+'</ul>';
}

function masterHTML(){
  var h='<div class="stack"><div class="notice warn">Host view. This shows every country’s hidden stability, AP and reach. Keep it away from players. It is only sent to your browser while this tab is open.</div>';
  if(note)h+='<div class="notice '+(note.ok?'good':'bad')+'" role="status">'+esc(note.text)+'</div>';
  var rows=(st.host||[]).slice().sort(function(a,b){return cname(a.cc).localeCompare(cname(b.cc))});
  h+='<div class="tbl"><table class="mtable"><thead><tr><th>Country</th><th>Square</th><th>Stability</th><th>AP</th><th>Reach</th><th>Status</th><th></th></tr></thead><tbody>';
  if(!st.host)h+='<tr><td colspan="7">Loading</td></tr>';
  rows.forEach(function(q){var on=q.x!=null;
    h+='<tr><td>'+chip(q.cc)+'</td><td class="mono">'+(on?coord(q.x,q.y):'–')+'</td><td class="mono">'+(on?q.lives:'–')+'</td><td class="mono">'+(on?q.ap:'–')+'</td><td class="mono">'+(on?q.reach:'–')+'</td><td>'+(!on?'In lobby':q.alive?'In play':'Collapsed')+'</td><td><button class="btn small" data-act="newcode" data-cc="'+q.cc+'" data-fid="nc-'+q.cc+'" '+(busy?'disabled':'')+'>New code</button></td></tr>';});
  h+='</tbody></table></div><p class="private-note">"New code" replaces that country’s player code, for when its player loses it. The old code stops working at once.</p>';
  h+='<div class="row"><button class="btn small" data-act="export" data-fid="export">Download game data</button></div>';
  h+='<div><h3>Danger zone</h3><div class="row" style="margin-top:8px"><button class="btn danger small'+(armed==='reset'?' armed':'')+'" data-act="reset" data-fid="reset" '+(busy?'disabled':'')+'>'+(armed==='reset'?'Confirm: erase this game':'Reset to an empty lobby')+'</button><span class="private-note">Same lobby code. Removes all countries and the log.</span></div></div></div>';
  return h;
}

function logText(e,me){
  switch(e.k){
    case 'open':return 'The lobby was opened.';
    case 'join':return chip(e.a,me)+' joined the lobby.';
    case 'start':return 'The game has begun with '+e.n+' countries, each on a random square.';
    case 'move':return chip(e.a,me)+' moved from '+coord(e.fx,e.fy)+' to '+coord(e.x,e.y)+'.';
    case 'kill':return chip(e.a,me)+' imposed the final sanction. '+chip(e.b,me)+' has collapsed at '+coord(e.x,e.y)+'.';
    case 'win':return chip(e.a,me)+' is the last country standing and wins the game.';
    case 'grant':return 'Daily action points issued: every country still in play gets +1 AP.';
    case 'hit':return chip(e.a)+' sanctioned you. Your stability is now '+e.left+'.';
    case 'shot':return 'Your sanction reached '+chip(e.b)+'. Their remaining stability is hidden from you.';
    case 'loot':return 'You received '+e.n+' AP from the fallen '+chip(e.b)+'.';
    case 'gave':return 'You sent 1 AP in aid to '+chip(e.b)+'.';
    case 'got':return chip(e.a)+' sent you 1 AP in aid.';
    case 'up':return 'You extended your reach to '+e.r+'.';
    case 'council':return 'The council voted for you. You gained +1 AP.';
  }
  return 'Unknown event.';
}
function logHTML(me){
  var all=st.log.slice().reverse();
  var list=all.filter(function(e){return filter==='all'||(filter==='public'?!e.to:!!e.to)}).slice(0,200);
  var h='<div class="panel-head" style="margin-bottom:8px"><div class="seg" role="group" aria-label="Filter log">'+
    [['all','All'],['public','Public'],['mine','Only me']].map(function(f){return '<button data-act="filter" data-v="'+f[0]+'" data-fid="f-'+f[0]+'" aria-pressed="'+(filter===f[0])+'">'+f[1]+'</button>'}).join('')+'</div></div>';
  if(!list.length)return h+'<div class="empty">Nothing here yet. Moves, final sanctions and collapses appear for everyone. Sanctions that do not collapse a country, aid and reach upgrades only appear to the countries involved.</div>';
  h+='<ol class="list log" id="logList" role="log" aria-live="polite" aria-label="Game log, newest first" tabindex="0" style="list-style:none">';
  list.forEach(function(e){h+='<li class="ev'+(e.to?' priv':'')+(e.k==='kill'?' kill':'')+'"><time>'+esc(stamp(e.t))+'</time><div>'+logText(e,me)+(e.to?'<span class="tag">Only you</span>':'')+'</div></li>'});
  return h+'</ol>';
}

function rulesHTML(){
  var tz=st?st.tz:DEFAULT_TZ,ab=tzAbbr(tz,now());
  return '<div class="rules">'+
  '<h3>Goal</h3><p>Be the last country standing. Every player is assigned a random country, and that flag is your identity for the whole game.</p>'+
  '<h3>Codes</h3><ul><li><b>Lobby code</b> (5 characters): share it so friends can find your game.</li><li><b>Player code</b> (15): given to you when you join. Enter it on any device to get back to your country. Keep it private, because anyone with it can play as you.</li><li><b>Master code</b> (20): given to the host who creates the lobby. It unlocks the host controls and the host view.</li></ul>'+
  '<h3>Start</h3><p>Every country begins on a random square of the 25 × 25 map with <b>3 stability</b>, <b>1 action point (AP)</b> and a <b>reach of 2</b>. Columns are lettered A to Y and rows are numbered 1 to 25.</p>'+
  '<h3>Time</h3><ul><li>At <b>8:00 pm '+ab+'</b> every day, each country still in play automatically gains <b>+1 AP</b>. Unused AP carry over with no cap.</li><li>AP can only be spent in the <b>action window, 8:00 to 10:15 pm '+ab+'</b>. Outside it the map is frozen.</li></ul>'+
  '<h3>Orders</h3><table><tr><th>Move (1 AP)</th><td>Step one square in any of 8 directions onto an empty square.</td></tr>'+
  '<tr><th>Sanction (1 AP)</th><td>Apply pressure to any country within your reach. It loses 1 stability. There is no luck involved. At 0 stability it collapses and its remaining AP pass to you.</td></tr>'+
  '<tr><th>Send aid (1 AP)</th><td>Give 1 of your AP to a country within reach. It costs you that AP. This is how alliances are made.</td></tr>'+
  '<tr><th>Extend reach ('+EXTEND_COST+' AP)</th><td>Permanently add +1 to your reach.</td></tr></table>'+
  '<p style="margin-top:6px">Reach counts squares in a square shape, diagonals included. A reach of 2 covers any square up to 2 away in every direction.</p>'+
  '<h3>Fog of war</h3><div class="see"><div><b>Everyone sees</b>Where every country is, every move, which country imposes a final sanction, and which country collapses. These all appear in the log.</div><div><b>Only you see</b>Your own stability, AP, reach and orders. A sanction that does not collapse a country, aid and reach upgrades are shown only to the countries involved.</div></div>'+
  '<p>The log marks private notes with an <b>Only you</b> tag. Hidden numbers are kept on the server and are never sent to your browser, so work out your rivals from how they behave.</p>'+
  '<h3>The council</h3><p>Countries that collapse stay in the game. Each day they can vote for one country still in play. At 8:00 pm the country with the most votes gets an extra +1 AP. A tie gives nobody the point, and votes are secret.</p></div>';
}

function tabsFor(me){
  var t=[];
  if(st.phase==='lobby')t.push(['lobby','Lobby']);
  else if(me&&st.players[me])t.push(['orders','Orders']);
  t.push(['log','Log']);
  if(st.phase!=='lobby')t.push(['roster','Countries']);
  if(st.isMaster)t.push(['master','Host']);
  t.push(['rules','How to play']);
  return t;
}

function codeField(id,label,val){return '<div class="field"><label for="'+id+'">'+label+'</label><div class="row" style="flex-wrap:nowrap"><input class="codebox" id="'+id+'" readonly value="'+esc(val)+'" data-fid="'+id+'"><button class="btn small" data-act="copy" data-target="'+id+'" data-fid="copy-'+id+'">Copy</button></div></div>'}
function codesHTML(){
  if(!session)return '';
  var h='<details class="panel codes"'+(codesOpen?' open':'')+'><summary>My codes</summary>';
  h+=codeField('c-lobby','Lobby code (share this)',session.lobby);
  if(session.p)h+=codeField('c-player','Player code (keep private)',fmtCode(session.p));
  else h+='<p class="private-note" style="margin-top:10px">You have no player code on this device. Join the lobby, or enter your player code from the start screen.</p>';
  if(session.m&&st&&st.isMaster)h+=codeField('c-master','Master code (host only)',fmtCode(session.m));
  return h+'<p class="private-note" style="margin-top:10px">Codes are remembered on this device.</p></details>';
}
function freshHTML(){
  if(!fresh)return '';
  var title=fresh.kind==='player'?'Save your player code':fresh.kind==='master'?'Save your master code':'New code for '+cname(fresh.cc);
  var msg=fresh.kind==='player'?'This is the only way back into your country on another device or after clearing your browser. Anyone who has it can play as you.':
    fresh.kind==='master'?'It unlocks the host controls and host view for this lobby. It is also kept on this device. There is no way to recover it if you lose it.':
    'Give this to that player. Their old code no longer works.';
  return '<div class="panel stack fresh" role="status"><h3 style="color:var(--ink)">'+esc(title)+'</h3>'+codeField('c-fresh','Code',fresh.code)+'<p class="private-note">'+msg+'</p><div class="row"><button class="btn small primary" data-act="dismiss" data-fid="dismiss">I have saved it</button></div></div>';
}

function landingHTML(){
  var saved=savedMap(),keys=Object.keys(saved);
  var tz=lobbyTz||DEFAULT_TZ,opts=TZS.slice();if(!opts.some(function(o){return o[0]===tz}))opts.unshift([tz,tz]);
  var h='<div class="panel stack"><h2>Play</h2>';
  h+='<form id="codeForm" class="stack" autocomplete="off"><div><label for="codeIn"><h3>Enter a code</h3></label><p class="private-note">A <b>lobby code</b> opens a game so you can join it. A <b>player code</b> returns you to your country. A <b>master code</b> returns you to the host controls. Dashes are optional.</p></div>'+
    '<div class="row" style="flex-wrap:nowrap"><input class="codebox codein" id="codeIn" data-fid="codeIn" value="'+esc(codeText)+'" placeholder="e.g. K7QMX" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="30"><button type="submit" class="btn primary" data-fid="codeGo">Continue</button></div>'+
    (codeErr?'<div class="notice bad" role="alert">'+esc(codeErr)+'</div>':'')+'</form>';
  if(keys.length){h+='<div><h3>On this device</h3><ul class="list">';keys.forEach(function(k){h+='<li><div><b class="mono">'+esc(k)+'</b><div class="meta">'+(saved[k].m?'Host':'')+(saved[k].m&&saved[k].p?' and ':'')+(saved[k].p?'Player':'')+'</div></div><button class="btn small" data-act="resume" data-v="'+esc(k)+'" data-fid="resume-'+esc(k)+'">Open</button></li>'});h+='</ul></div>'}
  h+='<div class="hr">or</div><div class="stack"><div><h3>Start a new game</h3><p class="private-note">You get a lobby code to share and a master code that makes you the host.</p></div>'+
    '<label for="tzNew" style="font-size:14px">Game time zone. Action points arrive at 8:00 pm here.</label><select id="tzNew" data-fid="tzNew">'+opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===tz?' selected':'')+'>'+esc(o[1])+'</option>'}).join('')+'</select>'+
    '<div class="row"><button class="btn primary" data-act="create" data-fid="create" '+(busy?'disabled':'')+'>Create a lobby</button></div>'+
    (createErr?'<div class="notice bad" role="alert">'+esc(createErr)+'</div>':'')+'</div></div>';
  return h+'<div class="panel">'+rulesHTML()+'</div>';
}

function sideHTML(){
  var h='';
  if(!session)return landingHTML();
  if(!loaded)return '<div class="panel"><div class="empty">Opening lobby '+esc(session.lobby)+'.</div></div>';
  if(!st)return '<div class="panel stack"><h2>Lobby not found</h2><p>No game exists with the code <b class="mono">'+esc(session.lobby)+'</b>. Check the code and try again.</p><div class="row"><button class="btn primary" data-act="leave-view" data-fid="back">Back</button></div></div>';
  var me=st.me;
  h+=freshHTML();
  if(codeErr)h+='<div class="notice bad" role="alert">'+esc(codeErr)+'</div>';
  if(st.phase==='over'&&st.winner)h+='<div class="panel winner" role="status"><i class="bigflag f-'+st.winner+'"></i><div><h2>'+esc(cname(st.winner))+' wins</h2><p>'+(st.winner===me?'Your country is the last one standing.':'The last country standing.')+'</p></div></div>';
  if(me&&st.phase!=='lobby')h+=mineHTML(me);
  else if(!me&&st.phase!=='lobby')h+='<div class="panel"><div class="notice info">You are watching. If you are playing, use Switch lobby and enter your player code.</div></div>';
  var tabs=tabsFor(me);if(!tabs.some(function(x){return x[0]===tab}))tab=tabs[0][0];
  var maxId=0;st.log.forEach(function(e){if(e.id>maxId)maxId=e.id});
  if(lastSeen==null||tab==='log')lastSeen=maxId;
  var unread=st.log.filter(function(e){return e.id>lastSeen}).length;
  h+='<div class="panel"><div class="tabs" role="tablist">'+tabs.map(function(x){return '<button role="tab" id="tab-'+x[0]+'" aria-selected="'+(tab===x[0])+'" data-act="tab" data-v="'+x[0]+'" data-fid="tab-'+x[0]+'">'+x[1]+(x[0]==='log'&&unread?'<span class="badge" aria-label="'+unread+' new">'+unread+'</span>':'')+'</button>'}).join('')+'</div><div role="tabpanel" aria-labelledby="tab-'+tab+'">';
  if(tab==='lobby')h+=lobbyHTML(me);
  else if(tab==='orders')h+=ordersHTML(me);
  else if(tab==='log')h+=logHTML(me);
  else if(tab==='roster')h+=rosterHTML(me);
  else if(tab==='master')h+=masterHTML();
  else h+=rulesHTML();
  h+='</div></div>'+codesHTML();
  return h;
}

function render(){
  var a=document.activeElement,fid=a&&a.dataset?a.dataset.fid:null;
  var logEl=document.getElementById('logList'),ls=logEl?logEl.scrollTop:0,keep=logEl&&document.activeElement===logEl;
  elStatus.innerHTML=statusHTML();elBoard.innerHTML=boardHTML();elSide.innerHTML=sideHTML();
  if(fid){var n=document.querySelector('[data-fid="'+fid+'"]');if(n)n.focus({preventScroll:true})}
  else if(keep){var l=document.getElementById('logList');if(l)l.focus({preventScroll:true})}
  var l2=document.getElementById('logList');if(l2)l2.scrollTop=ls;
  lastKey=keyOf();
}
function keyOf(){if(!st)return '';var t=now();return st.phase+':'+(st.phase==='running'?(windowInfo(t,st.tz).open+':'+grantDay(t,st.tz)):'')}
function tick(){
  var k=keyOf();
  if(k!==lastKey){render();if(session&&st&&st.phase==='running')poll(true)}
  else tickStatus();
}

/* ---------- actions ---------- */
async function post(verb,body){
  busy=true;render();
  try{
    var r=await api('POST','/api/lobbies/'+session.lobby+'/'+verb,Object.assign({host:tab==='master'},body||{}));
    if(r.view)apply(r.view);
    note={ok:true,text:r.ok||'Done.'};busy=false;render();return r;
  }catch(e){
    busy=false;note={ok:false,text:e.message||'Something went wrong.'};
    if(!e.status)offline=true;
    render();return null;
  }
}
function arm(key){armed=key;clearTimeout(armTimer);armTimer=setTimeout(function(){armed=null;render()},4000);render()}
function disarm(){armed=null;clearTimeout(armTimer)}

document.addEventListener('click',async function(ev){
  var b=ev.target.closest('[data-act]');if(!b||b.disabled)return;
  var a=b.dataset.act,cc=b.dataset.cc;
  if(a==='tab'){tab=b.dataset.v;render();if(tab==='master')poll(true);return}
  if(a==='filter'){filter=b.dataset.v;render();return}
  if(a==='zoom'){zoom=b.dataset.v==='1';render();return}
  if(a==='sel'){sel=sel===cc?null:cc;render();return}
  if(a==='dismiss'){fresh=null;render();return}
  if(a==='leave-view'){leaveView();return}
  if(a==='refresh'){poll(true);return}
  if(a==='resume'){codeErr=null;await openLobby(b.dataset.v);return}
  if(a==='copy'){
    var inp=document.getElementById(b.dataset.target);if(!inp)return;
    var done=function(m){b.textContent=m;setTimeout(function(){b.textContent='Copy'},1800)};
    try{await navigator.clipboard.writeText(inp.value);done('Copied')}catch(e){inp.focus();inp.select();done('Press Ctrl+C')}
    return;
  }
  if(a==='create'){var s=document.getElementById('tzNew');await createLobby(s?s.value:DEFAULT_TZ);return}
  var needs={sanction:'sanction:'+cc,aid:'aid:'+cc,extend:'up',reset:'reset'};
  if(needs[a]&&armed!==needs[a]){arm(needs[a]);return}
  disarm();
  var lobby=session&&session.lobby;
  if(a==='move')post('move',{dx:+b.dataset.dx,dy:+b.dataset.dy});
  else if(a==='sanction'||a==='aid'||a==='vote')post(a,{cc:cc});
  else if(a==='extend')post('extend');
  else if(a==='join'){
    var r=await post('join');
    if(r&&r.player){var n=normCode(r.player);session.p=n;saveCodes(lobby,{p:n});fresh={kind:'player',code:r.player};render();poll(true)}
  }
  else if(a==='leave'){var r2=await post('leave');if(r2){session.p=null;saveCodes(lobby,{p:null});fresh=null;render();poll(true)}}
  else if(a==='start'){var t2=document.getElementById('tzSel');post('start',{tz:t2?t2.value:undefined})}
  else if(a==='reset'){var r4=await post('reset');if(r4){session.p=null;saveCodes(lobby,{p:null});tab=null;render()}}
  else if(a==='newcode'){var r3=await post('newcode',{cc:cc});if(r3&&r3.player){fresh={kind:'reissue',cc:cc,code:r3.player};render()}}
  else if(a==='export'){
    try{
      var res=await fetch('/api/lobbies/'+lobby+'/export',{headers:{'X-Master-Code':session.m||''}});
      if(!res.ok)throw new Error('Could not download.');
      var blob=await res.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='alliances-'+lobby+'.json';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url)},2000);
      note={ok:true,text:'Game data downloaded.'};
    }catch(e){note={ok:false,text:e.message}}
    render();
  }
});
document.addEventListener('submit',function(ev){
  if(ev.target&&ev.target.id==='codeForm'){ev.preventDefault();var i=document.getElementById('codeIn');handleCode(i?i.value:codeText)}
});
document.addEventListener('input',function(ev){if(ev.target&&ev.target.id==='codeIn')codeText=ev.target.value});
document.addEventListener('change',function(ev){if(ev.target&&(ev.target.id==='tzSel'||ev.target.id==='tzNew'))lobbyTz=ev.target.value});
document.addEventListener('toggle',function(ev){if(ev.target&&ev.target.classList&&ev.target.classList.contains('codes'))codesOpen=ev.target.open},true);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&session)poll(true)});

/* ---------- boot ---------- */
render();
setInterval(tick,1000);
var last=lsGet('alliances:last');
if(last&&/^[A-Z0-9]{5}$/.test(last))openLobby(last);
})();
