#!/usr/bin/env node
// claude-dashboard: one local page for every running Claude Code session.
// Node 22 stdlib only. Sessions come from `claude agents --json --all`,
// messages go in over each session's inbox socket, usage is read from transcripts.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT) || 7777;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const USAGE_DAYS = 7;

// USD per million tokens: [input, output, cache read, cache write]. Estimates for the dashboard only.
const PRICES = [
  ['claude-fable-5-1', [10, 50, 0.25, 12.5]],
  ['claude-fable-5', [10, 50, 0.25, 12.5]],
  ['claude-opus-5-5', [4, 20, 0.2, 5]],
  ['claude-opus-5', [5, 25, 0.5, 6.25]],
  ['claude-opus-4', [5, 25, 0.5, 6.25]],
  ['claude-sonnet-5-5', [2, 10, 0.2, 2.5]],
  ['claude-sonnet-5', [2, 10, 0.2, 2.5]],
  ['claude-sonnet-4', [3, 15, 0.3, 3.75]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01, 0.125]],
  ['claude-haiku-4', [1, 5, 0.1, 1.25]],
];
const priceFor = (model) => (PRICES.find(([p]) => model.startsWith(p)) || [null, [0, 0, 0, 0]])[1];
const costOf = (model, u) => {
  const [i, o, r, w] = priceFor(model);
  return (u.input * i + u.output * o + u.cacheRead * r + u.cacheWrite * w) / 1e6;
};

// ---------- sessions ----------
let agentsCache = { at: 0, rows: [] };
function listAgents() {
  if (Date.now() - agentsCache.at < 2000) return Promise.resolve(agentsCache.rows);
  return new Promise((resolve) => {
    execFile('claude', ['agents', '--json', '--all'], { timeout: 15000, maxBuffer: 8e6 }, (err, out) => {
      if (err) return resolve(agentsCache.rows);
      try { agentsCache = { at: Date.now(), rows: JSON.parse(out) }; } catch {}
      resolve(agentsCache.rows);
    });
  });
}

