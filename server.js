// Local-only credentials live in .env (gitignored). Production environment
// variables supplied by Render take precedence and are never overwritten.
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Small message buffer + fast ping so network drops are noticed quickly and oversized payloads are refused.
const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 8000 });
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const googleSessions = new Map(); // In-memory; never persist OAuth credentials or send them to a browser.
const googleStates = new Map();
const googleReady = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && /^https?:\/\//.test(GOOGLE_REDIRECT_URI));
const sameOrigin = (req) => !req.get('origin') || [
  `${req.protocol}://${req.get('host')}`,
  ...(googleReady() ? [new URL(GOOGLE_REDIRECT_URI).origin] : []),
].includes(req.get('origin'));
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(name + '='))?.slice(name.length + 1) || '';
function googleSession(req) {
  const key = cookieValue(req, 'watchify_google');
  const s = /^[a-f0-9]{64}$/.test(key) && googleSessions.get(key);
  if (s && s.expires > Date.now()) return s;
  if (s) googleSessions.delete(key);
  return null;
}
function googleCookie(res, req, value, maxAge) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || GOOGLE_REDIRECT_URI.startsWith('https:');
  res.cookie('watchify_google', value, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge });
}
async function googleToken(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('Google authorization failed.');
  return data;
}
async function googleAccess(auth) {
  if (auth.expiresAt > Date.now() + 60000) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('Google login expired. Reconnect Drive.');
  if (!auth.refreshPromise) auth.refreshPromise = googleToken({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: auth.refreshToken, grant_type: 'refresh_token' }).then((v) => {
    auth.accessToken = v.access_token; auth.expiresAt = Date.now() + Number(v.expires_in || 3600) * 1000;
    return auth.accessToken;
  }).finally(() => { auth.refreshPromise = null; });
  return auth.refreshPromise;
}
async function googleApi(auth, apiPath, opts = {}) {
  const token = await googleAccess(auth);
  return fetch('https://www.googleapis.com/drive/v3/' + apiPath, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + token }, signal: opts.signal || AbortSignal.timeout(20000), redirect: 'error' });
}
const MAX_MB = Number(process.env.MAX_MB) || 2000;
const mbLimit = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value) * 1048576)) : fallback * 1048576;
const MAX_TOTAL_BYTES = mbLimit(process.env.MAX_TOTAL_MB, 5000);
const MAX_ROOM_BYTES = mbLimit(process.env.MAX_ROOM_MB, 1000);
const EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg', '.ogv']);
let totalUploadBytes = 0;

const trustProxy = process.env.TRUST_PROXY || 'false';
if (trustProxy !== 'false' && trustProxy !== '0') app.set('trust proxy', trustProxy === 'true' ? 1 : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), fullscreen=(self), picture-in-picture=(self)',
    'Content-Security-Policy': [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
      "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com https://player.vimeo.com https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:", "media-src 'self' blob: data: https: http:",
      "connect-src 'self' ws: wss: https: http:",
      "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
      "worker-src 'self' blob:"
    ].join('; '),
  });
  next();
});

const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });
// Rooms live only in memory; files left by an unexpected server restart are orphaned.
for (const entry of fs.readdirSync(UP, { withFileTypes: true })) {
  if (entry.isFile()) fs.promises.unlink(path.join(UP, entry.name)).catch(console.error);
}

