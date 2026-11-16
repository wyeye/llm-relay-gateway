// relay-gateway 代理：ZCode → 本机 → 中转站。
// 三件事：1) 把图片请求体压进安全预算；2) 对中转站的随机 4xx/5xx 分级重试；3) 其余字节零拷贝透传。
// 附带每请求一行元数据记录（不含对话内容与图片），异步写盘不阻塞转发。
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { unlinkSync, writeFileSync } from 'node:fs';
import { configWarnings, loadConfig, PID_PATH } from './lib/config.mjs';
import { createLogger } from './lib/log.mjs';
import { detectProtocol, mayContainImage, scanImages, stripAll } from './lib/protocols.mjs';
import { formatBytes, planTrim } from './lib/plan.mjs';
import { RequestRecorder } from './lib/records.mjs';

const cfg = loadConfig();
const log = createLogger(cfg);
for (const warning of configWarnings) log.warn(warning);
function fatal(message) {
  log.error(message);
  process.stderr.write(`relay-gateway: ${message}\n`);
  process.exit(1);
}

if (!cfg.upstream.baseUrl) {
  fatal('未配置上游地址：请在 config.json 里设置 upstream.baseUrl，或设置环境变量 LRG_UPSTREAM');
}
let base;
try {
  base = new URL(cfg.upstream.baseUrl);
} catch {
  // 不回显完整地址：用户可能把 key 拼在了 path/query 里。
  fatal(`上游地址不是合法 URL（upstream.baseUrl / LRG_UPSTREAM）：${String(cfg.upstream.baseUrl).slice(0, 80)}`);
}
if (base.protocol !== 'http:' && base.protocol !== 'https:') {
  fatal(`上游地址只支持 http/https，当前是 ${base.protocol}`);
}
const recorder = new RequestRecorder(cfg, log);
const transport = base.protocol === 'https:' ? https : http;
const agent = new transport.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16,
  keepAliveMsecs: 15_000,
});

// 网关自己产生的可重试信号：400 里带这些码时，重发通常能过（实测约 8/10）。
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const RETRY_HINT = /invalid_protocol_request|invalid_request|no_healthy_account|PROVIDER_BUSINESS_ERROR|server_error|rate_limited|Invalid protocol request|Invalid request parameters|Unmarshal .*failed/i;

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  original: 0,
  trimmed: 0,
  stripped: 0,
  retried: 0,
  failures: 0,
  imagesDropped: 0,
  bytesSaved: 0,
  statuses: {},
  recent: [],
};

function remember(entry) {
  stats.recent.push(entry);
  if (stats.recent.length > 20) stats.recent.shift();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 不立刻 destroy：先暂停读取，让上层把 413 写回去再断开。
        fail(Object.assign(new Error('request body too large'), { code: 'E_BODY_TOO_LARGE' }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('client aborted')));
  });
}

/** 解析并规划；只有确实要丢弃图片时才重新序列化。 */
function prepare(body, protocol) {
  if (protocol === 'unknown') return { protocol, refs: [], changed: false, model: '' };
  const parsed = JSON.parse(body.toString('utf8'));
  const model = typeof parsed?.model === 'string' ? parsed.model.slice(0, 64) : '';
  const refs = scanImages(parsed, protocol);
  if (!refs.length) return { protocol, refs, changed: false, model };
  const plan = planTrim(refs, cfg.limits);
  if (!plan.drop.size) return { protocol, refs, changed: false, plan, model };
  for (const [index, reason] of plan.reasons) {
    refs[index].replace(`[图片已省略（relay-gateway）：${reason}]`);
  }
  return { protocol, refs, changed: true, plan, model, trimmed: Buffer.from(JSON.stringify(parsed)) };
}

/** 快路径不解析 JSON，用正则从字节头部取 model，用于记录和排障。 */
function modelOf(body) {
  if (!body?.length) return '';
  const match = body.subarray(0, 512).toString('latin1').match(/"model"\s*:\s*"([^"\\]{1,64})"/);
  return match ? match[1] : '';
}

function withoutImages(body, protocol) {
  const parsed = JSON.parse(body.toString('utf8'));
  const refs = scanImages(parsed, protocol);
  if (!refs.length) return body;
  stripAll(refs, '本次请求按无图重试');
  return Buffer.from(JSON.stringify(parsed));
}

function targetUrl(pathname, search) {
  const url = new URL(base.href);
  const basePath = base.pathname.replace(/\/+$/, '');
  // 上游 baseUrl 自带路径时，避免和客户端路径重复拼接（/v1 + /v1/chat → /v1/chat）。
  const path = basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ? pathname
    : `${basePath}${pathname}`;
  url.pathname = path;
  url.search = search;
  return url;
}

