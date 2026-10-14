import express from 'express';
import session from 'express-session';
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';

/* ───────── Config ───────── */
const env = process.env;
const PORT = +env.PORT || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
let API_KEY = env.GOOGLE_API_KEY || '';
const HOST = env.HOST || '0.0.0.0';
const DESKTOP = env.DESKTOP === '1';
const CONFIG_FILE = env.CONFIG_FILE || '';
if (CONFIG_FILE) { try { API_KEY = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).apiKey || API_KEY; } catch { /* no saved key yet */ } }
const CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const TEMP_DIR = path.resolve(env.TEMP_DIR || './tmp');
const RETENTION_MS = (+env.RETENTION_MINUTES || 120) * 60_000;
const MAX_LINKS = +env.MAX_LINKS || 20;
const MAX_JOBS = +env.MAX_CONCURRENT_JOBS || 2;
const MAX_RETRIES = +env.MAX_RETRIES || 5;
const SECURE_WIPE = env.SECURE_WIPE === 'true';
const OAUTH_ON = !!(CLIENT_ID && CLIENT_SECRET);
const SESSION_SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!API_KEY && !OAUTH_ON) console.warn('⚠ Set GOOGLE_API_KEY and/or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET');

const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
// Native Google files can't be downloaded as-is; export to Office/PDF.
const EXPORTS = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing': ['application/pdf', '.pdf'],
};
const NO_COMPRESS = new Set(['.zip', '.7z', '.rar', '.gz', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mkv', '.mov', '.mp3', '.aac', '.flac', '.pdf', '.docx', '.xlsx', '.pptx']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── App + security ───────── */
const app = express();
if (+env.TRUST_PROXY) app.set('trust proxy', +env.TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(session({
  name: 'dz.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'), maxAge: 8 * 3600_000 },
}));
app.use(express.static(path.join(import.meta.dirname, 'public')));

const hits = new Map(); // naive per-IP rate limit for job creation
function rateLimit(req, res, next) {
  const now = Date.now(), win = 10 * 60_000, max = 20;
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  arr.push(now); hits.set(req.ip, arr); next();
}

/* ───────── URL validation ───────── */
const ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
function parseDriveLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(u.hostname)) return null;
  const m = u.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]+)/);
  const id = m?.[1] ?? u.searchParams.get('id');
  return id && ID_RE.test(id) ? id : null;
}
function safeName(n) {
  const s = String(n).replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').replace(/^\.+$/, '_').trim().slice(0, 180);
  return s || 'unnamed';
}

/* Desktop app: first-run API key entry, saved locally */
app.post('/api/config', async (req, res) => {
  if (!DESKTOP) return res.status(404).end();
  if (req.headers.origin && req.headers.origin !== BASE_URL) return res.status(403).json({ error: 'Forbidden' });
  const key = String(req.body?.apiKey || '').trim();
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return res.status(400).json({ error: 'That does not look like a Google API key. It starts with AIza and is 39 characters long.' });
  API_KEY = key;
  if (CONFIG_FILE) await fsp.writeFile(CONFIG_FILE, JSON.stringify({ apiKey: key }), { mode: 0o600 });
  res.json({ ok: true });
});

/* ───────── OAuth (tokens never leave the server) ───────── */
app.get('/api/me', (req, res) => res.json({ oauthConfigured: OAUTH_ON, signedIn: !!req.session.tokens, publicConfigured: !!API_KEY }));

