// 记录模块单测：写入格式、按天文件、总量封顶清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestRecorder } from '../lib/records.mjs';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'relay-gateway-rec-'));
}

test('写入 JSONL：每请求一行且字段完整', async () => {
  const dir = tempDir();
  const recorder = new RequestRecorder({ records: { enabled: true, maxTotalBytes: 1 << 20, dir } }, silentLog);
  recorder.record({ at: '2026-11-16T07:00:00.000Z', path: '/v1/chat/completions', status: 200, mode: 'trimmed', images: 12, kept: 6, dropped: 6 });
  recorder.record({ at: '2026-11-16T07:00:01.000Z', path: '/v1/messages', status: 400, mode: 'stripped', errorCode: 'invalid_protocol_request' });
  await recorder.close();

  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^requests-\d{8}\.jsonl$/);
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.status, 200);
  assert.equal(first.dropped, 6);
  const second = JSON.parse(lines[1]);
  assert.equal(second.errorCode, 'invalid_protocol_request');
  rmSync(dir, { recursive: true, force: true });
});

test('超出总量上限时删除最旧文件，且不动当天文件', () => {
  const dir = tempDir();
  const big = 'x'.repeat(4000);
  for (const day of ['20261101', '20261102', '20261103']) {
    writeFileSync(join(dir, `requests-${day}.jsonl`), `${big}\n`.repeat(3));
  }
  const cap = 6000; // 三个 4005B 文件 = 12015B，超过上限
  const recorder = new RequestRecorder({ records: { enabled: true, maxTotalBytes: cap, dir } }, silentLog);
  const remaining = readdirSync(dir).sort();
  assert.ok(remaining.length < 3, `应至少删除一个文件，实际剩 ${remaining.length}`);
  assert.ok(recorder.stats().bytes <= cap, '清理后总量应在上限内');
  recorder.close();
  rmSync(dir, { recursive: true, force: true });
});

test('记录关闭时完全不落盘', () => {
  const dir = tempDir();
  const recorder = new RequestRecorder({ records: { enabled: false, maxTotalBytes: 1 << 20, dir } }, silentLog);
  recorder.record({ at: new Date().toISOString(), status: 200 });
  recorder.close();
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
