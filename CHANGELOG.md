# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-16

首个公开版本。

### 新增

- 透明转发：`/v1/**` 请求体原样转发，响应逐字节透传，不解析流。
- 图片预算：单请求图片张数、单图体积、总体积三重上限，超限的图片替换成文字占位。
- 协议识别：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini（`/v1beta/**`）。
- 图片校验与去重：PNG 块结构 + CRC 校验（不做像素解压）；同内容图片只保留最新一张。
- 分级重试：连接失败与可重试状态码自动重发；最后一次尝试去掉全部图片。
- 请求记录：每请求一行 JSONL，按天切分、总量封顶删旧，只记元数据。
- 运维命令：`status` / `report` / `records` / `start` / `stop` / `log`，以及幂等启动器。
- 部署：Dockerfile（非 root 运行）+ compose，配置与密钥通过 `LRG_UPSTREAM` / `config.json` 注入。

### 修复

- Responses 协议中顶层 `input_image`（不在 `content` 数组里）的图片引用字段错位，导致裁剪时抛错并退化为原样转发。
- `node --test test/` 在 Node 22+ 下无法解析目录；改为自动发现，并把基准脚本移出 `test/`。

[1.0.0]: https://github.com/
