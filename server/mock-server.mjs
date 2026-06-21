// Minimal zero-dependency mock backend + static file server.
//
// The original Shattered Colony used a server to share custom maps (returning a
// short URL/code), submit Kongregate stats, and (informally) track scores.
// This mock provides the same surface so the client's networking code paths run
// end to end. It keeps everything in memory (plus an optional JSON file) — no
// database, no real persistence guarantees.
//
//   node server/mock-server.mjs           # serves the game at http://localhost:8080
//
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = process.env.PORT || 8080;

// in-memory stores
const maps = new Map();   // code -> map data
const scores = [];        // {difficulty, waves, killed, ts}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function code() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function api(req, res, path) {
  // GET /api/ping
  if (path === '/ping' && req.method === 'GET') return json(res, 200, { ok: true, server: 'mock' });

  // POST /api/maps  -> { code, url }
  if (path === '/maps' && req.method === 'POST') {
    const body = await readBody(req);
    const c = code();
    maps.set(c, body.map ?? body);
    const host = req.headers.host || `localhost:${PORT}`;
    return json(res, 200, { code: c, url: `http://${host}/?map=${c}` });
  }
  // GET /api/maps/:code
  if (path.startsWith('/maps/') && req.method === 'GET') {
    const c = decodeURIComponent(path.slice('/maps/'.length));
    if (maps.has(c)) return json(res, 200, { code: c, map: maps.get(c) });
    return json(res, 404, { error: 'not found' });
  }
  // scores
  if (path === '/scores' && req.method === 'POST') {
    const body = await readBody(req);
    scores.push({ ...body, ts: Date.now() });
    scores.sort((a, b) => (b.waves - a.waves) || (b.killed - a.killed));
    return json(res, 200, { ok: true });
  }
  if (path === '/scores' && req.method === 'GET') {
    return json(res, 200, { scores: scores.slice(0, 20) });
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return serveStatic(req, res, rel + '/index.html');
    const data = await readFile(filePath);
    send(res, 200, data, MIME[extname(filePath)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) return api(req, res, url.slice(4).split('?')[0]);
  return serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Shattered Colony recreation running at http://localhost:${PORT}`);
  console.log('(mock server: /api/ping /api/maps /api/scores)');
});
