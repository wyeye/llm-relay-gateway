// 异步日志：只在内存里拼行，写入失败一律吞掉，绝不影响转发。
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 16 * 1024 * 1024;

export function createLogger(cfg) {
  const level = LEVELS[cfg.log.level] ?? LEVELS.info;
  const enabled = cfg.log.enabled;
  let stream;
  if (enabled) {
    try {
      const path = cfg.log.path;
      mkdirSync(dirname(path), { recursive: true });
      // 启动时滚动一次：长跑的守护进程不会把日志写到无限大。
      try {
        if (statSync(path).size > MAX_LOG_BYTES) {
          try { unlinkSync(`${path}.1`); } catch { /* 没有旧文件 */ }
          renameSync(path, `${path}.1`);
        }
      } catch { /* 首次启动没有文件 */ }
      stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
      stream.on('error', () => { stream = undefined; });
    } catch {
      stream = undefined;
    }
  }
  const emit = (at, message) => {
    if (!enabled || LEVELS[at] < level) return;
    const line = `[${new Date().toISOString()}] ${at.toUpperCase()} ${message}\n`;
    if (stream) stream.write(line);
    else if (at === 'error' || at === 'warn') process.stderr.write(line);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    close: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve())),
  };
}
