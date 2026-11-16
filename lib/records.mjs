// 请求记录：每请求一行 JSONL，只记元数据（不含对话内容、图片、请求头），异步追加不阻塞转发。
// 轮转：按天切文件；总量超过上限时从最旧的文件开始删除。
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^requests-\d{8}\.jsonl$/;

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export class RequestRecorder {
  constructor(cfg, log) {
    this.enabled = Boolean(cfg.records.enabled);
    this.maxTotalBytes = cfg.records.maxTotalBytes;
    this.dir = cfg.records.dir;
    this.log = log;
    this.stream = null;
    this.day = null;
    this.file = null;
    this.bytes = 0;
    this.written = 0;
    if (!this.enabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.files = readdirSync(this.dir).filter((name) => FILE_PATTERN.test(name)).sort();
      this.bytes = this.files.reduce((sum, name) => sum + sizeOf(join(this.dir, name)), 0);
      this.prune();
    } catch (error) {
      this.log.warn(`记录目录初始化失败，已关闭记录：${error.message}`);
      this.enabled = false;
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      files: this.files?.length ?? 0,
      bytes: this.bytes,
      maxTotalBytes: this.maxTotalBytes,
      written: this.written,
    };
  }

  record(entry) {
    if (!this.enabled) return;
    const day = today();
    if (day !== this.day) this.rotate(day);
    if (!this.stream) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.bytes += Buffer.byteLength(line);
    this.written += 1;
    this.stream.write(line);
    if (this.bytes > this.maxTotalBytes) this.prune();
  }

  rotate(day) {
    this.closeStream();
    const name = `requests-${day}.jsonl`;
    const file = join(this.dir, name);
    try {
      this.stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
      this.stream.on('error', (error) => {
        this.log.warn(`记录写入失败，已关闭记录：${error.message}`);
        this.stream = null;
        this.enabled = false;
      });
      this.day = day;
      this.file = file;
      if (!this.files.includes(name)) this.files.push(name);
    } catch (error) {
      this.log.warn(`记录文件打开失败：${error.message}`);
      this.stream = null;
      this.enabled = false;
    }
  }

  /** 超过上限时删到 80%，给下一轮留余量；正在写的当天文件不动。 */
  prune() {
    if (!this.files) return;
    const target = Math.floor(this.maxTotalBytes * 0.8);
    const current = this.day ? `requests-${this.day}.jsonl` : null;
    while (this.bytes > target) {
      const oldest = this.files.find((name) => name !== current);
      if (!oldest) break;
      const path = join(this.dir, oldest);
      const size = sizeOf(path);
      try {
        unlinkSync(path);
      } catch (error) {
        this.log.warn(`清理旧记录失败 ${oldest}：${error.message}`);
        this.files = this.files.filter((name) => name !== oldest);
        continue;
      }
      this.bytes -= size;
      this.files = this.files.filter((name) => name !== oldest);
    }
  }

  closeStream() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  close() {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      const stream = this.stream;
      this.stream = null;
      stream.end(resolve);
    });
  }
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export { FILE_PATTERN };
