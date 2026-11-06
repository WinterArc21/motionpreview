#!/usr/bin/env node
// Watches one HyperFrames composition file and streams every saved version to the viewer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'index.html');
const dir = path.dirname(file);
const port = Number(process.env.PORT) || 4317;
const publicDir = path.join(import.meta.dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
let current = read();
// Every saved version since start, so a viewer that loads later can still replay the whole build.
const versions = current?.trim() ? [current] : [];
const clients = new Set();
const event = () => `event: comp\ndata: ${JSON.stringify({ file: path.relative(process.cwd(), file) || file, html: current })}\n\n`;

// Agents often write a file in more than one chunk, so wait until the content stops changing.
let settle;
fs.watchFile(file, { interval: 150 }, () => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    const next = read();
    if (next === current) return;
    current = next;
    if (!next?.trim()) versions.length = 0; // the agent started over
    else versions.push(next);
    for (const res of clients) res.write(event());
  }, 120);
});

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: history\ndata: ${JSON.stringify(versions)}\n\n`);
    res.write(event());
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (p.startsWith('/comp/')) {
    const target = path.join(dir, p.slice('/comp/'.length));
    if (!target.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
    sendFile(res, target);
    return;
  }
  const name = p === '/' ? 'index.html' : p.slice(1);
  if (!['index.html', 'app.js', 'style.css'].includes(name)) { res.writeHead(404).end('Not found'); return; }
  sendFile(res, path.join(publicDir, name));
}).listen(port, () => {
  console.log(`HyperFrames Live: watching ${file}`);
  console.log(`Open http://localhost:${port}`);
});
