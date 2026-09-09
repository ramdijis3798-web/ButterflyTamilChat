const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6 });
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null;

const DEFAULT_ROOMS = [
  ['tamil-friends','Tamil Friends','🦋','system'],
  ['fm-lounge','FM Lounge','🎵','system'],
  ['love-corner','Love Corner','❤️','system']
];
const users = new Map(); // socket.id -> session
const bannedIps = new Set();
const mutedUntil = new Map();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', async (_req,res) => res.json({ ok:true, service:'ButterflyTamilChat', database:!!pool }));

function cleanName(name){ return String(name||'Guest').trim().slice(0,30)||'Guest'; }
function cleanRoomId(name){ return String(name||'').toLowerCase().trim().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32); }
function ipOf(socket){ return String(socket.handshake.headers['x-forwarded-for']||socket.handshake.address||'').split(',')[0].trim().replace(/^::ffff:/,''); }
function adminOk(key){ return key === ADMIN_KEY; }
function now(){ return new Date().toISOString(); }
async function q(text,params=[]){ if(!pool) return {rows:[]}; return pool.query(text,params); }

async function initDb(){
  if(!pool) return;
  await q(`CREATE TABLE IF NOT EXISTS profiles (
    uid TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '💬', owner_uid TEXT NOT NULL DEFAULT 'system', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS room_messages (
    id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, uid TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', attachment JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS room_messages_room_id_id_idx ON room_messages(room_id,id)`);
  await q(`CREATE TABLE IF NOT EXISTS private_messages (
    id BIGSERIAL PRIMARY KEY, sender_uid TEXT NOT NULL, receiver_uid TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', attachment JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS private_messages_pair_idx ON private_messages(sender_uid,receiver_uid,id)`);
  await q(`CREATE TABLE IF NOT EXISTS banned_ips (ip TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS room_mutes (uid TEXT PRIMARY KEY, muted_until TIMESTAMPTZ NOT NULL)`);
  for(const [id,name,emoji,owner] of DEFAULT_ROOMS) await q(`INSERT INTO rooms(id,name,emoji,owner_uid) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[id,name,emoji,owner]);
  const bans = await q('SELECT ip FROM banned_ips'); bans.rows.forEach(r=>bannedIps.add(r.ip));
}
async function getRooms(){
  if(!pool) return DEFAULT_ROOMS.map(([id,name,emoji,owner])=>({id,name,emoji,owner}));
  const r=await q('SELECT id,name,emoji,owner_uid AS owner FROM rooms ORDER BY created_at,id'); return r.rows;
}
async function sendRooms(socket){ socket.emit('rooms',await getRooms()); }
async function broadcastRooms(){ io.emit('rooms',await getRooms()); }
async function loadProfile(uid,name,avatar){
  if(!pool) return {uid,name,avatar};
  const r=await q(`INSERT INTO profiles(uid,name,avatar) VALUES($1,$2,$3) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,avatar=EXCLUDED.avatar,updated_at=NOW() RETURNING uid,name,avatar`,[uid,name,avatar]);
  return r.rows[0];
}
async function loadHistory(room,socket){
  if(!pool) return;
  const r=await q(`SELECT uid AS "userId",name,avatar,text,attachment,created_at AS time FROM room_messages WHERE room_id=$1 ORDER BY id DESC LIMIT 100`,[room]);
  socket.emit('chat:history',r.rows.reverse().map(x=>({...x,room}))); 
}
async function loadPrivateHistory(a,b,socket){
  if(!pool) return;
  const r=await q(`SELECT sender_uid AS "from",name,avatar,text,attachment,created_at AS time FROM private_messages WHERE (sender_uid=$1 AND receiver_uid=$2) OR (sender_uid=$2 AND receiver_uid=$1) ORDER BY id ASC LIMIT 200`,[a,b]);
  socket.emit('private:history',{target:b,messages:r.rows});
}
function directory(){
  return [...users.entries()].map(([id,u])=>({id,uid:u.uid,name:u.name,room:u.room,avatar:u.avatar||'',muted:(mutedUntil.get(u.uid)||0)>Date.now()}));
}
function broadcastDirectory(){ io.emit('directory',directory()); }

io.on('connection',socket=>{
  const ip=ipOf(socket);
  if(bannedIps.has(ip)){ socket.emit('moderation:banned','You are banned from ButterflyTamilChat.'); return socket.disconnect(true); }

  socket.on('join',async({uid,name,avatar})=>{
    uid=String(uid||crypto.randomUUID()).slice(0,80); name=cleanName(name); avatar=String(avatar||'').slice(0,900000);
    const profile=await loadProfile(uid,name,avatar);
    const user={uid,name:profile.name,avatar:profile.avatar||'',room:'tamil-friends',ip};
    users.set(socket.id,user); socket.join(user.room);
    socket.emit('joined',{id:socket.id,uid:user.uid,room:user.room}); await sendRooms(socket); await loadHistory(user.room,socket);
    io.to(user.room).emit('system',`${user.name} joined the room`); broadcastDirectory();
  });

  socket.on('profile:update',async({name,avatar})=>{const u=users.get(socket.id);if(!u)return;u.name=cleanName(name);u.avatar=String(avatar||'').slice(0,900000);await loadProfile(u.uid,u.name,u.avatar);socket.emit('profile:updated',{name:u.name,avatar:u.avatar});broadcastDirectory();});

  socket.on('room:create',async({name})=>{const u=users.get(socket.id);if(!u)return;const id=cleanRoomId(name);if(!id||id.length<2)return socket.emit('room:error','Room name is invalid.');
    const exists=(await getRooms()).some(r=>r.id===id); if(exists)return socket.emit('room:error','Room already exists.');
    if(pool) await q('INSERT INTO rooms(id,name,emoji,owner_uid) VALUES($1,$2,$3,$4)',[id,String(name).trim().slice(0,30),'💬',u.uid]);
    broadcastRooms();socket.emit('room:created',id);
  });

  socket.on('room:join',async room=>{const u=users.get(socket.id);if(!u)return;const valid=(await getRooms()).some(r=>r.id===room);if(!valid)return;
    socket.leave(u.room);socket.to(u.room).emit('system',`${u.name} left the room`);u.room=room;socket.join(room);socket.emit('room:joined',room);await loadHistory(room,socket);io.to(room).emit('system',`${u.name} joined the room`);broadcastDirectory();
  });

  socket.on('room:delete',async({room,key})=>{if(!adminOk(key))return socket.emit('admin:error','Invalid admin key.');if(DEFAULT_ROOMS.some(x=>x[0]===room))return;if(pool)await q('DELETE FROM rooms WHERE id=$1',[room]);broadcastRooms();});

  socket.on('chat',async({text,room,attachment})=>{const u=users.get(socket.id);if(!u)return;const mute=mutedUntil.get(u.uid)||0;if(mute>Date.now())return socket.emit('moderation:muted',Math.ceil((mute-Date.now())/1000));
    const clean=String(text||'').trim().slice(0,1000);const target=(await getRooms()).some(r=>r.id===room)?room:u.room;
    if(clean.toLowerCase()==='/clear cmnt'){if(!adminOk(process.env.ADMIN_KEY||'')) return socket.emit('admin:needed'); if(pool) await q('DELETE FROM room_messages WHERE room_id=$1',[target]); io.to(target).emit('chat:cleared'); return;}
    const att=validAttachment(attachment);if(!clean&&!att)return;
    const packet={userId:u.uid,id:socket.id,name:u.name,avatar:u.avatar||'',text:clean,room:target,time:now(),attachment:att};
    if(pool) await q('INSERT INTO room_messages(room_id,uid,name,avatar,text,attachment) VALUES($1,$2,$3,$4,$5,$6)',[target,u.uid,u.name,u.avatar||'',clean,att?JSON.stringify(att):null]);
    io.to(target).emit('chat',packet);
  });

  socket.on('private:open',async target=>{const u=users.get(socket.id);if(!u||!target)return;await loadPrivateHistory(u.uid,String(target),socket);});
  socket.on('private:message',async({target,text,attachment})=>{const u=users.get(socket.id);if(!u)return;const mute=mutedUntil.get(u.uid)||0;if(mute>Date.now())return socket.emit('moderation:muted',Math.ceil((mute-Date.now())/1000));
    target=String(target||'');const receiver=[...users.values()].find(x=>x.uid===target);if(!receiver)return;const clean=String(text||'').trim().slice(0,1000);const att=validAttachment(attachment);if(!clean&&!att)return;
    const packet={from:u.uid,name:u.name,avatar:u.avatar||'',text:clean,time:now(),attachment:att};if(pool)await q('INSERT INTO private_messages(sender_uid,receiver_uid,name,avatar,text,attachment) VALUES($1,$2,$3,$4,$5,$6)',[u.uid,target,u.name,u.avatar||'',clean,att?JSON.stringify(att):null]);
    socket.emit('private:message',packet);const targetSocket=[...users.entries()].find(([,x])=>x.uid===target)?.[0];if(targetSocket)io.to(targetSocket).emit('private:message',packet);
  });

  socket.on('moderation:action',async({action,target,key,duration})=>{if(!adminOk(key))return socket.emit('admin:error','Invalid admin key.');const tu=users.get(target);if(!tu)return;
    if(action==='kick'){io.to(target).emit('moderation:kicked','You were kicked by an administrator.');io.sockets.sockets.get(target)?.disconnect(true);}
    else if(action==='ban'){bannedIps.add(tu.ip);if(pool)await q('INSERT INTO banned_ips(ip) VALUES($1) ON CONFLICT DO NOTHING',[tu.ip]);io.to(target).emit('moderation:banned','You were banned by an administrator.');io.sockets.sockets.get(target)?.disconnect(true);}
    else if(action==='mute'){const seconds=Math.min(Math.max(Number(duration)||300,10),86400);const until=Date.now()+seconds*1000;mutedUntil.set(tu.uid,until);if(pool)await q('INSERT INTO room_mutes(uid,muted_until) VALUES($1,to_timestamp($2/1000.0)) ON CONFLICT(uid) DO UPDATE SET muted_until=EXCLUDED.muted_until',[tu.uid,until]);io.to(target).emit('moderation:muted',seconds);broadcastDirectory();}
    else if(action==='unmute'){mutedUntil.delete(tu.uid);if(pool)await q('DELETE FROM room_mutes WHERE uid=$1',[tu.uid]);io.to(target).emit('moderation:unmuted');broadcastDirectory();}
  });

  socket.on('admin:users',async key=>{if(!adminOk(key))return socket.emit('admin:error','Invalid admin key.');socket.emit('admin:users',[...users.entries()].map(([id,u])=>({id,uid:u.uid,name:u.name,room:u.room,ip:u.ip,muted:(mutedUntil.get(u.uid)||0)>Date.now(),avatar:u.avatar||''})));});
  socket.on('admin:clear',async({room,key})=>{if(!adminOk(key))return socket.emit('admin:error','Invalid admin key.');if(pool)await q('DELETE FROM room_messages WHERE room_id=$1',[room]);io.to(room).emit('chat:cleared');});

  // WebRTC signaling
  socket.on('call:offer',({target,offer,mode})=>{const s=[...users.entries()].find(([,u])=>u.uid===target)?.[0];if(s)io.to(s).emit('call:offer',{from:users.get(socket.id)?.uid,name:users.get(socket.id)?.name||'Guest',offer,mode:mode==='video'?'video':'audio'});});
  socket.on('call:answer',({target,answer})=>{const s=[...users.entries()].find(([,u])=>u.uid===target)?.[0];if(s)io.to(s).emit('call:answer',{from:users.get(socket.id)?.uid,answer});});
  socket.on('call:ice',({target,candidate})=>{const s=[...users.entries()].find(([,u])=>u.uid===target)?.[0];if(s)io.to(s).emit('call:ice',{from:users.get(socket.id)?.uid,candidate});});
  socket.on('call:hangup',({target})=>{const s=[...users.entries()].find(([,u])=>u.uid===target)?.[0];if(s)io.to(s).emit('call:hangup',{from:users.get(socket.id)?.uid});});

  socket.on('disconnect',()=>{const u=users.get(socket.id);users.delete(socket.id);if(u)io.to(u.room).emit('system',`${u.name} left the room`);broadcastDirectory();});
});
function validAttachment(a){if(!a||!['image/jpeg','image/png','image/gif','image/webp'].includes(a.type))return null;const data=String(a.data||'');if(!data.startsWith('data:')||data.length>2800000)return null;return {type:a.type,data,name:String(a.name||'image').slice(0,80)};}

(async()=>{try{await initDb();server.listen(PORT,()=>console.log(`ButterflyTamilChat running on ${PORT}; persistent DB=${!!pool}`));}catch(e){console.error(e);process.exit(1);}})();
