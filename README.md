# llm-relay-gateway

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

<!-- 发布到 GitHub 后填入 <owner>/<repo> 启用 CI 徽章：
![CI](https://github.com/<owner>/llm-relay-gateway/actions/workflows/ci.yml/badge.svg)
-->

LLM 上游中转站的前置网关：客户端 → 本网关 → 上游。零依赖，单个 Node 进程。

很多中转站对单次请求的图片数量/体积有硬限制，超了会随机返回 400，客户端却只能看到一句「请求失败」。本网关在转发路径上做三件事：

1. **透明转发**：请求体原样转给上游，响应逐字节透传；`model`、`tools`、`temperature` 等字段不改。
2. **超预算时裁图**：单次请求图片超过 6 张或超过 1MB base64 时，把超出的图片换成文字占位；上游返回可重试的 4xx/5xx 时重发，最后一次去掉全部图片。
3. **记录与日志**：每请求一行元数据（不含对话内容、图片、请求头），异步落盘，不阻塞转发。

## 要求

- Node.js >= 20（CI 覆盖 20 / 22 / 24）
- 一个 OpenAI / Anthropic / Gemini 兼容的上游地址

## 快速开始

```bash
cp config.json.example config.json   # 填 upstream.baseUrl
node server.mjs                      # 默认监听 127.0.0.1:8787
```

或者用环境变量，不落配置文件：

```bash
LRG_UPSTREAM=https://your-upstream.example.com node server.mjs
```

客户端把 `baseUrl` 指向网关即可（如 `http://127.0.0.1:8787/v1`），其余不用改。

### Docker 部署（Linux）

```bash
cd /opt/llm-relay-gateway
cp .env.example .env                  # 填上游地址
cp config.json.example config.json    # 可选：改图片预算
docker compose up -d --build
docker compose logs -f --tail 20
```

默认只绑 `127.0.0.1:8080`，前面挂 nginx/caddy 做 TLS 与鉴权。要让内网直接用，把 `compose.yml` 的 ports 改成 `"8080:8080"` 并用防火墙限制来源。容器内 `LRG_HOST=0.0.0.0`、端口 `8080`；记录与日志挂到 `/data`（`volumes: ./data:/data`）。

验证：

```bash
curl -s http://127.0.0.1:8080/__gateway/status | head -c 400

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer <上游 key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

### 本地（Windows / ZCode）

```bash
node bin/ensure.mjs        # 启动（幂等）
node bin/cli.mjs status    # 是否在跑、端口、最近请求
node bin/cli.mjs log 3     # 最近 3 行；看到 → 200 就说明已转到上游
node bin/cli.mjs stop
```

ZCode 通过 `~/.zcode/cli/config.json` 的 SessionStart 钩子调 `ensure.mjs` 自启；ZCode 的 provider `baseUrl` 指向 `http://127.0.0.1:8787/v1`。

## 配置

上游地址必填：写在 `config.json`（见 `config.json.example`）或环境变量 `LRG_UPSTREAM` 里，两者都没有时进程会报错退出。`config.json` 与 `.env` 已被 `.gitignore` 忽略，不入库。

| 键 | 默认 | 说明 |
|---|---|---|
| `upstream.baseUrl` | 无（必填） | 上游地址，请求转发到这里 |
| `limits.maxImagesPerRequest` | `6` | 单次请求最多几张图 |
| `limits.maxTotalImageBytes` | `1000000` | 图片 base64 总字符上限 |

环境变量（容器部署用，优先级高于 config.json）：

| 变量 | 作用 |
|---|---|
| `LRG_HOST` / `LRG_PORT` | 监听地址与端口 |
| `LRG_UPSTREAM` | 上游地址 |
| `LRG_RECORDS_DIR` | 请求记录目录 |
| `LRG_LOG_PATH` | 日志文件路径 |
| `LRG_LOG=off` | 关闭文本日志 |
| `LRG_CONFIG` | 指定配置文件路径 |

改 `config.json` 后要重启进程（`docker compose restart`）。

## 端点

| 路径 | 行为 |
|---|---|
| `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1beta/**` | 转发；按协议识别图片块 |
| 其它路径 | 原样转发（不解析） |
| `/__gateway/status` | 运行状态与最近请求 |
| `/__gateway/shutdown`（POST） | 停止进程 |

## 运维命令

```bash
node bin/cli.mjs status            # 运行状态、预算、最近 5 条请求
node bin/cli.mjs report 24h        # 按时间窗口汇总；--failed 只看失败
node bin/cli.mjs records           # 记录文件与占用
node bin/cli.mjs log 50            # 最近 50 行日志
node bin/cli.mjs start | stop
```

## 目录

```
server.mjs            转发、裁剪、重试
lib/                  协议识别、预算、PNG 校验、记录、日志
bin/ensure.mjs        启动器（钩子调它）
bin/cli.mjs           status / report / records / start / stop / log
config.json.example   配置模板（config.json 不入库）
.env.example          compose 用的上游地址模板
Dockerfile, compose.yml
.github/workflows/    CI：Node 20/22/24 测试 + 镜像构建
test/                 node --test（26 项）
bench/                性能基准，不进镜像：node bench/bench.mjs
records/              每请求一行元数据（不含对话内容与图片）
relay-gateway.log     文本日志
```

## 边界

- 不做协议转换（chat ↔ anthropic）、不做鉴权、不解析响应流。
- 裁剪只影响本次请求，客户端侧的历史与原图不动。
- 请求体上限 64MB（可配置），超限返回 413。

## 贡献与安全

- 开发与提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- 更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
