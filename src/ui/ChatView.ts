import {
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import type {
  ChatMessage,
  ChatSession,
  CompletionResult,
  ModelConfig,
  ProviderId,
  QuickPrompt,
} from "../types";
import { createChatSession, createLocalId, deriveSessionTitle } from "../api/session";
import { PocketAgentApiError, resolveProviderCredentials, resolveRequestMode } from "../api/client";
import { VAULT_TOOL_DEFINITIONS, VaultTools } from "../agent/vaultTools";
import { confirmVaultEdit } from "./DiffModal";
import type PocketAgentPlugin from "../main";

export const VIEW_TYPE_POCKET_AGENT = "pocket-agent-chat-view";

/** “存为新笔记”的收集箱目录（Vault 根目录） */
const NOTE_INBOX_FOLDER = "PocketAgent";
/** 单次请求最多允许的 Agent 工具轮数 */
const MAX_AGENT_ROUNDS = 5;
/** 注入上下文的笔记正文上限 */
const MAX_CONTEXT_CHARS = 12_000;
/** 注入上下文的选中文本上限 */
const MAX_SELECTION_CHARS = 6_000;

const PROVIDER_LABELS: Record<ProviderId, string> = {
  "opencode-go": "OpenCode Go",
  deepseek: "DeepSeek / OpenAI 兼容",
};

const TOOL_LABELS: Record<string, string> = {
  search_vault_notes: "搜索笔记",
  read_note_content: "读取笔记",
  propose_note_edit: "修改笔记（需确认）",
};

function modelKey(model: ModelConfig): string {
  return `${model.provider}:${model.id}`;
}

function describeError(error: unknown): string {
  if (error instanceof PocketAgentApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatHistoryTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${formatClock(timestamp)}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${formatClock(timestamp)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 核心聊天界面。
 *
 * 布局：顶栏（品牌 / Agent 开关 / 模型 / 新对话 / 历史）→ 消息流 → 底部输入区。
 * 所有可点击控件触控高度不低于 44px，输入区贴底并留出安全区域。
 */
export class ChatView extends ItemView {
  plugin: PocketAgentPlugin;
  session: ChatSession;

  private busy = false;
  private abortController: AbortController | null = null;
  private attachNote = false;
  private agentMode = false;
  private selectionText = "";
  private drawerOpen = false;
  private lastMarkdownView: MarkdownView | null = null;

  private mdComponents: Component[] = [];
  private animatedIds = new Set<string>();
  private streamingMsgId: string | null = null;
  private streamingTextEl: HTMLElement | null = null;
  private streamingTypingEl: HTMLElement | null = null;

  private brandSubEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private agentToggleEl!: HTMLButtonElement;
  private newChatBtnEl!: HTMLButtonElement;
  private historyBtnEl!: HTMLButtonElement;
  private messagesEl!: HTMLElement;
  private msgListEl!: HTMLElement;
  private noteToggleEl!: HTMLButtonElement;
  private selectionBtnEl!: HTMLButtonElement;
  private chipsEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private drawerEl!: HTMLElement;
  private drawerPanelEl!: HTMLElement;
  private drawerListEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: PocketAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    const fallbackModelId = plugin?.settings?.selectedModelId ?? "";
    this.session = createChatSession(fallbackModelId);
  }

  getViewType(): string {
    return VIEW_TYPE_POCKET_AGENT;
  }

  getDisplayText(): string {
    return "PocketAgent";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.buildUi();
    this.registerWorkspaceEvents();
    this.rememberMarkdownView();

    const settings = this.plugin.settings;
    this.agentMode = Boolean(settings?.agentMode);
    this.attachNote = Boolean(settings?.attachCurrentNote);

    try {
      const latest = await this.plugin.history.latest();
      if (latest && Array.isArray(latest.messages)) {
        this.adoptSession(latest);
      }
    } catch (error) {
      console.error("PocketAgent: 读取最近对话失败", error);
      this.session = createChatSession(this.defaultModelId());
    }

    this.syncModelSelect();
    this.renderAgentToggle();
    this.refreshContextState();
    this.renderChips();
    this.renderMessages();
    this.updateBrandSub();
    this.updateBusyUi();
  }

  async onClose(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearMarkdownComponents();
    if (this.session.messages.length > 0) {
      try {
        await this.plugin.history.save(this.session);
      } catch {
        /* 关闭时保存失败不打扰用户 */
      }
    }
  }

  focusInput(): void {
    if (!this.textareaEl) return;
    this.textareaEl.focus();
  }

  async newSession(): Promise<void> {
    if (this.busy) {
      new Notice("正在生成回复，请先停止再新建对话。");
      return;
    }

    if (this.session.messages.length > 0) {
      try {
        await this.plugin.history.save(this.session);
      } catch (error) {
        console.error("PocketAgent: 保存旧对话失败", error);
      }
    }

    const model = this.resolveActiveModel();
    this.session = createChatSession(model ? modelKey(model) : this.defaultModelId());
    this.selectionText = "";
    this.animatedIds.clear();

    if (this.textareaEl) {
      this.textareaEl.value = "";
      this.autoGrow();
    }
    this.syncModelSelect();
    this.renderMessages();
    this.updateBrandSub();
    this.updateSelectionChip();
    this.setDrawer(false);
    this.focusInput();
  }

  async loadSession(id: string): Promise<void> {
    if (this.busy) {
      new Notice("正在生成回复，请先停止再切换对话。");
      return;
    }
    try {
      const loaded = await this.plugin.history.load(id);
      if (!loaded) {
        new Notice("没有找到这段对话。");
        return;
      }
      this.adoptSession(loaded);
      this.selectionText = "";
      this.animatedIds.clear();
      if (this.textareaEl) {
        this.textareaEl.value = "";
        this.autoGrow();
      }
      this.syncModelSelect();
      this.renderMessages();
      this.updateBrandSub();
      this.updateSelectionChip();
      this.setDrawer(false);
      new Notice(`已切换到「${loaded.title || "新对话"}」`);
    } catch (error) {
      new Notice(`读取对话失败：${describeError(error)}`);
    }
  }

  async sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;
    if (this.busy) {
      new Notice("还在生成中，请稍候。");
      return;
    }

    const model = this.resolveActiveModel();
    if (!model) {
      new Notice("还没有可用的模型，请先在插件设置中填写 API Key 与模型。");
      return;
    }

    this.busy = true;
    this.updateBusyUi();
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const contextBlock = await this.buildContextBlock();

      const userMessage: ChatMessage = {
        id: createLocalId("msg"),
        role: "user",
        content,
        createdAt: Date.now(),
      };
      const isFirstUserMessage = !this.session.messages.some((message) => message.role === "user");
      this.session.messages.push(userMessage);
      if (isFirstUserMessage) {
        this.session.title = deriveSessionTitle(content, "新对话");
      }
      this.session.modelId = modelKey(model);
      this.session.updatedAt = Date.now();

      if (this.textareaEl) {
        this.textareaEl.value = "";
        this.autoGrow();
      }
      await this.persist();
      this.renderMessages();
      this.updateBrandSub();

      await this.runAgentLoop(model, contextBlock, controller);
    } catch (error) {
      this.clearStreamingIndicators();
      if (controller.signal.aborted || isAbortError(error)) {
        new Notice("已停止生成。");
      } else {
        const message = describeError(error);
        new Notice(message);
        this.session.messages.push({
          id: createLocalId("msg"),
          role: "assistant",
          content: `⚠️ ${message}`,
          createdAt: Date.now(),
          isError: true,
        });
      }
      await this.persist();
      this.renderMessages();
    } finally {
      this.busy = false;
      this.abortController = null;
      this.updateBusyUi();
      this.scrollToBottom(true);
      this.refreshContextState();
    }
  }

  // ─────────────────────────────────────────────
  // 发送流程
  // ─────────────────────────────────────────────

  private async runAgentLoop(
    model: ModelConfig,
    contextBlock: string,
    controller: AbortController
  ): Promise<void> {
    const settings = this.plugin.settings;
    const tools = this.agentMode ? VAULT_TOOL_DEFINITIONS : undefined;
    const vaultTools = tools ? new VaultTools(this.app, (request) => confirmVaultEdit(this.app, request)) : null;
    const credentials = resolveProviderCredentials(model, {
      opencodeApiKey: settings?.opencodeApiKey ?? "",
      opencodeBaseUrl: settings?.opencodeBaseUrl ?? "",
      deepseekApiKey: settings?.deepseekApiKey ?? "",
      deepseekBaseUrl: settings?.deepseekBaseUrl ?? "",
    });
    const requestMode = resolveRequestMode(model, {
      opencodeRequestMode: settings?.opencodeRequestMode ?? "requestUrl",
    });

    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      if (controller.signal.aborted) {
        throw new DOMException("已停止生成", "AbortError");
      }

      const assistantMessage: ChatMessage = {
        id: createLocalId("msg"),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      };
      this.session.messages.push(assistantMessage);
      this.renderMessages();
      this.scrollToBottom(true);

      let result: CompletionResult;
      try {
        result = await this.plugin.client.complete({
          model,
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
          requestMode,
          messages: this.buildRequestMessages(assistantMessage.id, contextBlock),
          systemPrompt: settings?.systemPrompt ?? "",
          temperature: settings?.temperature ?? 0.7,
          maxTokens: settings?.maxTokens ?? 2048,
          tools,
          sessionId: this.session.opencodeSessionId,
          onDelta: (delta) => this.appendStreamDelta(assistantMessage.id, delta),
          signal: controller.signal,
        });
      } catch (error) {
        // 占位消息没有内容，直接移除，避免留下空气泡
        this.session.messages = this.session.messages.filter((message) => message.id !== assistantMessage.id);
        throw error;
      }

      assistantMessage.content = result.content || assistantMessage.content;
      assistantMessage.streaming = false;
      assistantMessage.toolCalls = result.toolCalls.length > 0 ? result.toolCalls : undefined;
      this.clearStreamingIndicators();

      await this.persist();
      this.renderMessages();
      this.scrollToBottom(true);

      if (!vaultTools || result.toolCalls.length === 0) return;

      for (const call of result.toolCalls) {
        const execution = await vaultTools.execute(call);
        this.session.messages.push({
          id: createLocalId("msg"),
          role: "tool",
          content: execution.content,
          createdAt: Date.now(),
          toolCallId: call.id,
          name: call.name,
          isError: execution.isError,
        });
      }
      await this.persist();
      this.renderMessages();
      this.scrollToBottom(true);
    }

    new Notice("已达到单轮工具调用上限（5 轮），先暂停，你可以继续追问。");
  }

  /** 构造请求消息：去掉占位消息，并把当前上下文挂到最近一条用户消息上 */
  private buildRequestMessages(excludeId: string, contextBlock: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const message of this.session.messages) {
      if (message.id === excludeId || message.streaming) continue;
      messages.push({ ...message });
    }

    if (!contextBlock) return messages;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        messages[i] = {
          ...messages[i],
          content: `${contextBlock}\n\n${messages[i].content}`,
        };
        break;
      }
    }
    return messages;
  }

  private appendStreamDelta(id: string, delta: string): void {
    const message = this.session.messages.find((item) => item.id === id);
    if (!message) return;
    message.content += delta;
    if (this.streamingMsgId === id && this.streamingTextEl) {
      this.streamingTextEl.setText(message.content);
      if (this.streamingTypingEl) {
        this.streamingTypingEl.toggleClass("is-hidden", message.content.length > 0);
      }
      this.scrollToBottom(false);
    }
  }

  private async buildContextBlock(): Promise<string> {
    const parts: string[] = [];

    if (this.attachNote) {
      const file = this.getActiveNoteFile();
      if (file) {
        try {
          const raw = await this.app.vault.cachedRead(file);
          const clipped =
            raw.length > MAX_CONTEXT_CHARS
              ? `${raw.slice(0, MAX_CONTEXT_CHARS)}\n\n（笔记太长，后面部分已截断）`
              : raw;
          parts.push(`【当前笔记】${file.basename}（${file.path}）\n<<<\n${clipped}\n>>>`);
        } catch (error) {
          new Notice(`读取笔记失败：${describeError(error)}`);
        }
      }
    }

    const selection = this.selectionText.trim();
    if (selection) {
      const clipped = selection.length > MAX_SELECTION_CHARS ? selection.slice(0, MAX_SELECTION_CHARS) : selection;
      parts.push(`【用户选中的内容】\n<<<\n${clipped}\n>>>`);
    }

    return parts.join("\n\n");
  }

  private async persist(): Promise<void> {
    this.session.updatedAt = Date.now();
    try {
      await this.plugin.history.save(this.session);
    } catch (error) {
      console.error("PocketAgent: 保存对话失败", error);
      new Notice("保存对话失败，内容可能只留在当前窗口里。");
    }
  }

  /** 接管一个从历史读出的会话，顺手清掉可能残留的流式标记 */
  private adoptSession(session: ChatSession): void {
    for (const message of session.messages) {
      if (message.streaming) message.streaming = false;
    }
    this.session = session;
  }

  // ─────────────────────────────────────────────
  // 界面搭建
  // ─────────────────────────────────────────────

  private buildUi(): void {
    this.contentEl.empty();
    this.contentEl.addClass("pocket-agent-view");

    const shell = this.contentEl.createDiv({ cls: "pa-shell" });

    // 顶栏
    const topbar = shell.createDiv({ cls: "pa-topbar" });

    const brandRow = topbar.createDiv({ cls: "pa-brand-row" });
    const brand = brandRow.createDiv({ cls: "pa-brand" });
    const brandMark = brand.createDiv({ cls: "pa-brand-mark", attr: { "aria-hidden": "true" } });
    setIcon(brandMark, "message-square");
    const brandText = brand.createDiv({ cls: "pa-brand-text" });
    brandText.createDiv({ cls: "pa-brand-name", text: "PocketAgent" });
    this.brandSubEl = brandText.createDiv({ cls: "pa-brand-sub", text: "新对话" });

    this.agentToggleEl = brandRow.createEl("button", {
      cls: "pa-agent-toggle",
      attr: { type: "button", "aria-pressed": "false" },
    });
    this.agentToggleEl.addEventListener("click", () => void this.toggleAgentMode());

    const controlsRow = topbar.createDiv({ cls: "pa-controls-row" });
    const modelWrap = controlsRow.createDiv({ cls: "pa-model-wrap" });
    this.modelSelectEl = modelWrap.createEl("select", {
      cls: "pa-model-select",
      attr: { "aria-label": "选择模型" },
    });
    this.modelSelectEl.addEventListener("change", () => void this.changeModel(this.modelSelectEl.value));

    const actions = controlsRow.createDiv({ cls: "pa-topbar-actions" });

    this.newChatBtnEl = actions.createEl("button", {
      cls: "pa-btn",
      attr: { type: "button", title: "保存当前对话并开始新对话", "aria-label": "新对话" },
    });
    this.newChatBtnEl.createSpan({ cls: "pa-btn-icon", text: "➕" });
    this.newChatBtnEl.createSpan({ cls: "pa-btn-text", text: "新对话" });
    this.newChatBtnEl.addEventListener("click", () => void this.newSession());

    this.historyBtnEl = actions.createEl("button", {
      cls: "pa-btn",
      attr: { type: "button", title: "打开历史对话", "aria-label": "历史对话" },
    });
    this.historyBtnEl.createSpan({ cls: "pa-btn-icon", text: "📂" });
    this.historyBtnEl.createSpan({ cls: "pa-btn-text", text: "历史" });
    this.historyBtnEl.addEventListener("click", () => void this.openHistory());

    // 消息流
    this.messagesEl = shell.createDiv({ cls: "pa-messages", attr: { role: "log", "aria-live": "polite" } });
    this.msgListEl = this.messagesEl.createDiv({ cls: "pa-msg-list" });

    // 输入区
    const composer = shell.createDiv({ cls: "pa-composer" });

    const contextRow = composer.createDiv({ cls: "pa-context" });
    const contextLine = contextRow.createDiv({ cls: "pa-context-line" });

    this.noteToggleEl = contextLine.createEl("button", {
      cls: "pa-toggle",
      attr: { type: "button", "aria-pressed": "false" },
    });
    this.noteToggleEl.addEventListener("click", () => this.toggleAttachNote());

    this.selectionBtnEl = contextLine.createEl("button", {
      cls: "pa-toggle pa-toggle-selection is-hidden",
      attr: { type: "button", title: "把选中的文字引用到输入框" },
    });
    this.selectionBtnEl.addEventListener("click", () => this.quoteSelection());

    this.chipsEl = contextRow.createDiv({ cls: "pa-chips", attr: { "aria-label": "快捷指令" } });

    const inputRow = composer.createDiv({ cls: "pa-input-row" });
    this.textareaEl = inputRow.createEl("textarea", {
      cls: "pa-input",
      attr: {
        rows: "1",
        placeholder: "输入消息…",
        "aria-label": "消息输入框",
      },
    });
    this.textareaEl.addEventListener("input", () => this.autoGrow());
    this.registerDomEvent(this.textareaEl, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
      if (Platform.isMobile || Platform.isTablet) return; // 手机 / 平板回车换行
      event.preventDefault();
      void this.sendMessage(this.textareaEl.value);
    });

    this.sendBtnEl = inputRow.createEl("button", {
      cls: "pa-send",
      text: "发送",
      attr: { type: "button", "aria-label": "发送消息" },
    });
    this.sendBtnEl.addEventListener("click", () => {
      if (this.busy) {
        this.abortController?.abort();
        return;
      }
      void this.sendMessage(this.textareaEl.value);
    });

    this.hintEl = composer.createDiv({
      cls: "pa-hint",
      text: Platform.isMobile || Platform.isTablet ? "点按发送按钮送出消息" : "Enter 发送 · Shift+Enter 换行",
    });

    // 历史抽屉
    this.drawerEl = shell.createDiv({ cls: "pa-drawer" });
    const backdrop = this.drawerEl.createDiv({ cls: "pa-drawer-backdrop" });
    backdrop.addEventListener("click", () => this.setDrawer(false));

    this.drawerPanelEl = this.drawerEl.createDiv({ cls: "pa-drawer-panel" });
    const drawerHead = this.drawerPanelEl.createDiv({ cls: "pa-drawer-head" });
    drawerHead.createDiv({ cls: "pa-drawer-title", text: "历史对话" });
    const drawerClose = drawerHead.createEl("button", {
      cls: "pa-icon-btn",
      attr: { type: "button", "aria-label": "关闭历史" },
    });
    setIcon(drawerClose, "x");
    drawerClose.addEventListener("click", () => this.setDrawer(false));

    this.drawerListEl = this.drawerPanelEl.createDiv({ cls: "pa-drawer-list" });
    this.drawerEl.setAttr("aria-hidden", "true");

    this.autoGrow();
  }

  private registerWorkspaceEvents(): void {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.rememberMarkdownView();
        this.refreshContextState();
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
        this.setSelection(editor.getSelection() ?? "");
      })
    );

    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.drawerOpen) {
        this.setDrawer(false);
      }
    });
  }

  // ─────────────────────────────────────────────
  // 顶栏行为
  // ─────────────────────────────────────────────

  private syncModelSelect(): void {
    if (!this.modelSelectEl) return;
    const select = this.modelSelectEl;
    select.empty();

    const models = this.collectModels();
    if (models.length === 0) {
      select.createEl("option", { value: "", text: "尚未配置模型" });
      select.value = "";
      select.disabled = true;
      return;
    }
    select.disabled = false;

    const groups = new Map<ProviderId, ModelConfig[]>();
    for (const model of models) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }

    for (const [provider, list] of groups) {
      const group = select.createEl("optgroup", { attr: { label: PROVIDER_LABELS[provider] ?? provider } });
      for (const model of list) {
        group.createEl("option", {
          value: modelKey(model),
          text: model.name || model.id,
        });
      }
    }

    const active = this.resolveActiveModel();
    const target = active ? modelKey(active) : this.session.modelId;
    const exists = Array.from(select.options).some((option) => option.value === target);
    if (exists) {
      select.value = target;
    } else if (target) {
      select.createEl("option", { value: target, text: `${target}（当前）` });
      select.value = target;
    }
  }

  private async changeModel(key: string): Promise<void> {
    if (!key) return;
    const model = this.plugin.getModel?.(key) ?? this.collectModels().find((item) => modelKey(item) === key);
    if (!model) {
      new Notice("没有找到这个模型。");
      return;
    }
    this.session.modelId = modelKey(model);
    this.session.updatedAt = Date.now();

    const settings = this.plugin.settings;
    if (settings) {
      settings.selectedModelId = this.session.modelId;
      try {
        await this.plugin.saveSettings();
      } catch (error) {
        console.error("PocketAgent: 保存模型选择失败", error);
      }
    }

    if (this.session.messages.length > 0) {
      await this.persist();
    }
    this.updateBrandSub();
    new Notice(`已切换到 ${model.name || model.id}`);
  }

  private async toggleAgentMode(): Promise<void> {
    this.agentMode = !this.agentMode;
    this.renderAgentToggle();
    const settings = this.plugin.settings;
    if (settings) {
      settings.agentMode = this.agentMode;
      try {
        await this.plugin.saveSettings();
      } catch (error) {
        console.error("PocketAgent: 保存 Agent 模式失败", error);
      }
    }
    new Notice(this.agentMode ? "已开启笔记库 Agent 模式" : "已关闭笔记库 Agent 模式");
  }

  private renderAgentToggle(): void {
    if (!this.agentToggleEl) return;
    this.agentToggleEl.setText(this.agentMode ? "🤖 Agent 开" : "🤖 Agent 关");
    this.agentToggleEl.toggleClass("is-on", this.agentMode);
    this.agentToggleEl.setAttr("aria-pressed", String(this.agentMode));
    this.agentToggleEl.setAttr(
      "title",
      this.agentMode ? "AI 可以搜索、读取并提议修改你的笔记" : "开启后 AI 可以操作笔记库"
    );
  }

  private updateBrandSub(): void {
    if (!this.brandSubEl) return;
    const title = this.session.title || "新对话";
    const model = this.resolveActiveModel();
    const label = model ? `${title} · ${model.name || model.id}` : title;
    this.brandSubEl.setText(label);
    this.brandSubEl.setAttr("title", label);
  }

  // ─────────────────────────────────────────────
  // 上下文与快捷指令
  // ─────────────────────────────────────────────

  private refreshContextState(): void {
    const view = this.getActiveNoteView();
    this.setSelection(this.getSelectionFromView(view));
    this.renderNoteToggle();
  }

  private getSelectionFromView(view: MarkdownView | null): string {
    if (!view) return "";
    try {
      return view.editor?.getSelection() ?? "";
    } catch {
      return "";
    }
  }

  private setSelection(text: string): void {
    const next = text.length > 0 ? text : "";
    if (next === this.selectionText) return;
    this.selectionText = next;
    this.updateSelectionChip();
  }

  private updateSelectionChip(): void {
    if (!this.selectionBtnEl) return;
    const text = this.selectionText.trim();
    const count = text.replace(/\s+/g, "").length;
    if (count === 0) {
      this.selectionBtnEl.addClass("is-hidden");
      this.selectionBtnEl.setAttr("disabled", "true");
      return;
    }
    this.selectionBtnEl.removeClass("is-hidden");
    this.selectionBtnEl.removeAttribute("disabled");
    this.selectionBtnEl.setText(`✂️ 引用选中内容 (${count}字)`);
  }

  private quoteSelection(): void {
    const text = this.selectionText.trim();
    if (!text) return;
    const quoted = text
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    const existing = this.textareaEl.value.trim();
    this.textareaEl.value = existing ? `${existing}\n\n${quoted}\n\n` : `${quoted}\n\n`;
    this.autoGrow();
    this.focusInput();
  }

  private toggleAttachNote(): void {
    this.attachNote = !this.attachNote;
    this.renderNoteToggle();
    const file = this.getActiveNoteFile();
    if (this.attachNote && !file) {
      new Notice("当前没有打开的 Markdown 笔记可以附带。");
    }
  }

  private renderNoteToggle(): void {
    if (!this.noteToggleEl) return;
    const file = this.getActiveNoteFile();
    const state = this.attachNote ? "开" : "关";
    this.noteToggleEl.setText(file ? `📄 附带当前笔记：${state} · ${file.basename}` : `📄 附带当前笔记：${state}`);
    this.noteToggleEl.toggleClass("is-on", this.attachNote);
    this.noteToggleEl.toggleClass("is-muted", !file);
    this.noteToggleEl.setAttr("aria-pressed", String(this.attachNote));
    this.noteToggleEl.setAttr(
      "title",
      file ? `发送时自动带上「${file.basename}」的标题和正文` : "当前没有打开的 Markdown 笔记"
    );
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    const prompts = this.plugin.settings?.quickPrompts ?? [];
    if (prompts.length === 0) {
      this.chipsEl.addClass("is-empty");
      return;
    }
    this.chipsEl.removeClass("is-empty");

    for (const prompt of prompts) {
      const chip = this.chipsEl.createEl("button", {
        cls: "pa-chip",
        text: prompt.label || "快捷指令",
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => void this.useQuickPrompt(prompt));
    }
  }

  private async useQuickPrompt(prompt: QuickPrompt): Promise<void> {
    if (this.busy) {
      new Notice("正在生成中，请稍候。");
      return;
    }

    let text = prompt.prompt || prompt.label || "";
    if (text.includes("{{selection}}")) {
      text = text.split("{{selection}}").join(this.selectionText.trim());
    }
    if (text.includes("{{note}}")) {
      let noteText = "";
      const file = this.getActiveNoteFile();
      if (file) {
        try {
          noteText = await this.app.vault.cachedRead(file);
        } catch {
          noteText = "";
        }
      }
      text = text.split("{{note}}").join(noteText);
    }

    const finalText = text.trim();
    if (!finalText) {
      new Notice("这条快捷指令没有可发送的内容。");
      return;
    }
    await this.sendMessage(finalText);
  }

  // ─────────────────────────────────────────────
  // 消息渲染
  // ─────────────────────────────────────────────

  private renderMessages(): void {
    if (!this.msgListEl) return;
    this.clearMarkdownComponents();
    this.msgListEl.empty();
    this.streamingMsgId = null;
    this.streamingTextEl = null;
    this.streamingTypingEl = null;

    const visible = this.session.messages.filter(
      (message) => message.role === "user" || message.role === "assistant" || message.role === "tool"
    );

    if (visible.length === 0) {
      this.renderEmptyState();
      return;
    }

    for (const message of visible) {
      this.renderMessage(message);
    }
  }

  private renderEmptyState(): void {
    const empty = this.msgListEl.createDiv({ cls: "pa-empty" });
    empty.createDiv({ cls: "pa-empty-mark", attr: { "aria-hidden": "true" }, text: "◈" });
    empty.createDiv({ cls: "pa-empty-title", text: "说点什么，或者交给 Agent" });
    empty.createDiv({
      cls: "pa-empty-desc",
      text: "对话会保存在本地笔记库里，随时可以翻回去继续。",
    });
    const hints = empty.createDiv({ cls: "pa-empty-hints" });
    hints.createDiv({ cls: "pa-empty-hint", text: "📄 打开「附带当前笔记」，就能直接针对这篇笔记提问。" });
    hints.createDiv({ cls: "pa-empty-hint", text: "✂️ 在编辑器里选中一段文字，这里会出现引用按钮。" });
    hints.createDiv({ cls: "pa-empty-hint", text: "🤖 开启 Agent 模式，AI 可以搜索、读取并提议修改笔记。" });
  }

  private renderMessage(message: ChatMessage): void {
    if (message.role === "tool") {
      this.renderToolMessage(message);
      return;
    }

    const container = this.msgListEl.createDiv({
      cls: `pa-msg pa-msg-${message.role}${message.isError ? " pa-msg-error" : ""}`,
    });
    if (!this.animatedIds.has(message.id)) {
      this.animatedIds.add(message.id);
      container.addClass("is-new");
    }

    const main = container.createDiv({ cls: "pa-msg-main" });

    if (message.role === "assistant") {
      const head = main.createDiv({ cls: "pa-msg-head" });
      const author = head.createDiv({ cls: "pa-msg-author" });
      author.createSpan({ cls: "pa-msg-dot" });
      author.createSpan({ text: "PocketAgent" });
      head.createDiv({ cls: "pa-msg-time", text: formatClock(message.createdAt) });
    }

    const contentEl = main.createDiv({ cls: "pa-msg-content" });

    if (message.role === "user") {
      contentEl.addClass("pa-bubble");
      contentEl.setText(message.content);
      main.createDiv({ cls: "pa-msg-time pa-msg-time-user", text: formatClock(message.createdAt) });
      return;
    }

    if (message.streaming) {
      const streamEl = contentEl.createDiv({ cls: "pa-stream" });
      streamEl.setText(message.content);
      const typing = contentEl.createDiv({ cls: "pa-typing" });
      typing.createSpan({ cls: "pa-typing-dot" });
      typing.createSpan({ cls: "pa-typing-dot" });
      typing.createSpan({ cls: "pa-typing-dot" });
      typing.toggleClass("is-hidden", message.content.length > 0);

      this.streamingMsgId = message.id;
      this.streamingTextEl = streamEl;
      this.streamingTypingEl = typing;
      return;
    }

    if (message.content.trim()) {
      contentEl.addClass("markdown-rendered");
      void this.renderMarkdownInto(contentEl, message.content);
    } else if (message.toolCalls?.length) {
      const names = message.toolCalls.map((call) => TOOL_LABELS[call.name] ?? call.name).join("、");
      contentEl.createDiv({ cls: "pa-tool-hint", text: `🔧 正在调用工具：${names}` });
    } else {
      contentEl.createDiv({ cls: "pa-tool-hint", text: "（空回复）" });
    }

    this.addActionBar(main, message);
  }

  private renderToolMessage(message: ChatMessage): void {
    const details = this.msgListEl.createEl("details", { cls: "pa-tool" });
    const summary = details.createEl("summary", { cls: "pa-tool-summary" });
    summary.createSpan({
      cls: "pa-tool-name",
      text: `🔧 ${TOOL_LABELS[message.name ?? ""] ?? message.name ?? "工具调用"}`,
    });
    summary.createSpan({
      cls: "pa-tool-state",
      text: message.isError ? "失败" : "完成",
    });
    if (message.isError) summary.addClass("is-error");
    details.createEl("pre", { cls: "pa-tool-output", text: message.content.slice(0, 4000) });
  }

  private addActionBar(container: HTMLElement, message: ChatMessage): void {
    if (!message.content.trim()) return;
    const bar = container.createDiv({ cls: "pa-actions" });

    const copyButton = bar.createEl("button", {
      cls: "pa-action",
      text: "📋 复制",
      attr: { type: "button" },
    });
    copyButton.addEventListener("click", () => void this.copyMessage(message));

    const insertButton = bar.createEl("button", {
      cls: "pa-action",
      text: "📥 插入光标处",
      attr: { type: "button", title: "写入当前笔记的光标位置，失败时追加到末尾" },
    });
    insertButton.addEventListener("click", () => void this.insertMessage(message));

    const saveButton = bar.createEl("button", {
      cls: "pa-action",
      text: "➕ 存为新笔记",
      attr: { type: "button", title: "保存为收集箱里的新笔记" },
    });
    saveButton.addEventListener("click", () => void this.saveAsNote(message));
  }

  private async renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void> {
    const component = new Component();
    this.addChild(component);
    this.mdComponents.push(component);
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    try {
      await MarkdownRenderer.render(this.app, markdown, el, sourcePath, component);
    } catch {
      el.setText(markdown);
    }
  }

  private clearMarkdownComponents(): void {
    for (const component of this.mdComponents) {
      try {
        this.removeChild(component);
      } catch {
        /* 已移除 */
      }
      try {
        component.unload();
      } catch {
        /* 忽略重复卸载 */
      }
    }
    this.mdComponents = [];
  }

  private clearStreamingIndicators(): void {
    this.streamingMsgId = null;
    this.streamingTextEl = null;
    this.streamingTypingEl = null;
  }

  // ─────────────────────────────────────────────
  // AI 消息操作
  // ─────────────────────────────────────────────

  private async copyMessage(message: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content);
      new Notice("已复制");
    } catch {
      this.copyWithFallback(message.content);
      new Notice("已复制");
    }
  }

  private copyWithFallback(text: string): void {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand("copy");
    } catch {
      /* 忽略：兜底也失败时只保留提示 */
    }
    helper.remove();
  }

  private async insertMessage(message: ChatMessage): Promise<void> {
    const view = this.getActiveNoteView();
    const content = message.content;

    if (view) {
      try {
        const editor = view.editor;
        editor.replaceSelection(content);
        editor.focus();
        new Notice("已插入光标处");
        return;
      } catch (error) {
        console.error("PocketAgent: 插入光标处失败，尝试追加到末尾", error);
      }
    }

    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("没有打开的笔记，无法插入。");
      return;
    }

    try {
      let existing = "";
      try {
        existing = await this.app.vault.cachedRead(file);
      } catch {
        existing = "";
      }
      const prefix = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      await this.app.vault.append(file, `${prefix}${content}`);
      new Notice(`已追加到「${file.basename}」末尾`);
    } catch (error) {
      new Notice(`写入笔记失败：${describeError(error)}`);
    }
  }

  private async saveAsNote(message: ChatMessage): Promise<void> {
    const content = message.content.trim();
    if (!content) {
      new Notice("这条回复是空的，无法保存。");
      return;
    }

    try {
      const folderPath = normalizePath(NOTE_INBOX_FOLDER);
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        try {
          await this.app.vault.createFolder(folderPath);
        } catch {
          /* 目录可能已被并发创建 */
        }
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
        now.getMinutes()
      )}${pad(now.getSeconds())}`;

      let path = normalizePath(`${folderPath}/PocketAgent ${stamp}.md`);
      let attempt = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(`${folderPath}/PocketAgent ${stamp} (${attempt}).md`);
        attempt += 1;
      }

      const file = await this.app.vault.create(path, content);
      new Notice(`已保存为新笔记：${file.path}`);
    } catch (error) {
      new Notice(`保存笔记失败：${describeError(error)}`);
    }
  }

  // ─────────────────────────────────────────────
  // 历史抽屉
  // ─────────────────────────────────────────────

  private setDrawer(open: boolean): void {
    if (!this.drawerEl) return;
    this.drawerOpen = open;
    this.drawerEl.toggleClass("is-open", open);
    this.drawerEl.setAttr("aria-hidden", String(!open));
  }

  private async openHistory(): Promise<void> {
    this.setDrawer(true);
    this.drawerListEl.empty();
    this.drawerListEl.createDiv({ cls: "pa-drawer-loading", text: "正在读取历史…" });

    try {
      const list = await this.plugin.history.list();
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      this.drawerListEl.empty();
      this.renderHistoryList(sorted);
    } catch (error) {
      this.drawerListEl.empty();
      this.drawerListEl.createDiv({ cls: "pa-drawer-empty", text: `读取历史失败：${describeError(error)}` });
    }
  }

  private renderHistoryList(list: { id: string; title: string; updatedAt: number }[]): void {
    if (list.length === 0) {
      this.drawerListEl.createDiv({ cls: "pa-drawer-empty", text: "还没有保存的对话。" });
      return;
    }

    for (const item of list) {
      const row = this.drawerListEl.createDiv({ cls: "pa-history-item" });
      row.toggleClass("is-active", item.id === this.session.id);

      const main = row.createEl("button", { cls: "pa-history-main", attr: { type: "button" } });
      main.createDiv({ cls: "pa-history-title", text: item.title || "新对话" });
      main.createDiv({ cls: "pa-history-time", text: formatHistoryTime(item.updatedAt) });
      main.addEventListener("click", () => void this.loadSession(item.id));

      const remove = row.createEl("button", {
        cls: "pa-history-del",
        attr: { type: "button", "aria-label": `删除「${item.title || "新对话"}」` },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.deleteSession(item.id);
      });
    }
  }

  private async deleteSession(id: string): Promise<void> {
    try {
      await this.plugin.history.remove(id);
      new Notice("已删除这段对话");
      const list = await this.plugin.history.list();
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      this.drawerListEl.empty();
      this.renderHistoryList(sorted);
      if (id === this.session.id) {
        // 当前会话已被删除：直接丢弃内存中的副本，避免 newSession() 把它重新写回磁盘
        const model = this.resolveActiveModel();
        this.session = createChatSession(model ? modelKey(model) : this.defaultModelId());
        this.selectionText = "";
        this.animatedIds.clear();
        this.syncModelSelect();
        this.renderMessages();
        this.updateBrandSub();
        this.updateSelectionChip();
      }
    } catch (error) {
      new Notice(`删除失败：${describeError(error)}`);
    }
  }

  // ─────────────────────────────────────────────
  // 输入区
  // ─────────────────────────────────────────────

  private autoGrow(): void {
    if (!this.textareaEl) return;
    this.textareaEl.style.height = "auto";
    const next = Math.max(44, Math.min(this.textareaEl.scrollHeight, 160));
    this.textareaEl.style.height = `${next}px`;
  }

  private updateBusyUi(): void {
    if (!this.sendBtnEl) return;
    this.sendBtnEl.setText(this.busy ? "停止" : "发送");
    this.sendBtnEl.toggleClass("is-busy", this.busy);
    this.sendBtnEl.setAttr("aria-label", this.busy ? "停止生成" : "发送消息");
    if (this.hintEl) {
      this.hintEl.setText(
        this.busy
          ? "正在生成… 点按「停止」可以中断"
          : Platform.isMobile || Platform.isTablet
            ? "点按发送按钮送出消息"
            : "Enter 发送 · Shift+Enter 换行"
      );
    }
  }

  private scrollToBottom(force: boolean): void {
    if (!this.messagesEl) return;
    const el = this.messagesEl;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (!force && !nearBottom) return;
    const raf = window.requestAnimationFrame;
    if (typeof raf === "function") {
      raf(() => {
        el.scrollTop = el.scrollHeight;
      });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }

  // ─────────────────────────────────────────────
  // 模型与笔记辅助
  // ─────────────────────────────────────────────

  private collectModels(): ModelConfig[] {
    const fromPlugin = this.plugin.getAllModels?.() ?? [];
    if (fromPlugin.length > 0) return fromPlugin;

    const settings = this.plugin.settings;
    if (!settings) return [];
    return [...(settings.opencodeModels ?? []), ...(settings.deepseekModels ?? [])].filter(
      (model) => model?.enabled !== false
    );
  }

  private defaultModelId(): string {
    const selected = this.plugin.getSelectedModel?.();
    if (selected) return modelKey(selected);
    const first = this.collectModels()[0];
    return first ? modelKey(first) : this.plugin.settings?.selectedModelId ?? "";
  }

  private resolveActiveModel(): ModelConfig | undefined {
    const key = this.session.modelId;
    if (key) {
      const byKey = this.plugin.getModel?.(key);
      if (byKey) return byKey;
      const direct = this.collectModels().find((model) => modelKey(model) === key || model.id === key);
      if (direct) return direct;
    }
    return this.plugin.getSelectedModel?.() ?? this.collectModels()[0];
  }

  private getActiveNoteView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active;

    // 聊天视图获得焦点时 activeLeaf 不是笔记，退回到最近一次操作的笔记视图
    const recent = this.lastMarkdownView;
    if (recent?.file && this.app.vault.getAbstractFileByPath(recent.file.path)) {
      return recent;
    }
    return null;
  }

  private getActiveNoteFile(): TFile | null {
    const view = this.getActiveNoteView();
    if (view?.file) return view.file;
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file : null;
  }

  private rememberMarkdownView(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) this.lastMarkdownView = view;
  }
}
