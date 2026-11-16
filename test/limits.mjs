// 测试用预算：与生产默认值一致，单图上限放大以免小图被误判。
import { DEFAULTS } from '../lib/config.mjs';

export function defaultLimits() {
  return {
    ...DEFAULTS.limits,
    maxSingleImageBytes: 8_000_000,
  };
}
