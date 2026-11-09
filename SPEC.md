# 项目需求与技术规格书：Obsidian PocketAgent（移动端优先的 AI 对话与笔记 Agent 插件）

> **给 AI 编程助手的执行指令（Prompt）：**
> 请仔细阅读以下 `spec.md` 规格说明书，严格按照其中的架构设计、移动端技术限制和接口协议规范，完整实现该 Obsidian 插件的所有源码文件（包括 `manifest.json`、`package.json`、`tsconfig.json`、`esbuild.config.mjs`、`styles.css` 以及 `src/` 目录下的全部 TypeScript 模块）。请确保代码无任何 Node.js 原生依赖，能夠在 iOS / Android / 平板及桌面端的 Obsidian 中直接编译并正常运行。

---

## 1. 项目概述
- **插件 ID (id)**：`obsidian-pocket-agent`
- **插件名称 (name)**：`PocketAgent - 移动端 AI 与 OpenCode Go 助手`
- **目标平台**：手机端（iOS / Android）、平板端（iPad / Android Pad）以及桌面端（`manifest.json` 中必须设置 `"isDesktopOnly": false`）。
- **核心目标**：打造一款轻量、针对触控屏深度优化的 Obsidian AI 聊天与笔记库（Vault）智能体插件。原生攻克 **OpenCode Go 订阅接口**在移动端的调用难题（自动管理 `x-opencode-session` 请求头、自定义 `User-Agent`、绕过移动端 WebView CORS 跨域限制），同时兼容 DeepSeek 官方 API 等标准 OpenAI 格式接口。

---

## 2. 移动端技术红线与环境约束
1. **绝对零 Node.js / Electron 依赖**：
   - **严禁**引入 `fs`、`path`、`child_process`、`http`、`https`、`os`、`crypto` 等任何 Node.js 原生模块（因为 iOS 和 Android 的 Obsidian 运行在纯 WebView 沙盒中，引入即崩溃）。
   - 所有文件读写与检索必须使用 Obsidian 官方跨平台 API：`app.vault`、`app.metadataCache`、`normalizePath`。
   - 生成随机 Session ID 必须使用浏览器标准 Web Crypto API：`globalThis.crypto.getRandomValues`。
2. **网络请求与跨域（CORS）双模策略**：
   - **原生直连模式（OpenCode Go 默认模式）**：使用 Obsidian 内置的 `requestUrl` API 发起请求。该 API 走手机系统底层网络栈，**100% 无视 WebView 的 CORS 跨域预检拦截**，且允许自由注入 `x-opencode-session` 和 `User-Agent` 请求头，无需额外部署代理服务器即可直连官方接口。
   - **流式输出模式（SSE 可选模式）**：当用户使用支持 CORS 的接口（如 DeepSeek 官方 API）或配置了自定义 Cloudflare Worker 代理地址时，支持切换为标准 `fetch` + `ReadableStream` 解析 `data: ` 流，实现打字机逐字输出效果；若 `fetch` 遇到跨域或网络报错，自动降级回 `requestUrl` 模式。

---

## 3. 核心架构与目录结构
```text
obsidian-pocket-agent/
├── manifest.json          # 插件元数据（必须设置 "isDesktopOnly": false）
├── package.json           # 依赖配置（obsidian, esbuild, typescript）
├── tsconfig.json          # TypeScript 编译配置
├── esbuild.config.mjs     # 打包脚本，编译输出根目录的 main.js
├── styles.css             # 针对手机/平板触控屏优化的响应式样式（适配 .is-mobile, .is-tablet）
└── src/
    ├── main.ts            # 插件入口：生命周期管理、侧边栏图标、命令注册、视图挂载
    ├── types.ts           # 全局类型定义：设置项、消息结构、会话结构、服务商与工具 Schema
    ├── settings.ts        # 插件设置页（PluginSettingTab）：配置 API Key、模型列表、快捷指令
    ├── api/
    │   ├── session.ts     # OpenCode Go 专属 `ses_` + 32位十六进制 ID 生成器与会话绑定逻辑
    │   └── client.ts      # 统一网络客户端：处理 OpenCode Go 多协议路由与 DeepSeek 接口
    ├── agent/
    │   └── vaultTools.ts  # 笔记库工具调用（Function Calling）：搜索笔记、读取笔记、修改笔记
    └── ui/
        ├── ChatView.ts    # 核心聊天界面（继承 ItemView）：适配右侧边栏与移动端全屏抽屉
        └── DiffModal.ts   # 安全确认弹窗（继承 Modal）：AI 修改笔记前展示增删对比，确认后落盘
```

