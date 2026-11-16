// PNG 结构校验：只走块结构与 CRC，不做像素解压——解压一张 4K 截图要几十 MB 内存和十几毫秒，
// 而我们只需要判断「这张图是不是被截断/损坏」。损坏图片是上游 400 的常见来源之一。
import { crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export function pngProblem(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return 'PNG 数据为空';
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return 'PNG 文件头不对';
  let offset = 8;
  let headerSeen = false;
  let dataSeen = false;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return 'PNG 块被截断';
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return 'PNG 块长度越界';
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return 'PNG 块类型无效';
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      return `${type} 块 CRC 校验失败`;
    }
    if (!headerSeen && type !== 'IHDR') return 'PNG 缺少起始 IHDR';
    if (type === 'IHDR') {
      if (headerSeen || length !== 13) return 'IHDR 重复或长度错误';
      headerSeen = true;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16];
      const color = bytes[offset + 17];
      const interlace = bytes[offset + 20];
      if (!width || !height || !VALID_DEPTHS[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || interlace > 1) {
        return 'IHDR 参数无效';
      }
    } else if (type === 'IDAT') {
      dataSeen = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !dataSeen) return 'IEND 无效或缺少 IDAT';
      ended = true;
      offset += 12;
      break;
    }
    offset += length + 12;
  }
  if (!ended) return 'PNG 缺少 IEND';
  if (offset !== bytes.length) return 'PNG 的 IEND 后存在多余数据';
  return null;
}

/** base64 里出现换行/空格时先剥掉再解码；用于校验，不用于改写请求体。 */
export function decodeBase64Loose(data) {
  const clean = data.indexOf('\n') === -1 && data.indexOf('\r') === -1 && data.indexOf(' ') === -1
    ? data
    : data.replace(/[\s]/g, '');
  return Buffer.from(clean, 'base64');
}

export function isPng(mime) {
  return typeof mime === 'string' && mime.toLowerCase().includes('png');
}
