import { requestUrl } from "obsidian";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelConfig,
  ProtocolType,
  ProviderId,
  ToolCall,
  ToolDefinition,
} from "../types";
import { generateOpenCodeSessionId } from "./session";

/** OpenCode Go 默认 Base URL */
export const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
/** DeepSeek 默认 Base URL */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
/** OpenCode Go 强制 User-Agent */
export const POCKET_AGENT_USER_AGENT = "pocket-agent/1.0.0";
/** Anthropic 协议版本 */
const ANTHROPIC_VERSION = "2023-06-01";

/** 网络错误类型，区分是否允许降级到 requestUrl */
export class PocketAgentApiError extends Error {
  status?: number;
  body?: string;
  /** 是否允许自动降级为 requestUrl 直连（仅网络层错误允许） */
  fallbackAllowed: boolean;

  constructor(message: string, options: { status?: number; body?: string; fallbackAllowed?: boolean } = {}) {
    super(message);
    this.name = "PocketAgentApiError";
    this.status = options.status;
    this.body = options.body;
    this.fallbackAllowed = options.fallbackAllowed ?? false;
  }
}

/** 拼接协议端点 */
export function resolveEndpoint(baseUrl: string, protocol: ProtocolType): string {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  switch (protocol) {
    case "anthropic-messages":
      return `${base}/messages`;
    case "openai-responses":
      return `${base}/responses`;
    case "openai-chat":
    default:
      return `${base}/chat/completions`;
  }
}

/** 构造请求头（含 OpenCode Go 强制注入项） */
export function buildHeaders(req: CompletionRequest): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (req.model.provider === "opencode-go") {
    headers["Authorization"] = `Bearer ${req.apiKey}`;
    headers["x-opencode-session"] = req.sessionId || generateOpenCodeSessionId();
    headers["User-Agent"] = POCKET_AGENT_USER_AGENT;
  } else {
    headers["Authorization"] = `Bearer ${req.apiKey}`;
  }

  if (req.model.protocol === "anthropic-messages") {
    headers["x-api-key"] = req.apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }

  return headers;
}

/** 将工具定义转换为 Anthropic 格式 */
function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

/** 将工具定义转换为 Responses API 格式 */
function toResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

/** 安全解析工具参数 JSON */
function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 构造 OpenAI Chat Completions 消息体 */
function toOpenAIMessages(messages: ChatMessage[], systemPrompt: string): unknown[] {
  const result: unknown[] = [];
  if (systemPrompt.trim()) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      result.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }

  return result;
}

/** 构造 Anthropic Messages 请求体（合并连续同角色消息） */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  type Block = Record<string, unknown>;
  interface AnthMessage {
    role: "user" | "assistant";
    content: string | Block[];
  }

  const raw: AnthMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      raw.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Block[] = [];
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeParseArguments(call.arguments),
        });
      }
      raw.push({
        role: "assistant",
        content: blocks.length === 1 && blocks[0].type === "text" ? message.content : blocks,
      });
      continue;
    }

    raw.push({ role: "user", content: message.content });
  }

  // Anthropic 要求 user/assistant 交替，合并连续同角色消息
  const merged: AnthMessage[] = [];
  for (const message of raw) {
    const previous = merged[merged.length - 1];
    if (!previous || previous.role !== message.role) {
      merged.push({
        role: message.role,
        content: Array.isArray(message.content) ? [...message.content] : message.content,
      });
      continue;
    }
    const previousBlocks: Block[] =
      typeof previous.content === "string"
        ? previous.content.trim()
          ? [{ type: "text", text: previous.content }]
          : []
        : previous.content;
    const nextBlocks: Block[] =
      typeof message.content === "string"
        ? message.content.trim()
          ? [{ type: "text", text: message.content }]
          : []
        : message.content;
    previous.content = [...previousBlocks, ...nextBlocks];
  }

  if (merged.length === 0) {
    merged.push({ role: "user", content: "" });
  }

  return merged;
}

/** 构造 Responses API 输入数组 */
function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content.trim()) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

