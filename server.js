// server.js — Clavier Ninja Online (Render-ready)
const http = require('http');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;

// Petit serveur HTTP pour le healthcheck de Render
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('Clavier Ninja server OK');
});
httpServer.listen(PORT, () => {
  console.log(`HTTP listening on :${PORT}`);
});

// ====== Utilitaires & Générateurs de défis ======
const words = [
  "banane","kebab","sorcière","pigeon","gaufre","paprika","ninja","pamplemousse",
  "tortue","pastèque","saucisson","biscotte","caramel","moustache","chaussette",
  "croissant","baguette","fromage","harissa","taboulé","moutarde","frites","cornichon","gazelle"
];
const rand = n => Math.floor(Math.random()*n);
const pick = arr => arr[rand(arr.length)];
const reverse = s => s.split('').reverse().join('');

function genExact(){
  const opt = [
    pick(words),
    pick(words)+' '+pick(words),
    pick(words)+' '+rand(99),
    'je te vois','ok daccord','vive le roi','mdr ptdr'
  ];
  const base = pick(opt);
  return { prompt:`Tape exactement : « ${base} »`, expect: base };
}
function genUpper(){
  const base = (pick(words)+' '+pick(words)).toLowerCase();
  return { prompt:`MAJUSCULES : « ${base} »`, expect: base.toUpperCase() };
}
function genReverse(){
  const base = pick(words)+' '+pick(words);
  return { prompt:`À l’envers : « ${base} »`, expect: reverse(base) };
}
const generators = [genExact, genUpper, genReverse];
function newChallenge(){ return pick(generators)(); }

// ====== WebSocket + Rooms ======
const wss = new WebSocketServer({ server: httpServer });

/*
room = {
  id, players: [{id, ws, name}], scores:[0,0], target:5, secs:10,
  turn:0|1, current:{prompt, expect}, timeLeft, timerLoop, roundId
}
*/
const rooms = new Map();
const send = (ws, type, data={}) => { try{ ws.send(JSON.stringify({type, ...data})); }catch{} };
const broadcast = (room, type, data={}) => room.players.forEach(p=> send(p.ws, type, data));
const state = (room) => ({
  room: room.id,
  players: room.players.map(p=>({id:p.id,name:p.name})),
  scores: room.scores,
  target: room.target,
  secs: room.secs,
  turn: room.turn,
  timeLeft: room.timeLeft,
  prompt: room.current ? room.current.prompt : null
});
function ensureRoom(id){
  if(!rooms.has(id)){
    rooms.set(id, { id, players:[], scores:[0,0], target:5, secs:10, turn:0,
      current:null, timeLeft:0, timerLoop:null, roundId:null });
  }
  return rooms.get(id);
}

function startRound(room){
  // Victoire ?
  if(room.scores[0] >= room.target || room.scores[1] >= room.target){
    const winner = room.scores[0] > room.scores[1] ? 0 : 1;
    broadcast(room, 'end', { winner, scores: room.scores });
    return;
  }
  room.roundId = nanoid();
  room.current = newChallenge();
  room.timeLeft = room.secs;

  broadcast(room, 'challenge', { ...state(room) });

  clearInterval(room.timerLoop);
  room.timerLoop = setInterval(()=>{
    room.timeLeft -= 1;
    if(room.timeLeft <= 0){
      clearInterval(room.timerLoop);
      broadcast(room, 'tick', { timeLeft: 0 });
      broadcast(room, 'result', { ok:false, expect: room.current.expect, turn: room.turn });
      room.turn = 1 - room.turn;
      setTimeout(()=> startRound(room), 600);
      return;
    }
    broadcast(room, 'tick', { timeLeft: room.timeLeft });
  }, 1000);
}

wss.on('connection', (ws) => {
  ws.id = nanoid();
  ws.meta = { roomId:null, index:null, name:`Joueur-${ws.id.slice(0,4)}` };

  ws.on('message', (buf)=>{
    let msg={}; try{ msg = JSON.parse(buf.toString()); }catch{ return; }

    if(msg.type==='join'){
      const room = ensureRoom(String(msg.room||'salon'));
      if(room.players.length >= 2) return send(ws,'error',{message:'Salon plein (2 max).'});
      ws.meta.roomId = room.id;
      ws.meta.name = (msg.name||ws.meta.name).slice(0,20);
      room.players.push({ id: ws.id, ws, name: ws.meta.name });
      ws.meta.index = room.players.length-1;
      if(room.players.length===1){ room.scores=[0,0]; room.turn=0; room.current=null; }
      broadcast(room, 'lobby', state(room));
      if(room.players.length===2) broadcast(room,'lobby-ready', state(room));
      return;
    }

    if(msg.type==='config'){
      const room = rooms.get(ws.meta.roomId); if(!room) return;
      if(ws.meta.index!==0) return; // seul J1
      room.target = Math.max(1, Math.min(20, parseInt(msg.target||5)));
      room.secs   = Math.max(3, Math.min(30, parseInt(msg.secs||10)));
      broadcast(room, 'lobby', state(room));
      return;
    }

    if(msg.type==='start'){
      const room = rooms.get(ws.meta.roomId); if(!room) return;
      if(room.players.length<2) return send(ws,'error',{message:'Attends le 2e joueur.'});
      if(ws.meta.index!==0) return;
      room.scores=[0,0];
      room.turn = Math.random()<0.5 ? 0 : 1;
      startRound(room);
      return;
    }

    if(msg.type==='submit'){
      const room = rooms.get(ws.meta.roomId); if(!room||!room.current) return;
      if(ws.meta.index !== room.turn) return;
      const answer = String(msg.answer||'');
      const ok = answer === room.current.expect;
      clearInterval(room.timerLoop);
      broadcast(room,'result',{ ok, expect:room.current.expect, turn:room.turn, answer });
      if(ok) room.scores[ws.meta.index] += 1;
      room.turn = 1 - room.turn;
      setTimeout(()=> startRound(room), 600);
      return;
    }

    if(msg.type==='skip'){
      const room = rooms.get(ws.meta.roomId); if(!room||!room.current) return;
      if(ws.meta.index !== room.turn) return;
      clearInterval(room.timerLoop);
      broadcast(room,'result',{ ok:false, expect:room.current.expect, turn:room.turn, skipped:true });
      room.turn = 1 - room.turn;
      setTimeout(()=> startRound(room), 600);
      return;
    }
  });

  ws.on('close', ()=>{
    const roomId = ws.meta.roomId; if(!roomId) return;
    const room = rooms.get(roomId); if(!room) return;
    room.players = room.players.filter(p=>p.id!==ws.id);
    clearInterval(room.timerLoop);
    broadcast(room,'lobby', state(room));
    if(room.players.length===0) rooms.delete(roomId);
  });
});

console.log(`Clavier Ninja serveur WebSocket prêt sur port ${PORT}`);