const upload = multer({
  storage: {
    _handleFile(req, file, cb) {
      const room = req.uploadRoom;
      const filename = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase();
      const filepath = path.join(UP, filename);
      const output = fs.createWriteStream(filepath, { flags: 'wx' });
      const entry = { bytes: 0, abort: () => file.stream.destroy(new Error('This room has ended.')) };
      room.activeUploads.add(entry);
      let finished = false;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        room.activeUploads.delete(entry);
        if (err) {
          if (rooms[room.code] === room) { room.uploadBytes -= entry.bytes; totalUploadBytes -= entry.bytes; }
          output.destroy();
          fs.promises.unlink(filepath).catch((e) => { if (e.code !== 'ENOENT') console.error(e); });
          cb(err);
        } else {
          room.uploads.add(filename);
          cb(null, { destination: UP, filename, path: filepath, size: entry.bytes, originalname: file.originalname });
        }
      };
      file.stream.on('data', (chunk) => {
        if (finished) return;
        if (rooms[room.code] !== room || room.uploadBytes + chunk.length > MAX_ROOM_BYTES || totalUploadBytes + chunk.length > MAX_TOTAL_BYTES) {
          const err = new Error(rooms[room.code] !== room ? 'This room has ended.' : 'Upload exceeds the room or server storage limit.');
          err.status = rooms[room.code] !== room ? 410 : 413;
          file.stream.unpipe(output); file.stream.resume(); finish(err);
          return;
        }
        entry.bytes += chunk.length; room.uploadBytes += chunk.length; totalUploadBytes += chunk.length;
      });
      file.stream.on('error', finish);
      output.on('error', finish);
      output.on('finish', () => finish());
      if (rooms[room.code] !== room) return finish(new Error('This room has ended.'));
      file.stream.pipe(output);
    },
    _removeFile(req, file, cb) {
      const room = req.uploadRoom;
      if (room && room.uploads.delete(file.filename)) { room.uploadBytes -= file.size; totalUploadBytes -= file.size; }
      fs.unlink(file.path, (err) => cb(err && err.code !== 'ENOENT' ? err : null));
    },
  },
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    if (!EXTENSIONS.has(path.extname(f.originalname).toLowerCase()) || !/^video\//.test(f.mimetype)) return cb(new Error('Choose an MP4, WebM, MOV, M4V, OGG or OGV video.'));
    cb(null, true);
  },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UP, { index: false, dotfiles: 'deny' })); // range requests supported; no directory listing

// OAuth 2.0 authorization-code flow: server receives and holds tokens, not the frontend.
app.use('/google-drive', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/google-drive/status', (req, res) => res.json({ configured: googleReady(), connected: !!googleSession(req) }));
app.get('/google-drive/connect', (req, res) => {
  if (!googleReady()) return res.status(503).send('Google Drive is not configured on this server.');
  if (googleStates.size > 1000) googleStates.clear();
  const state = crypto.randomBytes(32).toString('hex');
  googleStates.set(state, Date.now() + 5 * 60000);
  res.cookie('watchify_google_state', state, { httpOnly: true, sameSite: 'lax', secure: GOOGLE_REDIRECT_URI.startsWith('https:'), path: '/google-drive', maxAge: 5 * 60000 });
  const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'consent', state });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});
app.get('/google-drive/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const expiry = googleStates.get(state); googleStates.delete(state);
  const validState = /^[a-f0-9]{64}$/.test(state) && cookieValue(req, 'watchify_google_state') === state;
  res.clearCookie('watchify_google_state', { path: '/google-drive' });
  if (!validState || !expiry || expiry < Date.now() || typeof req.query.code !== 'string') return res.status(400).send('Google login was cancelled or expired.');
  try {
    const t = await googleToken({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' });
    const key = crypto.randomBytes(32).toString('hex');
    googleSessions.set(key, { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + Number(t.expires_in || 3600) * 1000, expires: Date.now() + 24 * 3600000 });
    googleCookie(res, req, key, 24 * 3600000);
    res.redirect('/?drive=connected' + (req.query.room ? '#' + encodeURIComponent(req.query.room) : ''));
  } catch { res.status(502).send('Google login failed. Please retry.'); }
});
app.post('/google-drive/disconnect', (req, res) => {
  if (!sameOrigin(req)) return res.status(403).end();
  const key = cookieValue(req, 'watchify_google');
  const auth = googleSessions.get(key);
  googleSessions.delete(key); googleCookie(res, req, '', 0);
  for (const room of Object.values(rooms)) if (auth && room.googleDriveAuth === auth) { room.googleDriveAuth = null; room.driveToken = null; }
  res.json({ ok: true });
});
app.get('/google-drive/files', async (req, res) => {
  const auth = googleSession(req);
  if (!auth) return res.status(401).json({ error: 'Connect your Google Drive first.' });
  try {
    const q = "trashed = false and (mimeType contains 'video/' or name contains '.mkv')";
    const params = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,size)', page_size: '100', pageSize: '100', orderBy: 'modifiedTime desc' });
    params.delete('page_size');
    const upstream = await googleApi(auth, 'files?' + params);
    if (!upstream.ok) return res.status(502).json({ error: 'Could not list Drive videos. Check Google permissions.' });
    const data = await upstream.json();
    res.json({ files: (data.files || []).filter((f) => DRIVE_ID.test(f.id)).map((f) => ({ id: f.id, name: String(f.name || '').slice(0, 180), size: f.size, type: f.mimeType })) });
  } catch { res.status(502).json({ error: 'Could not connect to Google Drive.' }); }
});

