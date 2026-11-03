'use strict';
const E = window.LudoEngine;
const $ = (id) => document.getElementById(id);
const BASE = {red:[[1.5,1.5],[3.5,1.5],[1.5,3.5],[3.5,3.5]],green:[[10.5,1.5],[12.5,1.5],[10.5,3.5],[12.5,3.5]],yellow:[[10.5,10.5],[12.5,10.5],[10.5,12.5],[12.5,12.5]],blue:[[1.5,10.5],[3.5,10.5],[1.5,12.5],[3.5,12.5]]};
const YARD = {red:[-.5,-.5],green:[8.5,-.5],yellow:[8.5,8.5],blue:[-.5,8.5]};
const state = {socket:null,room:null,token:null,color:null,game:null,local:false,ai:false,mode:'',activity:[],inviteUrl:''};
const views=['home-view','lobby-view','game-view','result-view'];
function view(id){views.forEach(v=>$(v).classList.toggle('hidden',v!==id));window.scrollTo(0,0)}
let toastTimer;
function toast(s){$('toast').textContent=s;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2400)}
function name(){return localStorage.getItem('parcheesi.name')||'Player'}
function askName(){let n=prompt('What should we call you?',name());if(n===null)return null;n=n.replace(/[<>]/g,'').trim().slice(0,20)||'Player';localStorage.setItem('parcheesi.name',n);return n}
function connect(){return new Promise((resolve,reject)=>{if(state.socket?.readyState===1)return resolve();const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(proto+'://'+location.host+'/ws');state.socket=ws;const timer=setTimeout(()=>reject(Error('Connection timed out')),5000);ws.onopen=()=>{clearTimeout(timer);$('network-label').textContent='CONNECTED';$('connection-pill').innerHTML='<i></i> CONNECTED';resolve()};ws.onmessage=e=>{try{message(JSON.parse(e.data))}catch{}};ws.onclose=()=>{$('network-label').textContent='DISCONNECTED'};ws.onerror=()=>{clearTimeout(timer);reject(Error('Could not connect to game server'))}})}
function send(type,data={}){if(state.socket?.readyState===1)state.socket.send(JSON.stringify({type,...data}));else toast('Not connected')}
function message(m){
 if(m.type==='room.created'||m.type==='room.joined'){state.room=m.room;state.seenLen=null;state.token=m.playerToken;state.color=m.playerColor;localStorage.setItem('parcheesi:'+m.invite,m.playerToken);state.inviteUrl=location.origin+'/room/'+m.invite;renderLobby();view('lobby-view')}
 if(m.type==='room.snapshot'){state.room=m.room;if(m.room.status==='playing'||m.room.status==='finished'){state.game=m.room.state;state.local=false;renderGame();m.room.status==='finished'?result():view('game-view')}else{renderLobby();view('lobby-view')}}
 if(m.type==='game.started'||m.type==='game.update'){state.room=m.room;state.game=m.room.state;renderGame();if(state.game.status==='finished')result()}
 if(m.type==='room.error')toast(m.error);
 if(m.type==='room.closed'){state.room=null;view('home-view');toast('Room closed')}
 if(m.type==='chat.message')activity(m.player+': '+m.text,'CHAT');
}
function createRoom(){const n=askName();if(n)connect().then(()=>send('room.create',{name:n})).catch(e=>toast(e.message))}
function joinRoom(code,n){const token=localStorage.getItem('parcheesi:'+code);connect().then(()=>send('room.join',{invite:code,playerToken:token,name:n||name()})).catch(e=>toast(e.message))}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderLobby(){const r=state.room;if(!r)return;$('room-code').textContent=r.invite;$('lobby-status').textContent=r.status.toUpperCase();$('lobby-hint').textContent=r.players.length+' of 4 seats filled · '+r.players.filter(p=>p.ready).length+' ready';const me=r.players.find(p=>p.color===state.color);$('start-game').disabled=!(r.host===me?.id&&r.players.length>=2&&r.players.every(p=>p.ready));$('toggle-ready').textContent=me?.ready?'Not ready':'Ready up';$('toggle-ready').disabled=!me;const grid=$('player-grid');grid.innerHTML='';for(let i=0;i<4;i++){const p=r.players[i],el=document.createElement('div');el.className='player-seat'+(!p?' seat-empty':'');el.innerHTML=p?'<span class="seat-dot color-'+p.color+'"></span><div class="seat-info"><b>'+esc(p.name)+(p.host?' · HOST':'')+'</b><small>'+(p.connected?'CONNECTED':'RECONNECTING')+' · '+p.color.toUpperCase()+'</small></div><span class="seat-ready">'+(p.ready?'READY':'NOT READY')+'</span>':'<span class="seat-dot color-muted"></span><div class="seat-info"><b>Open seat</b><small>INVITE A FRIEND</small></div>';grid.appendChild(el)}}
function localGame(ai){const count=ai?4:Number(prompt('How many players? Choose 2, 3, or 4.','4'));if(!ai&&(!Number.isInteger(count)||count<2||count>4))return;const ids=E.PLAYER_IDS.slice(0,count),kinds={red:'human',green:ai?'ai':'human',yellow:ai?'ai':'human',blue:ai?'ai':'human'};state.local=true;state.seenLen=null;state.ai=ai;state.mode=ai?'PLAY VS AI':'PASS & PLAY';state.room=null;state.color='red';state.game=E.initialState({players:ids,names:{red:name(),green:ai?'Clover':'Player 2',yellow:ai?'Marlow':'Player 3',blue:ai?'Atlas':'Player 4'},kinds});state.activity=[];renderGame();view('game-view');maybeAI()}
function board(target,g,interactive){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
 svg.setAttribute('viewBox','-.5 -.5 15 15');svg.setAttribute('class','board-svg');svg.setAttribute('role','img');svg.setAttribute('aria-label','Parcheesi board');
 const el=(tag,a,text)=>{const n=document.createElementNS(ns,tag);for(const k in a)n.setAttribute(k,a[k]);if(text!=null)n.textContent=text;svg.appendChild(n);return n};
 const active=new Set(g.players.map(p=>p.id));
 el('rect',{x:-.5,y:-.5,width:15,height:15,rx:.6,class:'b-board'});
 E.PLAYER_IDS.forEach(c=>{const [x,y]=YARD[c],idle=active.has(c)?'':' is-idle';
  el('rect',{x,y,width:6,height:6,rx:.6,class:'b-yard c-'+c+idle});
  el('rect',{x:x+.7,y:y+.7,width:4.6,height:4.6,rx:.5,class:'b-yard-in'+idle});
  BASE[c].forEach(([cx,cy])=>el('circle',{cx,cy,r:.62,class:'b-pad'+idle}))});
 E.TRACK_COORDS.forEach(([x,y],i)=>{const start=E.PLAYER_IDS.find(c=>E.START_OFFSETS[c]===i),safe=E.SAFE_TRACK.has(i);
  el('rect',{x:x-.46,y:y-.46,width:.92,height:.92,rx:.1,class:'b-cell'+(safe?' is-safe':'')+(start?' is-start c-'+start:'')});
  if(safe)el('text',{x,y:y+.03,class:'b-star'+(start?' on-start':'')},'✦')});
 E.PLAYER_IDS.forEach(c=>E.HOME_COORDS[c].slice(0,5).forEach(([x,y])=>el('rect',{x:x-.46,y:y-.46,width:.92,height:.92,rx:.1,class:'b-lane c-'+c})));
 [['red','5.5,5.5 7,7 5.5,8.5'],['green','5.5,5.5 8.5,5.5 7,7'],['yellow','8.5,5.5 8.5,8.5 7,7'],['blue','5.5,8.5 8.5,8.5 7,7']].forEach(([c,points])=>el('polygon',{points,class:'b-tri c-'+c}));
 const turn=g.players[g.currentPlayer],legal=interactive&&g.awaitingMove?E.legalMoves(g):[],items=[];
 const DIR={red:[-1,0],green:[0,-1],yellow:[1,0],blue:[0,1]};
 g.players.forEach(p=>p.tokens.forEach((progress,i)=>{let x,y,r=.36,done=false;
  if(progress===-1){[x,y]=BASE[p.id][i];r=.4}
  else if(progress===E.FINISH_PROGRESS){const d=DIR[p.id],k=(i-1.5)*.22;x=7+d[0]*.55-d[1]*k;y=7+d[1]*.55+d[0]*k;r=.17;done=true}
  else if(progress>=E.HOME_ENTRY_PROGRESS)[x,y]=E.HOME_COORDS[p.id][progress-E.HOME_ENTRY_PROGRESS];
  else[x,y]=E.TRACK_COORDS[E.globalTrackIndex(p.id,progress)];
  items.push({p,i,x,y,r,share:progress>=0&&!done,can:p.id===turn.id&&legal.includes(i)})}));
 const groups={};items.forEach(t=>{if(t.share)(groups[t.x+','+t.y]=groups[t.x+','+t.y]||[]).push(t)});
 const OFF=[[0,0],[-.2,-.2],[.2,-.2],[-.2,.2],[.2,.2]];
 Object.values(groups).forEach(a=>{if(a.length>1)a.forEach((t,n)=>{const o=OFF[Math.min(n+1,4)];t.x+=o[0];t.y+=o[1];t.r*=.72})});
 items.sort((a,b)=>a.can-b.can).forEach(t=>{
  if(t.can){el('circle',{cx:t.x,cy:t.y,r:t.r+.13,class:'b-ring b-ring-dark'});el('circle',{cx:t.x,cy:t.y,r:t.r+.13,class:'b-ring'})}
  el('circle',{cx:t.x,cy:t.y,r:t.r,class:'token c-'+t.p.id});
  el('circle',{cx:t.x-t.r*.28,cy:t.y-t.r*.3,r:t.r*.38,class:'token-shine'});
  if(t.can){const h=el('circle',{cx:t.x,cy:t.y,r:.62,class:'hit','data-token':t.i,tabindex:0,role:'button','aria-label':t.p.name+' token '+(t.i+1)})}
 });
 target.replaceChildren(svg);
 svg.addEventListener('click',e=>{const t=e.target.closest('[data-token]');if(t)move(Number(t.dataset.token))});
 svg.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const t=e.target.closest('[data-token]');if(t){e.preventDefault();move(Number(t.dataset.token))}}});
}
function renderGame(){const g=state.game;if(!g)return;const p=g.players[g.currentPlayer];$('game-mode-label').textContent=state.mode||'PRIVATE ROOM';$('game-title').textContent=state.local?'The table is yours.':'Room '+(state.room?.invite||'');$('connection-pill').style.display=state.local?'none':'flex';$('turn-text').textContent=p.name.toUpperCase()+' TO PLAY';$('turn-detail').textContent=g.awaitingMove?'Choose a token':'Roll the dice';$('turn-banner').querySelector('.turn-dot').className='turn-dot color-'+p.id;$('dice-face').textContent=g.dice?['','⚀','⚁','⚂','⚃','⚄','⚅'][g.dice]:'⚄';$('dice-title').textContent=g.awaitingMove?'Choose your token':'Roll the dice';$('dice-subtitle').textContent=g.awaitingMove?g.dice+' spaces to move':'A six brings a token out';const mine=state.local?p.kind==='human':p.id===state.color;$('roll-dice').disabled=!mine||g.awaitingMove||g.status!=='playing';$('move-hint').textContent=g.awaitingMove?'Select a highlighted token.':mine?'Your turn. Give it a roll.':p.name+' is thinking…';$('game-players').innerHTML=g.players.map(x=>'<div class="game-player '+(x.id===p.id?'active':'')+'"><span class="seat-dot color-'+x.id+'"></span><div><b>'+esc(x.name)+'</b><small>'+x.tokens.filter(t=>t===57).length+'/4 HOME · '+x.captures+' CAPTURES</small></div></div>').join('');board($('game-board'),g,mine&&g.status==='playing');cues(g);const hist=g.history.slice(-9).reverse();$('activity-list').innerHTML=hist.length?hist.map(h=>'<div class="activity-item"><small>'+h.type.toUpperCase()+'</small>'+esc(h.type==='roll'?h.player+' rolled '+h.roll:h.type==='move'?h.player+' moved token '+(h.token+1):h.player+' lost a turn')+'</div>').join(''):'<p class="empty-activity">Every great game starts with a roll.</p>'}
function move(i){if(!state.game?.awaitingMove)return;if(state.local){try{state.game=E.applyMove(state.game,i);renderGame();if(state.game.status==='finished')result();else maybeAI()}catch(e){toast(e.message)}}else send('game.move',{token:i})}
function roll(){if($('roll-dice').disabled)return;if(state.local){state.game=E.applyRoll(state.game,1+Math.floor(Math.random()*6));renderGame();maybeAI()}else send('game.roll')}
let aiTimer;
function maybeAI(){clearTimeout(aiTimer);if(!state.local||!state.ai||state.game.status!=='playing')return;const p=state.game.players[state.game.currentPlayer];if(p.kind!=='ai')return;aiTimer=setTimeout(()=>{if(state.game.awaitingMove){const i=E.chooseAIMove(state.game);if(i!==null)state.game=E.applyMove(state.game,i)}else state.game=E.applyRoll(state.game,1+Math.floor(Math.random()*6));renderGame();if(state.game.status==='finished')result();else maybeAI()},650)}
function result(){const p=state.game.players.find(x=>x.id===state.game.winner);$('result-title').textContent=(p?.name||'Someone')+' wins.';$('result-subtitle').textContent='A game well played. The table has a champion.';$('result-stats').innerHTML=state.game.players.map(x=>'<div class="rule-line"><span>'+esc(x.name.toUpperCase())+'</span><b>'+x.tokens.filter(t=>t===57).length+'/4 HOME · '+x.captures+' CAPTURES</b></div>').join('');view('result-view')}
function activity(s,label){const el=document.createElement('div');el.className='activity-item';el.innerHTML='<small>'+esc(label)+'</small>'+esc(s);$('activity-list').prepend(el)}
function invite(){navigator.clipboard?.writeText(state.inviteUrl).then(()=>toast('Invitation link copied')).catch(()=>toast(state.inviteUrl))}
function chat(){const input=$('chat-input'),text=input.value.trim();if(!text)return;if(state.local)activity(name()+': '+text,'CHAT');else send('chat.send',{text});input.value=''}
const THEMES=['noir','classic','forest'],DEFAULT_PREFS={motion:false,sound:false,theme:'noir'};
function loadPrefs(){try{const s={...DEFAULT_PREFS,...JSON.parse(localStorage.getItem('parcheesi.settings')||'{}')};if(!THEMES.includes(s.theme))s.theme='noir';return s}catch{return {...DEFAULT_PREFS}}}
let prefs=loadPrefs();
function applyPrefs(s){const root=document.documentElement;root.dataset.theme=s.theme;root.classList.toggle('reduced-motion',!!s.motion);const bg=getComputedStyle(root).getPropertyValue('--bg').trim();document.querySelector('meta[name="theme-color"]')?.setAttribute('content',bg||'#08090b')}
function readForm(){const t=document.querySelector('input[name="theme"]:checked');return{motion:$('motion-setting').checked,sound:$('sound-setting').checked,theme:t?t.value:'noir'}}
function fillForm(s){$('motion-setting').checked=!!s.motion;$('sound-setting').checked=!!s.sound;(document.querySelector('input[name="theme"][value="'+s.theme+'"]')||document.querySelector('input[name="theme"][value="noir"]')).checked=true}
function settings(){fillForm(prefs);applyPrefs(prefs);
 document.querySelectorAll('input[name="theme"]').forEach(r=>r.addEventListener('change',()=>applyPrefs(readForm())));
 $('motion-setting').addEventListener('change',()=>applyPrefs(readForm()));
 $('sound-setting').addEventListener('change',()=>{if($('sound-setting').checked)sfx.move()});
 $('settings-dialog').addEventListener('close',()=>{applyPrefs(prefs);fillForm(prefs)})}
