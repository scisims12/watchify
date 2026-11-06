const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Small message buffer + fast ping so network drops are noticed quickly and oversized payloads are refused.
const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 8000 });
const PORT = process.env.PORT || 3000;
const MAX_MB = Number(process.env.MAX_MB) || 2000;

const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });
// Rooms live only in memory; files left by an unexpected server restart are orphaned.
for (const entry of fs.readdirSync(UP, { withFileTypes: true })) {
  if (entry.isFile()) fs.promises.unlink(path.join(UP, entry.name)).catch(console.error);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, f, cb) => cb(null, Date.now() + '-' + f.originalname.replace(/[^\w.\-]/g, '_')),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, /^video\//.test(f.mimetype)),
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UP)); // range requests supported, so seeking works

app.post('/upload', (req, res) => {
  const code = cleanCode(req.get('x-room-code'));
  const socket = io.sockets.sockets.get(req.get('x-socket-id'));
  const room = rooms[code];
  if (!room || !socket || !room.members.has(socket.id) || socket.data.roomCode !== code || !allowed(socket, room))
    return res.status(403).json({ error: 'Join the room with playback permission before uploading.' });
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Please choose a video file.' });
    if (rooms[code] !== room || !room.members.has(socket.id) || !allowed(socket, room)) {
      fs.promises.unlink(req.file.path).catch(console.error);
      return res.status(410).json({ error: 'This room has ended or upload permission changed.' });
    }
    room.uploads.add(req.file.filename);
    res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
  });
});

// Optional: resolve other sites (Dailymotion, Twitter/X, Facebook, etc.) with yt-dlp, if installed on the server.
const PRIVATE = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i;
app.get('/resolve', (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || '')); } catch (e) { return res.status(400).json({ error: 'Invalid link.' }); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) return res.status(400).json({ error: 'This link is not allowed.' });
  execFile('yt-dlp', ['--no-playlist', '-f', 'best[ext=mp4]/best', '-e', '-g', u.href], { timeout: 25000 }, (err, out) => {
    if (err && err.code === 'ENOENT') return res.status(503).json({ error: 'This site needs yt-dlp installed on the server.' });
    const lines = String(out || '').trim().split('\n').filter(Boolean);
    if (err || lines.length < 2) return res.status(422).json({ error: 'Could not find a playable video at this link. It may be private, paid or DRM-protected.' });
    res.json({ title: lines[0], url: lines[lines.length - 1] });
  });
});