// Public Google Drive files: stream through our origin so HTML5 video has Range support.
// Google may still deny downloads or impose quota limits; never accept arbitrary upstream URLs.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
const driveHost = (h) => h === 'drive.google.com' || h === 'drive.usercontent.google.com' || h.endsWith('.googleusercontent.com');
let activeDriveStreams = 0;
async function driveUpstream(id, range, signal) {
  const attempts = [
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}&confirm=t`,
  ];
  const failures = [];
  for (let url of attempts) {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !driveHost(target.hostname) || target.username || target.password || target.port)
        throw new Error('Unsafe Google Drive redirect.');
      // DNS rebinding remains a residual risk, but HTTPS and strict Google-only hosts also limit exposure.
      const addresses = await dns.lookup(target.hostname, { all: true });
      if (!addresses.length || addresses.some((a) => blockedAddress(a.address))) throw new Error('Unsafe Google Drive address.');
      const response = await fetch(target, { redirect: 'manual', signal, headers: { ...(range ? { Range: range } : {}), 'Accept-Encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Invalid Google Drive redirect.');
        await response.body?.cancel();
        url = new URL(location, target).href;
        continue;
      }
      const type = response.headers.get('content-type') || '';
      if ([200, 206].includes(response.status) && !/text\/html|application\/json|text\/plain/i.test(type))
        return { response, failures };
      failures.push(`${response.status} ${type.split(';')[0].slice(0, 45)}`);
      await response.body?.cancel();
      break;
    }
  }
  return { response: null, failures };
}
async function authorizedDriveUpstream(auth, id, range, signal) {
  const upstream = await googleApi(auth, `files/${encodeURIComponent(id)}?alt=media`, { headers: range ? { Range: range } : {}, signal });
  const type = upstream.headers.get('content-type') || '';
  if (![200, 206].includes(upstream.status) || /text\/html|application\/json/i.test(type)) {
    const status = `${upstream.status} ${type.split(';')[0].slice(0, 45)}`;
    await upstream.body?.cancel();
    return { response: null, failures: [status] };
  }
  return { response: upstream, failures: [] };
}
app.get('/drive/:id', async (req, res) => {
  const id = req.params.id, room = rooms[cleanCode(req.query.room)], token = String(req.query.token || '');
  if (!DRIVE_ID.test(id) || !room || !room.driveToken || room.video?.driveId !== id ||
      !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(room.driveToken)))
    return res.status(403).json({ error: 'This Google Drive stream is not part of an active room.' });
  if (activeDriveStreams >= 60) return res.status(503).json({ error: 'Too many video streams. Try again shortly.' });
  const range = req.get('range');
  if (range && !/^bytes=\d*-\d*$/.test(range)) return res.status(416).end();
  activeDriveStreams++;
  const abort = new AbortController();
  // The previous hard 120-second cutoff interrupted even healthy multi-GB
  // streams. Time out only when no bytes arrive for a prolonged period.
  let timer;
  const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), 60000); };
  refreshTimeout();
  let released = false;
  const release = () => { if (released) return; released = true; clearTimeout(timer); activeDriveStreams--; };
  res.on('close', () => { abort.abort(); release(); });
  try {
    const { response: upstream, failures } = room.googleDriveAuth
      ? await authorizedDriveUpstream(room.googleDriveAuth, id, range, abort.signal)
      : await driveUpstream(id, range, abort.signal);
    if (!upstream) {
      release();
      return res.status(422).json({ error: 'Google Drive did not provide a direct video download. Its preview player may still work, but Watchify requires downloadable video bytes.', upstream: failures });
    }
    const type = upstream.headers.get('content-type') || '';
    res.status(upstream.status);
    res.set('Content-Type', /^video\/|^application\/octet-stream/i.test(type) ? type : 'application/octet-stream');
    res.set('Cache-Control', 'private, no-store');
    res.set('Accept-Ranges', 'bytes');
    for (const header of ['content-range', 'content-length']) if (upstream.headers.has(header)) res.set(header, upstream.headers.get(header));
    if (!upstream.body) { release(); return res.end(); }
    Readable.fromWeb(upstream.body).on('data', refreshTimeout)
      .on('error', () => res.destroy()).on('end', release).pipe(res);
  } catch (e) {
    release();
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Could not stream this Google Drive video.' });
  }
});

// Optional compatible soundtrack. Progressive MP3 is deliberately used here:
// HTMLAudioElement can decode it while the response is still streaming, unlike
// an unbounded fragmented MP4 whose initialization data can appear successful
// even when no playable audio packets arrive.
const AUDIO_JOBS_LIMIT = Math.max(1, Math.min(4, Number(process.env.MAX_AUDIO_JOBS) || 2));
const audioJobs = new Set();
let activeAudioProbes = 0;
// Read-only track discovery, cached per room/movie. Never expose upstream URLs or credentials.
app.get('/drive-audio-tracks/:id', async (req, res) => {
  const id = req.params.id, room = rooms[cleanCode(req.query.room)], token = String(req.query.token || '');
  if (!DRIVE_ID.test(id) || !room || !room.driveToken || room.video?.driveId !== id ||
    !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(room.driveToken)))
    return res.status(403).json({ error: 'Not an active Drive movie.' });
  res.set('Cache-Control', 'private, no-store');
  if (room.audioTracks) return res.json({ tracks: room.audioTracks });
  if (activeAudioProbes >= 3) return res.status(503).json({ error: 'Track discovery is busy.' });
  const port = server.address()?.port;
  if (!port) return res.status(503).end();
  const input = `http://127.0.0.1:${port}/drive/${encodeURIComponent(id)}?room=${room.code}&token=${room.driveToken}`;
  activeAudioProbes++;
  try {
    const tracks = await new Promise((resolve, reject) => {
      execFile(process.env.FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', '-analyzeduration', '15M', '-probesize', '15M',
        '-select_streams', 'a', '-show_entries', 'stream=index,codec_name,channels:stream_tags=language,title',
        '-of', 'json', input
      ], { timeout: 25000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const streams = JSON.parse(stdout).streams || [];
          resolve(streams.slice(0, 32).map((stream, position) => ({
            id: position, language: String(stream.tags?.language || 'und').slice(0, 16),
            title: String(stream.tags?.title || '').slice(0, 80),
            codec: String(stream.codec_name || '').slice(0, 24), channels: Number(stream.channels) || 0
          })));
        } catch (e) { reject(e); }
      });
    });
    if (rooms[room.code] === room && room.video?.driveId === id) room.audioTracks = tracks;
    res.json({ tracks });
  } catch (e) {
    res.status(503).json({ error: 'Could not inspect audio tracks. Check FFprobe on the server.' });
  } finally { activeAudioProbes--; }
});
app.get('/drive-audio/:id', (req, res) => {
  const id = req.params.id, room = rooms[cleanCode(req.query.room)], token = String(req.query.token || '');
  if (!DRIVE_ID.test(id) || !room || !room.driveToken || room.video?.driveId !== id ||
    !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(room.driveToken)))
    return res.status(403).json({ error: 'Audio stream is not part of an active room.' });
  const offset = Number(req.query.start || 0);
  if (!Number.isFinite(offset) || offset < 0 || offset > 86400) return res.status(400).end();
  const track = Number(req.query.track ?? 0);
  if (!Number.isSafeInteger(track) || track < 0 || track > 31 ||
    (room.audioTracks && track >= room.audioTracks.length)) return res.status(400).json({ error: 'Invalid audio track.' });
  if (audioJobs.size >= AUDIO_JOBS_LIMIT) return res.status(503).json({ error: 'Audio conversion is busy. Try again.' });
  const port = server.address()?.port;
  if (!port) return res.status(503).end();
  const input = `http://127.0.0.1:${port}/drive/${encodeURIComponent(id)}?room=${room.code}&token=${room.driveToken}`;
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-analyzeduration', '15M', '-probesize', '15M', '-ss', offset.toFixed(3), '-i', input,
    '-map', `0:a:${track}`, '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '160k',
    '-ac', '2', '-ar', '44100', '-f', 'mp3', 'pipe:1'];
  const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  audioJobs.add(proc);
  (room.audioJobs ||= new Set()).add(proc);
  let done = false, outputBytes = 0, log = '', errorReported = false;
  const finish = () => { if (done) return; done = true; audioJobs.delete(proc); room.audioJobs?.delete(proc); if (!proc.killed) proc.kill('SIGTERM'); };
  res.on('close', finish);
  const safeLog = (s) => String(s)
    .replace(/https?:\/\/[^\s\]]+/gi, '[media source]')
    .replace(/token=[^\s&]+/gi, 'token=[redacted]')
    .replace(/[a-f0-9]{64}/gi, '[redacted]')
    .slice(0, 1200);
  proc.once('error', (e) => {
    errorReported = true;
    console.error('[Audio compatibility] FFmpeg could not start:', e.code || 'unknown');
    if (!res.headersSent) res.status(503).json({ error: 'FFmpeg is unavailable on this server.' });
    finish();
  });
  proc.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
  proc.stdout.on('error', finish);
  proc.stderr.on('data', (chunk) => { log = (log + chunk.toString()).slice(-4000); });
  proc.once('close', (code) => {
    if (!errorReported && code !== 0 && code !== null) {
      console.error(`[Audio compatibility] FFmpeg exit ${code}, audio bytes ${outputBytes}: ${safeLog(log)}`);
    } else if (!errorReported && code === 0 && outputBytes < 4096) {
      console.error(`[Audio compatibility] No playable audio produced (${outputBytes} bytes): ${safeLog(log)}`);
    }
    if (!res.headersSent) res.status(502).end();
    else if (!res.writableEnded) res.end();
    finish();
  });
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  proc.stdout.pipe(res);
});

