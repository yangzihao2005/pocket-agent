/**
 * 全局类型定义：设置项、消息结构、会话结构、服务商与工具 Schema。
 * 本文件不依赖任何 Node.js 原生模块，可在 iOS / Android WebView 沙盒中安全使用。
 */

/** 服务商标识 */
export type ProviderId = "opencode-go" | "deepseek";

/** 协议类型 */
export type ProtocolType = "openai-chat" | "anthropic-messages" | "openai-responses";

/** 网络请求模式：requestUrl 免跨域直连 / fetch 流式输出 */
export type RequestMode = "requestUrl" | "fetch";

/** 历史记录保存格式 */
export type HistoryFormat = "json" | "markdown";

/** 单个模型配置 */
export interface ModelConfig {
  /** 模型 ID，例如 deepseek-v4.1-flash */
  id: string;
  /** 展示名称 */
  name: string;
  /** 所属服务商 */
  provider: ProviderId;
  /** 协议类型 */
  protocol: ProtocolType;
  /** 是否启用 */
  enabled: boolean;
  /**
   * 是否允许发送 temperature 参数。
   * 部分模型（如 Claude Haiku、Kimi K2.7、GPT Luna 系列）会因 temperature 直接返回 400，
   * 省略该字段时默认视为支持。
   */
  supportsTemperature?: boolean;
}

/** 快捷指令胶囊 */
export interface QuickPrompt {
  id: string;
  /** 胶囊按钮文字，例如 "✨ 润色选中" */
  label: string;
  /** 发送给模型的提示词模板，可使用 {{selection}} 与 {{note}} 占位符 */
  prompt: string;
}

/** 插件设置 */
export interface PocketAgentSettings {
  /** OpenCode Go API Key */
  opencodeApiKey: string;
  /** OpenCode Go Base URL */
  opencodeBaseUrl: string;
  /** OpenCode Go 请求模式 */
  opencodeRequestMode: RequestMode;
  /** OpenCode Go 模型列表 */
  opencodeModels: ModelConfig[];
  /** DeepSeek / 自定义 OpenAI API Key */
  deepseekApiKey: string;
  /** DeepSeek / 自定义 OpenAI Base URL */
  deepseekBaseUrl: string;
  /** DeepSeek / 自定义 OpenAI 模型列表 */
  deepseekModels: ModelConfig[];
  /** 当前选中的模型，格式 "provider:modelId" */
  selectedModelId: string;
  /** 全局系统提示词 */
  systemPrompt: string;
  /** 快捷指令列表 */
  quickPrompts: QuickPrompt[];
  /** 会话存储文件夹（相对 Vault 根目录） */
  historyFolder: string;
  /** 会话保存格式 */
  historyFormat: HistoryFormat;
  /** 最多保留的历史会话数量 */
  maxHistorySessions: number;
  /** 是否默认开启笔记库 Agent 模式 */
  agentMode: boolean;
  /** 采样温度 */
  temperature: number;
  /** 是否默认附带当前笔记 */
  attachCurrentNote: boolean;
  /** 单次回复最大 token 数 */
  maxTokens: number;
  /** 设置结构版本，用于旧版本配置迁移 */
  schemaVersion?: number;
}

/** 消息角色 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 工具调用（由模型返回） */
export interface ToolCall {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 原始 JSON 字符串参数 */
  arguments: string;
}

/** 聊天消息 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** assistant 消息可能携带的工具调用 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时对应的调用 ID */
  toolCallId?: string;
  /** role === "tool" 时的工具名称 */
  name?: string;
  /** 工具执行是否出错 */
  isError?: boolean;
  /** 是否正在流式生成中 */
  streaming?: boolean;
}

/** 聊天会话（同一窗口内 opencodeSessionId 保持不变） */
export interface ChatSession {
  /** 本地会话 ID */
  id: string;
  /** OpenCode Go 会话 ID，格式 ^ses_[0-9a-f]{32}$ */
  opencodeSessionId: string;
  /** 会话标题 */
  title: string;
  /** 使用的模型，格式 "provider:modelId" */
  modelId: string;
  /** 消息列表 */
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 附带的笔记上下文 */
export interface NoteContext {
  path: string;
  title: string;
  content: string;
}

/** 用户选中的文本上下文 */
export interface SelectionContext {
  text: string;
}

/** JSON Schema 属性定义 */
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
}

/** 工具 JSON Schema */
export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 工具定义（标准 OpenAI function calling 格式） */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  /** 返回给模型的文本 */
  content: string;
  /** 是否执行失败 */
  isError: boolean;
}

/** 笔记编辑确认请求（供 DiffModal 展示） */
export interface VaultEditRequest {
  path: string;
  oldContent: string;
  newContent: string;
  mode: "append" | "overwrite";
}

/** 单次补全请求参数 */
export interface CompletionRequest {
  model: ModelConfig;
  apiKey: string;
  baseUrl: string;
  requestMode: RequestMode;
  messages: ChatMessage[];
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  tools?: ToolDefinition[];
  /** OpenCode Go 会话 ID */
  sessionId?: string;
  /** 流式增量回调 */
  onDelta?: (delta: string) => void;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** 单次补全结果 */
export interface CompletionResult {
  /** 助手文本内容 */
  content: string;
  /** 模型请求的工具调用 */
  toolCalls: ToolCall[];
  /** 原始响应（调试用） */
  raw?: unknown;
}

/** 历史会话索引项 */
export interface HistorySessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/** 网络请求公共头部 */
export interface RequestHeaders {
  [key: string]: string;
}