function send(url, method, headers, payload) {
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers, agent }, (response) => {
      clearTimeout(headerTimer);
      resolve(response);
    });
    const headerTimer = setTimeout(
      () => request.destroy(Object.assign(new Error('upstream headers timeout'), { code: 'E_HEADERS_TIMEOUT' })),
      cfg.timeouts.headersMs,
    );
    request.setTimeout(cfg.timeouts.idleMs, () => {
      request.destroy(Object.assign(new Error('upstream idle timeout'), { code: 'E_IDLE_TIMEOUT' }));
    });
    request.on('error', (error) => {
      clearTimeout(headerTimer);
      reject(error);
    });
    request.end(payload ?? undefined);
  });
}

/** 上游可能按 accept-encoding 压缩错误体，不先解开就看不出可重试的错误码。 */
function decodeForMatch(buffer, encoding) {
  const value = String(encoding ?? '').toLowerCase();
  if (!value || value === 'identity') return buffer.toString('utf8');
  const options = { maxOutputLength: 4 * 1024 * 1024 };
  try {
    if (value.includes('br')) return brotliDecompressSync(buffer, options).toString('utf8');
    if (value.includes('gzip')) return gunzipSync(buffer, options).toString('utf8');
    if (value.includes('deflate')) return inflateSync(buffer, options).toString('utf8');
  } catch {
    // 解不开就按原始字节处理，退化为「看不出错误码」，不影响转发。
  }
  return buffer.toString('utf8');
}

function retryable(status, errorText) {
  if (RETRY_STATUS.has(status)) return true;
  if (status === 400 || status === 422) return RETRY_HINT.test(errorText);
  return false;
}