function saveSettings(){prefs=readForm();try{localStorage.setItem('parcheesi.settings',JSON.stringify(prefs))}catch{}applyPrefs(prefs);$('settings-dialog').close();toast('Preferences saved')}
function openSettings(){fillForm(prefs);$('settings-dialog').showModal()}
let actx;
function tone(f,d,type,vol,delay){try{actx=actx||new(window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume();const t=actx.currentTime+(delay||0),o=actx.createOscillator(),g=actx.createGain();o.type=type||'sine';o.frequency.setValueAtTime(f,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol||.08,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(actx.destination);o.start(t);o.stop(t+d+.02)}catch{}}
const sfx={roll(){[0,.07,.14,.21].forEach((t,i)=>tone(180+i*55,.06,'square',.035,t))},move(){tone(520,.1,'triangle',.09)},capture(){tone(330,.12,'sawtooth',.06);tone(165,.25,'sawtooth',.06,.1)},pen(){tone(200,.25,'sine',.08)},win(){[523,659,784,1047].forEach((f,i)=>tone(f,.2,'triangle',.08,i*.14))}};
function cues(g){const n=g.history.length;if(state.seenLen==null||n<state.seenLen){state.seenLen=n;return}if(n===state.seenLen)return;const h=g.history[n-1];state.seenLen=n;if(!prefs.sound)return;if(g.status==='finished')sfx.win();else if(h.type==='move')(h.captured&&h.captured.length)?sfx.capture():sfx.move();else if(h.type==='roll')sfx.roll();else sfx.pen()}
function preview(){const s=E.initialState();s.players[0].tokens=[-1,-1,9,33];s.players[1].tokens=[-1,22,-1,41];s.players[2].tokens=[-1,-1,47,12];s.players[3].tokens=[-1,5,28,-1];board($('preview-board'),s,false)}
$('create-room').onclick=createRoom;$('join-room').onclick=()=>$('join-dialog').showModal();$('join-confirm').onclick=()=>{const code=$('join-code').value.trim().replace(/.*\/room\//,'');if(!code)return toast('Enter a room code');localStorage.setItem('parcheesi.name',$('player-name').value.trim()||name());$('join-dialog').close();joinRoom(code,name())};$('play-ai').onclick=()=>localGame(true);$('play-local').onclick=()=>localGame(false);$('copy-invite').onclick=invite;$('share-invite').onclick=()=>navigator.share?navigator.share({url:state.inviteUrl,title:'Join my PARCHEESI game'}):invite();$('toggle-ready').onclick=()=>{const p=state.room?.players.find(x=>x.color===state.color);if(p)send('lobby.ready',{ready:!p.ready})};$('start-game').onclick=()=>send('lobby.start');$('roll-dice').onclick=roll;$('leave-game').onclick=()=>{if(!state.local)send('room.leave');clearTimeout(aiTimer);state.room=null;state.game=null;state.local=false;state.seenLen=null;view('home-view')};$('play-again').onclick=()=>{if(state.local)localGame(state.ai);else{state.room=null;view('home-view')}};$('chat-send').onclick=chat;$('chat-input').onkeydown=e=>{if(e.key==='Enter')chat()};$('settings-open').onclick=openSettings;$('settings-save').onclick=saveSettings;$('how-to-play').onclick=()=>$('help-dialog').showModal();$('game-menu').onclick=()=>$('help-dialog').showModal();document.querySelectorAll('[data-go-home]').forEach(b=>b.onclick=()=>view('home-view'));document.querySelectorAll('.modal-close').forEach(b=>b.onclick=e=>e.target.closest('dialog').close());settings();preview();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});const match=location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);if(match){$('join-code').value=match[1];$('player-name').value=name();$('join-dialog').showModal()}view('home-view');
