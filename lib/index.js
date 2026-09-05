// dsh-composer-upload host side.
// Registers the guarded POST /api/_upload endpoint that persists generic
// (non-image) files under the server working directory's `.dsh-uploads/`
// folder, so the running agent can read them with its normal filesystem
// tools. Self-contained: re-implements the same browser-trust fence the dsh
// /api transport uses (loopback or declared trusted hosts, same-origin
// browser markers), because the fence helper is private to dsh-client-connection.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-composer-upload';
export const inject = ['webServer'];

const ROUTE_PATH = '/api/_upload';
const WAKE_PATH = '/api/_wake';
const UPLOAD_FOLDER = '.dsh-uploads';
const UPLOAD_MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_BODY_BYTES = 160 * 1024 * 1024; // keep parity with the /api carrier cap

/** Model-visible continuation instruction for a silent host-side wake. The
* message is stored with source.kind 'wake', which the chat snapshot builder
* never renders as a user bubble, so no visible text appears in history. */
const WAKE_TEXT = '\u7EE7\u7EED\u5904\u7406\u5F53\u524D\u4F1A\u8BDD\u4E2D\u5C1A\u672A\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002\u4EE5\u5F53\u524D\u5DE5\u4F5C\u533A\u3001\u5DE5\u5177\u7ED3\u679C\u548C\u76EE\u6807\u72B6\u6001\u4E3A\u51C6\uFF1B\u5982\u6709\u672A\u5B8C\u6210\u4EFB\u52A1\u5C31\u7EE7\u7EED\u5B8C\u6210\uFF0C\u5B8C\u6210\u540E\u62A5\u544A\u3002'; // 继续处理当前会话中尚未完成的工作...（内部唤醒指令，不会显示为聊天文字）

// ---- browser-trust fence (mirrors @deepseek-ai/dsh-client-connection) ----
function loopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function trustedAuthority(host, trustedHosts) {
  if (!Array.isArray(trustedHosts)) return false;
  const hostLow = String(host).toLowerCase();
  const hostname = hostLow.split(':')[0];
  for (const raw of trustedHosts) {
    if (typeof raw !== 'string' || raw === '') continue;
    const entry = raw.toLowerCase();
    if (entry === hostLow || entry === hostname || hostLow.startsWith(entry + ':')) return true;
  }
  return false;
}
/** Same-origin guard for one upload request: loopback/trusted Host + no cross-site markers. */
function isTrustedUploadRequest(req, trustedHosts) {
  const host = req.headers['host'];
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (!loopbackHostname(hostUrl.hostname) && !trustedAuthority(hostUrl.host, trustedHosts)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers['origin'];
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---- file handling ----
function sanitizeUploadName(raw) {
  const base = basename(String(raw ?? '').replaceAll('\\', '/')).trim();
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 160);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? `upload-${randomUUID().slice(0, 8)}` : cleaned;
}
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}
// Content-address dedupe: re-uploading the SAME bytes (even under a different
// name) reuses the existing stored file instead of piling up "-1/-2" copies.
// Only files whose size matches are hashed, so the scan stays cheap on small
// folders; a collision across sizes is impossible because the hash includes
// the full bytes.
async function findExistingByContent(dir, data) {
  let names = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  const want = sha256(data);
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await stat(p);
      if (st.size !== data.length) continue;
      if (sha256(await readFile(p)) === want) return p;
    } catch { /* skip unreadable */ }
  }
  return undefined;
}
async function persistUploadedFile(name, data) {
  const dir = join(process.cwd(), UPLOAD_FOLDER);
  await mkdir(dir, { recursive: true });
  const existing = await findExistingByContent(dir, data);
  if (existing !== undefined) {
    const storedName = basename(existing);
    return { absolutePath: existing, workspacePath: `${UPLOAD_FOLDER}/${storedName}`, name: storedName };
  }
  let target = join(dir, name);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 0;
  for (;;) {
    try {
      await writeFile(target, data, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      n += 1;
      target = join(dir, `${stem}-${n}${ext}`);
    }
  }
  const storedName = basename(target);
  return { absolutePath: target, workspacePath: `${UPLOAD_FOLDER}/${storedName}`, name: storedName };
}

// ---- request handling ----
async function readBody(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.byteLength;
    if (received > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { code: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sendJson(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
async function handleUpload(req, res, trustedHosts) {
  if (!isTrustedUploadRequest(req, trustedHosts)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    sendJson(res, error?.code === 413 ? 413 : 400, { ok: false, error: error?.code === 413 ? 'request body too large' : 'invalid json body' });
    return;
  }
  const name = sanitizeUploadName(body?.name);
  const data = body?.data;
  if (typeof data !== 'string' || data === '') {
    sendJson(res, 400, { ok: false, error: 'missing base64 data' });
    return;
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) {
    sendJson(res, 400, { ok: false, error: 'empty payload' });
    return;
  }
  if (buffer.length > UPLOAD_MAX_FILE_BYTES) {
    sendJson(res, 413, { ok: false, error: `file exceeds ${UPLOAD_MAX_FILE_BYTES} bytes` });
    return;
  }
  try {
    sendJson(res, 200, { ok: true, ...(await persistUploadedFile(name, buffer)) });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error) });
  }
}

/** POST /api/_wake { sessionId }: drive one silent agent continuation through
* the same public Agent channel the goal-round driver uses (agent.followup with
* an internal message). No user-visible text is added to the conversation. */
async function handleWake(req, res, ctx) {
  if (!isTrustedUploadRequest(req, (ctx.get('webRuntime') ?? {}).trustedHosts ?? [])) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'invalid json body' });
    return;
  }
  const sessionId = body?.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'missing sessionId' });
    return;
  }
  let agents;
  try { agents = ctx.get('agents'); } catch (e) { agents = undefined; }
  if (!agents || typeof agents.get !== 'function') {
    sendJson(res, 503, { ok: false, error: 'agents service unavailable' });
    return;
  }
  let agent;
  try { agent = agents.get(sessionId); } catch (e) { agent = undefined; }
  if (!agent || typeof agent.followup !== 'function') {
    sendJson(res, 404, { ok: false, error: 'no live agent for session' });
    return;
  }
  if (agent.status !== 'idle') {
    sendJson(res, 409, { ok: false, error: 'agent busy' });
    return;
  }
  try {
    const message = createUserMessage({
      content: [{ type: 'text', text: WAKE_TEXT }],
      source: { kind: 'wake' },
    });
    agent.followup(message);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error) });
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) return;
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => {
          const runtime = ctx.get('webRuntime');
          handleUpload(req, res, runtime?.trustedHosts ?? []);
        },
      }),
    'dsh-composer-upload: /api/_upload route',
  );
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: WAKE_PATH,
        handler: (req, res) => handleWake(req, res, ctx),
      }),
    'dsh-composer-upload: /api/_wake route',
  );
}
