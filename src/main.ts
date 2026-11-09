import { Notice, Plugin, normalizePath } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { PocketAgentClient } from "./api/client";
import { DEFAULT_SETTINGS, PocketAgentSettingTab } from "./settings";
import type {
  ChatMessage,
  ChatSession,
  HistorySessionSummary,
  ModelConfig,
  PocketAgentSettings,
} from "./types";
import { ChatView, VIEW_TYPE_POCKET_AGENT } from "./ui/ChatView";

/** 聊天视图暴露的少量能力，供插件入口调用（避免依赖视图内部实现） */
interface ChatViewLike {
  focusInput?: () => void;
  newSession?: () => Promise<void> | void;
}

/** 历史记录存储接口（全部通过 Vault Adapter，零 Node.js 原生模块） */
export interface HistoryStore {
  list(): Promise<HistorySessionSummary[]>;
  load(id: string): Promise<ChatSession | null>;
  save(session: ChatSession): Promise<void>;
  remove(id: string): Promise<void>;
  latest(): Promise<ChatSession | null>;
}

/** 默认历史目录（与 DEFAULT_SETTINGS 保持一致，作为设置缺失时的兜底） */
const FALLBACK_HISTORY_FOLDER = ".obsidian/plugins/pocket-agent/history";
/** 默认最多保留会话数 */
const FALLBACK_MAX_SESSIONS = 50;
/** 合法会话 ID：只允许安全字符，防止路径穿越 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 消息角色中文标题 */
const ROLE_LABELS: Record<ChatMessage["role"], string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
};

/** 时间戳转可读字符串 */
function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "未知";
  try {
    return new Date(value).toISOString();
  } catch {
    return "未知";
  }
}

