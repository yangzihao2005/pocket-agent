# PocketAgent

移动端优先的 AI 对话与笔记库 Agent 插件，原生支持 OpenCode Go，并兼容 DeepSeek 与任意标准 OpenAI 接口。

专为手机、平板触控场景设计：无需电脑、无需本地 CLI、无需代理服务器，在 iOS / iPadOS / Android / 桌面端 Obsidian 中均可运行。

## 功能

- **OpenCode Go 原生协议**：自动注入 `x-opencode-session`、`Authorization` 与 `User-Agent`，会话 ID 在窗口内保持不变以复用服务端缓存；新建对话时自动刷新 `ses_` ID。
- **多协议路由**：支持 `openai-chat`、`anthropic-messages`、`openai-responses` 三种协议，按模型自动选择端点与请求体格式。
- **移动端免跨域直连**：默认使用 Obsidian `requestUrl` 绕过 WebView CORS；可切换 `fetch` 流式输出，网络层失败时自动降级。
- **触控优化界面**：顶部模型切换、历史抽屉、当前笔记挂载、选中文本感知、横向快捷指令胶囊、消息操作栏（复制 / 插入光标处 / 存为新笔记）。
- **笔记库 Agent**：AI 可搜索、读取笔记，并在用户确认差异对比后写入；不会静默修改文件。
- **本地历史记录**：会话通过 Vault Adapter 保存在库内，可选 JSON 或 JSON + Markdown 格式。

## 安装

### 从社区插件目录（上架后）

设置 → 第三方插件 → 浏览 → 搜索 `PocketAgent` → 安装并启用。

### 使用 BRAT（推荐用于自测与测试版）

1. 安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. 命令面板运行 `BRAT: Add a beta plugin for testing`
3. 输入 `你的GitHub用户名/pocket-agent`
4. 在第三方插件列表中启用 `PocketAgent`

### 手动安装

将以下文件放入 `<你的笔记库>/.obsidian/plugins/pocket-agent/`：

```
main.js
manifest.json
styles.css
```

重启 Obsidian 后在第三方插件中启用。iPadOS 的 Files App 默认不显示 `.obsidian` 隐藏目录，建议使用 BRAT，或使用 Taio / Textastic 等可访问配置目录的应用。

## 配置

### OpenCode Go

- **API Key**：OpenCode Go 访问密钥
- **Base URL**：默认 `https://opencode.ai/zen/go/v1`
- **请求模式**：
  - `requestUrl 免跨域直连`（默认，移动端最稳定）
  - `fetch 流式输出`（逐字显示，要求接口允许跨域）
- **模型列表**：可添加模型 ID、显示名称、协议类型

### DeepSeek / 自定义 OpenAI

- **API Key** 与 **Base URL**（默认 `https://api.deepseek.com/v1`）
- 默认模型：`deepseek-flash`（DeepSeek V4.1 Flash）、`deepseek-v4-pro`

### 其他

- 全局系统提示词
- 快捷指令胶囊的增删改（支持 `{{selection}}` 与 `{{note}}` 占位符）
- 会话存储路径、存储格式与最大历史条数
- 默认开启笔记库 Agent 模式 / 自动附带当前笔记
- 温度与最大回复 token 数

## 移动端说明

- 所有可点击控件最小触控热区 44×44 px
- 输入区使用 `env(safe-area-inset-bottom)` 避开全面屏手势条
- 适配 Obsidian 的 `.is-mobile` / `.is-tablet` 样式类
- 在手机 / 平板上按回车换行，使用发送按钮送出消息

## 隐私

- API Key 仅保存在本地插件数据 `data.json` 中，不会上传到任何第三方服务器。
- 请求直接发送到用户配置的服务商（OpenCode Go、DeepSeek 或自定义 Base URL）。
- 聊天记录保存在用户自己的笔记库内，路径可在设置中修改。

## 开发

```bash
npm install
npm run dev      # 监听并生成 main.js
npm run build    # 类型检查 + 生产构建
npm run typecheck
```

产物为根目录的 `main.js`。发布时请将 `main.js`、`manifest.json`、`styles.css` 作为独立附件上传到 GitHub Release，并保证 tag 与 `manifest.json` 的 `version` 完全一致。

## 目录结构

```
src/
├── main.ts            # 插件入口与历史存储
├── types.ts           # 全局类型
├── settings.ts        # 设置页
├── api/session.ts     # ses_ 会话 ID
├── api/client.ts      # 多协议网络客户端
├── agent/vaultTools.ts# 笔记库工具
└── ui/
    ├── ChatView.ts    # 聊天界面
    └── DiffModal.ts   # 差异确认弹窗
```

## License

MIT