---

## 4. 核心功能模块详细规格

### 4.1 OpenCode Go 原生协议适配器 (`src/api/client.ts` & `src/api/session.ts`)
1. **`x-opencode-session` 生成与复用规则**：
   - **格式要求**：严格匹配正则 `^ses_[0-9a-f]{32}$`（即 `ses_` 前缀加上 32 位小写十六进制字符）。
   - **生成算法**：
     ```typescript
     export function generateOpenCodeSessionId(): string {
       const bytes = new Uint8Array(16);
       globalThis.crypto.getRandomValues(bytes);
       const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
       return `ses_${hex}`;
     }
     ```
   - **会话粘性（Session Stickiness）**：每个聊天窗口（`ChatSession`）在创建时生成一个专属的 `opencodeSessionId` 并持久化保存。**同一个对话窗口内的所有追问必须携带完全相同的 `x-opencode-session` 值**，以便服务端路由到同一计算节点并复用 KV 缓存；只有当用户点击“新建对话”或“清空上下文”时，才生成新的 `ses_...` ID。
2. **强制注入请求头**：
   每次向 OpenCode Go 发送请求时，必须携带以下 Headers：
   ```json
   {
     "Content-Type": "application/json",
     "Authorization": "Bearer <用户配置的_API_KEY>",
     "x-opencode-session": "<当前对话绑定的_SESSION_ID>",
     "User-Agent": "obsidian-pocket-agent/1.0.0"
   }
   ```
3. **多协议端点自动路由**：
   - OpenCode Go 默认基础地址（Base URL）：`https://opencode.ai/zen/go/v1`
   - 支持为不同模型指定协议类型（Protocol Type）：
     - `openai-chat`（默认）：POST 请求发往 `${baseUrl}/chat/completions`（适用于 DeepSeek、GLM、Qwen、Kimi 等模型）。
     - `anthropic-messages`：POST 请求发往 `${baseUrl}/messages`，并自动附加 `x-api-key` 与 `anthropic-version: 2023-06-01` 请求头（适用于 MiniMax 及 Claude 协议模型）。 - `openai-responses`：POST 请求发往 `${baseUrl}/responses`，请求体使用 `input` 字段（适用于仅支持 Responses 协议的特定模型）。

### 4.2 专为手机与平板优化的触控交互界面 (`src/ui/ChatView.ts` & `styles.css`)
1. **顶部导航栏（Top Bar）**：
   - **模型快速切换下拉框**：一键在已配置的 OpenCode Go 模型与 DeepSeek 官方模型之间切换。
   - **新建对话按钮 `[➕ 新对话]`**：保存当前对话记录，清空聊天视口，并生成全新的 `ses_...` 会话 ID。
   - **历史会话抽屉按钮 `[📂 历史]`**：弹出滑动列表，支持切换或删除过往保存的对话。
2. **上下文挂载与快捷指令栏（位于底部输入框正上方）**：
   - **当前笔记挂载开关 `[📄 附带当前笔记: 开/关]`**：专为移动端设计，开启后无需手打 `@文件名`，提问时自动获取当前激活的 Markdown 笔记（`app.workspace.getActiveViewOfType(MarkdownView)?.file`），将其标题和正文自动注入上下文。
   - **选中文本自动感知 `[✂️ 引用选中内容 (N字)]`**：当检测到用户在笔记编辑器中选中了文字时自动高亮显示，点击即可围绕选中文本提问或改写。
   - **横向滑动快捷指令胶囊（Quick Prompt Chips）**：在软键盘上方提供一排可横向滚动的胶囊按钮（默认内置：`✨ 润色选中`、`📝 总结全文`、`🔍 提炼待办`、`🇬🇧 翻译中英`、`💡 解释概念`），点击胶囊直接填入并发送，省去手机打字烦恼。
