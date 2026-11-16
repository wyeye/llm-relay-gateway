#!/usr/bin/env node
// 供 SessionStart 钩子调用：代理没在跑就把它拉起来。无论成败都退出 0，绝不阻塞会话启动。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from '../lib/config.mjs';

const cfg = loadConfig();
const statusUrl = `http://${cfg.listen.host}:${cfg.listen.port}/__gateway/status`;

async function alive(timeoutMs = 1200) {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

if (await alive()) process.exit(0);

const serverPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server.mjs');
const child = spawn(process.execPath, [serverPath], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

const deadline = Date.now() + 6000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (await alive()) {
    process.stdout.write(`relay-gateway 已启动：${statusUrl}\n`);
    process.exit(0);
  }
}
process.stderr.write(`relay-gateway 启动超时，请手动运行：node "${serverPath}"\n`);
process.stderr.write('若提示上游地址缺失，请先配好 config.json 的 upstream.baseUrl 或 LRG_UPSTREAM\n');
process.exit(0);
