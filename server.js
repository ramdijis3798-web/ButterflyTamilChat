const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'butterfly-admin';

const users = new Map();
const rooms = new Map([
  ['tamil-friends', { name: 'Tamil Friends', emoji: '🦋', owner: 'system' }],
  ['fm-lounge', { name: 'FM Lounge', emoji: '🎵', owner: 'system' }],
  ['love-corner', { name: 'Love Corner', emoji: '❤️', owner: 'system' }]
]);
const bannedIps = new Set();
const mutedUntil = new Map();

app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ButterflyTamilChat' }));

function cleanName(name) { return String(name || 'Guest').trim().slice(0, 30) || 'Guest'; }
function cleanRoomId(name) { return String(name || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); }
function ipOf(socket) { return String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim().replace(/^::ffff:/, ''); }
function directory() {
  return [...users.entries()].map(([id, u]) => ({ id, name: u.name, room: u.room, avatar: u.avatar || '', muted: (mutedUntil.get(id) || 0) > Date.now() }));
}
function broadcastDirectory() { io.emit('directory', directory()); }
function adminOk(socket, key) { return key === ADMIN_KEY; }
function sendRooms(socket) { socket.emit('rooms', [...rooms.entries()].map(([id, r]) => ({ id, ...r }))); }
function broadcastRooms() { io.emit('rooms', [...rooms.entries()].map(([id, r]) => ({ id, ...r }))); }

