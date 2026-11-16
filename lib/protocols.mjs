// 协议层：只做「找出图片块 → 就地替换成文字块」这一件事。
// 支持 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini。
// 所有替换都在已解析的对象上原地进行，避免深拷贝大请求体。

const TEXT_BLOCK = {
  chat: (text) => ({ type: 'text', text }),
  responses: (text) => ({ type: 'input_text', text }),
  anthropic: (text) => ({ type: 'text', text }),
  gemini: (text) => ({ text }),
};

export function detectProtocol(pathname) {
  if (pathname.startsWith('/v1beta/') || /:generateContent$/.test(pathname)) return 'gemini';
  if (/\/messages$/.test(pathname)) return 'anthropic';
  if (/\/responses$/.test(pathname)) return 'responses';
  if (/\/(chat\/)?completions$/.test(pathname)) return 'chat';
  return 'unknown';
}

/** data URL 的载荷长度；远程 URL 返回 0（体积未知，但仍计入张数）。 */
function payloadOf(url) {
  if (typeof url !== 'string') return { bytes: 0, data: null, mime: 'unknown' };
  if (!url.startsWith('data:')) return { bytes: 0, data: null, mime: 'remote' };
  const comma = url.indexOf(',');
  if (comma < 0) return { bytes: 0, data: null, mime: 'broken' };
  const meta = url.slice(5, comma);
  const mime = meta.split(';')[0] || 'unknown';
  return { bytes: url.length - comma - 1, data: url.slice(comma + 1), mime };
}

function makeRef(data, bytes, mime, replace) {
  return { bytes, data, mime, replace };
}

/** 遍历一个 content/parts 数组，产出图片引用；tool_result 这类嵌套容器递归一层。 */
function scanArray(owner, key, protocol, out, depth = 0) {
  const arr = owner?.[key];
  if (!Array.isArray(arr) || depth > 3) return;
  for (let i = 0; i < arr.length; i++) {
    const part = arr[i];
    if (!part || typeof part !== 'object') continue;
    const replace = (text) => { arr[i] = TEXT_BLOCK[protocol](text); };

    // OpenAI Chat / Responses
    if (part.type === 'image_url' || part.type === 'input_image') {
      const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url;
      const { bytes, data, mime } = payloadOf(raw);
      out.push(makeRef(data, bytes, mime, replace));
      continue;
    }
    // Anthropic（source.base64）与部分兼容实现的扁平写法
    if (part.type === 'image') {
      const source = part.source;
      if (source && typeof source.data === 'string') {
        out.push(makeRef(source.data, source.data.length, source.media_type || 'image', replace));
      } else if (typeof part.data === 'string') {
        out.push(makeRef(part.data, part.data.length, part.mimeType || 'image', replace));
      }
      continue;
    }
    // Gemini
    const inline = part.inlineData ?? part.inline_data;
    if (inline && typeof inline.data === 'string' && String(inline.mimeType ?? inline.mime_type ?? '').startsWith('image/')) {
      out.push(makeRef(inline.data, inline.data.length, inline.mimeType ?? inline.mime_type, replace));
      continue;
    }
    // Anthropic tool_result 的内容数组里也可能有图片
    if (part.type === 'tool_result' && Array.isArray(part.content)) {
      scanArray(part, 'content', protocol, out, depth + 1);
    }
  }
}

function scanMessages(body, protocol, out) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (Array.isArray(message.content)) scanArray(message, 'content', protocol, out);
    if (Array.isArray(message.parts)) scanArray(message, 'parts', protocol, out);
    // Anthropic 的 tool_result 可以裸放在 content 之外（少见），保持兼容
    if (Array.isArray(message.tool_result?.content)) scanArray(message.tool_result, 'content', protocol, out);
  }
}

function scanInput(body, protocol, out) {
  const input = body?.input;
  if (!Array.isArray(input)) return;
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.content)) scanArray(item, 'content', protocol, out);
    if (Array.isArray(item.output)) scanArray(item, 'output', protocol, out); // function_call_output
    // 少数客户端把 input_image 直接放在 input 顶层，不在 content 数组里。
    if (item.type === 'input_image') {
      const raw = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url ?? item.url;
      const { bytes, data, mime } = payloadOf(raw);
      out.push(makeRef(data, bytes, mime, (text) => { input[index] = TEXT_BLOCK[protocol](text); }));
    }
  }
}

function scanGemini(body, protocol, out) {
  const contents = body?.contents;
  if (!Array.isArray(contents)) return;
  for (const content of contents) {
    if (!content || typeof content !== 'object') continue;
    scanArray(content, 'parts', protocol, out);
  }
  if (Array.isArray(body?.systemInstruction?.parts)) scanArray(body.systemInstruction, 'parts', protocol, out);
}

/** 返回 body 里所有图片引用；顺序即出现顺序（预算规划需要按新→旧倒序）。 */
export function scanImages(body, protocol) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  switch (protocol) {
    case 'chat':
    case 'anthropic':
      scanMessages(body, protocol, out);
      break;
    case 'responses':
      scanInput(body, protocol, out);
      scanMessages(body, protocol, out);
      break;
    case 'gemini':
      scanGemini(body, protocol, out);
      break;
    default:
      break;
  }
  return out;
}

/** 全部替换成占位文字（无图重试用）。 */
export function stripAll(refs, reason) {
  for (const ref of refs) ref.replace(`[图片已省略（relay-gateway）：${reason}]`);
  return refs.length;
}

/** 快速判定：请求体里是否可能出现图片块。Buffer 级子串搜索，不做 JSON 解析。 */
export function mayContainImage(buf) {
  return buf.includes('image') || buf.includes('inlineData') || buf.includes('inline_data');
}
