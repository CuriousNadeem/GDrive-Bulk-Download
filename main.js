import { app, BrowserWindow, shell, dialog } from 'electron';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

if (!app.requestSingleInstanceLock()) app.quit();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

let win, server, cleaned = false;

async function start() {
  const port = await freePort(), data = app.getPath('userData');
  fs.mkdirSync(data, { recursive: true });
  // Optional key baked in at build time; a key the user saves later overrides it.
  try {
    const d = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'defaults.json'), 'utf8'));
    if (d.apiKey) process.env.GOOGLE_API_KEY = d.apiKey;
  } catch { /* none bundled */ }
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    DESKTOP: '1', HOST: '127.0.0.1', PORT: String(port), BASE_URL: base,
    TEMP_DIR: path.join(app.getPath('temp'), 'drive-zip'),
    CONFIG_FILE: path.join(data, 'config.json'),
    RETENTION_MINUTES: '1440', MAX_CONCURRENT_JOBS: '1',
  });
  const entry = fs.existsSync(path.join(import.meta.dirname, 'server.bundle.mjs')) ? './server.bundle.mjs' : './server.js';
  server = await import(entry);
  await server.ready;

  win = new BrowserWindow({ width: 820, height: 860, minWidth: 480, title: 'Drive to one ZIP', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const external = (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); external(url); } });
  win.webContents.session.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => { if (state === 'completed') shell.showItemInFolder(item.getSavePath()); });
  });
  win.loadURL(base);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', async (e) => {
  if (cleaned) return;
  e.preventDefault(); cleaned = true;
  try { await server?.cleanup(); } catch { /* best effort */ }
  app.exit(0);
});
app.whenReady().then(start).catch((err) => { dialog.showErrorBox('Could not start', String(err)); app.exit(1); });
