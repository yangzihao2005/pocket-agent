import type { ChatSession } from "../types";

/**
 * OpenCode Go 会话 ID 正则：ses_ 前缀 + 32 位小写十六进制字符。
 */
export const OPENCODE_SESSION_PATTERN = /^ses_[0-9a-f]{32}$/;

/**
 * 使用浏览器标准 Web Crypto API 生成 OpenCode Go 会话 ID。
 * 绝对不依赖 Node.js crypto 模块，保证移动端沙盒可用。
 */
export function generateOpenCodeSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ses_${hex}`;
}

/**
 * 校验一个字符串是否符合 OpenCode Go 会话 ID 格式。
 */
export function isValidOpenCodeSessionId(value: string | null | undefined): boolean {
  return typeof value === "string" && OPENCODE_SESSION_PATTERN.test(value);
}

/**
 * 生成带前缀的本地唯一 ID（不依赖 Node.js crypto）。
 */
export function createLocalId(prefix = "id"): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/**
 * 确保会话拥有合法且稳定的 OpenCode Go 会话 ID。
 * 已存在合法 ID 时原样返回（会话粘性），否则生成新的 ID 并写回。
 */
export function ensureSessionId(session: ChatSession): string {
  if (!isValidOpenCodeSessionId(session.opencodeSessionId)) {
    session.opencodeSessionId = generateOpenCodeSessionId();
  }
  return session.opencodeSessionId;
}

/**
 * 创建一个全新的聊天会话。仅在“新建对话”或“清空上下文”时调用。
 */
export function createChatSession(modelId: string, title = "新对话"): ChatSession {
  const now = Date.now();
  return {
    id: createLocalId("chat"),
    opencodeSessionId: generateOpenCodeSessionId(),
    title,
    modelId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 清空会话上下文并刷新 OpenCode Go 会话 ID。
 */
export function resetChatSession(session: ChatSession): ChatSession {
  session.messages = [];
  session.opencodeSessionId = generateOpenCodeSessionId();
  session.updatedAt = Date.now();
  return session;
}

/**
 * 将任意字符串规整为可用于标题的短文本。
 */
export function deriveSessionTitle(text: string, fallback = "新对话"): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
}
