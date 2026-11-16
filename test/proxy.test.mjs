// 集成测试：真实起一个代理进程 + 一个假上游，验证裁剪、重试、无图降级和零拷贝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { after } from 'node:test';
import { ROOT } from '../lib/config.mjs';
import { chatBody, countImages, fakeJpegDataUrl } from './helpers.mjs';

// 测试期一律写临时目录，避免污染生产记录。
const TEST_RECORDS_DIR = mkdtempSync(join(tmpdir(), 'relay-gateway-test-rec-'));
after(() => rmSync(TEST_RECORDS_DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假上游：script 是响应函数数组，用完后重复最后一个。 */
function startUpstream(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        text: body.toString('utf8'),
      });
      const index = Math.min(seen.length - 1, script.length - 1);
      const respond = script[index];
      const { status = 200, headers = {}, payload = 'data: ok\n\n' } = respond(seen.at(-1)) ?? {};
      res.writeHead(status, { 'content-type': 'text/event-stream', ...headers });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function startProxy(upstreamPort, extraEnv = {}) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      LRG_PORT: String(port),
      LRG_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LRG_LOG: 'off',
      LRG_RECORDS_DIR: TEST_RECORDS_DIR,
      ...extraEnv,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/__gateway/status`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { base, child };
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('代理未能在 10s 内启动');
}

test('12 张图请求被裁到预算内，且上游只收到裁剪后的体积', async (t) => {
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  const urls = Array.from({ length: 12 }, (_, i) => fakeJpegDataUrl(90_000, i));
  const body = JSON.stringify(chatBody(urls));
  assert.ok(Buffer.byteLength(body) > 1_000_000, '原始请求体应超过 1MB');

  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(upstream.seen.length, 1, '成功场景不应产生重试');
  const forwarded = upstream.seen[0];
  const forwardedJson = JSON.parse(forwarded.text);
  assert.ok(countImages(forwardedJson) <= 6, `转发图片数应 ≤6，实际 ${countImages(forwardedJson)}`);
  assert.ok(forwarded.body.length < 800_000, `转发体积应明显下降，实际 ${forwarded.body.length}`);
  assert.match(forwarded.text, /图片已省略/);
  assert.equal(Number(forwarded.headers['content-length']), forwarded.body.length, 'Content-Length 必须重算');
});

test('连续两次 400 invalid_protocol_request 后，第三次以无图请求成功', async (t) => {
  const bad = () => ({
    status: 400,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ code: 'invalid_protocol_request', message: 'Invalid protocol request.' }),
  });
  const upstream = await startUpstream([bad, bad, () => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  const urls = Array.from({ length: 8 }, (_, i) => fakeJpegDataUrl(60_000, i));
  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody(urls)),
  });
  assert.equal(response.status, 200, '重试后应拿到 200');
  await response.text();

  assert.equal(upstream.seen.length, 3, '应当尝试 3 次');
  assert.ok(countImages(JSON.parse(upstream.seen[0].text)) <= 6);
  assert.ok(countImages(JSON.parse(upstream.seen[1].text)) <= 6);
  assert.equal(countImages(JSON.parse(upstream.seen[2].text)), 0, '最后一次必须是无图降级');
});

test('纯文本请求原样透传，一个字节都不改写', async (t) => {
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  const body = JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].body.toString('utf8'), body, '快路径必须零改写');
});

test('上游持续 500 时把错误原样回传给客户端', async (t) => {
  const upstream = await startUpstream([() => ({
    status: 500,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ error: 'boom' }),
  })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody([fakeJpegDataUrl(30_000, 1)])),
  });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /boom/);
  assert.equal(upstream.seen.length, 3, '5xx 应当重试到上限');
});

test('请求体超限时返回 413，而不是直接把连接掐断', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-gateway-cfg-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ retry: { maxBodyBytes: 2048 } }));
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port, { LRG_CONFIG: configPath });
  t.after(() => { proxy.child.kill(); upstream.server.close(); rmSync(dir, { recursive: true, force: true }); });

  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'y'.repeat(20_000) }] }),
  }).catch((error) => error);
  assert.ok(response instanceof Response, `应拿到 HTTP 响应而不是网络错误：${response?.message}`);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, 'body_too_large');
  assert.equal(upstream.seen.length, 0, '超限请求不应转发');
});

test('上游流中途断开时客户端能立刻结束，不会挂住', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n');
      setTimeout(() => res.destroy(), 30);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy(server.address().port);
  t.after(() => { proxy.child.kill(); server.close(); });

  const started = Date.now();
  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 200, '响应头已经发出，状态仍是 200');
  await assert.rejects(() => response.text(), '流被中断时读取应失败');
  assert.ok(Date.now() - started < 5000, '不应挂到超时');
});

test('上游 baseUrl 自带路径时不会重复拼接', async (t) => {
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port, { LRG_UPSTREAM: `http://127.0.0.1:${upstream.port}/v1` });
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  }).then((r) => r.text());
  assert.equal(upstream.seen[0].url, '/v1/chat/completions');

  await fetch(`${proxy.base}/v1beta/models/x:generateContent?key=k`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [] }),
  }).then((r) => r.text());
  assert.equal(upstream.seen[1].url, '/v1/v1beta/models/x:generateContent?key=k', '不同前缀仍需补上 base 路径');
});