/** 从错误体里提取一个短码用于统计；gpt-load 会把上游 JSON 再塞进 message 字符串。 */
function errorCodeOf(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const direct = parsed?.error?.code ?? parsed?.code;
    if (typeof direct === 'string' && direct.length <= 64) return direct;
    const inner = typeof parsed?.error?.message === 'string' ? parsed.error.message : '';
    const nested = inner.match(/\\?"code\\?"\s*:\s*\\?"?([A-Za-z0-9_]{1,64})/);
    if (nested) return nested[1];
  } catch { /* 非 JSON，走下面的正则 */ }
  const match = text.match(/"code"\s*:\s*"?([A-Za-z0-9_]{1,64})/);
  return match ? match[1] : '';
}

function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function forwardError(res, status, code, message) {
  writeJson(res, status, { error: { code, message, type: 'img_guard_error' } });
}

async function proxy(req, res) {
  const startedAt = process.hrtime.bigint();
  stats.requests += 1;

  const [pathname, search = ''] = req.url.split('?');
  const query = search ? `?${search}` : '';
  const protocol = detectProtocol(pathname);

  // 记录条目不写 query（Gemini 的 key 在 query 里），也不写任何请求头。
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: pathname,
    protocol,
    model: '',
    status: 0,
    mode: 'original',
    bodyBytes: 0,
    forwardedBytes: 0,
    images: 0,
    kept: 0,
    dropped: 0,
    savedBytes: 0,
    attempts: [],
    errorCode: '',
    upstreamRequestId: '',
    ms: 0,
  };
  const finish = (patch) => {
    entry.ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    Object.assign(entry, patch);
    recorder.record(entry);
    return entry;
  };

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req, cfg.retry.maxBodyBytes);
    } catch (error) {
      if (error.code === 'E_BODY_TOO_LARGE') {
        finish({ status: 413, errorCode: 'body_too_large' });
        // 先把 413 发完再断开，否则客户端只会看到 ECONNRESET。
        res.on('finish', () => req.destroy());
        return forwardError(res, 413, 'body_too_large', error.message);
      }
      finish({ status: 0, errorCode: 'client_aborted' });
      return undefined; // 客户端已断开，无需响应
    }
  }
  entry.bodyBytes = body?.length ?? 0;

  let prepared = null;
  if (body?.length && protocol !== 'unknown' && mayContainImage(body)) {
    try {
      prepared = prepare(body, protocol);
    } catch (error) {
      log.warn(`请求体解析失败，原样转发：${error.message}`);
    }
  }

  entry.model = prepared?.model || modelOf(body);
  entry.images = prepared?.refs.length ?? 0;
  const hasImages = Boolean(prepared?.refs.length);
  entry.kept = prepared?.plan?.kept ?? entry.images;
  entry.dropped = prepared?.plan?.drop.size ?? 0;
  entry.savedBytes = prepared?.plan?.droppedBytes ?? 0;

  const maxAttempts = hasImages && cfg.retry.stripImagesOnLastAttempt
    ? cfg.retry.maxAttempts
    : Math.min(cfg.retry.maxAttempts, 2);
  const baseHeaders = { ...req.headers };
  delete baseHeaders.host;
  delete baseHeaders.connection;
  delete baseHeaders['content-length'];
  delete baseHeaders['transfer-encoding'];

  let stripped;
  let lastErrorText = '';
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLast = attempt === maxAttempts;
    let payload = body;
    let mode = 'original';
    if (prepared?.changed) {
      payload = prepared.trimmed;
      mode = 'trimmed';
    }
    if (isLast && hasImages && cfg.retry.stripImagesOnLastAttempt) {
      if (stripped === undefined) {
        try {
          stripped = withoutImages(body, protocol);
        } catch (error) {
          log.warn(`无图降级构造失败：${error.message}`);
          stripped = null;
        }
      }
      if (stripped) {
        payload = stripped;
        mode = 'stripped';
      }
    }

    const headers = { ...baseHeaders };
    if (payload) headers['content-length'] = String(payload.length);

    const attemptStarted = process.hrtime.bigint();
    const attemptRecord = { n: attempt, mode, status: 0, ms: 0 };
    entry.attempts.push(attemptRecord);

    let response;
    try {
      response = await send(targetUrl(pathname, query), req.method, headers, payload);
    } catch (error) {
      attemptRecord.ms = Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1e6);
      attemptRecord.error = error.code ?? 'error';
      lastStatus = 0;
      lastErrorText = error.message;
      if (attempt < maxAttempts) {
        stats.retried += 1;
        log.warn(`上游连接失败（${error.code ?? error.message}），第 ${attempt} 次重试`);
        await delay(attempt);
        continue;
      }
      stats.failures += 1;
      log.error(`上游连接失败且已用尽重试：${error.message}`);
      if (!res.headersSent) forwardError(res, 502, 'upstream_unreachable', `上游连接失败：${error.message}`);
      finish({ status: 0, mode, errorCode: `network:${error.code ?? 'error'}`, forwardedBytes: payload?.length ?? 0 });
      remember({ at: entry.at, status: 0, mode, protocol, model: entry.model, error: `network:${error.code ?? 'error'}` });
      return;
    }

    attemptRecord.ms = Math.round(Number(process.hrtime.bigint() - attemptStarted) / 1e6);
    const status = response.statusCode ?? 502;
    attemptRecord.status = status;
    entry.upstreamRequestId = String(
      response.headers['x-gptload-request-id'] ?? response.headers['x-request-id'] ?? '',
    );
    stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;

    if (status < 300) {
      if (mode === 'trimmed') stats.trimmed += 1;
      else if (mode === 'stripped') stats.stripped += 1;
      else stats.original += 1;
      res.writeHead(status, response.headers);
      // 上游流中断时必须主动收尾，否则 pipe 不会结束响应，客户端会挂住等超时。
      response.on('error', (error) => {
        log.warn(`上游响应流中断：${error.message}`);
        if (!res.destroyed) res.destroy();
      });
      response.on('aborted', () => {
        if (!res.destroyed) res.destroy();
      });
      res.on('error', () => {
        if (!response.destroyed) response.destroy();
      });
      response.pipe(res);
      res.on('close', () => {
        if (!response.destroyed) response.destroy();
      });
      const plan = prepared?.plan;
      finish({ status, mode, forwardedBytes: payload?.length ?? 0 });
      log.info(
        `${req.method} ${pathname} → ${status} ${entry.ms}ms model=${entry.model || '-'} mode=${mode} attempt=${attempt}` +
        (prepared ? ` images=${prepared.refs.length}/${plan?.kept ?? prepared.refs.length} kept, dropped=${plan?.drop.size ?? 0}` : ''),
      );
      remember({
        at: entry.at,
        status,
        mode,
        attempt,
        protocol,
        model: entry.model,
        ms: entry.ms,
        images: entry.images,
        kept: entry.kept,
        dropped: entry.dropped,
        bodyBytes: entry.bodyBytes,
      });
      return;
    }

    // 非 2xx：读完错误体再决定重试（错误体通常只有几十到几百字节）
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > 2 * 1024 * 1024) break;
      }
    } catch (error) {
      log.warn(`读取错误响应体失败：${error.message}`);
    }
    lastErrorText = decodeForMatch(Buffer.concat(chunks, size), response.headers['content-encoding']);
    lastStatus = status;
    const canRetry = attempt < maxAttempts && retryable(status, lastErrorText);
    if (canRetry) {
      stats.retried += 1;
      response.destroy();
      log.warn(
        `${pathname} → ${status}（可重试），第 ${attempt} 次重试，model=${entry.model || '-'} mode=${mode}` +
        (lastErrorText.includes('no_available_candidate') ? '｜上游没有该模型的可用渠道，检查模型 ID 是否存在于中转站' : ''),
      );
      await delay(attempt);
      continue;
    }

    stats.failures += 1;
    const plan = prepared?.plan;
    log.warn(
      `${pathname} → ${status} 放弃重试 model=${entry.model || '-'} mode=${mode} attempt=${attempt}` +
      (plan ? ` images=${prepared.refs.length}/${plan.kept} dropped=${plan.drop.size} saved=${formatBytes(plan.droppedBytes)}` : ''),
    );
    if (!res.headersSent) {
      const headers = { ...response.headers };
      delete headers['transfer-encoding'];
      delete headers.connection;
      headers['content-length'] = String(size);
      res.writeHead(status, headers);
      res.end(Buffer.concat(chunks, size));
    }
    const code = errorCodeOf(lastErrorText);
    finish({
      status,
      mode,
      forwardedBytes: payload?.length ?? 0,
      errorCode: code,
    });
    remember({
      at: entry.at,
      status,
      mode,
      attempt,
      protocol,
      model: entry.model,
      images: entry.images,
      kept: entry.kept,
      dropped: entry.dropped,
      // 只留短码：错误体可能回显请求内容，不能进 /status。
      error: code || `http_${status}`,
    });
    return;
  }

  if (!res.headersSent) {
    forwardError(res, 502, 'upstream_failed', `上游连续失败：${lastStatus} ${lastErrorText.slice(0, 160)}`);
  }
  finish({ status: lastStatus || 0, mode: 'unknown', errorCode: 'retry_exhausted' });
}

