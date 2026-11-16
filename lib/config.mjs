// 配置加载：项目目录下的 config.json 覆盖默认值；非法值一律回落到默认，避免代理因配置写错而不可用。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = join(ROOT, 'config.json');
export const PID_PATH = join(ROOT, 'relay-gateway.pid');
/** 配置回退等启动期告警，交给 server/cli 在日志里落地——否则守护进程的 stderr 没人看得到。 */
export const configWarnings = [];

export const DEFAULTS = Object.freeze({
  listen: { host: '127.0.0.1', port: 8787 },
  upstream: { baseUrl: '' }, // 必填：config.json 或 LRG_UPSTREAM 指定，缺省时 server 会直接报错退出
  limits: {
    // 实测：6 张 / 945KB 稳定，9 张 / 1.44MB 开始随机 400，因此总预算收到 1MB。
    maxImagesPerRequest: 6,
    maxTotalImageBytes: 1_000_000,
    maxSingleImageBytes: 4_000_000,
    dropDuplicates: true,
    validatePng: true,
  },
  retry: {
    maxAttempts: 3,
    stripImagesOnLastAttempt: true,
    baseDelayMs: 400,
    maxBodyBytes: 64 * 1024 * 1024,
  },
  timeouts: { headersMs: 180_000, idleMs: 300_000 },
  // 请求记录：只记元数据，按天切文件，总量封顶后删最旧的。
  records: { enabled: true, maxTotalBytes: 256 * 1024 * 1024, dir: join(ROOT, 'records') },
  log: { enabled: true, level: 'info', path: join(ROOT, 'relay-gateway.log') },
});

const int = (value, fallback, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const str = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

export function normalize(raw) {
  const cfg = structuredClone(DEFAULTS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cfg;
  const listen = raw.listen ?? {};
  cfg.listen.host = str(listen.host, cfg.listen.host);
  cfg.listen.port = int(listen.port, cfg.listen.port, 1, 65535);
  const upstream = raw.upstream ?? {};
  cfg.upstream.baseUrl = str(upstream.baseUrl, cfg.upstream.baseUrl).replace(/\/+$/, '');
  const limits = raw.limits ?? {};
  cfg.limits.maxImagesPerRequest = int(limits.maxImagesPerRequest, cfg.limits.maxImagesPerRequest, 0, 64);
  cfg.limits.maxTotalImageBytes = int(limits.maxTotalImageBytes, cfg.limits.maxTotalImageBytes, 0, 256 * 1024 * 1024);
  cfg.limits.maxSingleImageBytes = int(limits.maxSingleImageBytes, cfg.limits.maxSingleImageBytes, 0, 256 * 1024 * 1024);
  cfg.limits.dropDuplicates = bool(limits.dropDuplicates, cfg.limits.dropDuplicates);
  cfg.limits.validatePng = bool(limits.validatePng, cfg.limits.validatePng);
  const retry = raw.retry ?? {};
  cfg.retry.maxAttempts = int(retry.maxAttempts, cfg.retry.maxAttempts, 1, 5);
  cfg.retry.stripImagesOnLastAttempt = bool(retry.stripImagesOnLastAttempt, cfg.retry.stripImagesOnLastAttempt);
  cfg.retry.baseDelayMs = int(retry.baseDelayMs, cfg.retry.baseDelayMs, 0, 10_000);
  cfg.retry.maxBodyBytes = int(retry.maxBodyBytes, cfg.retry.maxBodyBytes, 1024, 512 * 1024 * 1024);
  const timeouts = raw.timeouts ?? {};
  cfg.timeouts.headersMs = int(timeouts.headersMs, cfg.timeouts.headersMs, 1000, 3_600_000);
  cfg.timeouts.idleMs = int(timeouts.idleMs, cfg.timeouts.idleMs, 1000, 3_600_000);
  const records = raw.records ?? {};
  cfg.records.enabled = bool(records.enabled, cfg.records.enabled);
  cfg.records.maxTotalBytes = int(records.maxTotalBytes, cfg.records.maxTotalBytes, 1024 * 1024, 64 * 1024 * 1024 * 1024);
  cfg.records.dir = str(records.dir, cfg.records.dir);
  const log = raw.log ?? {};
  cfg.log.enabled = bool(log.enabled, cfg.log.enabled);
  cfg.log.level = ['debug', 'info', 'warn', 'error'].includes(log.level) ? log.level : cfg.log.level;
  cfg.log.path = str(log.path, cfg.log.path);
  return cfg;
}

export function loadConfig(path = process.env.LRG_CONFIG || CONFIG_PATH) {
  let cfg;
  try {
    cfg = normalize(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      configWarnings.push(`配置读取失败，已回退默认值：${error.message}`);
    }
    cfg = normalize(undefined);
  }
  // 环境变量覆盖：容器化部署主要靠这几个，避免把主机差异写进 config.json。
  const port = Number(process.env.LRG_PORT);
  if (Number.isInteger(port) && port > 0 && port <= 65535) cfg.listen.port = port;
  if (process.env.LRG_HOST) cfg.listen.host = process.env.LRG_HOST;
  if (process.env.LRG_UPSTREAM) cfg.upstream.baseUrl = process.env.LRG_UPSTREAM.replace(/\/+$/, '');
  if (process.env.LRG_RECORDS_DIR) cfg.records.dir = process.env.LRG_RECORDS_DIR;
  if (process.env.LRG_LOG_PATH) cfg.log.path = process.env.LRG_LOG_PATH;
  if (process.env.LRG_LOG === 'off') cfg.log.enabled = false;
  return cfg;
}