app.post('/upload', (req, res) => {
  const code = cleanCode(req.get('x-room-code'));
  const socket = io.sockets.sockets.get(req.get('x-socket-id'));
  const room = rooms[code];
  if (!room || !socket || !room.members.has(socket.id) || socket.data.roomCode !== code || !allowed(socket, room))
    return res.status(403).json({ error: 'Join the room with playback permission before uploading.' });
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > 0 && (room.uploadBytes + length > MAX_ROOM_BYTES || totalUploadBytes + length > MAX_TOTAL_BYTES))
    return res.status(413).json({ error: 'Upload exceeds the room or server storage limit.' });
  req.uploadRoom = room;
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Video exceeds the maximum file size.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Please choose a video file.' });
    if (rooms[code] !== room || !room.members.has(socket.id) || !allowed(socket, room)) {
      if (room.uploads.delete(req.file.filename)) { room.uploadBytes -= req.file.size; totalUploadBytes -= req.file.size; }
      fs.promises.unlink(req.file.path).catch(console.error);
      return res.status(410).json({ error: 'This room has ended or upload permission changed.' });
    }
    room.uploads.add(req.file.filename);
    res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
  });
});

// One small, validated subtitle track per room; it follows the current HTML5 video.
const subtitleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) => cb(null, /\.(srt|vtt)$/i.test(f.originalname) && /^(text\/|application\/(x-subrip|octet-stream)$)/i.test(f.mimetype)) });
function subtitleVtt(file) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim() || /\0|<[^>]*>/.test(source)) throw new Error('Subtitle must contain plain UTF-8 text.');
  let body = source;
  if (/\.vtt$/i.test(file.originalname)) {
    if (!/^WEBVTT(?:[^\n]*)\n/.test(source)) throw new Error('Invalid WebVTT header.');
    body = source.replace(/^WEBVTT[^\n]*\n/, '');
  }
  const stamp = '(?:\\d{2}:)?\\d{2}:\\d{2}[.,]\\d{3}';
  const cue = new RegExp('^(' + stamp + ')[ \\t]+-->[ \\t]+(' + stamp + ')(?:[ \\t]+[^\\n]*)?$', 'gm');
  const matches = [...body.matchAll(cue)];
  if (!matches.length || matches.length > 10000) throw new Error('Invalid subtitle timing.');
  const seconds = (s) => { const p = s.replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  for (const m of matches) if (seconds(m[1]) >= seconds(m[2]) || seconds(m[2]) > 86400) throw new Error('Invalid subtitle timing.');
  if (/\.srt$/i.test(file.originalname)) body = body.replace(cue, (_, a, b) => a.replace(',', '.') + ' --> ' + b.replace(',', '.'));
  return 'WEBVTT\n\n' + body.trim() + '\n';
}
app.post('/subtitle', (req, res) => {
  const code = cleanCode(req.get('x-room-code')), socket = io.sockets.sockets.get(req.get('x-socket-id'));
  const room = rooms[code];
  if (!room || !socket || !room.members.has(socket.id) || socket.data.roomCode !== code || !allowed(socket, room) || room.video?.provider !== 'html5')
    return res.status(403).json({ error: 'Join a room with HTML5 playback permission to upload subtitles.' });
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > 1024 * 1024 + 8192) return res.status(413).json({ error: 'Subtitles must be 1 MB or smaller.' });
  subtitleUpload.single('subtitle')(req, res, async (err) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Subtitles must be 1 MB or smaller.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Choose an .srt or .vtt subtitle file.' });
    let content;
    try { content = subtitleVtt(req.file); } catch (e) { return res.status(400).json({ error: e.message }); }
    const seq = room.seq, filename = crypto.randomBytes(16).toString('hex') + '.vtt', size = Buffer.byteLength(content);
    if (room.uploadBytes - room.subtitleBytes + size > MAX_ROOM_BYTES || totalUploadBytes - room.subtitleBytes + size > MAX_TOTAL_BYTES)
      return res.status(413).json({ error: 'Subtitles exceed the room or server storage limit.' });
    room.uploadBytes += size; totalUploadBytes += size;
    try { await fs.promises.writeFile(path.join(UP, filename), content, { flag: 'wx' }); }
    catch (e) { if (rooms[code] === room) { room.uploadBytes -= size; totalUploadBytes -= size; } return res.status(500).json({ error: 'Could not save subtitles.' }); }
    if (rooms[code] !== room || room.seq !== seq || !room.members.has(socket.id) || !allowed(socket, room)) {
      if (rooms[code] === room) { room.uploadBytes -= size; totalUploadBytes -= size; }
      await fs.promises.unlink(path.join(UP, filename)).catch(console.error);
      return res.status(410).json({ error: 'The video or upload permission changed.' });
    }
    if (room.subtitle) fs.promises.unlink(path.join(UP, room.subtitle)).catch(console.error);
    room.uploadBytes -= room.subtitleBytes; totalUploadBytes -= room.subtitleBytes;
    room.subtitle = filename; room.subtitleBytes = size;
    const info = { url: '/uploads/' + filename, name: req.file.originalname };
    io.to(code).emit('subtitle', info);
    res.json(info);
  });
});