function delay(attempt) {
  const baseMs = cfg.retry.baseDelayMs * attempt;
  const jitter = Math.floor(Math.random() * Math.max(1, baseMs));
  return new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
}

function statusPayload() {
  return {
    ok: true,
    pid: process.pid,
    startedAt: stats.startedAt,
    uptimeMs: Date.now() - Date.parse(stats.startedAt),
    listen: cfg.listen,
    upstream: cfg.upstream,
    limits: cfg.limits,
    retry: { maxAttempts: cfg.retry.maxAttempts, stripImagesOnLastAttempt: cfg.retry.stripImagesOnLastAttempt },
    records: recorder.stats(),
    stats: {
      requests: stats.requests,
      original: stats.original,
      trimmed: stats.trimmed,
      stripped: stats.stripped,
      retried: stats.retried,
      failures: stats.failures,
      statuses: stats.statuses,
      recent: stats.recent,
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__gateway/')) {
    const [path] = req.url.split('?');
    if (path === '/__gateway/status') return writeJson(res, 200, statusPayload());
    if (path === '/__gateway/shutdown' && req.method === 'POST') {
      writeJson(res, 200, { ok: true, stopping: true });
      setTimeout(() => shutdown(0), 50);
      return undefined;
    }
    return writeJson(res, 404, { error: 'not_found' });
  }
  return proxy(req, res).catch((error) => {
    log.error(`未捕获异常：${error.stack ?? error.message}`);
    if (!res.headersSent) forwardError(res, 500, 'img_guard_internal', error.message);
    else res.destroy();
  });
});

server.on('checkContinue', (req, res) => {
  res.writeContinue();
  proxy(req, res).catch(() => res.destroy());
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

function shutdown(code = 0) {
  server.close(() => {
    try {
      unlinkSync(PID_PATH);
    } catch { /* 忽略 */ }
    log.info('已停止');
    Promise.all([recorder.close(), log.close()]).finally(() => process.exit(code));
  });
  setTimeout(() => process.exit(code), 3000).unref();
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`端口 ${cfg.listen.port} 已被占用，可能有另一个实例在运行`);
    process.exit(0);
  }
  log.error(`监听失败：${error.message}`);
  process.exit(1);
});

server.listen(cfg.listen.port, cfg.listen.host, () => {
  try {
    writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  } catch { /* 忽略 */ }
  log.info(`监听 http://${cfg.listen.host}:${cfg.listen.port} → ${cfg.upstream.baseUrl}`);
  process.stdout.write(`relay-gateway listening on http://${cfg.listen.host}:${cfg.listen.port} -> ${cfg.upstream.baseUrl}\n`);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => log.error(`uncaughtException：${error.stack ?? error.message}`));
process.on('unhandledRejection', (error) => log.error(`unhandledRejection：${error?.stack ?? error}`));
