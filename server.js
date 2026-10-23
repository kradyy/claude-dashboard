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
    if (!info.lastPrompt && st.size > 262144) info = parseTail(fd, st.size, 4194304);
    tailCache.set(file, { key, info });
    return info;
  } catch { return {}; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function parseTail(fd, size, max) {
  const len = Math.min(size, max);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift(); // first line is probably cut
  const info = { lastPrompt: '', lastReply: '', lastActivity: null, model: '' };
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.timestamp) info.lastActivity = d.timestamp;
    const m = d.message || {};
    if (d.type === 'user' && !d.isMeta) {
      const t = promptText(textOf(m.content).trim());
      if (t) info.lastPrompt = clip(t, 200);
    } else if (d.type === 'queue-operation' && d.operation === 'enqueue' && typeof d.content === 'string') {
      info.lastPrompt = clip(d.content.trim(), 200);
    } else if (d.type === 'assistant') {
      if (m.model && !m.model.startsWith('<')) info.model = m.model;
      const t = textOf(m.content).trim();
      if (t) info.lastReply = clip(t, 300);
    }
  }
  return info;
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

function buildFrames(session, text, token) {
  const frames = [];
  if (token) frames.push({ type: 'auth', token });
  frames.push({ type: 'user', message: { content: text }, session_id: session.sessionId, msg_id: randomUUID(), from: 'dashboard' });
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

// ---------- http ----------
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'] };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && STATIC[req.url]) {
      const [file, type] = STATIC[req.url];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      return json(res, 200, { sessions: await sessions(), usage, now: new Date().toISOString() });
    }
    if (req.method === 'POST' && req.url === '/api/send') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
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
  assert.strictEqual(lines[1].message.content, 'hi');
  assert.strictEqual(lines[1].session_id, 'abc');
  assert.strictEqual(buildFrames(s, 'x', null).trim().split('\n').length, 1);
  assert.strictEqual(projectSlug('/Users/me/a b.c'), '-Users-me-a-b-c');
  assert.ok(Math.abs(costOf('claude-opus-5-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }) - 4) < 1e-9);
  assert.strictEqual(textOf([{ type: 'tool_result' }, { type: 'text', text: 'ok' }]), 'ok');
  assert.strictEqual(promptText('<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args>build it</command-args>'), '/plan build it');
  assert.strictEqual(promptText('<local-command-stdout>x</local-command-stdout>'), '');
  assert.strictEqual(promptText('[Image #1] why?'), '[Image #1] why?');
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

if (process.argv.includes('--check')) {
  selfCheck().catch((e) => { console.error(e); process.exit(1); });
} else {
  rescanUsage().catch((e) => console.error('usage scan failed', e));
  setInterval(() => rescanUsage().catch(() => {}), 20000);
  server.listen(PORT, '127.0.0.1', () => console.log(`claude-dashboard → http://localhost:${PORT}`));
}