// DNS rebinding remains a residual risk: yt-dlp performs its own DNS lookups and may follow redirects.
function blockedAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIP(ip) !== 6) return true;
  const parts = ip.split('::');
  if (parts.length > 2) return true;
  const expand = (part) => part ? part.split(':').flatMap((p) => p.includes('.') ? [((Number(p.split('.')[0]) << 8) | Number(p.split('.')[1])).toString(16), ((Number(p.split('.')[2]) << 8) | Number(p.split('.')[3])).toString(16)] : [p]) : [];
  const first = expand(parts[0]), last = parts.length === 2 ? expand(parts[1]) : [];
  const words = parts.length === 2 ? [...first, ...Array(8 - first.length - last.length).fill('0'), ...last] : first;
  if (words.length !== 8) return true;
  const n = words.map((w) => parseInt(w || '0', 16));
  if (n.some((w) => !Number.isInteger(w) || w < 0 || w > 65535)) return true;
  if (n.slice(0, 5).every((w) => w === 0) && n[5] === 0xffff) return blockedAddress([n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.'));
  return n.every((w) => w === 0) || n.slice(0, 7).every((w) => w === 0) && n[7] === 1 ||
    (n[0] & 0xfe00) === 0xfc00 || (n[0] & 0xffc0) === 0xfe80 || (n[0] & 0xff00) === 0xff00;
}
let activeResolves = 0;
app.get('/resolve', async (req, res) => {
  const code = cleanCode(req.get('x-room-code'));
  const socket = io.sockets.sockets.get(req.get('x-socket-id'));
  const room = rooms[code];
  if (!room || !socket || !room.members.has(socket.id) || socket.data.roomCode !== code || !allowed(socket, room))
    return res.status(403).json({ error: 'Join the room with playback permission before resolving a link.' });
  const now = Date.now(), recent = (socket.data.resolveTimes || []).filter((t) => now - t < 60000);
  socket.data.resolveTimes = recent;
  if (recent.length >= 6) return res.status(429).json({ error: 'Too many links. Try again in a minute.' });
  recent.push(now);
  let u;
  try { u = new URL(String(req.query.url || '')); } catch (e) { return res.status(400).json({ error: 'Invalid link.' }); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port)))
    return res.status(400).json({ error: 'This link is not allowed.' });
  try {
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => blockedAddress(a.address))) return res.status(400).json({ error: 'Private or unsafe addresses are not allowed.' });
  } catch (e) { return res.status(400).json({ error: 'Could not verify this hostname.' }); }
  if (activeResolves >= 2) return res.status(503).json({ error: 'Video lookup is busy. Try again shortly.' });
  activeResolves++;
  execFile('yt-dlp', ['--no-playlist', '-f', 'best[ext=mp4]/best', '-e', '-g', u.href], { timeout: 25000 }, (err, out) => {
    activeResolves--;
    if (err && err.code === 'ENOENT') return res.status(503).json({ error: 'This site needs yt-dlp installed on the server.' });
    const lines = String(out || '').trim().split('\n').filter(Boolean);
    if (err || lines.length < 2) return res.status(422).json({ error: 'Could not find a playable video at this link. It may be private, paid or DRM-protected.' });
    res.json({ title: lines[0], url: lines[lines.length - 1] });
  });
});

