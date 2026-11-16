// 测试用预算：与 product 默认值一致，单图上限放大以免小图被误判。
import { DEFAULTS } from '../lib/config.mjs';

export function defaultLimits() {
  return {
    ...DEFAULTS.limits,
    maxSingleImageBytes: 8_000_000,
  };
}
