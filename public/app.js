// The Floor — client. Vanilla, no build step.
// Identity is shared with the main platform: we accept ?uid= (how the main site
// links here), remember it in localStorage, and validate it against radical-db.

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

const state = {
  me: null,
  ws: null,
  room: 'square',
  roomMeta: { id: 'square', kind: 'square', topic: '' },
  lastSender: null,
  typers: new Map(),
  reconnectT: null,
};

// ---- identity -------------------------------------------------------------
function cookieUid() {
  const m = document.cookie.match(/(?:^|;\s*)radical_uid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function storedUid() {
  // Priority: explicit ?uid= link → shared cross-subdomain cookie → last used.
  const u = new URL(location.href);
  const q = u.searchParams.get('uid');
  if (q) { localStorage.setItem('floor_uid', q); return q; }
  const ck = cookieUid();
  if (ck) { localStorage.setItem('floor_uid', ck); return ck; }
  return localStorage.getItem('floor_uid');
}

async function resolveMe() {
  const uid = storedUid();
  if (!uid) return null;
  try {
    const r = await fetch('/api/me?uid=' + encodeURIComponent(uid));
    if (!r.ok) return null;
    const { user } = await r.json();
    return user;
  } catch { return null; }
}

// ---- routing (which room) -------------------------------------------------
function roomFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('p_')) return h;
  const u = new URL(location.href);
  const ref = u.searchParams.get('proposal');
  if (ref) return 'p_' + ref;
  return 'square';
}