/** 构造请求体 */
function buildBody(req: CompletionRequest, stream: boolean): unknown {
  const protocol = req.model.protocol;
  const temperature = req.model.supportsTemperature === false ? {} : { temperature: req.temperature };

  if (protocol === "anthropic-messages") {
    return {
      model: req.model.id,
      max_tokens: Math.max(1, req.maxTokens),
      ...temperature,
      ...(req.systemPrompt.trim() ? { system: req.systemPrompt } : {}),
      messages: toAnthropicMessages(req.messages),
      ...(req.tools?.length ? { tools: toAnthropicTools(req.tools) } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  if (protocol === "openai-responses") {
    return {
      model: req.model.id,
      input: toResponsesInput(req.messages),
      ...(req.systemPrompt.trim() ? { instructions: req.systemPrompt } : {}),
      ...temperature,
      max_output_tokens: Math.max(1, req.maxTokens),
      ...(req.tools?.length ? { tools: toResponsesTools(req.tools), tool_choice: "auto" } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  return {
    model: req.model.id,
    messages: toOpenAIMessages(req.messages, req.systemPrompt),
    ...temperature,
    max_tokens: Math.max(1, req.maxTokens),
    ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** 将可能为数组/字符串/对象的内容统一为文本 */
function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

/** 解析非流式响应 */
export function parseCompletionResponse(protocol: ProtocolType, data: unknown): CompletionResult {
  const root = (data ?? {}) as Record<string, unknown>;

  if (protocol === "anthropic-messages") {
    const blocks = Array.isArray(root.content) ? (root.content as Array<Record<string, unknown>>) : [];
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `tool_${toolCalls.length}`,
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return { content, toolCalls, raw: data };
  }

  if (protocol === "openai-responses") {
    const output = Array.isArray(root.output) ? (root.output as Array<Record<string, unknown>>) : [];
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const item of output) {
      if (item.type === "message") {
        content += coerceText(item.content);
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "",
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        });
      }
    }
    if (!content && typeof root.output_text === "string") {
      content = root.output_text;
    }
    return { content, toolCalls, raw: data };
  }

  const choices = Array.isArray(root.choices) ? (root.choices as Array<Record<string, unknown>>) : [];
  const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
  const content = coerceText(message.content);
  const toolCalls: ToolCall[] = [];
  const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  for (const call of rawCalls) {
    const fn = (call.function ?? {}) as Record<string, unknown>;
    toolCalls.push({
      id: typeof call.id === "string" ? call.id : `tool_${toolCalls.length}`,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return { content, toolCalls, raw: data };
}

/** 解析服务端错误响应，尽量把原始 message 暴露给用户 */
export function describeApiFailure(status: number, rawBody: string): string {
  const raw = (rawBody || "").trim();
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const envelope =
      parsed && typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : parsed;
    if (typeof parsed.error === "string") {
      detail = parsed.error;
    } else if (envelope && typeof envelope === "object") {
      const parts = [envelope.message, envelope.type, envelope.param, envelope.code]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .filter((part, index, all) => all.indexOf(part) === index);
      detail = parts.join(" · ");
    }
  } catch {
    detail = raw;
  }
  if (!detail) detail = raw;
  const clipped = detail.replace(/\s+/g, " ").trim().slice(0, 600);
  return `请求失败（HTTP ${status}）${clipped ? `：${clipped}` : ""}`;
}

/** 通过 Obsidian requestUrl 发起非流式请求（免 CORS，移动端默认） */
async function completeWithRequestUrl(req: CompletionRequest): Promise<CompletionResult> {
  const url = resolveEndpoint(req.baseUrl, req.model.protocol);
  const headers = buildHeaders(req);
  const body = buildBody(req, false);

  const response = await requestUrl({
    url,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new PocketAgentApiError(describeApiFailure(response.status, response.text), {
      status: response.status,
      body: response.text,
      fallbackAllowed: false,
    });
  }

  let data: unknown;
  try {
    data = response.json;
  } catch {
    data = JSON.parse(response.text);
  }

  const result = parseCompletionResponse(req.model.protocol, data);
  if (!result.content && result.toolCalls.length === 0) {
    throw new PocketAgentApiError("模型返回了空内容。", { status: response.status, body: response.text });
  }
  return result;
}

/** 增量累积器：兼容 OpenAI / Anthropic / Responses 三种流式协议 */
class StreamAccumulator {
  content = "";
  private openaiCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private anthropicCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private responsesCalls = new Map<string, { callId: string; name: string; arguments: string }>();
  private currentAnthropicIndex = -1;

  feedOpenAIChoice(delta: Record<string, unknown>): void {
    const text = coerceText(delta.content);
    if (text) {
      this.content += text;
      this.onDelta?.(text);
    }
    const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    for (const call of calls) {
      const index = typeof call.index === "number" ? call.index : this.openaiCalls.size;
      const entry = this.openaiCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string" && call.id) entry.id = call.id;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name === "string" && fn.name) entry.name = fn.name;
      if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
      this.openaiCalls.set(index, entry);
    }
  }

  setAnthropicIndex(index: number): void {
    this.currentAnthropicIndex = index;
  }

  feedAnthropicBlockStart(index: number, block: Record<string, unknown>): void {
    this.currentAnthropicIndex = index;
    if (block.type !== "tool_use") return;
    this.anthropicCalls.set(index, {
      id: typeof block.id === "string" ? block.id : `tool_${index}`,
      name: typeof block.name === "string" ? block.name : "",
      arguments: "",
    });
  }

  feedAnthropicDelta(delta: Record<string, unknown>): void {
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.content += delta.text;
      this.onDelta?.(delta.text);
      return;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const entry = this.anthropicCalls.get(this.currentAnthropicIndex);
      if (entry) entry.arguments += delta.partial_json;
    }
  }

  feedResponsesEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      this.content += event.delta;
      this.onDelta?.(event.delta);
      return;
    }
    if (type === "response.output_item.added") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      const key = typeof item.id === "string" ? item.id : `item_${this.responsesCalls.size}`;
      if (item.type === "function_call") {
        this.responsesCalls.set(key, {
          callId: typeof item.call_id === "string" ? item.call_id : key,
          name: typeof item.name === "string" ? item.name : "",
          arguments: "",
        });
      }
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const key = typeof event.item_id === "string" ? event.item_id : "";
      const entry = this.responsesCalls.get(key);
      if (entry && typeof event.delta === "string") entry.arguments += event.delta;
    }
  }

  mergeFinal(final: CompletionResult): CompletionResult {
    // 流式文本为空时用最终响应兜底，工具调用以最终响应为准
    const content = this.content || final.content;
    const toolCalls: ToolCall[] = final.toolCalls.length
      ? final.toolCalls
      : this.openaiCalls.size
        ? Array.from(this.openaiCalls.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, value], index) => ({
              id: value.id || `tool_${index}`,
              name: value.name,
              arguments: value.arguments || "{}",
            }))
        : this.anthropicCalls.size
          ? Array.from(this.anthropicCalls.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, value], index) => ({
                id: value.id || `tool_${index}`,
                name: value.name,
                arguments: value.arguments || "{}",
              }))
          : Array.from(this.responsesCalls.values()).map((value, index) => ({
              id: value.callId || `tool_${index}`,
              name: value.name,
              arguments: value.arguments || "{}",
            }));
    return { content, toolCalls, raw: final.raw };
  }

  onDelta?: (delta: string) => void;

  setOnDelta(callback?: (delta: string) => void): void {
    this.onDelta = callback;
  }

  get hasToolCalls(): boolean {
    return this.openaiCalls.size > 0 || this.anthropicCalls.size > 0 || this.responsesCalls.size > 0;
  }
}

