const $ = (id) => document.getElementById(id);
let jobId = null, es = null;

const fmtBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`; };
const fmtTime = (s) => { if (s == null) return '–'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };

async function loadAuth() {
  const me = await (await fetch('/api/me')).json();
  const needKey = !me.publicConfigured && !me.oauthConfigured;
  $('keySetup').hidden = !needKey; $('setup').hidden = needKey;
  const box = $('auth'); box.textContent = '';
  if (me.signedIn) {
    const b = document.createElement('button'); b.className = 'link'; b.textContent = 'Signed in with Google · Sign out';
    b.onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); loadAuth(); };
    box.append(b);
  } else if (me.oauthConfigured) {
    const a = document.createElement('a'); a.href = '/auth/google'; a.textContent = 'Sign in with Google for private files';
    box.append(a);
  }
}

function showError(msg) { const e = $('formError'); e.textContent = msg; e.hidden = !msg; }

$('start').onclick = async () => {
  showError('');
  const links = $('links').value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!links.length) return showError('Paste at least one Google Drive link.');
  $('start').disabled = true;
  try {
    const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error + (d.invalid ? ' ' + d.invalid.join(', ') : ''));
    jobId = d.id; $('job').hidden = false; $('ready').hidden = true; $('errBox').hidden = true; $('cancel').hidden = false;
    listen();
  } catch (e) { showError(e.message); $('start').disabled = false; }
};

$('cancel').onclick = async () => { if (jobId) await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }); es?.close(); $('phase').textContent = 'Cancelled'; $('start').disabled = false; };

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('dlLink').href);
  $('copy').textContent = 'Link copied'; setTimeout(() => ($('copy').textContent = 'Copy link for download manager'), 2000);
};

function listen() {
  es?.close(); es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (ev) => render(JSON.parse(ev.data));
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

function render(s) {
  $('phase').textContent = s.phase;
  const dl = s.bytesTotal ? Math.min(100, (s.bytesDone / s.bytesTotal) * 100) : 0;
  $('dlBar').style.width = `${dl}%`;
  $('dlText').textContent = `${fmtBytes(s.bytesDone)} of ${fmtBytes(s.bytesTotal)}`;
  const zp = s.status === 'ready' ? 100 : s.bytesTotal ? Math.min(99, (s.zipBytes / s.bytesTotal) * 100) : 0;
  $('zipBar').style.width = `${zp}%`;
  $('zipText').textContent = fmtBytes(s.zipBytes);
  $('files').textContent = `${s.filesDone} / ${s.filesTotal}`;
  $('speed').textContent = s.speed > 1 ? `${fmtBytes(s.speed)}/s` : '–';
  $('eta').textContent = fmtTime(s.eta);
  $('errCount').textContent = s.errorCount;
  $('current').textContent = s.current;

  if (s.errorCount) {
    $('errBox').hidden = false; $('errList').textContent = '';
    for (const e of s.errors) { const li = document.createElement('li'); li.textContent = `${e.name}: ${e.error}`; $('errList').append(li); }
  }
  if (s.status === 'ready') {
    es.close(); $('cancel').hidden = true; $('ready').hidden = false; $('start').disabled = false;
    const url = new URL(s.downloadUrl, location.href).href;
    $('dlLink').href = url;
    $('dlLink').textContent = `Download ZIP (${fmtBytes(s.zipSize)})`;
    $('expires').textContent = new Date(s.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (['failed', 'cancelled'].includes(s.status)) {
    es.close(); $('cancel').hidden = true; $('start').disabled = false;
  }
}
$('saveKey').onclick = async () => {
  const e = $('keyError'); e.hidden = true;
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: $('apiKey').value }) });
  if (!r.ok) { e.textContent = (await r.json()).error; e.hidden = false; return; }
  $('apiKey').value = ''; loadAuth();
};
loadAuth();
