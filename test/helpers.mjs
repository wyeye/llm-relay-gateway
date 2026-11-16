// 测试辅助：构造合法/损坏的 PNG data URL 与四种协议的请求体。
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function makePng(width = 12, height = 12, seed = 0) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const i = 1 + x * 3;
      row[i] = (x * 7 + seed) & 0xff;
      row[i + 1] = (y * 11 + seed) & 0xff;
      row[i + 2] = (x * y + seed) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function pngDataUrl(width = 12, seed = 0) {
  return `data:image/png;base64,${makePng(width, width, seed).toString('base64')}`;
}

/** 用不可压缩的随机字节造一张「体积可预期」的 JPEG 假图（不需要真实解码）。 */
export function fakeJpegDataUrl(bytes, seed = 0) {
  const raw = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) raw[i] = (i * 31 + seed * 17) & 0xff;
  return `data:image/jpeg;base64,${raw.toString('base64')}`;
}

export function chatBody(urls, extra = {}) {
  return {
    model: 'deepseek-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [
        { type: 'text', text: 'screenshots' },
        ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ] },
    ],
    ...extra,
  };
}

export function responsesBody(urls) {
  return {
    model: 'deepseek-flash',
    stream: true,
    input: [
      { role: 'user', content: [
        { type: 'input_text', text: 'shots' },
        ...urls.map((url) => ({ type: 'input_image', image_url: url })),
      ] },
    ],
  };
}

export function anthropicBody(urls) {
  return {
    model: 'deepseek-flash',
    max_tokens: 64,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'shots' },
        ...urls.map((url) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: url.split(',')[1] },
        })),
      ] },
    ],
  };
}

export function geminiBody(urls) {
  return {
    contents: [
      { role: 'user', parts: [
        { text: 'shots' },
        ...urls.map((url) => ({ inlineData: { mimeType: 'image/png', data: url.split(',')[1] } })),
      ] },
    ],
  };
}

/** 统计请求体里的图片块数量（独立于实现，用于测试断言）。 */
export function countImages(value) {
  let count = 0;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (node.type === 'image_url' || node.type === 'input_image' || node.type === 'image') {
      count += 1;
      return;
    }
    if (node.inlineData?.data || node.inline_data?.data) { count += 1; return; }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(value);
  return count;
}
