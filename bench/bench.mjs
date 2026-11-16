// 性能基准：直连假上游 vs 经过代理，分别测小文本请求和大图片请求的端到端延迟。
// 运行：node bench/bench.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/config.mjs';
import { chatBody, fakeJpegDataUrl } from '../test/helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

function upstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"ok":true}\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function proxy(upstreamPort) {
  const port = 21_000 + Math.floor(Math.random() * 15_000);
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      LRG_PORT: String(port),
      LRG_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LRG_LOG: 'off',
      LRG_RECORDS_DIR: mkdtempSync(join(tmpdir(), 'relay-gateway-bench-')),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/__gateway/status`, { signal: AbortSignal.timeout(400) });
      if (r.ok) return { base, child };
    } catch { /* 等待 */ }
    await sleep(100);
  }
  throw new Error('代理启动超时');
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function post(url, body) {
  return new Promise((resolve, reject) => {
    const started = now();
    const request = http.request(url, {
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(now() - started));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { p50: pick(0.5), p95: pick(0.95), avg, min: sorted[0], max: sorted.at(-1) };
}

async function measure(label, url, body, iterations) {
  await post(url, body); // 预热
  const samples = [];
  for (let i = 0; i < iterations; i++) samples.push(await post(url, body));
  const s = stats(samples);
  const fmt = (n) => `${n.toFixed(2)}ms`;
  console.log(`${label.padEnd(34)} p50 ${fmt(s.p50).padStart(9)}  p95 ${fmt(s.p95).padStart(9)}  avg ${fmt(s.avg).padStart(9)}  min ${fmt(s.min).padStart(9)}`);
  return s;
}

const up = await upstream();
const px = await proxy(up.port);
try {
  const small = JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'x'.repeat(8_000) }] });
  const urls = Array.from({ length: 12 }, (_, i) => fakeJpegDataUrl(90_000, i));
  const big = JSON.stringify(chatBody(urls));

  console.log(`\n小文本请求 ${(Buffer.byteLength(small) / 1024).toFixed(0)}KB，5 次预热 + 100 次采样`);
  await measure('  直连上游', `http://127.0.0.1:${up.port}/v1/chat/completions`, small, 100);
  await measure('  经 relay-gateway 代理（快路径）', `${px.base}/v1/chat/completions`, small, 100);

  console.log(`\n大图片请求 ${(Buffer.byteLength(big) / 1048576).toFixed(2)}MB（12 张图，会被裁剪），3 次预热 + 20 次采样`);
  await measure('  直连上游（不裁剪，仅作基线）', `http://127.0.0.1:${up.port}/v1/chat/completions`, big, 20);
  await measure('  经 relay-gateway 代理（裁剪+重序列化）', `${px.base}/v1/chat/completions`, big, 20);
} finally {
  px.child.kill();
  up.server.close();
  agent.destroy();
}
