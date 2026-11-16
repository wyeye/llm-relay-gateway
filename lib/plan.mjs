// 预算规划：从新到旧挑选保留的图片，其余标记为丢弃。
// 性能要点：先按 mime+体积分组，只有同组（可能重复）的图片才算 SHA-256——
// 典型截图体积各不相同，所以常见情况下零哈希开销。
import { createHash } from 'node:crypto';
import { decodeBase64Loose, isPng, pngProblem } from './png.mjs';

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function hashOf(ref) {
  if (ref._hash !== undefined) return ref._hash;
  ref._hash = ref.data === null ? null : createHash('sha256').update(ref.data).digest('hex');
  return ref._hash;
}

function problemOf(ref, validatePng) {
  if (!validatePng || !isPng(ref.mime) || !ref.data) return null;
  if (ref._problem !== undefined) return ref._problem;
  let problem = null;
  try {
    problem = pngProblem(decodeBase64Loose(ref.data));
  } catch {
    problem = 'PNG 解码失败';
  }
  ref._problem = problem;
  return problem;
}

export function planTrim(refs, limits) {
  const drop = new Set();
  const reasons = new Map();

  // 只有同组存在多张时才需要哈希去重。
  const groups = new Map();
  for (const ref of refs) {
    if (ref.data === null) continue;
    const key = `${ref.mime}:${ref.bytes}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const seen = new Set();
  let count = 0;
  let total = 0;

  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    let reason;

    if (count >= limits.maxImagesPerRequest) {
      reason = `超过单次请求图片张数上限（${limits.maxImagesPerRequest} 张）`;
    } else if (ref.bytes > limits.maxSingleImageBytes) {
      reason = `超过单图上限（${formatBytes(limits.maxSingleImageBytes)}）`;
    } else if (ref.bytes > limits.maxTotalImageBytes - total) {
      reason = `超过单次请求图片总体积上限（${formatBytes(limits.maxTotalImageBytes)}）`;
    } else {
      const problem = problemOf(ref, limits.validatePng);
      if (problem) reason = `图片结构校验失败：${problem}`;
    }

    if (!reason && limits.dropDuplicates) {
      const key = `${ref.mime}:${ref.bytes}`;
      if (ref.data !== null && (groups.get(key) ?? 0) > 1) {
        const hash = hashOf(ref);
        if (hash && seen.has(hash)) reason = '与更新的一张图片内容相同';
        else if (hash) seen.add(hash);
      }
    }

    if (reason) {
      drop.add(i);
      reasons.set(i, reason);
    } else {
      count++;
      total += ref.bytes;
    }
  }

  let droppedBytes = 0;
  for (const index of drop) droppedBytes += refs[index].bytes;
  return { drop, reasons, kept: count, keptBytes: total, droppedBytes };
}