// ---- rooms ----
const rooms = {};
const inviteHits = new Map();
app.get('/healthz', (req, res) => res.json({ ok: true }));
// Public invite info for a scheduled movie night (title and time only).
app.get('/api/invite/:code', (req, res) => {
  const now = Date.now(), ip = req.ip;
  const hits = (inviteHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= 30) return res.status(429).json({ error: 'Too many invite checks. Try again in a minute.' });
  hits.push(now); inviteHits.set(ip, hits);
  const r = rooms[cleanCode(req.params.code)];
  if (!r || !r.schedule) return res.json({ exists: !!r, serverTime: Date.now() });
  res.json({ exists: true, name: r.name, title: r.schedule.title, at: r.schedule.at, locked: r.locked, count: r.members.size, serverTime: Date.now() });
});
setInterval(() => { for (const r of Object.values(rooms)) if (r.playing && r.video && r.members.size) r.stats.secs++; }, 1000); // time watched together
setInterval(() => { for (const r of Object.values(rooms)) if (!r.members.size && !r.hostTimer && !keepAlive(r)) destroyRoom(r); }, 60000);
setInterval(() => { const now = Date.now(); for (const [ip, hits] of inviteHits) if (hits.every((t) => now - t >= 60000)) inviteHits.delete(ip); }, 60000);
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
  if (!v || typeof v !== 'object' || !['youtube', 'vimeo', 'html5', 'drive'].includes(v.provider)) return null;
  if (v.provider === 'youtube' && !/^[\w-]{11}$/.test(v.id || '')) return null;
  if (v.provider === 'vimeo' && !/^\d{6,15}$/.test(v.id || '')) return null;
  if (v.provider === 'drive' && !DRIVE_ID.test(v.id || '')) return null;
  if (v.provider === 'html5' && !(typeof v.url === 'string' && (v.url.startsWith('/uploads/') || /^https?:\/\//i.test(v.url)))) return null;
  if (v.provider === 'html5' && v.url.startsWith('/uploads/') && !r.uploads.has(v.url.slice('/uploads/'.length))) return { error: 'This upload does not belong to this room.' };
  return { provider: v.provider, id: String(v.id || '').slice(0, 40), url: String(v.url || '').slice(0, 2000), name: String(v.name || '').slice(0, 120) };
}
const videoLabel = (v) => v.name || { youtube: 'YouTube video', vimeo: 'Vimeo video', html5: 'Video link', drive: 'Google Drive video' }[v.provider];
function clearBuffering(r) { r.buffering.forEach((t) => clearTimeout(t)); r.buffering.clear(); r.autoPaused = false; }
function setVideo(r, video, play) {
  clearBuffering(r);
  for (const job of r.audioJobs || []) job.kill('SIGTERM');
  r.googleDriveAuth = null;
  if (r.subtitle) { fs.promises.unlink(path.join(UP, r.subtitle)).catch(console.error); r.subtitle = null; r.uploadBytes -= r.subtitleBytes; totalUploadBytes -= r.subtitleBytes; r.subtitleBytes = 0; io.to(r.code).emit('subtitle', null); }
  r.driveToken = video.provider === 'drive' ? crypto.randomBytes(32).toString('hex') : null;
  r.audioTracks = null;
  r.video = video.provider === 'drive' ? { provider: 'html5', driveId: video.id, name: video.name || 'Google Drive video', url: `/drive/${video.id}?room=${r.code}&token=${r.driveToken}` } : video;
  r.playing = !!play && !r.brb.size; r.brbPaused = !!play && r.brb.size > 0; r.time = 0; r.at = Date.now(); r.seq++;
  r.notes = []; r.heat = {};
  io.to(r.code).emit('state', snapshot(r)); io.to(r.code).emit('waiting', []);
  io.to(r.code).emit('heat', {}); sendNotes(r);
}
app.post('/google-drive/play', express.json({ limit: '2kb' }), async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).end();
  const auth = googleSession(req);
  const id = req.body?.id;
  const code = cleanCode(req.get('x-room-code'));
  const socket = io.sockets.sockets.get(req.get('x-socket-id'));
  const room = rooms[code];
  if (!auth) return res.status(401).json({ error: 'Connect Google Drive first.' });
  if (!DRIVE_ID.test(id || '') || !room || !socket || !room.members.has(socket.id) || socket.data.roomCode !== code || !allowed(socket, room))
    return res.status(403).json({ error: 'You do not have playback permission in this room.' });
  try {
    const upstream = await googleApi(auth, `files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,capabilities(canDownload)`);
    if (!upstream.ok) return res.status(422).json({ error: 'Cannot access this Drive video.' });
    const file = await upstream.json();
    if (file.id !== id || (!String(file.mimeType || '').startsWith('video/') && !/\.mkv$/i.test(file.name || '')) || file.capabilities?.canDownload === false)
      return res.status(422).json({ error: 'Select a downloadable video file.' });
    setVideo(room, { provider: 'drive', id, name: String(file.name || 'Google Drive video').slice(0, 120) }, false);
    room.googleDriveAuth = auth;
    announce(room, `${socket.data.name} started a Google Drive video: ${room.video.name}`);
    res.json({ ok: true });
  } catch { res.status(502).json({ error: 'Google Drive could not open this file.' }); }
});
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
  for (const job of r.audioJobs || []) job.kill('SIGTERM');
  clearHostTimer(r); clearBuffering(r); clearTimeout(r.remoteTimer); r.brb.forEach((t) => clearTimeout(t)); r.brb.clear();
  r.leaving.forEach((t) => clearTimeout(t)); r.leaving.clear();
  delete rooms[r.code];
  if (r.subtitle) fs.promises.unlink(path.join(UP, r.subtitle)).catch(console.error);
  for (const entry of r.activeUploads) entry.abort();
  io.to(r.code).emit('room-ended', reason);
  for (const m of r.members.values()) {
    const s = io.sockets.sockets.get(m.socketId);
    if (s) { s.data.roomCode = null; s.leave(r.code); }
  }
  r.members.clear();
  totalUploadBytes -= r.uploadBytes;
  r.uploadBytes = 0;
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
    if (code.length < 5 || !validId(id) || typeof payload.create !== 'boolean') return socket.emit('join-error', 'Invalid room or browser ID.');
    if (!rooms[code] && !payload.create) return socket.emit('join-error', 'Room not found. Check the code, or create a new room.');
    if (!rooms[code] && Object.keys(rooms).length >= MAX_ROOMS) return socket.emit('join-error', 'The server is busy. Please try again later.');
    const r = rooms[code] || (rooms[code] = { code, video: null, playing: false, time: 0, at: Date.now(), hostClientId: id,
      members: new Map(), uploads: new Set(), subtitle: null, subtitleBytes: 0, uploadBytes: 0, activeUploads: new Set(), banned: new Set(), mode: 'everyone', remoteId: null, locked: false, password: '', readyCheck: null, countdownAt: null, hostTimer: null,
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
    socket.emit('subtitle', r.subtitle ? { url: '/uploads/' + r.subtitle } : null);
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
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const room of Object.values(rooms)) destroyRoom(room, 'The server is shutting down.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
