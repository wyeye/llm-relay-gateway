# 贡献指南

## 环境

- Node.js >= 20（CI 跑 20 / 22 / 24）
- 无第三方依赖，`npm install` 不需要跑

## 开发

```bash
node --test              # 全部测试（26 项，约 6 秒）
node bench/bench.mjs     # 性能基准：直连上游 vs 经代理
node server.mjs          # 本机启动，需要配置 upstream.baseUrl 或 LRG_UPSTREAM
```

启动前需要上游地址，两种方式任选：

```bash
cp config.json.example config.json   # 填 upstream.baseUrl
# 或
LRG_UPSTREAM=https://your-upstream.example.com node server.mjs
```

`config.json` 与 `.env` 已被 `.gitignore` 忽略，不会被提交。

## 改动约定

- **零依赖**：只用 Node 内置模块，不引入 npm 包。
- **转发路径不阻塞**：记录、日志都异步落盘；解析失败一律回退为原样转发。
- **不动请求语义**：除了裁图，不改 `model`、`tools`、`temperature` 等字段；不解析响应流。
- 代码缩进 2 空格、UTF-8、LF；注释用中文，说明「为什么」而不是「做了什么」。

## 提交前

```bash
node --test
```

测试里覆盖了四种协议（OpenAI Chat / Responses / Anthropic / Gemini）的图片识别与替换、裁剪预算、重试、错误透传、413 收尾、记录脱敏。改 `lib/protocols.mjs` 时请补对应协议的单测；改 `server.mjs` 的转发逻辑时请补 `test/proxy.test.mjs` 的集成用例。

## Pull Request

- 一个 PR 做一件事，描述里写清楚「解决什么问题」和「怎么验证」。
- 不要提交 `config.json`、`.env`、`records/`、日志，也不要在 issue/PR 里贴上游地址、密钥或完整请求体。