// ---- websocket ------------------------------------------------------------
function connect() {
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  clearTimeout(state.reconnectT);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?room=${encodeURIComponent(state.room)}&uid=${encodeURIComponent(state.me.id)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    state.reconnectT = setTimeout(connect, 1500);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

// ---- message handling -----------------------------------------------------
function handle(m) {
  switch (m.t) {
    case 'hello':
      state.roomMeta = m.room || state.roomMeta;
      renderRoomHeader();
      el('stream').innerHTML = '';
      state.lastSender = null;
      (m.messages || []).forEach(addMessage);
      sysLine('you joined the floor');
      applyTally(m.tally);
      updatePresence(m.presence);
      scrollDown(true);
      break;
    case 'chat':
      addMessage(m.msg); scrollDownIfNear(); break;
    case 'presence':
      updatePresence(m.presence);
      if (m.joined) sysLine(m.joined + ' joined');
      break;
    case 'typing':
      showTyping(m.name); break;
    case 'react':
      floatReact(m.emoji); break;
    case 'tally':
      applyTally(m.tally); break;
  }
}

// ---- rendering ------------------------------------------------------------
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function avatarHTML(m, cls){
  if (m.avatar && /^https?:\/\//.test(m.avatar)) return `<img class="${cls}" src="${esc(m.avatar)}" alt="">`;
  const initial = (m.name || '✊').trim().charAt(0).toUpperCase();
  return `<div class="${cls}">${esc(initial || '✊')}</div>`;
}
function timeStr(ts){const d=new Date(ts);return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}

function addMessage(m){
  const stream = el('stream');
  const cont = state.lastSender === m.uid;
  state.lastSender = m.uid;
  const div = document.createElement('div');
  div.className = 'msg' + (cont ? ' cont' : '');
  div.dataset.uid = m.uid;
  div.innerHTML = cont
    ? `<div class="av"></div><div class="body">${linkify(m.body)}</div>`
    : `${avatarHTML(m,'av')}<div><div><span class="who">${esc(m.name)}</span><span class="t mono">${timeStr(m.ts)}</span></div><div class="body">${linkify(m.body)}</div></div>`;
  // double-tap to react
  div.addEventListener('dblclick', () => { send({t:'react',emoji:'✊'}); floatReact('✊'); });
  stream.appendChild(div);
}
function linkify(s){
  return esc(s).replace(/(https?:\/\/[^\s]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
}
function sysLine(text){
  const div=document.createElement('div');
  div.className='msg sys';
  div.innerHTML=`<div class="body">— ${esc(text)} —</div>`;
  el('stream').appendChild(div);
  state.lastSender=null;
}

function renderRoomHeader(){
  const meta = state.roomMeta;
  el('roomName').textContent = meta.kind === 'proposal' ? 'debate' : 'square';
  if (meta.kind === 'proposal') {
    el('roomTopic').textContent = meta.topic || 'proposal debate';
  } else {
    el('roomTopic').textContent = "the town square — everyone's here";
  }
}

function applyTally(t){
  const box = el('tally');
  if (!t) { box.classList.remove('show'); return; }
  el('tUp').textContent = t.up; el('tDown').textContent = t.down; el('tPet').textContent = t.petition;
  el('voteBtn').href = 'https://theradicalparty.com/?proposal=' + encodeURIComponent(t.proposalId);
  box.classList.add('show');
}

let presenceCache = {count:0,users:[]};
function updatePresence(p){
  if (!p) return;
  presenceCache = p;
  el('onlineN').textContent = p.count;
}

// typing indicator
function showTyping(name){
  state.typers.set(name, Date.now());
  renderTyping();
}
function renderTyping(){
  const now=Date.now();
  for(const [n,t] of state.typers) if(now-t>3000) state.typers.delete(n);
  const names=[...state.typers.keys()];
  const box=el('typing');
  if(!names.length){box.textContent='';return;}
  box.textContent = names.length===1 ? `${names[0]} is typing…`
    : names.length===2 ? `${names[0]} and ${names[1]} are typing…`
    : `${names.length} radicals are typing…`;
}
setInterval(renderTyping, 1500);

// reactions
function floatReact(emoji){
  const c=el('reacts');
  const s=document.createElement('div');
  s.className='rfloat'; s.textContent=emoji;
  s.style.right=(Math.random()*60)+'px';
  c.appendChild(s);
  setTimeout(()=>s.remove(),1800);
}

// scroll
function scrollDown(force){const s=el('stream');s.scrollTop=s.scrollHeight;}
function scrollDownIfNear(){const s=el('stream');if(s.scrollHeight-s.scrollTop-s.clientHeight<160)s.scrollTop=s.scrollHeight;}

// ---- rooms sidebar --------------------------------------------------------
async function refreshRooms(){
  let data={online:0,square:0,hot:[]};
  try{ data = await (await fetch('/api/activity')).json(); }catch{}
  el('onlineN').textContent = data.online || presenceCache.count || 0;
  const list = el('roomList');
  const rooms = [{id:'square',kind:'square',topic:'Town square',count:data.square||0}, ...(data.hot||[]).map(h=>({id:h.room,kind:'proposal',topic:h.topic,count:h.count}))];
  // ensure current room is present even if empty of others
  if (!rooms.find(r=>r.id===state.room)) rooms.push({id:state.room,kind:state.roomMeta.kind,topic:state.roomMeta.topic,count:presenceCache.count});
  list.innerHTML='';
  rooms.forEach(r=>{
    const b=document.createElement('button');
    b.className='room'+(r.id===state.room?' active':'');
    const label = r.kind==='square' ? 'town-square' : (r.topic||'debate');
    b.innerHTML=`<span class="hash">${r.kind==='square'?'⌂':'#'}</span><span class="rt">${esc(label)}</span><span class="cnt${r.count>0?' live':''}">${r.count}</span>`;
    b.onclick=()=>enterRoom(r.id);
    list.appendChild(b);
  });
}
setInterval(refreshRooms, 5000);

function enterRoom(id){
  if (id===state.room) { closeAside(); return; }
  state.room = id;
  location.hash = id==='square' ? '' : ('#/'+id);
  connect();
  refreshRooms();
  closeAside();
}

// ---- compose --------------------------------------------------------------
function submitInput(){
  const inp = el('input');
  const val = inp.value.trim();
  if (!val) return;
  inp.value=''; autosize();
  if (val.startsWith('/propose ')) { doPropose(val.slice(9).trim()); return; }
  if (val === '/propose') { openPropose(); return; }
  send({t:'chat', body:val});
}

let typingThrottle=0;
function onType(){
  autosize();
  const now=Date.now();
  if(now-typingThrottle>1500){ send({t:'typing'}); typingThrottle=now; }
}
function autosize(){const i=el('input');i.style.height='auto';i.style.height=Math.min(i.scrollHeight,120)+'px';}

// ---- propose flow ---------------------------------------------------------
function openPropose(prefill){
  el('proposeModal').classList.add('show');
  const t=el('propText'); t.value=prefill||''; t.focus();
  el('propCount').textContent=t.value.length;
}
function closePropose(){el('proposeModal').classList.remove('show');}
async function doPropose(text){
  text=(text||'').trim();
  if(!text){openPropose();return;}
  try{
    const r=await fetch('/api/propose',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({uid:state.me.id,text})});
    const d=await r.json();
    if(!r.ok){alert(d.error||'could not propose');return;}
    closePropose();
    // jump into the fresh debate room
    enterRoom(d.room.id);
  }catch(e){alert('network error');}
}

// ---- boot -----------------------------------------------------------------
async function boot(){
  const me = await resolveMe();
  if (!me){ el('gate').classList.add('show'); return; }
  state.me = me;
  el('gate').classList.remove('show');
  el('meAv').innerHTML = (me.avatar_url && /^https?:/.test(me.avatar_url))
    ? `<img src="${esc(me.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
    : esc((me.name||'✊').charAt(0).toUpperCase());

  state.room = roomFromHash();
  connect();
  refreshRooms();

  // wire events
  el('sendBtn').onclick=submitInput;
  el('input').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitInput();}
  });
  el('input').addEventListener('input',onType);
  el('proposeBtn').onclick=()=>openPropose();
  el('propCancel').onclick=closePropose;
  el('propSubmit').onclick=()=>doPropose(el('propText').value);
  el('propText').addEventListener('input',e=>el('propCount').textContent=e.target.value.length);
  el('menuBtn').onclick=()=>el('aside').classList.toggle('open');
  window.addEventListener('hashchange',()=>{const r=roomFromHash();if(r!==state.room)enterRoom(r);});

  // heartbeat ping to keep ws warm
  setInterval(()=>send({t:'ping'}), 25000);
}
function closeAside(){el('aside').classList.remove('open');}

el('gateRetry').onclick=()=>location.reload();
boot();