/** 生成会话的可读 Markdown 文本（供 historyFormat === "markdown" 时导出） */
function renderTranscript(session: ChatSession): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || "未命名对话"}`, "");
  lines.push(`- 模型：${session.modelId || "未知"}`);
  lines.push(`- 创建时间：${formatTimestamp(session.createdAt)}`);
  lines.push(`- 更新时间：${formatTimestamp(session.updatedAt)}`);
  lines.push("");

  for (const message of session.messages) {
    const hasContent = typeof message.content === "string" && message.content.trim().length > 0;
    const toolCalls = message.toolCalls ?? [];
    if (!hasContent && toolCalls.length === 0) continue;

    lines.push(`## ${ROLE_LABELS[message.role] ?? message.role}`);
    if (hasContent) {
      lines.push("", message.content.trim());
    }
    for (const call of toolCalls) {
      lines.push("", `> 工具调用：${call.name || "未知工具"} ${call.arguments || ""}`.trimEnd());
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** 基于 Vault Adapter 的文件历史存储 */
class FileHistoryStore implements HistoryStore {
  constructor(private readonly plugin: PocketAgentPlugin) {}

  /** 当前生效的历史目录（归一化后，无首尾斜杠） */
  private getFolder(): string {
    const configured = (this.plugin.settings?.historyFolder ?? "").trim();
    const raw = configured || FALLBACK_HISTORY_FOLDER;
    const trimmed = raw.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
    if (!trimmed) return "";
    const normalized = normalizePath(trimmed);
    return normalized === "/" || normalized === "." ? "" : normalized;
  }

  /** 最多保留的会话数量 */
  private getMaxSessions(): number {
    const raw = Number(this.plugin.settings?.maxHistorySessions);
    if (!Number.isFinite(raw) || raw <= 0) return FALLBACK_MAX_SESSIONS;
    return Math.max(1, Math.floor(raw));
  }

  /** 过滤不安全 ID，防止路径穿越 */
  private safeId(id: string): string {
    const value = typeof id === "string" ? id.trim() : "";
    return SAFE_ID_PATTERN.test(value) ? value : "";
  }

  private sessionUpdatedAt(session: ChatSession): number {
    if (Number.isFinite(session.updatedAt) && session.updatedAt > 0) return session.updatedAt;
    if (Number.isFinite(session.createdAt) && session.createdAt > 0) return session.createdAt;
    return 0;
  }

  /** 逐级创建目录，兼容不支持自动创建父目录的实现 */
  private async ensureFolder(folder: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    let current = "";
    for (const segment of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (await adapter.exists(current)) continue;
      try {
        await adapter.mkdir(current);
      } catch {
        // 并发或已存在时忽略
      }
    }
  }

  /** 安全读取并规整单个会话文件 */
  private async readSession(path: string): Promise<ChatSession | null> {
    try {
      const raw = await this.plugin.app.vault.adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const candidate = parsed as Partial<ChatSession>;
      if (typeof candidate.id !== "string" || !SAFE_ID_PATTERN.test(candidate.id)) return null;

      // 以文件名为准，保证 id 与实际存储路径始终一致
      const fileName = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
      const id = SAFE_ID_PATTERN.test(fileName) ? fileName : candidate.id;

      const now = Date.now();
      return {
        id,
        opencodeSessionId:
          typeof candidate.opencodeSessionId === "string" ? candidate.opencodeSessionId : "",
        title:
          typeof candidate.title === "string" && candidate.title.trim()
            ? candidate.title
            : "未命名对话",
        modelId: typeof candidate.modelId === "string" ? candidate.modelId : "",
        messages: Array.isArray(candidate.messages) ? (candidate.messages as ChatMessage[]) : [],
        createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
        updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now,
      };
    } catch {
      return null;
    }
  }

  /** 读取目录内全部会话，按更新时间倒序 */
  private async collectSessions(folder: string): Promise<ChatSession[]> {
    const adapter = this.plugin.app.vault.adapter;
    let files: string[] = [];
    try {
      const listing = await adapter.list(folder);
      files = listing.files ?? [];
    } catch {
      return [];
    }

    const sessions: ChatSession[] = [];
    for (const file of files) {
      if (!/\.json$/i.test(file)) continue;
      const session = await this.readSession(file);
      if (session) sessions.push(session);
    }

    sessions.sort((a, b) => this.sessionUpdatedAt(b) - this.sessionUpdatedAt(a));
    return sessions;
  }

  /** 删除会话的 json 与同名 md */
  private async deleteFiles(id: string): Promise<void> {
    const safe = this.safeId(id);
    const folder = this.getFolder();
    if (!safe || !folder) return;

    const adapter = this.plugin.app.vault.adapter;
    for (const extension of ["json", "md"]) {
      const path = `${folder}/${safe}.${extension}`;
      try {
        if (await adapter.exists(path)) {
          await adapter.remove(path);
        }
      } catch {
        // 删除失败不影响主流程
      }
    }
  }

  /** 超出上限时按更新时间裁剪最旧的会话 */
  private async prune(folder: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    let count = 0;
    try {
      const listing = await adapter.list(folder);
      count = (listing.files ?? []).filter((file) => /\.json$/i.test(file)).length;
    } catch {
      return;
    }

    const max = this.getMaxSessions();
    if (count <= max) return;

    const sessions = await this.collectSessions(folder);
    for (const session of sessions.slice(max)) {
      await this.deleteFiles(session.id);
    }
  }

  async list(): Promise<HistorySessionSummary[]> {
    const folder = this.getFolder();
    if (!folder) return [];

    const sessions = await this.collectSessions(folder);
    const max = this.getMaxSessions();
    for (const session of sessions.slice(max)) {
      await this.deleteFiles(session.id);
    }

    return sessions.slice(0, max).map((session) => ({
      id: session.id,
      title: session.title || "未命名对话",
      updatedAt: this.sessionUpdatedAt(session),
    }));
  }

  async load(id: string): Promise<ChatSession | null> {
    const safe = this.safeId(id);
    const folder = this.getFolder();
    if (!safe || !folder) return null;
    return this.readSession(`${folder}/${safe}.json`);
  }

  async save(session: ChatSession): Promise<void> {
    const safe = this.safeId(session.id);
    const folder = this.getFolder();
    if (!safe || !folder) return;

    await this.ensureFolder(folder);

    session.updatedAt = Date.now();
    if (!session.title || !session.title.trim()) {
      session.title = "未命名对话";
    }

    const adapter = this.plugin.app.vault.adapter;
    await adapter.write(`${folder}/${safe}.json`, JSON.stringify(session, null, 2));

    if (this.plugin.settings?.historyFormat === "markdown") {
      await adapter.write(`${folder}/${safe}.md`, renderTranscript(session));
    }

    await this.prune(folder);
  }

  async remove(id: string): Promise<void> {
    await this.deleteFiles(id);
  }

  async latest(): Promise<ChatSession | null> {
    const folder = this.getFolder();
    if (!folder) return null;
    const sessions = await this.collectSessions(folder);
    return sessions.length > 0 ? sessions[0] : null;
  }
}

/** PocketAgent 插件入口 */
export default class PocketAgentPlugin extends Plugin {
  settings!: PocketAgentSettings;
  client!: PocketAgentClient;
  history!: HistoryStore;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.client = new PocketAgentClient();
    this.history = new FileHistoryStore(this);

    this.registerView(VIEW_TYPE_POCKET_AGENT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "PocketAgent 聊天", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-chat",
      name: "打开 PocketAgent 聊天",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "new-chat",
      name: "新建 PocketAgent 对话",
      callback: () => {
        void this.startNewChat();
      },
    });

    this.addCommand({
      id: "toggle-agent-mode",
      name: "切换笔记库 Agent 模式",
      callback: () => {
        void this.toggleAgentMode();
      },
    });

    this.addSettingTab(new PocketAgentSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_POCKET_AGENT);
  }

  /** 读取设置并与默认值合并 */
  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PocketAgentSettings> | null;
    const merged: PocketAgentSettings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };

    this.settings = {
      ...merged,
      opencodeModels: Array.isArray(merged.opencodeModels)
        ? merged.opencodeModels.map((model) => ({ ...model }))
        : DEFAULT_SETTINGS.opencodeModels.map((model) => ({ ...model })),
      deepseekModels: Array.isArray(merged.deepseekModels)
        ? merged.deepseekModels.map((model) => ({ ...model }))
        : DEFAULT_SETTINGS.deepseekModels.map((model) => ({ ...model })),
      quickPrompts: Array.isArray(merged.quickPrompts)
        ? merged.quickPrompts.map((prompt) => ({ ...prompt }))
        : DEFAULT_SETTINGS.quickPrompts.map((prompt) => ({ ...prompt })),
    };
  }

  /** 合并默认设置并落盘 */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 所有启用中的模型（OpenCode Go + DeepSeek） */
  getAllModels(): ModelConfig[] {
    const opencode = this.settings?.opencodeModels ?? [];
    const deepseek = this.settings?.deepseekModels ?? [];
    return [...opencode, ...deepseek].filter((model) => model.enabled);
  }

  /** 按 "provider:modelId" 查找模型 */
  getModel(key: string): ModelConfig | undefined {
    if (!key) return undefined;

    const all = [...(this.settings?.opencodeModels ?? []), ...(this.settings?.deepseekModels ?? [])];
    const exact = all.find((model) => `${model.provider}:${model.id}` === key);
    if (exact) return exact;

    const separator = key.indexOf(":");
    if (separator > 0) {
      const provider = key.slice(0, separator);
      const modelId = key.slice(separator + 1);
      return (
        all.find((model) => model.provider === provider && model.id === modelId) ??
        all.find((model) => model.id === modelId)
      );
    }

    return all.find((model) => model.id === key);
  }

  /** 当前设置中选中的模型（失效时回退到第一个启用模型） */
  getSelectedModel(): ModelConfig | undefined {
    const selected = this.getModel(this.settings?.selectedModelId ?? "");
    if (selected?.enabled) return selected;
    return this.getAllModels()[0] ?? selected;
  }

  /** 打开（或激活）右侧边栏聊天视图 */
  async activateView(): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_POCKET_AGENT);
    let leaf: WorkspaceLeaf | null = existing.length > 0 ? existing[0] : null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_POCKET_AGENT, active: true });
    }

    await workspace.revealLeaf(leaf);

    const view = leaf.view as unknown as ChatViewLike;
    if (typeof view?.focusInput === "function") {
      try {
        view.focusInput();
      } catch {
        // 视图尚未就绪时忽略
      }
    }
  }

  /** 激活聊天视图并开启一条新对话 */
  private async startNewChat(): Promise<void> {
    await this.activateView();

    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_POCKET_AGENT)[0];
    const view = leaf?.view as unknown as ChatViewLike;
    if (view && typeof view.newSession === "function") {
      await view.newSession();
    }
  }

  /** 切换笔记库 Agent 模式 */
  private async toggleAgentMode(): Promise<void> {
    this.settings.agentMode = !this.settings.agentMode;
    await this.saveSettings();
    new Notice(this.settings.agentMode ? "已开启笔记库 Agent 模式" : "已关闭笔记库 Agent 模式");
  }
}