test('上游用 gzip 压缩错误体时，仍能识别出可重试的错误码', async (t) => {
  const gzipped = gzipSync(Buffer.from(JSON.stringify({
    code: 'invalid_protocol_request',
    message: 'Invalid protocol request.',
  })));
  const upsteamBad = () => ({
    status: 400,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    payload: gzipped,
  });
  const upstream = await startUpstream([upsteamBad, () => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  const response = await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody([fakeJpegDataUrl(20_000, 1)])),
  });
  assert.equal(response.status, 200, '压缩的错误体也应触发重试');
  await response.text();
  assert.equal(upstream.seen.length, 2);
});

test('状态端点可用且统计正确', async (t) => {
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port);
  t.after(() => { proxy.child.kill(); upstream.server.close(); });

  await fetch(`${proxy.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody(Array.from({ length: 10 }, (_, i) => fakeJpegDataUrl(50_000, i)))),
  }).then((r) => r.text());

  const status = await (await fetch(`${proxy.base}/__gateway/status`)).json();
  assert.equal(status.ok, true);
  assert.equal(status.stats.requests, 1);
  assert.equal(status.stats.trimmed, 1);
  assert.equal(status.stats.recent.at(-1).images, 10);
  assert.ok(status.stats.recent.at(-1).dropped >= 4);
  assert.equal(status.records.enabled, true, '记录默认开启');
});

test('记录里不出现 query、请求头或图片数据', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-gateway-rec-'));
  const upstream = await startUpstream([() => ({ status: 200 })]);
  const proxy = await startProxy(upstream.port, { LRG_RECORDS_DIR: dir });
  t.after(() => { proxy.child.kill(); upstream.server.close(); rmSync(dir, { recursive: true, force: true }); });

  const url = `${proxy.base}/v1beta/models/x:generateContent?key=SUPER_SECRET_KEY`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer SUPER_SECRET_KEY' },
    body: JSON.stringify(chatBody([fakeJpegDataUrl(20_000, 1)])),
  }).then((r) => r.text());

  // 等记录落盘
  let text = '';
  for (let i = 0; i < 30 && !text; i++) {
    await sleep(100);
    try {
      text = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('');
    } catch { /* 目录还没创建 */ }
  }
  assert.ok(text, '应产生记录');
  assert.ok(!text.includes('SUPER_SECRET_KEY'), '不能记录 key / query');
  assert.ok(!text.includes('base64'), '不能记录图片数据');
  assert.ok(!text.includes('authorization'), '不能记录请求头');

  const record = JSON.parse(text.trim().split('\n').at(-1));
  assert.equal(record.path, '/v1beta/models/x:generateContent', '路径保留但去掉 query');
  assert.equal(record.status, 200);
  assert.equal(record.protocol, 'gemini');
  assert.equal(record.model, 'deepseek-flash', '记录里应当带上模型 ID');
  assert.ok(record.bodyBytes > 0);
  assert.equal(record.attempts.length, 1);
});