/** 读取并逐行解析 SSE 数据流 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  protocol: ProtocolType,
  accumulator: StreamAccumulator
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const handleData = (payload: string): boolean => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return trimmed === "[DONE]";
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }
    const record = (parsed ?? {}) as Record<string, unknown>;

    if (protocol === "anthropic-messages") {
      const type = record.type;
      if (type === "content_block_start") {
        const index = typeof record.index === "number" ? record.index : -1;
        accumulator.feedAnthropicBlockStart(index, (record.content_block ?? {}) as Record<string, unknown>);
      } else if (type === "content_block_delta") {
        accumulator.setAnthropicIndex(typeof record.index === "number" ? record.index : -1);
        accumulator.feedAnthropicDelta((record.delta ?? {}) as Record<string, unknown>);
      }
      return false;
    }

    if (protocol === "openai-responses") {
      accumulator.feedResponsesEvent(record);
      return record.type === "response.completed";
    }

    const choices = Array.isArray(record.choices) ? (record.choices as Array<Record<string, unknown>>) : [];
    const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
    accumulator.feedOpenAIChoice(delta);
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreakIndex = buffer.indexOf("\n");
      while (lineBreakIndex >= 0) {
        const line = buffer.slice(0, lineBreakIndex).replace(/\r$/, "");
        buffer = buffer.slice(lineBreakIndex + 1);
        if (line.startsWith("data:")) {
          const isDone = handleData(line.slice(5));
          if (isDone) {
            buffer = "";
            return;
          }
        }
        lineBreakIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim().startsWith("data:")) {
      handleData(buffer.trim().slice(5));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/** 通过 fetch + ReadableStream 发起流式请求（需目标接口支持 CORS） */
