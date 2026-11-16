#!/usr/bin/env node
// 运维命令行：status / report / records / start / stop / log
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.mjs';

const cfg = loadConfig();
const root = ROOT;
const statusUrl = `http://${cfg.listen.host}:${cfg.listen.port}/__gateway/status`;
const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const RECORD_FILE = /^requests-\d{8}\.jsonl$/;

function human(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

async function getStatus() {
  const response = await fetch(statusUrl, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseSince(value) {
  if (!value) return Date.now() - 7 * 24 * 3600 * 1000;
  const match = String(value).match(/^(\d+)([hdm])$/);
  if (match) {
    const n = Number(match[1]);
    const unit = { h: 3600_000, d: 86_400_000, m: 60_000 }[match[2]];
    return Date.now() - n * unit;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() - 7 * 24 * 3600 * 1000 : parsed;
}

/** 逐行流式读取：记录总量上限 256MB，不能整份读进内存。 */
async function aggregate(sinceMs, onlyFailed) {
  const acc = {
    total: 0,
    ok: 0,
    modes: {},
    statuses: {},
    errors: {},
    perDay: {},
    images: 0,
    dropped: 0,
    saved: 0,
    withImages: 0,
    retried: 0,
    latencies: [],
  };
  let files = [];
  try {
    files = readdirSync(cfg.records.dir).filter((name) => RECORD_FILE.test(name)).sort();
  } catch {
    return acc;
  }
  for (const name of files) {
    const lines = createInterface({
      input: createReadStream(join(cfg.records.dir, name), 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // 进程崩溃时的半行，跳过
      }
      const at = Date.parse(record.at);
      if (Number.isNaN(at) || at < sinceMs) continue;
      const success = record.status >= 200 && record.status < 300;
      if (onlyFailed && success) continue;

      acc.total += 1;
      if (success) acc.ok += 1;
      acc.modes[record.mode] = (acc.modes[record.mode] ?? 0) + 1;
      acc.statuses[record.status] = (acc.statuses[record.status] ?? 0) + 1;
      acc.perDay[String(record.at).slice(0, 10)] = (acc.perDay[String(record.at).slice(0, 10)] ?? 0) + 1;
      if (record.images > 0) acc.withImages += 1;
      acc.images += record.images ?? 0;
      acc.dropped += record.dropped ?? 0;
      acc.saved += record.savedBytes ?? 0;
      if ((record.attempts?.length ?? 1) > 1) acc.retried += 1;
      if (success && Number.isFinite(record.ms)) acc.latencies.push(record.ms);
      if (!success) {
        const key = `${record.status || 'network'} ${record.errorCode || '-'}`;
        acc.errors[key] = (acc.errors[key] ?? 0) + 1;
      }
    }
  }
  return acc;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function formatReport(acc) {
  acc.latencies.sort((a, b) => a - b);
  const lines = [
    `请求 ${acc.total}（成功 ${acc.ok}，失败 ${acc.total - acc.ok}，成功率 ${acc.total ? ((acc.ok / acc.total) * 100).toFixed(1) : '0.0'}%）`,
    `模式：${Object.entries(acc.modes).map(([k, v]) => `${k}=${v}`).join('  ') || '-'}`,
    `状态码：${Object.entries(acc.statuses).map(([k, v]) => `${k || 'network'}=${v}`).join('  ') || '-'}`,
    `重试过的请求：${acc.retried}｜有图请求：${acc.withImages}｜图片 ${acc.images} 张，裁掉 ${acc.dropped} 张，省 ${human(acc.saved)}`,
    `延迟（成功请求）：p50 ${percentile(acc.latencies, 0.5)}ms  p95 ${percentile(acc.latencies, 0.95)}ms  max ${acc.latencies.at(-1) ?? 0}ms`,
    `按天：${Object.entries(acc.perDay).sort().map(([k, v]) => `${k}:${v}`).join('  ') || '-'}`,
  ];
  const topErrors = Object.entries(acc.errors).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (topErrors.length) {
    lines.push('Top 错误：');
    for (const [key, count] of topErrors) lines.push(`  ${String(count).padStart(4)}  ${key}`);
  }
  return lines.join('\n');
}

switch (command) {
  case 'status': {
    try {
      const s = await getStatus();
      const listening = s.listen;
      process.stdout.write(
        [
          `运行中 PID ${s.pid}，已运行 ${Math.round(s.uptimeMs / 60000)} 分钟`,
          `监听 http://${listening.host}:${listening.port} → ${s.upstream.baseUrl}`,
          `预算：≤${s.limits.maxImagesPerRequest} 张 / ${human(s.limits.maxTotalImageBytes)} base64 / 单图 ${human(s.limits.maxSingleImageBytes)}`,
          `请求 ${s.stats.requests}｜原样 ${s.stats.original}｜裁剪 ${s.stats.trimmed}｜无图降级 ${s.stats.stripped}｜重试 ${s.stats.retried}｜失败 ${s.stats.failures}`,
          `状态码：${JSON.stringify(s.stats.statuses)}`,
          `记录：${s.records.enabled ? `${s.records.dir}（${s.records.files} 个文件 / ${human(s.records.bytes)} / 上限 ${human(s.records.maxTotalBytes)}）` : '已关闭'}`,
          '最近 5 条：',
          ...s.stats.recent.slice(-5).map((r) =>
            `  ${r.at.slice(11, 19)} ${String(r.status).padStart(3)} ${r.mode.padEnd(8)} img=${r.images}/${r.kept} drop=${r.dropped} ${r.ms ?? ''}${r.ms ? 'ms' : ''} ${r.error ? `err=${String(r.error).slice(0, 40)}` : ''}`,
          ),
        ].join('\n') + '\n',
      );
    } catch (error) {
      process.stdout.write(`relay-gateway 未运行（${error.message}）\n启动：node "${join(root, 'bin', 'ensure.mjs')}"\n`);
      process.exitCode = 1;
    }
    break;
  }
  case 'report': {
    const since = parseSince(args.find((a) => !a.startsWith('-') && a !== 'report'));
    const acc = await aggregate(since, args.includes('--failed'));
    const from = new Date(since).toISOString().slice(0, 16).replace('T', ' ');
    process.stdout.write(`${from} 起：\n${formatReport(acc)}\n`);
    break;
  }
  case 'records': {
    const dir = cfg.records.dir;
    try {
      const files = readdirSync(dir).filter((name) => RECORD_FILE.test(name)).sort();
      if (!files.length) {
        process.stdout.write(`暂无记录（${dir}）\n`);
        break;
      }
      let total = 0;
      for (const name of files) {
        const size = statSync(join(dir, name)).size;
        total += size;
        process.stdout.write(`${name}  ${human(size)}\n`);
      }
      process.stdout.write(`共 ${files.length} 个文件，${human(total)}\n`);
    } catch (error) {
      process.stdout.write(`读取失败：${error.message}\n`);
    }
    break;
  }
  case 'start': {
    const child = spawn(process.execPath, [join(root, 'bin', 'ensure.mjs')], { stdio: 'inherit' });
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
    break;
  }
  case 'stop': {
    try {
      const response = await fetch(`http://${cfg.listen.host}:${cfg.listen.port}/__gateway/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      process.stdout.write(response.ok ? '已请求停止\n' : `停止请求返回 ${response.status}\n`);
    } catch (error) {
      process.stdout.write(`未运行：${error.message}\n`);
    }
    break;
  }
  case 'log': {
    try {
      const lines = readFileSync(cfg.log.path, 'utf8').trimEnd().split('\n');
      process.stdout.write(lines.slice(-Number(args[1] ?? 30)).join('\n') + '\n');
    } catch (error) {
      process.stdout.write(`读取日志失败（${cfg.log.enabled ? cfg.log.path : '日志已关闭'}）：${error.message}\n`);
    }
    break;
  }
  default:
    process.stdout.write('用法：node bin/cli.mjs [status|report [7d|24h|--failed]|records|start|stop|log [行数]]\n');
    process.exitCode = 1;
}