3. **AI 回复操作栏（每条 AI 消息气泡底部）**：
   - `[📋 复制]`：一键复制 Markdown 源码到剪贴板，弹出 `Notice("已复制")` 提示。
   - `[📥 插入光标处]`：将 AI 回复直接写回当前激活笔记的光标所在位置（若移动端失去光标焦点，则优雅降级为追加到当前笔记末尾）。
   - `[➕ 存为新笔记]`：将 AI 的回复内容一键保存为指定收集箱文件夹下的新 Markdown 笔记。
4. **移动端 CSS 触控人体工学 (`styles.css`)**：
   - 针对 Obsidian 移动端的 `.is-mobile` 和 `.is-tablet` 顶层类名做专门适配。
   - 所有可点击按钮、下拉框、胶囊开关的最小触控热区不小于 `44px × 44px`。
   - 底部输入区域使用 `padding-bottom: env(safe-area-inset-bottom)` 避开手机底部全面屏手势条，并确保软键盘弹出时输入框不被遮挡、消息列表平滑滚动到底部。

### 4.3 纯沙盒 Vault Agent 笔记工具调用 (`src/agent/vaultTools.ts`)
提供 `[🤖 笔记库 Agent 模式]` 开关。开启后，在请求体中附带标准 OpenAI `tools` JSON Schema，赋予 AI 检索与编辑笔记库的能力（全程仅用 Obsidian Vault API，无需本地 CLI）：
1. `search_vault_notes(query: string)`：遍历 `app.vault.getMarkdownFiles()`，匹配文件名与正文内容，返回相关性最高的前 5 篇笔记路径与摘要片段。
2. `read_note_content(path: string)`：通过 `app.vault.cachedRead()` 读取指定路径笔记的完整 Markdown 内容返回给大模型。
3. `propose_note_edit(path: string, content: string, mode: "append" | "overwrite")`：当 AI 想要修改或追加笔记内容时，**绝不直接静默修改文件**，而是触发弹出 `DiffModal` 对比确认窗口，展示变更前后的文本差异，用户点击 **[✅ 确认写入]** 后才调用 `app.vault.modify()` 或 `app.vault.append()`。

### 4.4 插件设置页 (`src/settings.ts`)
- **服务商配置（Providers）**：
  - **OpenCode Go 专区**：API Key 输入框、Base URL（默认 `https://opencode.ai/zen/go/v1`）、请求模式切换（`requestUrl 免跨域直连` / `fetch 流式输出`）、自定义模型列表管理（支持添加模型 ID、显示名称、协议类型）。
  - **DeepSeek / 自定义 OpenAI 专区**：API Key 输入框、Base URL（默认 `https://api.deepseek.com/v1`）、默认模型（`deepseek-chat`、`deepseek-reasoner`）。
- **全局系统提示词（System Prompt）**：自定义 AI 的默认角色与回复风格。
- **快捷指令胶囊管理**：允许用户自由增删改聊天框上方的快捷指令按钮。
- **会话存储路径**：设置历史聊天记录在笔记库中的保存位置（支持保存为 JSON 数据或 Markdown 笔记，默认路径为 `.obsidian/plugins/obsidian-pocket-agent/history`）。

---

## 5. 验收标准与测试清单
1. **OpenCode Go 移动端连通性**：在 Android / iOS / 平板端 Obsidian 中填入 OpenCode Go API Key 发送消息，不再出现 `400 Request is missing x-opencode-session` 或 CORS 跨域报错，正常返回 AI 回复。
2. **会话 ID 稳定性验证**：同一对话连续发送 3 条消息，请求头中的 `x-opencode-session` 保持一致；点击“新建对话”后，`x-opencode-session` 立即刷新为新的 32 位十六进制字符串。
3. **移动端交互体验**：在手机与平板上打开右侧边栏聊天窗口，界面无横向溢出，软键盘弹出时输入框贴合键盘上方，点击 `[📄 附带当前笔记]` 能准确读取当前笔记内容，点击 `[📥 插入光标处]` 能将回复写入笔记。