async function completeWithFetch(req: CompletionRequest, stream: boolean): Promise<CompletionResult> {
  const url = resolveEndpoint(req.baseUrl, req.model.protocol);
  const headers = buildHeaders(req);
  const body = buildBody(req, stream);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (error) {
    if (req.signal?.aborted) throw error;
    throw new PocketAgentApiError(
      `fetch 请求失败：${error instanceof Error ? error.message : String(error)}，将自动降级为 requestUrl 直连。`,
      { fallbackAllowed: true }
    );
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      /* noop */
    }
    throw new PocketAgentApiError(describeApiFailure(response.status, text), {
      status: response.status,
      body: text,
      fallbackAllowed: false,
    });
  }

  if (!stream || !response.body) {
    const data = (await response.json()) as unknown;
    const result = parseCompletionResponse(req.model.protocol, data);
    if (!result.content && result.toolCalls.length === 0) {
      throw new PocketAgentApiError("模型返回了空内容。", { body: JSON.stringify(data).slice(0, 500) });
    }
    if (stream && result.content) req.onDelta?.(result.content);
    return result;
  }

  const accumulator = new StreamAccumulator();
  accumulator.setOnDelta(req.onDelta);
  await consumeSse(response.body, req.model.protocol, accumulator);

  // 流结束时优先用已累积内容；若完全为空则视为流式解析失败，交由上层降级
  if (!accumulator.content && !accumulator.hasToolCalls) {
    throw new PocketAgentApiError("流式响应为空，将自动降级为 requestUrl 直连。", { fallbackAllowed: true });
  }

  return accumulator.mergeFinal({ content: "", toolCalls: [] });
}