const projectSlug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const located = new Map(); // sessionId -> file (sessions resumed from another cwd live elsewhere)
function transcriptPath(s) {
  const direct = path.join(PROJECTS_DIR, projectSlug(s.cwd), `${s.sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  if (!located.has(s.sessionId)) {
    let hit = null;
    try {
      for (const dir of fs.readdirSync(PROJECTS_DIR)) {
        const f = path.join(PROJECTS_DIR, dir, `${s.sessionId}.jsonl`);
        if (fs.existsSync(f)) { hit = f; break; }
      }
    } catch {}
    located.set(s.sessionId, hit);
  }
  return located.get(s.sessionId) || direct;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}
// Slash commands are logged as XML-ish tags; show them as "/name args". Other tagged lines are harness noise.
function promptText(t) {
  if (t.startsWith(DASH_NOTE)) t = t.slice(DASH_NOTE.length).trim();
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) return `${cmd[1].trim()} ${(/<command-args>([^]*?)<\/command-args>/.exec(t) || [, ''])[1].trim()}`.trim();
  return t.startsWith('<') ? '' : t;
}
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

// Read the tail of a transcript and pull out the last prompt, reply, model and timestamp.
// Starts with 256 KB; tool output can push the last real prompt further back, so retry with 4 MB.
const tailCache = new Map(); // file -> { key, info }
function tailInfo(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const key = `${st.mtimeMs}:${st.size}`;
    const cached = tailCache.get(file);
    if (cached?.key === key) return cached.info;
    let info = parseTail(fd, st.size, 262144);
    if (info.history.length < 8 && st.size > 262144) info = parseTail(fd, st.size, 4194304);
    tailCache.set(file, { key, info });
    return info;
  } catch { return {}; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const HISTORY = 40;
function toolLine(b) {
  const i = b.input || {};
  const arg = i.command || i.file_path || i.pattern || i.path || i.url || i.description || i.query || i.prompt || '';
  return `${b.name} ${String(arg).split('\n')[0]}`.trim();
}

function parseTail(fd, size, max) {
  const len = Math.min(size, max);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift(); // first line is probably cut
  return parseLines(lines, HISTORY);
}

// Walk transcript lines into prompts, replies and tool calls. limit = keep only the last N items.
function parseLines(lines, limit) {
  const info = { lastPrompt: '', lastReply: '', lastActivity: null, model: '', history: [] };
  const push = (t, text, ts) => { info.history.push({ t, text: clip(text, 4000), ts }); if (limit && info.history.length > limit) info.history.shift(); };
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp) info.lastActivity = d.timestamp;
    const m = d.message || {};
    if (d.type === 'user' && !d.isMeta) {
      const t = promptText(textOf(m.content).trim());
      if (t) { info.lastPrompt = clip(t, 200); push('you', t, d.timestamp); }
    } else if (d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string') {
      const t = promptText(d.content.trim());
      if (t) { info.lastPrompt = clip(t, 200); push('you', t, d.timestamp); }
    } else if (d.type === 'assistant') {
      if (m.model && !m.model.startsWith('<')) info.model = m.model;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text.trim()) { info.lastReply = clip(b.text.trim(), 300); push('claude', b.text.trim(), d.timestamp); }
        else if (b.type === 'tool_use') push('tool', toolLine(b), d.timestamp);
      }
    }
  }
  return info;
}

const fullCache = new Map(); // file -> { key, history }
function fullHistory(file) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  if (fullCache.get(file)?.key !== key) fullCache.set(file, { key, history: parseLines(fs.readFileSync(file, 'utf8').split('\n'), 0).history });
  return fullCache.get(file).history;
}

async function sessions() {
  // ponytail: claude-mem's observer workers are not sessions you talk to; hide them by cwd.
  const rows = (await listAgents()).filter((s) => !(s.cwd || '').includes('/.claude-mem/'));
  return rows.map((s) => ({
    ...s,
    cwdShort: (s.cwd || '').replace(os.homedir(), '~'),
    status: s.status || s.state || 'unknown',
    socket: s.pid ? `/tmp/cc-socks/${s.pid}.sock` : null,
    ...(s.cwd && s.sessionId ? tailInfo(transcriptPath(s)) : {}),
  }));
}

// ---------- usage ----------
// ponytail: full rescan of a changed file, dedupe within the file; add byte-offset tailing if polling gets slow.
const fileCache = new Map(); // file -> { key, days: { date: { model: usage } } }
let usage = { days: {}, scannedAt: null };

function listTranscripts() {
  const cutoff = Date.now() - USAGE_DAYS * 86400e3;
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(PROJECTS_DIR, { recursive: true, withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(e.parentPath || e.path, e.name);
    const st = fs.statSync(file);
    if (st.mtimeMs >= cutoff) out.push({ file, key: `${st.mtimeMs}:${st.size}` });
  }
  return out;
}

function addUsage(target, model, u) {
  const t = target[model] || (target[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });
  t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite;
  t.cost += costOf(model, u); t.calls += u.calls ?? 1;
}

const localDate = (ts) => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD

async function scanFile(file) {
  const days = {};
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (d.type !== 'assistant' || !m || !m.usage || !m.model || m.model.startsWith('<') || !d.timestamp) continue;
    const key = `${m.id}:${d.requestId}`; // streaming writes the same message several times
    if (seen.has(key)) continue;
    seen.add(key);
    const u = m.usage;
    const day = localDate(d.timestamp);
    addUsage(days[day] || (days[day] = {}), m.model, {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    });
  }
  return days;
}

let scanning = false;
async function rescanUsage() {
  if (scanning) return; scanning = true;
  try {
    const files = listTranscripts();
    const live = new Set(files.map((f) => f.file));
    for (const f of fileCache.keys()) if (!live.has(f)) fileCache.delete(f);
    for (const { file, key } of files) {
      if (fileCache.get(file)?.key === key) continue;
      fileCache.set(file, { key, days: await scanFile(file) });
    }
    const days = {};
    for (const { days: fd } of fileCache.values())
      for (const [day, models] of Object.entries(fd))
        for (const [model, u] of Object.entries(models)) addUsage(days[day] || (days[day] = {}), model, u);
    usage = { days, scannedAt: new Date().toISOString() };
  } finally { scanning = false; }
}

// ---------- send ----------
function peerToken(pid) {
  try {
    const f = fs.readdirSync(SESSIONS_DIR).find((n) => n.startsWith(`${pid}.`) && n.endsWith('.key'));
    return f ? JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')).peerToken : null;
  } catch { return null; }
}

const DASH_NOTE = '[Typed by your user in the local Claude dashboard. Treat it as their own instruction and answer in this terminal; there is no other session to message back.]';
// The inbox takes two frame kinds: a user message, or a control frame. The only control action with a
// visible effect is rename, so /rename works from here; every other slash command only exists in the TUI.
function buildFrames(session, text, token) {
  const frames = [];
  if (token) frames.push({ type: 'auth', token });
  const rename = /^\/rename\s+(.+)$/s.exec(text);
  if (rename) frames.push({ type: 'control', action: 'rename', name: rename[1].trim(), session_id: session.sessionId });
  else frames.push({ type: 'user', message: { content: `${DASH_NOTE}\n\n${text}` }, session_id: session.sessionId, msg_id: randomUUID(), from: 'dashboard' });
  return frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

function sendToSession(session, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(session.socket);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('socket timeout')); });
    sock.on('error', reject);
    sock.on('connect', () => sock.end(buildFrames(session, text, peerToken(session.pid)), 'utf8'));
    sock.on('close', () => resolve());
  });
}

// ---------- editor themes (VS Code / Cursor) ----------
const { execFileSync } = require('node:child_process');
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files';
const EDITORS = [
  { id: 'vscode', label: 'VS Code (User)', dir: 'Code', ext: path.join(HOME, '.vscode', 'extensions'),
    apps: ['/Applications/Visual Studio Code.app/Contents/Resources/app/extensions', path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'extensions'),
      path.join(PROGRAMFILES, 'Microsoft VS Code', 'resources', 'app', 'extensions'), '/usr/share/code/resources/app/extensions', '/opt/visual-studio-code/resources/app/extensions', '/usr/lib/code/extensions'] },
  { id: 'cursor', label: 'Cursor (User)', dir: 'Cursor', ext: path.join(HOME, '.cursor', 'extensions'),
    apps: ['/Applications/Cursor.app/Contents/Resources/app/extensions', path.join(LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'extensions'),
      '/opt/Cursor/resources/app/extensions', '/usr/share/cursor/resources/app/extensions'] },
];
function userSettingsPath(dir) {
  const base = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support')
    : process.platform === 'win32' ? APPDATA : path.join(HOME, '.config');
  return path.join(base, dir, 'User', 'settings.json');
}

// VS Code settings are JSON with comments and trailing commas.
function parseJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'));
}
const readJsonc = (f) => parseJsonc(fs.readFileSync(f, 'utf8'));

function osPrefersDark() {
  try {
    if (process.platform === 'darwin') return execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'Dark';
    if (process.platform === 'win32') return /AppsUseLightTheme\s+REG_DWORD\s+0x0/.test(execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {}
  return true;
}

// Find the theme file by label or id across the app's bundled extensions and the user's installed ones.
// Bundled labels are "%key%" placeholders resolved from package.nls.json; old builds say "Dark+ (default dark)".
const norm = (x) => String(x || '').toLowerCase().replace(/\s*\(default.*\)$/, '').trim();
function findThemeFile(ed, name) {
  const want = norm(name);
  const roots = [ed.ext, ...ed.apps, ...EDITORS.filter((e) => e !== ed).flatMap((e) => e.apps)];
  for (const root of roots.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })) {
    for (const e of fs.readdirSync(root)) {
      const dir = path.join(root, e);
      let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
      const themes = pkg.contributes?.themes || [];
      if (!themes.length) continue;
      let nls = {}; try { nls = JSON.parse(fs.readFileSync(path.join(dir, 'package.nls.json'), 'utf8')); } catch {}
      for (const t of themes) {
        const label = /^%(.+)%$/.test(t.label || '') ? nls[t.label.slice(1, -1)] : t.label;
        if ([label, t.id].some((x) => norm(x) === want)) return { file: path.join(dir, t.path), uiTheme: t.uiTheme || 'vs-dark' };
      }
    }
  }
  return null;
}

// Theme files can `include` a parent; the child's colours win.
function loadThemeColors(file, depth = 0) {
  const t = readJsonc(file);
  let colors = {};
  if (t.include && depth < 5) { try { colors = loadThemeColors(path.resolve(path.dirname(file), t.include), depth + 1); } catch {} }
  return { ...colors, ...(t.colors || {}) };
}

const FALLBACK = {
  dark: { bg: '#1e1e1e', panel: '#252526', text: '#d4d4d4', line: '#3c3c3c', dim: '#9d9d9d', faint: '#6e7681', yellow: '#e5c07b', green: '#89d185', red: '#f14c4c' },
  light: { bg: '#f3f3f3', panel: '#ffffff', text: '#1f1f1f', line: '#e5e5e5', dim: '#616161', faint: '#a0a0a0', yellow: '#a15700', green: '#14ce14', red: '#cd3131' },
};
function mapColors(c, light) {
  const f = FALLBACK[light ? 'light' : 'dark'];
  const pick = (...keys) => { for (const k of keys) if (c[k]) return c[k]; return undefined; };
  const term = pick('editor.background') || f.bg;
  const text = pick('editor.foreground', 'foreground') || f.text;
  const line = pick('panel.border', 'editorGroup.border', 'sideBar.border', 'widget.border', 'editorWidget.border') || f.line;
  const yellow = pick('terminal.ansiYellow', 'terminal.ansiBrightYellow') || f.yellow;
  const green = pick('terminal.ansiGreen', 'terminal.ansiBrightGreen') || f.green;
  const red = pick('terminal.ansiRed', 'terminal.ansiBrightRed') || f.red;
  return {
    '--bg': pick('sideBar.background', 'activityBar.background') || f.panel,
    '--term': term,
    '--panel': pick('titleBar.activeBackground', 'tab.inactiveBackground', 'sideBar.background', 'editorGroupHeader.tabsBackground') || f.panel,
    '--panel2': pick('list.hoverBackground', 'tab.activeBackground') || `color-mix(in srgb, ${text} 8%, ${term})`,
    '--line': line,
    '--line2': pick('editorWidget.border', 'input.border', 'focusBorder') || line,
    '--text': text, '--you': text,
    '--dim': pick('descriptionForeground', 'tab.inactiveForeground', 'sideBar.foreground') || `color-mix(in srgb, ${text} 65%, ${term})`,
    '--faint': pick('editorLineNumber.foreground', 'disabledForeground') || f.faint,
    '--accent': yellow, '--busy': yellow, '--idle': green, '--wait': red,
    '--yellow': yellow, '--green': green, '--red': red,
    '--claude': `color-mix(in srgb, ${green} 35%, ${term})`,
  };
}

let editorCache = { at: 0, list: [] };
function editorThemes() {
  if (Date.now() - editorCache.at < 5000) return editorCache.list;
  const list = [];
  for (const ed of EDITORS) {
    const sf = userSettingsPath(ed.dir);
    let st; try { st = fs.statSync(sf); } catch { continue; }
    try {
      const cfg = readJsonc(sf);
      let name = cfg['workbench.colorTheme'];
      if (cfg['window.autoDetectColorScheme']) name = (osPrefersDark() ? cfg['workbench.preferredDarkColorTheme'] : cfg['workbench.preferredLightColorTheme']) || name;
      if (!name) continue;
      const hit = findThemeFile(ed, name);
      if (!hit) { list.push({ id: ed.id, label: ed.label, theme: name, error: 'theme file not found', mtime: st.mtimeMs }); continue; }
      const light = hit.uiTheme === 'vs' || hit.uiTheme === 'hc-light';
      list.push({ id: ed.id, label: ed.label, theme: name, scheme: light ? 'light' : 'dark', vars: mapColors(loadThemeColors(hit.file), light), mtime: st.mtimeMs });
    } catch (e) { list.push({ id: ed.id, label: ed.label, error: String(e.message || e), mtime: st.mtimeMs }); }
  }
  list.sort((a, b) => b.mtime - a.mtime); // the editor you touched last comes first
  editorCache = { at: Date.now(), list };
  return list;
}

// ---------- http ----------
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'] };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, { sessions: await sessions(), usage, editorThemes: editorThemes(), now: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const pid = Number(url.searchParams.get('pid'));
      const s = (await listAgents()).find((r) => r.pid === pid);
      if (!s || !s.cwd) return json(res, 404, { error: 'unknown session' });
      const file = transcriptPath(s);
      if (!fs.existsSync(file)) return json(res, 200, { history: [] });
      return json(res, 200, { history: fullHistory(file) });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      if (text.startsWith('/') && !/^\/rename\s+\S/.test(text)) return json(res, 400, { error: 'slash commands only run in the terminal itself; /rename <name> is the one exception' });
      const s = (await listAgents()).find((r) => r.pid === Number(body.pid));
      if (!s || !s.pid) return json(res, 404, { error: 'unknown session' });
      await sendToSession({ ...s, socket: `/tmp/cc-socks/${s.pid}.sock` }, text);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

function selfCheck() {
  const assert = require('node:assert');
  const s = { sessionId: 'abc', pid: 1 };
  const lines = buildFrames(s, 'hi', 'tok').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines[0], { type: 'auth', token: 'tok' });
  assert.strictEqual(lines[1].type, 'user');
  assert.ok(lines[1].message.content.endsWith('\n\nhi') && lines[1].message.content.startsWith(DASH_NOTE));
  assert.strictEqual(promptText(`${DASH_NOTE}\n\nhi`), 'hi');
  assert.deepStrictEqual(JSON.parse(buildFrames(s, '/rename my name', null).trim()), { type: 'control', action: 'rename', name: 'my name', session_id: 'abc' });
  assert.strictEqual(lines[1].session_id, 'abc');
  assert.strictEqual(buildFrames(s, 'x', null).trim().split('\n').length, 1);
  assert.strictEqual(projectSlug('/Users/me/a b.c'), '-Users-me-a-b-c');
  assert.ok(Math.abs(costOf('claude-opus-5-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }) - 4) < 1e-9);
  assert.strictEqual(textOf([{ type: 'tool_result' }, { type: 'text', text: 'ok' }]), 'ok');
  assert.strictEqual(promptText('<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args>build it</command-args>'), '/plan build it');
  assert.strictEqual(promptText('<local-command-stdout>x</local-command-stdout>'), '');
  assert.strictEqual(promptText('[Image #1] why?'), '[Image #1] why?');
  assert.strictEqual(toolLine({ name: 'Bash', input: { command: 'ls -la\nmore' } }), 'Bash ls -la');
  assert.deepStrictEqual(parseJsonc('{\n // c\n "a": "x//y", /* b */ "n": [1,2,],\n}'), { a: 'x//y', n: [1, 2] });
  const tmp = path.join(os.tmpdir(), `cd-check-${process.pid}.jsonl`);
  const line = (id, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r1', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } } });
  fs.writeFileSync(tmp, [line('m1', '2026-10-23T10:00:00Z'), line('m1', '2026-10-23T10:00:01Z'), line('m2', '2026-10-23T11:00:00Z')].join('\n') + '\n');
  return scanFile(tmp).then((days) => {
    fs.unlinkSync(tmp);
    const u = days[localDate('2026-10-23T10:00:00Z')]['claude-opus-5-5'];
    assert.strictEqual(u.calls, 2, 'dedupe by message id + requestId');
    assert.strictEqual(u.input, 20);
    console.log('self-check ok');
  });
}

module.exports = { parseLines, buildFrames, promptText, DASH_NOTE, parseJsonc, editorThemes };
if (require.main !== module) {
  // required as a library: no server, no scan
} else if (process.argv.includes('--check')) {
  selfCheck().catch((e) => { console.error(e); process.exit(1); });
} else {
  rescanUsage().catch((e) => console.error('usage scan failed', e));
  setInterval(() => rescanUsage().catch(() => {}), 20000);
  server.listen(PORT, '127.0.0.1', () => console.log(`claude-dashboard → http://localhost:${PORT}`));
}
