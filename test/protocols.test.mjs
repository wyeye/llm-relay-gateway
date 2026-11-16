// 协议层与预算规划的单测：不依赖网络，毫秒级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol, mayContainImage, scanImages, stripAll } from '../lib/protocols.mjs';
import { planTrim } from '../lib/plan.mjs';
import { pngProblem } from '../lib/png.mjs';
import { defaultLimits } from './limits.mjs';
import { anthropicBody, chatBody, countImages, fakeJpegDataUrl, geminiBody, makePng, pngDataUrl, responsesBody } from './helpers.mjs';

const limits = defaultLimits();

test('detectProtocol 覆盖四种协议', () => {
  assert.equal(detectProtocol('/v1/chat/completions'), 'chat');
  assert.equal(detectProtocol('/v1/completions'), 'chat');
  assert.equal(detectProtocol('/v1/responses'), 'responses');
  assert.equal(detectProtocol('/v1/messages'), 'anthropic');
  assert.equal(detectProtocol('/v1beta/models/x:generateContent'), 'gemini');
  assert.equal(detectProtocol('/v1/models'), 'unknown');
});

test('四种协议都能找出全部图片块', () => {
  const urls = [pngDataUrl(12, 1), pngDataUrl(12, 2), fakeJpegDataUrl(2048, 3)];
  assert.equal(scanImages(chatBody(urls), 'chat').length, 3);
  assert.equal(scanImages(responsesBody(urls), 'responses').length, 3);
  assert.equal(scanImages(anthropicBody(urls), 'anthropic').length, 3);
  assert.equal(scanImages(geminiBody(urls), 'gemini').length, 3);
});

test('替换是原地生效的，序列化后图片数量正确下降', () => {
  const urls = Array.from({ length: 8 }, (_, i) => fakeJpegDataUrl(3000, i));
  for (const [protocol, body, build] of [
    ['chat', chatBody(urls), chatBody],
    ['responses', responsesBody(urls), responsesBody],
    ['anthropic', anthropicBody(urls), anthropicBody],
    ['gemini', geminiBody(urls), geminiBody],
  ]) {
    const refs = scanImages(body, protocol);
    assert.equal(refs.length, 8);
    refs[0].replace('[图片已省略]');
    assert.equal(countImages(body), 7, `${protocol} 替换后应剩 7 张`);
    assert.ok(JSON.stringify(body).includes('[图片已省略]'), `${protocol} 占位文字应存在`);
    assert.ok(build, 'sanity');
  }
});

test('Responses：顶层 input_image（不在 content 数组里）也能裁剪', () => {
  const urls = Array.from({ length: 8 }, (_, i) => fakeJpegDataUrl(3000, i));
  const body = {
    model: 'deepseek-flash',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'shots' }] },
      ...urls.map((url) => ({ type: 'input_image', image_url: url })),
    ],
  };
  const refs = scanImages(body, 'responses');
  assert.equal(refs.length, 8);
  for (const ref of refs) {
    assert.equal(typeof ref.replace, 'function', 'replace 必须可调用');
    assert.equal(typeof ref.data, 'string', 'data 应是 base64 字符串');
    assert.equal(ref.bytes, ref.data.length, 'bytes 应是 base64 长度');
  }
  const plan = planTrim(refs, { ...limits, validatePng: false });
  assert.equal(plan.drop.size, 2);
  for (const [index, reason] of plan.reasons) refs[index].replace(`[图片已省略]：${reason}`);
  assert.equal(countImages(body), 6);
  assert.ok(JSON.stringify(body).includes('图片已省略'));
});

test('stripAll 能清空所有图片', () => {
  const urls = Array.from({ length: 5 }, (_, i) => fakeJpegDataUrl(500, i));
  const body = chatBody(urls);
  assert.equal(stripAll(scanImages(body, 'chat'), '测试'), 5);
  assert.equal(countImages(body), 0);
});

test('预算：12 张图只保留最新的 6 张', () => {
  const urls = Array.from({ length: 12 }, (_, i) => fakeJpegDataUrl(90_000, i));
  const refs = scanImages(chatBody(urls), 'chat');
  const plan = planTrim(refs, limits);
  assert.equal(plan.drop.size, 6);
  assert.equal(plan.kept, 6);
  // 最新的（数组末尾）应全部保留
  for (const index of [11, 10, 9, 8, 7, 6]) assert.ok(!plan.drop.has(index), `第 ${index} 张应保留`);
  for (const index of [0, 1, 2, 3, 4, 5]) assert.ok(plan.drop.has(index), `第 ${index} 张应丢弃`);
});

test('预算：总体积超限时会继续丢弃旧图', () => {
  // 300000 字节 → 400000 个 base64 字符；预算 900K 只放得下两张。
  const urls = Array.from({ length: 6 }, (_, i) => fakeJpegDataUrl(300_000, i));
  const refs = scanImages(chatBody(urls), 'chat');
  const plan = planTrim(refs, { ...limits, maxImagesPerRequest: 10, maxTotalImageBytes: 900_000, validatePng: false });
  assert.equal(plan.drop.size, 4);
  assert.equal(plan.kept, 2);
});

test('去重：内容相同的图只保留最新一张', () => {
  const same = fakeJpegDataUrl(5_000, 7);
  const urls = [same, same, fakeJpegDataUrl(5_000, 8)];
  const refs = scanImages(chatBody(urls), 'chat');
  const plan = planTrim(refs, limits);
  assert.equal(plan.drop.size, 1);
  assert.ok(plan.drop.has(0), '最旧的那张重复图应被丢弃');
});

test('坏图：截断的 PNG 会被丢掉，好图保留', () => {
  const good = pngDataUrl(16, 1);
  const truncated = `data:image/png;base64,${makePng(16, 2).subarray(0, 40).toString('base64')}`;
  const refs = scanImages(chatBody([good, truncated]), 'chat');
  const plan = planTrim(refs, limits);
  assert.equal(plan.drop.size, 1);
  assert.ok(plan.drop.has(1), '截断的 PNG 应被丢弃');
  assert.match(plan.reasons.get(1), /结构校验失败/);
});

test('PNG 校验：合法通过、CRC 破坏被发现', () => {
  assert.equal(pngProblem(makePng(8, 1)), null);
  const broken = Buffer.from(makePng(8, 1));
  broken[40] ^= 0xff;
  assert.ok(pngProblem(broken));
});

test('快速判定不会漏掉图片请求', () => {
  assert.equal(mayContainImage(Buffer.from(JSON.stringify(chatBody([pngDataUrl()])))), true);
  assert.equal(mayContainImage(Buffer.from(JSON.stringify(geminiBody([pngDataUrl()])))), true);
  assert.equal(mayContainImage(Buffer.from('{"messages":[{"role":"user","content":"hi"}]}')), false);
  assert.equal(mayContainImage(Buffer.from('{"messages":[{"role":"user","content":"image"}]}')), true, '保守命中即可');
});