io.on('connection', socket => {
  const ip = ipOf(socket);
  if (bannedIps.has(ip)) {
    socket.emit('moderation:banned', 'You are banned from ButterflyTamilChat.');
    return socket.disconnect(true);
  }

  socket.on('join', ({ name, avatar }) => {
    const user = { name: cleanName(name), room: 'tamil-friends', avatar: String(avatar || '').slice(0, 500000), ip };
    users.set(socket.id, user);
    socket.join(user.room);
    socket.emit('joined', { id: socket.id, room: user.room });
    sendRooms(socket);
    io.to(user.room).emit('system', `${user.name} joined the room`);
    broadcastDirectory();
  });

  socket.on('profile:update', ({ name, avatar }) => {
    const user = users.get(socket.id); if (!user) return;
    user.name = cleanName(name); user.avatar = String(avatar || '').slice(0, 500000);
    socket.emit('profile:updated', { name: user.name, avatar: user.avatar });
    broadcastDirectory();
  });

  socket.on('room:create', ({ name }) => {
    const user = users.get(socket.id); if (!user) return;
    const id = cleanRoomId(name);
    if (!id || id.length < 2 || rooms.has(id)) return socket.emit('room:error', 'Room name is invalid or already exists.');
    rooms.set(id, { name: String(name).trim().slice(0, 30), emoji: '💬', owner: socket.id });
    broadcastRooms();
    socket.emit('room:created', id);
  });

  socket.on('room:join', room => {
    const user = users.get(socket.id);
    if (!user || !rooms.has(room)) return;
    socket.leave(user.room);
    socket.to(user.room).emit('system', `${user.name} left the room`);
    user.room = room; socket.join(room);
    socket.emit('room:joined', room);
    io.to(room).emit('system', `${user.name} joined the room`);
    broadcastDirectory();
  });

  socket.on('room:delete', ({ room, key }) => {
    if (!adminOk(socket, key)) return socket.emit('admin:error', 'Invalid admin key.');
    if (!rooms.has(room) || ['tamil-friends', 'fm-lounge', 'love-corner'].includes(room)) return;
    rooms.delete(room);
    for (const [id, u] of users) if (u.room === room) {
      u.room = 'tamil-friends'; io.sockets.sockets.get(id)?.join('tamil-friends'); io.to(id).emit('room:joined', 'tamil-friends');
    }
    broadcastRooms(); broadcastDirectory();
  });

  socket.on('chat', ({ text, room, attachment }) => {
    const user = users.get(socket.id); if (!user) return;
    const mute = mutedUntil.get(socket.id) || 0;
    if (mute > Date.now()) return socket.emit('moderation:muted', Math.ceil((mute - Date.now()) / 1000));
    const clean = String(text || '').trim().slice(0, 1000);
    const targetRoom = rooms.has(room) ? room : user.room;
    const packet = { id: socket.id, name: user.name, avatar: user.avatar || '', text: clean, room: targetRoom, time: new Date().toISOString(), attachment: null };
    if (attachment && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(attachment.type) && String(attachment.data || '').startsWith('data:') && String(attachment.data).length <= 2_500_000) {
      packet.attachment = { type: attachment.type, data: attachment.data, name: String(attachment.name || 'image').slice(0, 80) };
    }
    if (!clean && !packet.attachment) return;
    io.to(targetRoom).emit('chat', packet);
  });

  socket.on('private:message', ({ target, text, attachment }) => {
    const user = users.get(socket.id); const clean = String(text || '').trim().slice(0, 1000);
    if (!user || !users.has(target)) return;
    const mute = mutedUntil.get(socket.id) || 0; if (mute > Date.now()) return socket.emit('moderation:muted', Math.ceil((mute - Date.now()) / 1000));
    const packet = { from: socket.id, name: user.name, avatar: user.avatar || '', text: clean, time: new Date().toISOString(), attachment: null };
    if (attachment && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(attachment.type) && String(attachment.data || '').startsWith('data:') && String(attachment.data).length <= 2_500_000) packet.attachment = { type: attachment.type, data: attachment.data, name: String(attachment.name || 'image').slice(0, 80) };
    if (!clean && !packet.attachment) return;
    socket.emit('private:message', packet); io.to(target).emit('private:message', packet);
  });

  socket.on('moderation:action', ({ action, target, key, duration }) => {
    if (!adminOk(socket, key)) return socket.emit('admin:error', 'Invalid admin key.');
    const targetSocket = io.sockets.sockets.get(target); const targetUser = users.get(target); if (!targetSocket || !targetUser) return;
    if (action === 'kick') {
      io.to(target).emit('moderation:kicked', 'You were kicked by an administrator.');
      targetSocket.disconnect(true);
    } else if (action === 'ban') {
      bannedIps.add(targetUser.ip); io.to(target).emit('moderation:banned', 'You were banned by an administrator.'); targetSocket.disconnect(true);
    } else if (action === 'mute') {
      const seconds = Math.min(Math.max(Number(duration) || 300, 10), 86400);
      mutedUntil.set(target, Date.now() + seconds * 1000); io.to(target).emit('moderation:muted', seconds); broadcastDirectory();
    } else if (action === 'unmute') {
      mutedUntil.delete(target); io.to(target).emit('moderation:unmuted'); broadcastDirectory();
    }
  });

  socket.on('admin:users', key => {
    if (!adminOk(socket, key)) return socket.emit('admin:error', 'Invalid admin key.');
    socket.emit('admin:users', [...users.entries()].map(([id, u]) => ({ id, name: u.name, room: u.room, ip: u.ip, muted: (mutedUntil.get(id) || 0) > Date.now(), avatar: u.avatar || '' })));
  });

  // WebRTC signaling
  socket.on('call:offer', ({ target, offer, mode }) => { if (users.has(target)) io.to(target).emit('call:offer', { from: socket.id, name: users.get(socket.id)?.name || 'Guest', offer, mode: mode === 'video' ? 'video' : 'audio' }); });
  socket.on('call:answer', ({ target, answer }) => { if (users.has(target)) io.to(target).emit('call:answer', { from: socket.id, answer }); });
  socket.on('call:ice', ({ target, candidate }) => { if (users.has(target)) io.to(target).emit('call:ice', { from: socket.id, candidate }); });
  socket.on('call:hangup', ({ target }) => { if (users.has(target)) io.to(target).emit('call:hangup', { from: socket.id }); });

  socket.on('disconnect', () => { const user = users.get(socket.id); users.delete(socket.id); mutedUntil.delete(socket.id); if (user) io.to(user.room).emit('system', `${user.name} left the room`); broadcastDirectory(); });
});

server.listen(PORT, () => console.log(`ButterflyTamilChat running on ${PORT}`));