// ---- rooms ----
const rooms = {};
// Public invite info for a scheduled movie night (title and time only).
app.get('/api/invite/:code', (req, res) => {
  const r = rooms[cleanCode(req.params.code)];
  if (!r || !r.schedule) return res.json({ exists: !!r, serverTime: Date.now() });
  res.json({ exists: true, name: r.name, title: r.schedule.title, at: r.schedule.at, locked: r.locked, count: r.members.size, serverTime: Date.now() });
});
setInterval(() => { for (const r of Object.values(rooms)) if (r.playing && r.video && r.members.size) r.stats.secs++; }, 1000); // time watched together
setInterval(() => { for (const r of Object.values(rooms)) if (!r.members.size && !r.hostTimer && !keepAlive(r)) destroyRoom(r); }, 60000);
const currentTime = (r) => (r.playing ? r.time + (Date.now() - r.at) / 1000 : r.time);
const snapshot = (r) => ({ video: r.video, playing: r.playing, time: currentTime(r), seq: r.seq });
const validId = (v) => typeof v === 'string' && /^[a-f0-9-]{32,64}$/i.test(v);
const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const members = (r) => [...r.members.values()].sort((a, b) => a.at - b.at);
const memberList = (r) => members(r).map((m) => ({ id: m.id, name: m.name, host: m.id === r.hostClientId, remote: m.id === r.remoteId, brb: r.brb.has(m.id) }));
function broadcast(r) {
  io.to(r.code).emit('room-info', { mode: r.mode, locked: r.locked, hostId: r.hostClientId, remoteId: r.remoteId, users: memberList(r),
    name: r.name, maxMembers: r.maxMembers, chatMuted: r.chatMuted, vibe: r.vibe, schedule: r.schedule, remoteUntil: r.remoteUntil });
  sendQueue(r);
}
function announce(r, msg) { io.to(r.code).emit('chat', { system: true, msg }); }
function allowed(socket, r) {
  return !r.countdownAt && (r.mode === 'everyone' || socket.data.clientId === r.hostClientId ||
    (r.mode === 'ask' && socket.data.clientId === r.remoteId));
}
function deny(socket, msg = 'Only the host or remote holder can control playback.') { socket.emit('not-allowed', msg); }
const MAX_ROOMS = 500, MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 50, MAX_QUEUE = 20, MAX_SUGGESTIONS = 10;
const REACTIONS = ['heart', 'like', 'laugh', 'wow', 'star'];
const newId = () => crypto.randomBytes(6).toString('hex');
// Sliding-window rate limit per socket. Repeated violations earn a short mute (flood protection).
const LIMITS = { chat: [6, 8000], reaction: [8, 4000], typing: [12, 6000], suggest: [4, 30000], buffering: [10, 10000], note: [5, 20000], brb: [6, 20000] };
function limited(socket, kind) {
  const [max, win] = LIMITS[kind], now = Date.now(), d = socket.data, quiet = kind === 'typing' || kind === 'buffering';
  if (d.mutedUntil > now) { if (!quiet) deny(socket, 'You are muted for a moment because you sent too much too fast.'); return true; }
  const rl = d.rl || (d.rl = {}), recent = (rl[kind] = (rl[kind] || []).filter((t) => now - t < win));
  if (recent.length >= max) {
    d.strikes = (d.strikes || []).filter((t) => now - t < 60000); d.strikes.push(now);
    if (d.strikes.length >= 4) { d.mutedUntil = now + 30000; d.strikes = []; deny(socket, 'Too many messages. You are muted for 30 seconds.'); }
    else if (!quiet) deny(socket, 'You are sending too fast. Please slow down.');
    return true;
  }
  recent.push(now); return false;
}
// Validates a video request and returns the cleaned video, { error } or null.
function cleanVideo(v, r) {
  if (!v || typeof v !== 'object' || !['youtube', 'vimeo', 'html5'].includes(v.provider)) return null;
  if (v.provider === 'youtube' && !/^[\w-]{11}$/.test(v.id || '')) return null;
  if (v.provider === 'vimeo' && !/^\d{6,15}$/.test(v.id || '')) return null;
  if (v.provider === 'html5' && !(typeof v.url === 'string' && (v.url.startsWith('/uploads/') || /^https?:\/\//i.test(v.url)))) return null;
  if (v.provider === 'html5' && v.url.startsWith('/uploads/') && !r.uploads.has(v.url.slice('/uploads/'.length))) return { error: 'This upload does not belong to this room.' };
  return { provider: v.provider, id: String(v.id || '').slice(0, 40), url: String(v.url || '').slice(0, 2000), name: String(v.name || '').slice(0, 120) };
}
const videoLabel = (v) => v.name || { youtube: 'YouTube video', vimeo: 'Vimeo video', html5: 'Video link' }[v.provider];
function clearBuffering(r) { r.buffering.forEach((t) => clearTimeout(t)); r.buffering.clear(); r.autoPaused = false; }
function setVideo(r, video, play) {
  clearBuffering(r);
  r.video = video; r.playing = !!play && !r.brb.size; r.brbPaused = !!play && r.brb.size > 0; r.time = 0; r.at = Date.now(); r.seq++;
  r.notes = []; r.heat = {};
  io.to(r.code).emit('state', snapshot(r)); io.to(r.code).emit('waiting', []);
  io.to(r.code).emit('heat', {}); sendNotes(r);
}
function sendQueue(r) {
  io.to(r.code).emit('queue-info', { queue: r.queue.map((q) => ({ id: q.id, label: q.label, by: q.by })) });
  const h = memberSocket(r, r.hostClientId); // pending suggestions are only shown to the host
  if (h) h.emit('suggestions', r.suggestions.map((q) => ({ id: q.id, label: q.label, by: q.by })));
}
const bufferingNames = (r) => [...r.buffering.keys()].map((id) => { const m = [...r.members.values()].find((x) => x.id === id); return m && m.name; }).filter(Boolean);
// Pause everyone while someone is buffering; resume automatically once they are ready (or time out).
function bufferSync(r) {
  if (r.countdownAt) return;
  if (r.buffering.size && r.playing) { r.time = currentTime(r); r.playing = false; r.at = Date.now(); r.autoPaused = true; io.to(r.code).emit('state', snapshot(r)); }
  else if (!r.buffering.size && r.autoPaused && !r.brb.size) { r.autoPaused = false; r.playing = true; r.at = Date.now(); io.to(r.code).emit('state', snapshot(r)); }
  io.to(r.code).emit('waiting', r.autoPaused ? bufferingNames(r) : []);
}
const nameOf = (r, id) => { const m = [...r.members.values()].find((x) => x.id === id); return m && m.name; };
const brbNames = (r) => [...r.brb.keys()].map((id) => nameOf(r, id)).filter(Boolean);
function endBrb(r, id, msg) {
  clearTimeout(r.brb.get(id)); r.brb.delete(id);
  if (msg) announce(r, msg);
  if (!r.brb.size && r.brbPaused) { r.brbPaused = false; if (!r.buffering.size && !r.countdownAt) { r.playing = true; r.at = Date.now(); io.to(r.code).emit('state', snapshot(r)); } }
  bufferSync(r); io.to(r.code).emit('brb', brbNames(r)); broadcast(r);
}
// Remote pass: the host lends the remote to one member; it returns on its own when the time is up.
function endRemote(r) {
  clearTimeout(r.remoteTimer); r.remoteTimer = null; r.remoteUntil = 0; r.remoteId = null;
  if (r.modeBefore) { r.mode = r.modeBefore; r.modeBefore = null; }
}
function giveRemote(r, id, ms) {
  clearTimeout(r.remoteTimer); r.remoteTimer = null; r.remoteId = id;
  if (!ms) { r.remoteUntil = 0; r.modeBefore = null; return; }
  r.remoteUntil = Date.now() + ms;
  r.remoteTimer = setTimeout(() => {
    if (rooms[r.code] !== r || r.remoteId !== id) return;
    endRemote(r); announce(r, 'The remote went back to the host'); broadcast(r);
  }, ms);
}
const notesFor = (r, cid) => r.notes.map((n) => ({ id: n.id, t: n.t, by: n.by, text: n.text, mine: n.byId === cid }));
function sendNotes(r) { for (const m of r.members.values()) { const s = io.sockets.sockets.get(m.socketId); if (s) s.emit('notes', notesFor(r, m.id)); } }
const keepAlive = (r) => !!r.schedule && r.schedule.at + 3 * 3600000 > Date.now(); // scheduled rooms survive being empty until a few hours after start
function recapOf(r) {
  const st = r.stats;
  return { friends: st.ids.size, names: [...st.ids.values()].slice(0, 8), secs: st.secs, reacts: st.reacts,
    laugh: st.laugh ? st.laugh.t : null, any: st.any ? st.any.t : null, title: r.name || '' };
}
function host(socket, r) { if (socket.data.clientId !== r.hostClientId) { deny(socket, 'Host permission required.'); return false; } return true; }
function clearHostTimer(r) { if (r.hostTimer) clearTimeout(r.hostTimer); r.hostTimer = null; }
function destroyRoom(r, reason = 'The watch party has ended.') {
  if (rooms[r.code] !== r) return;
  clearHostTimer(r); clearBuffering(r); clearTimeout(r.remoteTimer); r.brb.forEach((t) => clearTimeout(t)); r.brb.clear();
  r.leaving.forEach((t) => clearTimeout(t)); r.leaving.clear();
  delete rooms[r.code];
  io.to(r.code).emit('room-ended', reason);
  for (const m of r.members.values()) {
    const s = io.sockets.sockets.get(m.socketId);
    if (s) { s.data.roomCode = null; s.leave(r.code); }
  }
  r.members.clear();
  for (const file of r.uploads) fs.promises.unlink(path.join(UP, file)).catch((err) => {
    if (err.code !== 'ENOENT') console.error('Failed to delete uploaded video:', err);
  });
  r.uploads.clear();
}
function scheduleHost(r) {
  clearHostTimer(r);
  r.hostTimer = setTimeout(() => {
    if (rooms[r.code] !== r || [...r.members.values()].some((m) => m.id === r.hostClientId)) return;
    const next = members(r)[0];
    if (next) { r.hostClientId = next.id; endRemote(r); announce(r, `${next.name} is now the host`); broadcast(r); }
    else if (!keepAlive(r)) destroyRoom(r);
  }, 30000);
}
function memberSocket(r, id) { const m = [...r.members.values()].find((x) => x.id === id); return m && io.sockets.sockets.get(m.socketId); }
function checkReady(r) { if (r.readyCheck) io.to(r.code).emit('ready-status', { ready: [...r.readyCheck.ready], total: r.members.size }); }

io.on('connection', (socket) => {
  let room = null, burst = [];
  // Hard flood cap: far above normal use, only trips on scripted abuse.
  socket.onAny(() => {
    const now = Date.now(); burst = burst.filter((t) => now - t < 5000); burst.push(now);
    if (burst.length > 150) { deny(socket, 'Too many requests.'); socket.disconnect(true); }
  });


  socket.on('join', (payload = {}) => {
    if (!payload || typeof payload !== 'object' || room) return;
    const code = cleanCode(payload.code), id = payload.clientId;
    if (!code || !validId(id)) return socket.emit('join-error', 'Invalid room or browser ID.');
    if (!rooms[code] && Object.keys(rooms).length >= MAX_ROOMS) return socket.emit('join-error', 'The server is busy. Please try again later.');
    const r = rooms[code] || (rooms[code] = { code, video: null, playing: false, time: 0, at: Date.now(), hostClientId: id,
      members: new Map(), uploads: new Set(), banned: new Set(), mode: 'everyone', remoteId: null, locked: false, password: '', readyCheck: null, countdownAt: null, hostTimer: null,
      name: '', maxMembers: 0, chatMuted: false, queue: [], suggestions: [], seq: 0, autoPaused: false, buffering: new Map(), bufCooldown: new Map(), leaving: new Map(), fails: [],
      brb: new Map(), brbPaused: false, vibe: 'cinema', schedule: null, remoteUntil: 0, remoteTimer: null, modeBefore: null,
      notes: [], heat: {}, recapSeq: -1, stats: { secs: 0, reacts: 0, laugh: null, any: null, ids: new Map() } });
    if (r.banned.has(id)) return socket.emit('join-error', 'You were removed from this room.');
    if (r.locked && id !== r.hostClientId && ![...r.members.values()].some((m) => m.id === id)) {
      const now = Date.now(); r.fails = r.fails.filter((t) => now - t < 60000);
      if (r.fails.length >= 10) return socket.emit('join-error', 'Too many wrong passwords. Please try again in a minute.');
      if (payload.password !== r.password) { r.fails.push(now); return socket.emit('join-error', 'Incorrect room password.'); }
    }
    const present = new Set([...r.members.values()].map((m) => m.id));
    if (!present.has(id) && id !== r.hostClientId && present.size >= (r.maxMembers || MAX_MEMBERS)) return socket.emit('join-error', 'This room is full.');
    const previous = memberSocket(r, id);
    if (previous && previous.id !== socket.id) { previous.data.replaced = true; previous.disconnect(true); }
    room = code;
    const back = r.leaving.has(id) || !!previous; // quick refresh or network blip: no leave/join noise in chat
    if (back) { clearTimeout(r.leaving.get(id)); r.leaving.delete(id); }
    socket.data.tid = newId();
    socket.data.clientId = id;
    socket.data.roomCode = code;
    socket.data.name = String(payload.user || 'Guest').trim().slice(0, 20) || 'Guest';
    socket.join(code);
    r.members.set(socket.id, { socketId: socket.id, id, name: socket.data.name, at: Date.now() });
    if (id === r.hostClientId) clearHostTimer(r);
    socket.emit('joined', { code });
    r.stats.ids.set(id, socket.data.name);
    socket.emit('state', snapshot(r));
    socket.emit('heat', r.heat); socket.emit('notes', notesFor(r, id)); socket.emit('brb', brbNames(r));
    if (r.autoPaused) socket.emit('waiting', bufferingNames(r));
    if (!back) announce(r, `${socket.data.name} joined`);
    broadcast(r); checkReady(r);
  });

  socket.on('video', (v) => {
    if (!room) return deny(socket);
    const r = rooms[room];
    if (!allowed(socket, r)) return deny(socket);
    const clean = cleanVideo(v, r);
    if (!clean) return;
    if (clean.error) return deny(socket, clean.error);
    setVideo(r, clean, false);
    io.to(room).emit('chat', { system: true, msg: `${socket.data.name} started a video${r.video.name ? ': ' + r.video.name : ''}` });
  });

  socket.on('control', (data = {}) => {
    if (!room) return deny(socket);
    const r = rooms[room];
    if (!allowed(socket, r)) return deny(socket);
    if (typeof data.playing !== 'boolean' || !Number.isFinite(data.time)) return;
    if (data.playing && r.brb.size) { socket.emit('state', snapshot(r)); return deny(socket, `Waiting for ${brbNames(r).join(', ')} to come back.`); }
    r.playing = data.playing; r.time = Math.min(86400, Math.max(0, data.time)); r.at = Date.now(); r.autoPaused = false;
    if (r.playing && r.buffering.size) bufferSync(r); // someone is still buffering: everyone waits
    else { socket.to(room).emit('state', snapshot(r)); io.to(room).emit('waiting', []); }
  });

  // Resync is read-only: viewers may request the authoritative state, but never change it.
  socket.on('resync', () => room && socket.emit('state', snapshot(rooms[room])));

  socket.on('set-mode', (mode) => {
    if (!room || !host(socket, rooms[room])) return;
    if (!['everyone', 'host', 'ask'].includes(mode)) return;
    const r = rooms[room]; r.modeBefore = null; r.mode = mode;
    if (mode !== 'ask') endRemote(r); else { clearTimeout(r.remoteTimer); r.remoteTimer = null; r.remoteUntil = 0; }
    broadcast(r);
  });
  socket.on('set-lock', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    if (typeof data.locked !== 'boolean' || typeof data.password !== 'string' || data.password.length > 64) return;
    if (data.locked && !data.password.trim()) return deny(socket, 'Enter a password to lock the room.');
    const r = rooms[room]; r.locked = data.locked; r.password = data.locked ? data.password : ''; broadcast(r);
  });
  socket.on('request-remote', () => {
    if (!room) return;
    const r = rooms[room];
    if (r.mode !== 'ask' || socket.data.clientId === r.hostClientId) return;
    const h = memberSocket(r, r.hostClientId);
    if (h) h.emit('remote-request', { id: socket.data.clientId, name: socket.data.name });
    else deny(socket, 'Host is temporarily offline.');
  });
  socket.on('remote-decision', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room]; if (r.mode !== 'ask' || !validId(data.id)) return;
    const target = memberSocket(r, data.id); if (!target || data.id === r.hostClientId) return;
    if (data.approve === true) { giveRemote(r, data.id, 0); announce(r, `${target.data.name} has the remote`); }
    target.emit('remote-result', data.approve === true ? 'Remote granted.' : 'Remote request denied.'); broadcast(r);
  });
  socket.on('member-action', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room]; if (!validId(data.id) || !['host', 'kick', 'remote', 'revoke'].includes(data.action)) return;
    const target = memberSocket(r, data.id);
    if (!target || data.id === socket.data.clientId) return;
    if (data.action === 'host') { r.hostClientId = data.id; endRemote(r); clearHostTimer(r); announce(r, `${target.data.name} is now the host`); }
    if (data.action === 'kick') { r.banned.add(data.id); target.data.replaced = true; target.emit('kicked'); target.disconnect(true); announce(r, `${target.data.name} was removed`); }
    if (data.action === 'remote' && r.mode === 'ask') giveRemote(r, data.id, 0);
    if (data.action === 'revoke') endRemote(r);
    broadcast(r);
  });
  socket.on('ready-start', () => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room]; if (!r.video) return deny(socket, 'Choose a video first.');
    if (r.brb.size) return deny(socket, `Waiting for ${brbNames(r).join(', ')} to come back.`);
    if (r.countdownAt) return;
    r.readyCheck = { ready: new Set(), time: Math.min(86400, Math.max(0, currentTime(r))) };
    r.playing = false; r.time = r.readyCheck.time; r.at = Date.now();
    io.to(room).emit('state', snapshot(r)); io.to(room).emit('ready-prompt'); checkReady(r);
  });
  socket.on('ready', () => { if (!room) return; const r = rooms[room]; if (r.readyCheck) { r.readyCheck.ready.add(socket.data.clientId); checkReady(r); } });
  socket.on('countdown-start', () => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room]; if (!r.readyCheck) return;
    const startAt = Date.now() + 3500, time = r.readyCheck.time;
    r.readyCheck = null; r.countdownAt = startAt; r.time = time; r.playing = false; r.at = Date.now();
    io.to(room).emit('countdown', { startAt, time });
    setTimeout(() => { if (rooms[r.code] !== r) return; r.countdownAt = null; r.time = time; r.playing = true; r.at = startAt; }, Math.max(0, startAt - Date.now()));
  });
  socket.on('clock-ping', (sent, reply) => { if (typeof reply === 'function' && Number.isFinite(sent)) reply({ serverTime: Date.now(), sent }); });

  socket.on('queue-suggest', (v) => {
    if (!room) return; const r = rooms[room];
    if (limited(socket, 'suggest')) return;
    const clean = cleanVideo(v, r);
    if (!clean) return deny(socket, 'That video link is not supported.');
    if (clean.error) return deny(socket, clean.error);
    const id = socket.data.clientId, entry = { id: newId(), video: clean, label: videoLabel(clean), by: socket.data.name, byId: id };
    if (id === r.hostClientId) {
      if (r.queue.length >= MAX_QUEUE) return deny(socket, 'The queue is full.');
      r.queue.push(entry); announce(r, `${entry.by} added ${entry.label} to the queue`);
    } else {
      if (r.suggestions.length >= MAX_SUGGESTIONS || r.suggestions.filter((x) => x.byId === id).length >= 3) return deny(socket, 'Too many pending suggestions. Please wait for the host.');
      r.suggestions.push(entry); socket.emit('remote-result', 'Suggestion sent to the host.');
    }
    sendQueue(r);
  });
  socket.on('queue-decision', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room], i = r.suggestions.findIndex((x) => x.id === data.id); if (i < 0) return;
    const [entry] = r.suggestions.splice(i, 1);
    if (data.approve === true) {
      if (r.queue.length >= MAX_QUEUE) { r.suggestions.splice(i, 0, entry); return deny(socket, 'The queue is full.'); }
      r.queue.push(entry); announce(r, `${entry.label} was added to the queue`);
    }
    sendQueue(r);
  });
  socket.on('queue-remove', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room]; r.queue = r.queue.filter((x) => x.id !== data.id); sendQueue(r);
  });
  socket.on('queue-play', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room], i = r.queue.findIndex((x) => x.id === data.id); if (i < 0) return;
    if (r.countdownAt) return deny(socket, 'Wait for the countdown to finish.');
    const [item] = r.queue.splice(i, 1);
    setVideo(r, item.video, false); announce(r, `${socket.data.name} started ${item.label}`); sendQueue(r);
  });
  // Reported by clients when a video finishes. The sequence number makes duplicate reports harmless.
  socket.on('video-ended', (data = {}) => {
    if (!room) return; const r = rooms[room];
    if (!allowed(socket, r) || !data || data.seq !== r.seq || !r.video) return;
    if (!r.queue.length) { if (r.recapSeq !== r.seq) { r.recapSeq = r.seq; io.to(room).emit('recap', recapOf(r)); } return; }
    const next = r.queue.shift();
    setVideo(r, next.video, true); announce(r, `Up next: ${next.label}`); sendQueue(r);
  });
  socket.on('buffering', (on) => {
    if (!room || typeof on !== 'boolean') return;
    const r = rooms[room], id = socket.data.clientId;
    if (limited(socket, 'buffering')) return;
    if (on) {
      if (!r.video || r.buffering.has(id) || (r.bufCooldown.get(id) || 0) > Date.now()) return;
      r.buffering.set(id, setTimeout(() => { // never let one slow viewer hold the room for long
        if (rooms[r.code] !== r) return;
        r.buffering.delete(id); r.bufCooldown.set(id, Date.now() + 30000); bufferSync(r);
      }, 15000));
    } else {
      if (!r.buffering.has(id)) return;
      clearTimeout(r.buffering.get(id)); r.buffering.delete(id); r.bufCooldown.set(id, Date.now() + 4000);
    }
    bufferSync(r);
  });
  socket.on('set-chat-muted', (on) => {
    if (!room || !host(socket, rooms[room]) || typeof on !== 'boolean') return;
    const r = rooms[room]; r.chatMuted = on; announce(r, on ? 'The host muted the chat' : 'The host unmuted the chat'); broadcast(r);
  });
  socket.on('clear-chat', () => { if (room && host(socket, rooms[room])) io.to(room).emit('chat-cleared'); });
  socket.on('set-room-name', (name) => {
    if (!room || !host(socket, rooms[room]) || typeof name !== 'string') return;
    const r = rooms[room]; r.name = name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40); broadcast(r);
  });
  socket.on('set-max', (n) => {
    if (!room || !host(socket, rooms[room])) return;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n === 1 || n > MAX_MEMBERS) return deny(socket, `Enter a number from 2 to ${MAX_MEMBERS}, or leave it empty for no limit.`);
    const r = rooms[room]; r.maxMembers = n; broadcast(r);
  });
  socket.on('typing', (on) => {
    if (!room || typeof on !== 'boolean') return; const r = rooms[room];
    if ((r.chatMuted && socket.data.clientId !== r.hostClientId) || limited(socket, 'typing')) return;
    socket.to(room).emit('typing', { tid: socket.data.tid, name: socket.data.name, on });
  });
  socket.on('reaction', (key) => {
    if (!room || !REACTIONS.includes(key) || limited(socket, 'reaction')) return;
    const r = rooms[room]; let b = null;
    if (r.video) { // remember where in the video the room reacted (10 second buckets) for the seek-bar heatmap
      const ct = currentTime(r); b = Math.floor(ct / 10);
      const h = r.heat[b] || (Object.keys(r.heat).length < 3000 ? (r.heat[b] = { n: 0, k: {} }) : null);
      if (h) {
        h.n++; h.k[key] = (h.k[key] || 0) + 1; r.stats.reacts++;
        if (key === 'laugh' && (!r.stats.laugh || h.k.laugh > r.stats.laugh.n)) r.stats.laugh = { n: h.k.laugh, t: Math.floor(ct) };
        if (!r.stats.any || h.n > r.stats.any.n) r.stats.any = { n: h.n, t: Math.floor(ct) };
      } else b = null;
    }
    io.to(room).emit('reaction', { key, name: socket.data.name, b });
  });

  socket.on('chat', (msg) => {
    if (!room) return;
    const r = rooms[room], d = socket.data;
    if (r.chatMuted && d.clientId !== r.hostClientId) return deny(socket, 'Chat is muted by the host.');
    msg = String(msg || '').trim().slice(0, 500);
    if (!msg || limited(socket, 'chat')) return;
    const now = Date.now();
    if (d.lastMsg === msg && now - d.lastMsgAt < 10000) return deny(socket, 'Please do not repeat the same message.');
    d.lastMsg = msg; d.lastMsgAt = now;
    const out = { name: d.name, msg, tid: d.tid };
    socket.to(room).emit('chat', out); socket.emit('chat', { ...out, mine: true });
  });

  // BRB: pauses everyone; the video only resumes once everyone who stepped away is back.
  socket.on('brb', (on) => {
    if (!room || typeof on !== 'boolean') return;
    const r = rooms[room], id = socket.data.clientId;
    if (limited(socket, 'brb')) return;
    if (on) {
      if (r.brb.has(id) || !r.video) return;
      r.brb.set(id, setTimeout(() => { if (rooms[r.code] === r && r.brb.has(id)) endBrb(r, id, `${nameOf(r, id) || 'Someone'} is back (timed out)`); }, 15 * 60000));
      announce(r, `${socket.data.name} will be right back`);
      if (r.playing && !r.countdownAt) { r.time = currentTime(r); r.playing = false; r.at = Date.now(); r.autoPaused = false; r.brbPaused = true; io.to(room).emit('state', snapshot(r)); }
      io.to(room).emit('brb', brbNames(r)); broadcast(r);
    } else if (r.brb.has(id)) endBrb(r, id, `${socket.data.name} is back`);
  });
  socket.on('pass-remote', (data = {}) => {
    if (!room || !host(socket, rooms[room])) return;
    const r = rooms[room], mins = Number(data.minutes);
    if (!validId(data.id) || !Number.isFinite(mins) || mins < 1 || mins > 60) return;
    if (r.mode === 'everyone') return deny(socket, 'Everyone can already control playback.');
    const target = memberSocket(r, data.id); if (!target || data.id === r.hostClientId) return;
    if (r.mode === 'host') { r.modeBefore = 'host'; r.mode = 'ask'; }
    giveRemote(r, data.id, Math.round(mins) * 60000);
    announce(r, `${target.data.name} has the remote for ${Math.round(mins)} min`); broadcast(r);
  });
  socket.on('note-add', (text) => {
    if (!room || typeof text !== 'string') return;
    const r = rooms[room]; if (!r.video || limited(socket, 'note')) return;
    text = text.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 140); if (!text) return;
    if (r.notes.length >= 50) return deny(socket, 'This video already has 50 notes.');
    r.notes.push({ id: newId(), t: Math.floor(currentTime(r)), by: socket.data.name, byId: socket.data.clientId, text });
    r.notes.sort((a, b) => a.t - b.t); sendNotes(r);
  });
  socket.on('note-remove', (data = {}) => {
    if (!room) return; const r = rooms[room], n = r.notes.find((x) => x.id === data.id);
    if (!n || (n.byId !== socket.data.clientId && socket.data.clientId !== r.hostClientId)) return;
    r.notes = r.notes.filter((x) => x !== n); sendNotes(r);
  });
  socket.on('set-schedule', (data = {}) => {
    if (!room || !host(socket, rooms[room]) || !data || typeof data !== 'object') return;
    const r = rooms[room];
    if (data.clear === true) { r.schedule = null; return broadcast(r); }
    const at = Number(data.at), title = String(data.title || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
    if (!Number.isFinite(at) || at < Date.now() - 60000 || at > Date.now() + 14 * 86400000) return deny(socket, 'Pick a time within the next 14 days.');
    r.schedule = { at: Math.round(at), title }; announce(r, `Movie night scheduled${title ? ': ' + title : ''}`); broadcast(r);
  });
  socket.on('set-vibe', (v) => {
    if (!room || !host(socket, rooms[room]) || !['cinema', 'cozy', 'date', 'party'].includes(v)) return;
    const r = rooms[room]; r.vibe = v; broadcast(r);
  });
  socket.on('recap-request', () => { if (room) socket.emit('recap', recapOf(rooms[room])); });

  socket.on('end-party', () => {
    const r = room && rooms[room];
    if (r && host(socket, r)) destroyRoom(r, 'The host ended this watch party.');
  });

  socket.on('disconnect', async () => {
    if (!room) return;
    const r = rooms[room]; if (!r) return;
    r.members.delete(socket.id);
    const cid = socket.data.clientId;
    if (r.remoteId === cid) endRemote(r);
    if (r.brb.has(cid)) endBrb(r, cid, null);
    if (r.buffering.has(cid)) { clearTimeout(r.buffering.get(cid)); r.buffering.delete(cid); bufferSync(r); }
    if (!socket.data.replaced) { // delay the "left" message so a quick refresh or reconnect stays quiet
      clearTimeout(r.leaving.get(cid));
      r.leaving.set(cid, setTimeout(() => { r.leaving.delete(cid); if (rooms[r.code] === r) announce(r, `${socket.data.name} left`); }, 8000));
    }
    if (socket.data.clientId === r.hostClientId && !memberSocket(r, r.hostClientId)) scheduleHost(r);
    if (!r.members.size && !r.hostTimer && !keepAlive(r)) destroyRoom(r);
    else { broadcast(r); checkReady(r); }
  });
});

server.listen(PORT, () => console.log(`Watch Party running at http://localhost:${PORT}`));