/** 统一网络客户端：OpenCode Go 多协议路由 + DeepSeek / OpenAI 兼容接口 */
export class PocketAgentClient {
  /**
   * 发送一次补全请求。
   * requestMode === "fetch" 时优先流式输出，网络层失败自动降级为 requestUrl。
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!req.apiKey.trim()) {
      throw new PocketAgentApiError("尚未配置 API Key，请前往插件设置填写。");
    }
    if (!req.model?.id) {
      throw new PocketAgentApiError("尚未选择模型，请先在聊天窗口顶部选择模型。");
    }

    if (req.requestMode === "fetch") {
      try {
        return await completeWithFetch(req, Boolean(req.onDelta));
      } catch (error) {
        if (req.signal?.aborted) throw error;
        const fallbackAllowed = error instanceof PocketAgentApiError ? error.fallbackAllowed : true;
        if (!fallbackAllowed) throw error;
        return completeWithRequestUrl(req);
      }
    }

    return completeWithRequestUrl(req);
  }
}

/** 获取模型对应的 API Key 与 Base URL（供 UI 调用） */export function resolveProviderCredentials(
  model: ModelConfig,
  settings: {
    opencodeApiKey: string;
    opencodeBaseUrl: string;
    deepseekApiKey: string;
    deepseekBaseUrl: string;
  }
): { apiKey: string; baseUrl: string } {
  if (model.provider === "opencode-go") {
    return { apiKey: settings.opencodeApiKey, baseUrl: settings.opencodeBaseUrl || OPENCODE_DEFAULT_BASE_URL };
  }
  return { apiKey: settings.deepseekApiKey, baseUrl: settings.deepseekBaseUrl || DEEPSEEK_DEFAULT_BASE_URL };
}

/** 请求模式映射（供 UI / 设置页调用） */
export function resolveRequestMode(
  model: ModelConfig,
  settings: { opencodeRequestMode: "requestUrl" | "fetch" }
): "requestUrl" | "fetch" {
  return model.provider === "opencode-go" ? settings.opencodeRequestMode : "fetch";
}

/** `/models` 返回的模型信息 */
export interface RemoteModelInfo {
  id: string;
  name: string;
  protocol: ProtocolType;
  supportsTemperature: boolean;
}

/** 已知拒绝 temperature 参数的模型 */
const NO_TEMPERATURE_MODEL_IDS = new Set([
  "claude-haiku-5-5",
  "kimi-k3",
  "kimi-k3.1-pro",
  "kimi-k2.7-code",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gemini-4-argon",
]);

/** 根据模型 ID 推断协议（仅用于自动补全，用户可在设置页修改） */
export function inferProtocolFromId(id: string, provider: ProviderId): ProtocolType {
  if (provider === "deepseek") return "openai-chat";
  if (id === "minimax-m3" || id.startsWith("claude-") || id.startsWith("qwen3.7") || id.startsWith("qwen3.8")) {
    return "anthropic-messages";
  }
  if (
    id.startsWith("gpt-5") ||
    id.startsWith("gpt-6") ||
    id.startsWith("grok-") ||
    id.startsWith("muse-spark") ||
    id.startsWith("crouton-")
  ) {
    return "openai-responses";
  }
  return "openai-chat";
}

/** 把模型 ID 转成可读名称 */
function prettifyModelName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** 从 /models 响应中读取协议（如果服务端提供了元数据） */
function readProtocolHint(item: Record<string, unknown>): ProtocolType | null {
  const candidates = [item.protocol, item.api, item.type].filter((value): value is string => typeof value === "string");
  for (const value of candidates) {
    const lower = value.toLowerCase();
    if (lower.includes("anthropic")) return "anthropic-messages";
    if (lower.includes("responses")) return "openai-responses";
    if (lower.includes("chat")) return "openai-chat";
  }
  return null;
}

/**
 * 通过 GET {baseUrl}/models 获取服务商当前可用的模型列表。
 * OpenCode Go 的 /models 是公开接口，但仍会带上 API Key 与会话头。
 */
export async function fetchProviderModels(options: {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  sessionId?: string;
}): Promise<RemoteModelInfo[]> {
  const base = (options.baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new PocketAgentApiError("尚未配置 Base URL。");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;
  if (options.provider === "opencode-go") {
    headers["x-opencode-session"] = options.sessionId || generateOpenCodeSessionId();
    headers["User-Agent"] = POCKET_AGENT_USER_AGENT;
  }

  const response = await requestUrl({
    url: `${base}/models`,
    method: "GET",
    headers,
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new PocketAgentApiError(describeApiFailure(response.status, response.text), {
      status: response.status,
      body: response.text,
    });
  }

  let data: unknown;
  try {
    data = response.json;
  } catch {
    data = JSON.parse(response.text);
  }

  const root = (data ?? {}) as Record<string, unknown>;
  const rawList = Array.isArray(root.data)
    ? (root.data as unknown[])
    : Array.isArray(root.models)
      ? (root.models as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : [];

  const models: RemoteModelInfo[] = [];
  for (const entry of rawList) {
    if (typeof entry === "string") {
      models.push({
        id: entry,
        name: prettifyModelName(entry),
        protocol: inferProtocolFromId(entry, options.provider),
        supportsTemperature: !NO_TEMPERATURE_MODEL_IDS.has(entry),
      });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
    if (!id) continue;

    const displayName =
      (typeof item.display_name === "string" && item.display_name) ||
      (typeof item.displayName === "string" && item.displayName) ||
      prettifyModelName(id);

    const capabilities =
      item.capabilities && typeof item.capabilities === "object"
        ? (item.capabilities as Record<string, unknown>)
        : {};

    const supportsTemperature =
      !NO_TEMPERATURE_MODEL_IDS.has(id) &&
      item.temperature !== false &&
      item.supports_temperature !== false &&
      capabilities.temperature !== false;

    models.push({
      id,
      name: displayName,
      protocol: readProtocolHint(item) ?? inferProtocolFromId(id, options.provider),
      supportsTemperature,
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}