app.get('/auth/google', (req, res) => {
  if (!OAUTH_ON) return res.status(501).send('OAuth is not configured.');
  req.session.oauthState = crypto.randomBytes(16).toString('hex');
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: `${BASE_URL}/auth/callback`, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline',
    prompt: 'consent', state: req.session.oauthState,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.session.oauthState || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid state.');
    delete req.session.oauthState;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${BASE_URL}/auth/callback`, grant_type: 'authorization_code' }),
    });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error_description || t.error);
    req.session.tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
    res.redirect('/');
  } catch { res.status(400).send('Sign-in failed. Close this tab and try again.'); }
});

app.post('/auth/logout', async (req, res) => {
  const t = req.session.tokens;
  if (t) fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token || t.access_token }) }).catch(() => {});
  req.session.destroy(() => res.json({ ok: true }));
});

function makeAuth(tokens) {
  const t = tokens ? { ...tokens } : null;
  return {
    mode: t ? 'oauth' : 'public',
    async refresh(force) {
      if (!t || (!force && t.expires_at - Date.now() > 60_000)) return;
      if (!t.refresh_token) throw new Error('Google session expired. Sign in again.');
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error('Google session expired. Sign in again.');
      t.access_token = j.access_token; t.expires_at = Date.now() + j.expires_in * 1000;
    },
    async headers() { await this.refresh(false); return t ? { Authorization: `Bearer ${t.access_token}` } : {}; },
    url(p, params = {}) {
      const q = new URLSearchParams({ supportsAllDrives: 'true', ...params });
      if (!t) q.set('key', API_KEY);
      return `${DRIVE}${p}?${q}`;
    },
  };
}

/* ───────── Jobs ───────── */
const jobs = new Map();

function newJob(auth, rootIds) {
  return {
    id: crypto.randomBytes(24).toString('hex'), auth, rootIds, abort: new AbortController(),
    status: 'queued', phase: 'Queued', createdAt: Date.now(), expiresAt: null,
    dir: null, zipPath: null, zipSize: 0,
    filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, zipBytes: 0,
    current: '', errors: [], speed: 0, eta: null, listeners: new Set(), _last: { t: Date.now(), b: 0 },
  };
}

function view(j) {
  return {
    id: j.id, status: j.status, phase: j.phase, filesTotal: j.filesTotal, filesDone: j.filesDone,
    bytesTotal: j.bytesTotal, bytesDone: j.bytesDone, zipBytes: j.zipBytes, current: j.current,
    errors: j.errors.slice(-200), errorCount: j.errors.length, speed: j.speed, eta: j.eta,
    zipSize: j.zipSize, expiresAt: j.expiresAt, downloadUrl: j.status === 'ready' ? `/download/${j.id}/drive-files.zip` : null,
  };
}
function emit(j) { const d = `data: ${JSON.stringify(view(j))}\n\n`; for (const r of j.listeners) r.write(d); }
function tick(j) {
  const now = Date.now(), dt = (now - j._last.t) / 1000;
  if (dt > 0) {
    const inst = (j.bytesDone - j._last.b) / dt;
    j.speed = j.speed ? 0.7 * j.speed + 0.3 * inst : inst;
    j._last = { t: now, b: j.bytesDone };
  }
  j.eta = j.speed > 1 && j.bytesTotal > j.bytesDone ? Math.round((j.bytesTotal - j.bytesDone) / j.speed) : null;
  emit(j);
}

async function errMsg(res) {
  try {
    const j = await res.json(); const e = j.error;
    return `${e?.errors?.[0]?.reason || res.status}: ${e?.message || res.statusText}`;
  } catch { return `${res.status}: ${res.statusText}`; }
}

/** fetch with retry/backoff, token refresh and rate-limit handling */
async function driveFetch(j, url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(await j.auth.headers()) }, signal: j.abort.signal }); }
    catch (e) {
      if (j.abort.signal.aborted || attempt >= MAX_RETRIES) throw e;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt)); continue;
    }
    if (res.ok) return res;
    if (res.status === 401 && j.auth.mode === 'oauth' && attempt < MAX_RETRIES) { await j.auth.refresh(true); continue; }
    const reason = (await errMsg(res.clone()));
    const rate = /rateLimit|backendError|internalError/i.test(reason);
    if ((res.status === 429 || res.status >= 500 || (res.status === 403 && rate)) && attempt < MAX_RETRIES) {
      await sleep(Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 500); continue;
    }
    const err = new Error(reason); err.status = res.status; throw err;
  }
}

const getMeta = async (j, id) => (await driveFetch(j, j.auth.url(`/files/${id}`, { fields: 'id,name,mimeType,size,shortcutDetails' }))).json();

async function* listChildren(j, folderId) {
  let pageToken;
  do {
    const p = { q: `'${folderId}' in parents and trashed=false`, pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,size,shortcutDetails)', includeItemsFromAllDrives: 'true' };
    if (pageToken) p.pageToken = pageToken;
    const data = await (await driveFetch(j, j.auth.url('/files', p))).json();
    yield* data.files; pageToken = data.nextPageToken;
  } while (pageToken);
}

/** Recursively collect files. Returns flat list with zip paths. */
async function scan(j) {
  const files = [], used = new Set(), seen = new Set();
  const unique = (p) => {
    let out = p, n = 1; const ext = path.posix.extname(p), base = p.slice(0, p.length - ext.length);
    while (used.has(out.toLowerCase())) out = `${base} (${n++})${ext}`;
    used.add(out.toLowerCase()); return out;
  };
  const addNode = async (node, prefix) => {
    if (j.abort.signal.aborted) throw new Error('Cancelled');
    if (node.mimeType === SHORTCUT && node.shortcutDetails?.targetId) {
      try { node = { ...(await getMeta(j, node.shortcutDetails.targetId)), name: node.name }; }
      catch (e) { j.errors.push({ name: prefix + node.name, error: `Broken shortcut (${e.message})` }); return; }
    }
    if (seen.has(node.id)) return; seen.add(node.id);
    const name = safeName(node.name);
    if (node.mimeType === FOLDER) {
      j.phase = `Scanning folders · ${files.length} files found`; j.current = prefix + name;
      const dir = `${prefix}${name}/`;
      let any = false;
      try { for await (const c of listChildren(j, node.id)) { any = true; await addNode(c, dir); } }
      catch (e) { j.errors.push({ name: dir, error: e.message }); }
      if (!any) { used.add(dir.toLowerCase()); files.push({ dir: dir, empty: true }); }
      return;
    }
    const exp = EXPORTS[node.mimeType];
    if (node.mimeType.startsWith('application/vnd.google-apps.') && !exp) {
      j.errors.push({ name: prefix + name, error: 'Google-native type cannot be exported (form/site/map)' }); return;
    }
    const zipName = unique(prefix + (exp && !name.toLowerCase().endsWith(exp[1]) ? name + exp[1] : name));
    files.push({ id: node.id, zipName, size: +node.size || 0, exportMime: exp?.[0] });
    j.bytesTotal += +node.size || 0; j.filesTotal = files.filter((f) => !f.empty).length;
  };
  for (const id of j.rootIds) {
    try { await addNode(await getMeta(j, id), ''); }
    catch (e) { j.errors.push({ name: id, error: e.status === 404 ? 'Not found or not shared with you' : e.message }); }
  }
  return files;
}

/** Download one file to disk with Range-resume on mid-stream failures. */
async function fetchToDisk(j, f, tmp) {
  let have = 0, fileBytes = 0;
  const url = f.exportMime
    ? j.auth.url(`/files/${f.id}/export`, { mimeType: f.exportMime })
    : j.auth.url(`/files/${f.id}`, { alt: 'media' });
  for (let attempt = 0; ; attempt++) {
    const out = fs.createWriteStream(tmp, { flags: have ? 'a' : 'w' });
    try {
      const res = await driveFetch(j, url, have && !f.exportMime ? { headers: { Range: `bytes=${have}-` } } : {});
      if (have && res.status !== 206) { j.bytesDone -= fileBytes; fileBytes = 0; have = 0; out.destroy(); await fsp.truncate(tmp, 0).catch(() => {}); attempt--; continue; }
      for await (const chunk of Readable.fromWeb(res.body)) {
        if (!out.write(chunk)) await once(out, 'drain');
        have += chunk.length; fileBytes += chunk.length; j.bytesDone += chunk.length;
      }
      out.end(); await finished(out); return have;
    } catch (e) {
      out.destroy();
      if (j.abort.signal.aborted || attempt >= MAX_RETRIES || (e.status && e.status < 500 && e.status !== 429 && e.status !== 403)) throw e;
      if (e.status === 403 && !/rateLimit/i.test(e.message)) throw e;
      have = (await fsp.stat(tmp).catch(() => ({ size: 0 }))).size;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
}

function addEntry(archive, tmp, name) {
  return new Promise((resolve, reject) => {
    const onEntry = (e) => { if (e.name === name) { archive.off('entry', onEntry); archive.off('error', reject); resolve(); } };
    archive.on('entry', onEntry); archive.once('error', reject);
    archive.file(tmp, { name, store: NO_COMPRESS.has(path.extname(name).toLowerCase()) });
  });
}

async function freeBytes() { const s = await fsp.statfs(TEMP_DIR); return s.bavail * s.bsize; }

async function run(j) {
  const timer = setInterval(() => tick(j), 1000);
  try {
    j.dir = path.join(TEMP_DIR, j.id); await fsp.mkdir(j.dir, { recursive: true, mode: 0o700 });
    j.status = 'scanning'; j.phase = 'Scanning folders';
    const files = await scan(j);
    const real = files.filter((f) => !f.empty);
    if (!real.length && !files.length) throw new Error('No accessible files found. Check sharing settings or sign in.');

    const biggest = Math.max(0, ...real.map((f) => f.size));
    const need = j.bytesTotal + biggest + 64 * 1024 * 1024;
    if (need > (await freeBytes())) throw new Error(`Not enough server disk space: need about ${(need / 2 ** 30).toFixed(1)} GB free.`);

    j.status = 'downloading'; j.phase = 'Downloading and zipping';
    j.zipPath = path.join(j.dir, 'archive.zip');
    const output = fs.createWriteStream(j.zipPath, { mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 1 }, forceZip64: j.bytesTotal > 3.5 * 2 ** 30 });
    archive.on('warning', () => {}); archive.pipe(output);
    output.on('drain', () => { j.zipBytes = output.bytesWritten; });
    const pump = setInterval(() => { j.zipBytes = output.bytesWritten; }, 500);

    for (const f of files) {
      if (j.abort.signal.aborted) throw new Error('Cancelled');
      if (f.empty) { archive.append('', { name: f.dir }); continue; }
      j.current = f.zipName;
      const tmp = path.join(j.dir, `dl-${crypto.randomBytes(6).toString('hex')}`);
      try {
        await fetchToDisk(j, f, tmp);
        await addEntry(archive, tmp, f.zipName);
        j.filesDone++;
      } catch (e) {
        if (j.abort.signal.aborted) throw e;
        j.errors.push({ name: f.zipName, error: e.message });
      } finally { await secureDelete(tmp); }
    }
    if (j.errors.length) {
      const txt = `Files that could not be included:\n\n${j.errors.map((e) => `- ${e.name}: ${e.error}`).join('\n')}\n`;
      archive.append(txt, { name: '_ERRORS.txt' });
    }
    j.phase = 'Finalizing ZIP'; j.current = '';
    await archive.finalize(); await finished(output); clearInterval(pump);
    j.zipSize = (await fsp.stat(j.zipPath)).size; j.zipBytes = j.zipSize;
    if (!j.filesDone) throw new Error('No files could be downloaded. See the error list.');
    j.status = 'ready'; j.phase = 'Ready'; j.expiresAt = Date.now() + RETENTION_MS; j.speed = 0; j.eta = 0;
  } catch (e) {
    j.status = j.abort.signal.aborted ? 'cancelled' : 'failed'; j.phase = j.status === 'failed' ? e.message : 'Cancelled';
    j.failedAt = Date.now(); await secureDelete(j.dir);
  } finally { clearInterval(timer); emit(j); }
}

/* ───────── API ───────── */
app.post('/api/jobs', rateLimit, (req, res) => {
  const links = Array.isArray(req.body?.links) ? req.body.links : [];
  if (!links.length || links.length > MAX_LINKS) return res.status(400).json({ error: `Provide 1–${MAX_LINKS} Google Drive links.` });
  const ids = [], bad = [];
  for (const l of links) { const id = parseDriveLink(l); id ? ids.push(id) : bad.push(String(l).slice(0, 80)); }
  if (bad.length) return res.status(400).json({ error: 'Not a valid Google Drive link:', invalid: bad });
  const tokens = req.session.tokens;
  if (!tokens && !API_KEY) return res.status(401).json({ error: 'Sign in with Google to continue.' });
  if ([...jobs.values()].filter((j) => ['queued', 'scanning', 'downloading'].includes(j.status)).length >= MAX_JOBS)
    return res.status(503).json({ error: 'Server is busy with other downloads. Try again shortly.' });
  const j = newJob(makeAuth(tokens), [...new Set(ids)]);
  jobs.set(j.id, j); run(j);
  res.status(201).json({ id: j.id });
});

const getJob = (req, res) => { const j = jobs.get(req.params.id); if (!j) res.status(404).json({ error: 'Job not found or expired.' }); return j; };

app.get('/api/jobs/:id', (req, res) => { const j = getJob(req, res); if (j) res.json(view(j)); });
app.get('/api/jobs/:id/events', (req, res) => {
  const j = getJob(req, res); if (!j) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.write(`data: ${JSON.stringify(view(j))}\n\n`);
  j.listeners.add(res); req.on('close', () => j.listeners.delete(res));
});
app.delete('/api/jobs/:id', async (req, res) => {
  const j = getJob(req, res); if (!j) return;
  j.abort.abort(); await secureDelete(j.dir); jobs.delete(j.id); res.json({ ok: true });
});

/** Resumable download: Content-Length, Accept-Ranges, ETag/If-Range, 206 partials (works with FDM). */
app.get('/download/:id/:filename', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'ready') return res.status(404).send('Archive not found or expired.');
  const size = j.zipSize, etag = `"${j.id.slice(0, 16)}-${size}"`;
  res.set({ 'Accept-Ranges': 'bytes', ETag: etag, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="drive-files.zip"', 'Cache-Control': 'private, no-store' });
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - +m[2]); }
    else { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], size - 1); }
    if (start > end || start >= size) { res.set('Content-Range', `bytes */${size}`); return res.status(416).end(); }
    status = 206; res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.status(status).set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(j.zipPath, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

/* ───────── Cleanup ───────── */
async function secureDelete(target) {
  if (!target) return;
  try {
    const st = await fsp.stat(target).catch(() => null); if (!st) return;
    if (SECURE_WIPE) {
      const wipe = async (file) => {
        const size = (await fsp.stat(file)).size, fh = await fsp.open(file, 'r+'), buf = Buffer.alloc(1 << 20);
        for (let pos = 0; pos < size; pos += buf.length) await fh.write(buf, 0, Math.min(buf.length, size - pos), pos);
        await fh.sync(); await fh.close();
      };
      if (st.isDirectory()) for (const f of await fsp.readdir(target)) await wipe(path.join(target, f)).catch(() => {});
      else await wipe(target).catch(() => {});
    }
    await fsp.rm(target, { recursive: true, force: true });
  } catch { /* best effort */ }
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const dead = (j.status === 'ready' && now > j.expiresAt) || (['failed', 'cancelled'].includes(j.status) && now - (j.failedAt || now) > 10 * 60_000);
    if (dead) { await secureDelete(j.dir); for (const r of j.listeners) r.end(); jobs.delete(id); }
  }
  for (const [ip, arr] of hits) if (!arr.some((t) => now - t < 600_000)) hits.delete(ip);
}, 60_000).unref();

await fsp.rm(TEMP_DIR, { recursive: true, force: true });           // wipe leftovers from a previous run
await fsp.mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
export async function cleanup() { for (const j of jobs.values()) j.abort.abort(); await secureDelete(TEMP_DIR); }
const shutdown = async () => { await cleanup(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

const server = app.listen(PORT, HOST, () => console.log(`Drive ZIP tool on ${BASE_URL}  (public: ${!!API_KEY}, oauth: ${OAUTH_ON})`));
export const ready = new Promise((r) => server.once('listening', () => r(server.address().port)));
