import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { fetchProviderModels } from "./api/client";
import type PocketAgentPlugin from "./main";
import type {
  HistoryFormat,
  ModelConfig,
  PocketAgentSettings,
  ProtocolType,
  ProviderId,
  RequestMode,
  QuickPrompt,
} from "./types";

/** 默认设置 */
export const DEFAULT_SETTINGS: PocketAgentSettings = {
  opencodeApiKey: "",
  opencodeBaseUrl: "https://opencode.ai/zen/go/v1",
  opencodeRequestMode: "requestUrl",
  opencodeModels: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "glm-5.3", name: "GLM-5.3", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      provider: "opencode-go",
      protocol: "openai-chat",
      enabled: true,
      supportsTemperature: false,
    },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", provider: "opencode-go", protocol: "anthropic-messages", enabled: true },
    { id: "qwen3.8-max", name: "Qwen3.8 Max", provider: "opencode-go", protocol: "anthropic-messages", enabled: true },
    {
      id: "claude-haiku-5-5",
      name: "Claude Haiku 5.5",
      provider: "opencode-go",
      protocol: "anthropic-messages",
      enabled: true,
      supportsTemperature: false,
    },
    { id: "grok-4.7", name: "Grok 4.7", provider: "opencode-go", protocol: "openai-responses", enabled: true },
  ],
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com/v1",
  deepseekModels: [
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", provider: "deepseek", protocol: "openai-chat", enabled: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", protocol: "openai-chat", enabled: true },
  ],
  selectedModelId: "opencode-go:deepseek-v4.1-flash",
  systemPrompt:
    "你是 PocketAgent，一款运行在 Obsidian 中的 AI 笔记助手。请始终使用简体中文回答，简洁、准确、结构化，优先使用 Markdown（标题、列表、代码块）。当用户附带笔记或选中文本时，请紧扣原文作答，不编造事实；信息不足时明确指出还需要哪些内容。除非用户要求展开，否则保持回答精炼。",
  quickPrompts: [
    {
      id: "polish",
      label: "✨ 润色选中",
      prompt:
        "请润色下面这段文字：保持原意与原有语言，改善表达流畅度、用词准确性与可读性。只输出润色后的文本，不要解释。\n\n{{selection}}",
    },
    {
      id: "summarize",
      label: "📝 总结全文",
      prompt:
        "请阅读以下笔记内容，用简洁的中文总结核心要点，输出 3-6 条要点列表，并在末尾用一句话概括主题。\n\n{{note}}",
    },
    {
      id: "todos",
      label: "🔍 提炼待办",
      prompt:
        "请从以下笔记中提炼可以执行的待办事项，使用 Markdown 任务列表输出（- [ ] 事项），如有负责人、截止时间等关键信息请一并标注。\n\n{{note}}",
    },
    {
      id: "translate",
      label: "🇬🇧 翻译中英",
      prompt:
        "请判断下面内容的主要语言：若为中文则翻译成地道的英文，若为英文则翻译成简洁的中文。只输出译文，不要解释。\n\n{{selection}}",
    },
    {
      id: "explain",
      label: "💡 解释概念",
      prompt:
        "请用通俗易懂的中文解释下面的概念：先给出一句话定义，再给出一个日常类比，最后给一个具体例子。\n\n{{selection}}",
    },
  ],
  historyFolder: ".obsidian/plugins/pocket-agent/history",
  historyFormat: "json",
  maxHistorySessions: 50,
  agentMode: false,
  temperature: 0.7,
  attachCurrentNote: false,
  maxTokens: 4096,
  schemaVersion: 2,
};

/** 请求模式取值收敛 */
function toRequestMode(value: string): RequestMode {
  return value === "fetch" ? "fetch" : "requestUrl";
}

/** 协议类型取值收敛 */
function toProtocol(value: string): ProtocolType {
  if (value === "anthropic-messages") return "anthropic-messages";
  if (value === "openai-responses") return "openai-responses";
  return "openai-chat";
}

/** 历史格式取值收敛 */
function toHistoryFormat(value: string): HistoryFormat {
  return value === "markdown" ? "markdown" : "json";
}

/** 协议展示名称 */
const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  "openai-chat": "OpenAI Chat（chat/completions）",
  "anthropic-messages": "Anthropic Messages",
  "openai-responses": "OpenAI Responses",
};

/** 插件设置页 */
export class PocketAgentSettingTab extends PluginSettingTab {
  plugin: PocketAgentPlugin;

  constructor(app: App, plugin: PocketAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "PocketAgent 设置" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "密钥仅保存在本地。常用项默认展开，其余按需点开。",
    });

    const connectionEl = this.createDetails(containerEl, "连接", true, "pocket-agent-settings-group");
    this.renderConnectionSection(connectionEl);

    const modelEl = this.createDetails(containerEl, "模型", true, "pocket-agent-settings-group");
    this.renderModelSection(modelEl);

    const chatEl = this.createDetails(containerEl, "对话", true, "pocket-agent-settings-group");
    this.renderChatSection(chatEl);

    const storageEl = this.createDetails(containerEl, "存储与 Agent", false, "pocket-agent-settings-group");
    this.renderStorageSection(storageEl);
  }

  /** 保存设置（统一入口） */
  private async persist(): Promise<void> {
    await this.plugin.saveSettings();
  }

  /** 创建折叠分组，返回其内容容器 */
  private createDetails(
    parentEl: HTMLElement,
    title: string,
    open: boolean,
    cls: string
  ): HTMLDivElement {
    const details = parentEl.createEl("details", { cls });
    details.open = open;
    details.createEl("summary", { cls: `${cls}-title`, text: title });
    return details.createDiv({ cls: `${cls}-body` });
  }

  /** 1) 连接：服务商密钥与地址 */
  private renderConnectionSection(parentEl: HTMLElement): void {
    const settings = this.plugin.settings;

    parentEl.createEl("p", { cls: "setting-item-description", text: "密钥仅保存在本地。" });

    new Setting(parentEl).setName("OpenCode Go").setHeading();

    new Setting(parentEl)
      .setName("API Key")
      .setDesc("留空则无法请求。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(settings.opencodeApiKey)
          .onChange(async (value) => {
            settings.opencodeApiKey = value.trim();
            await this.persist();
          });
      });

    new Setting(parentEl)
      .setName("Base URL")
      .setDesc("默认 https://opencode.ai/zen/go/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://opencode.ai/zen/go/v1")
          .setValue(settings.opencodeBaseUrl)
          .onChange(async (value) => {
            settings.opencodeBaseUrl = value.trim();
            await this.persist();
          })
      );

    new Setting(parentEl)
      .setName("请求模式")
      .setDesc("requestUrl 直连更稳；fetch 支持流式，失败会自动降级。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("requestUrl", "requestUrl 免跨域直连")
          .addOption("fetch", "fetch 流式输出")
          .setValue(settings.opencodeRequestMode)
          .onChange(async (value) => {
            settings.opencodeRequestMode = toRequestMode(value);
            await this.persist();
          })
      );

    new Setting(parentEl).setName("DeepSeek / 自定义 OpenAI").setHeading();
    parentEl.createEl("p", {
      cls: "setting-item-description",
      text: "默认 https://api.deepseek.com/v1（保留 /v1 兼容路径）。",
    });

    new Setting(parentEl)
      .setName("API Key")
      .setDesc("OpenAI 兼容服务同样适用。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(settings.deepseekApiKey)
          .onChange(async (value) => {
            settings.deepseekApiKey = value.trim();
            await this.persist();
          });
      });

    new Setting(parentEl)
      .setName("Base URL")
      .setDesc("默认 https://api.deepseek.com/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(settings.deepseekBaseUrl)
          .onChange(async (value) => {
            settings.deepseekBaseUrl = value.trim();
            await this.persist();
          })
      );
  }

  /** 2) 模型：默认选择 + 各服务商模型列表 */
  private renderModelSection(parentEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const enabledModels = this.plugin.getAllModels();

    new Setting(parentEl)
      .setName("默认模型")
      .setDesc("可在聊天窗口顶部随时切换。")
      .addDropdown((dropdown) => {
        enabledModels.forEach((model) => {
          const key = `${model.provider}:${model.id}`;
          dropdown.addOption(
            key,
            `${model.name || model.id}（${model.provider === "opencode-go" ? "OpenCode Go" : "DeepSeek"}）`
          );
        });

        const current = settings.selectedModelId;
        const currentKnown = enabledModels.some((model) => `${model.provider}:${model.id}` === current);
        if (current && !currentKnown) {
          dropdown.addOption(current, `${current}（当前未启用）`);
        }
        if (!current && enabledModels.length === 0) {
          dropdown.addOption("", "暂无可用模型，请先启用");
        }

        const fallback = enabledModels.length > 0 ? `${enabledModels[0].provider}:${enabledModels[0].id}` : "";
        dropdown.setValue(current || fallback).onChange(async (value) => {
          settings.selectedModelId = value;
          await this.persist();
        });
      });

    const opencodeModels = settings.opencodeModels;
    const opencodeEl = this.createDetails(
      parentEl,
      `OpenCode Go 模型（${opencodeModels.length}）`,
      false,
      "pocket-agent-settings-subgroup"
    );
    this.renderModelList(opencodeModels, "opencode-go", "OpenCode Go", opencodeEl);

    const deepseekModels = settings.deepseekModels;
    const deepseekEl = this.createDetails(
      parentEl,
      `DeepSeek 模型（${deepseekModels.length}）`,
      false,
      "pocket-agent-settings-subgroup"
    );
    this.renderModelList(deepseekModels, "deepseek", "DeepSeek", deepseekEl);
  }

  /** 模型列表管理：id / 名称 / 协议 / 启用 / 发送 temperature / 删除 */
  private renderModelList(
    models: ModelConfig[],
    provider: ProviderId,
    providerLabel: string,
    parentEl: HTMLElement
  ): void {
    const container = parentEl.createDiv({ cls: "pocket-agent-model-list" });

    if (models.length === 0) {
      container.createEl("p", {
        cls: "setting-item-description",
        text: `${providerLabel} 暂无模型，可添加或从服务端获取。`,
      });
    }

    models.forEach((model, index) => {
      const card = container.createDiv({ cls: "pocket-agent-model-card" });

      new Setting(card)
        .setName(model.name || model.id || `模型 ${index + 1}`)
        .setDesc(model.id ? `ID：${model.id}` : "未填写 ID")
        .addToggle((toggle) =>
          toggle
            .setValue(model.enabled)
            .setTooltip("是否在聊天窗口中显示")
            .onChange(async (value) => {
              model.enabled = value;
              await this.persist();
            })
        )
        .addExtraButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("删除该模型")
            .onClick(async () => {
              const position = models.indexOf(model);
              if (position >= 0) models.splice(position, 1);
              await this.persist();
              this.display();
            })
        );

      new Setting(card).setName("模型 ID").addText((text) =>
        text
          .setPlaceholder("deepseek-v4.1-flash")
          .setValue(model.id)
          .onChange(async (value) => {
            model.id = value.trim();
            await this.persist();
          })
      );

      new Setting(card).setName("名称").addText((text) =>
        text
          .setPlaceholder("DeepSeek V4.1 Flash")
          .setValue(model.name)
          .onChange(async (value) => {
            model.name = value;
            await this.persist();
          })
      );

      new Setting(card).setName("协议").addDropdown((dropdown) => {
        (Object.keys(PROTOCOL_LABELS) as ProtocolType[]).forEach((protocol) => {
          dropdown.addOption(protocol, PROTOCOL_LABELS[protocol]);
        });
        dropdown.setValue(model.protocol).onChange(async (value) => {
          model.protocol = toProtocol(value);
          await this.persist();
          this.display();
        });
      });

      new Setting(card)
        .setName("发送 temperature")
        .setDesc("关闭后不发送该参数（Claude / Kimi / GPT Luna 等需关闭）。")
        .addToggle((toggle) =>
          toggle.setValue(model.supportsTemperature !== false).onChange(async (value) => {
            model.supportsTemperature = value;
            await this.persist();
          })
        );
    });

    const actions = new Setting(container);
    actions.addButton((button) =>
      button
        .setButtonText("添加模型")
        .setCta()
        .onClick(async () => {
          models.push({
            id: "",
            name: "新模型",
            provider,
            protocol: "openai-chat",
            enabled: true,
          });
          await this.persist();
          this.display();
        })
    );
    actions.addButton((button) =>
      button
        .setButtonText("获取模型列表")
        .setTooltip("从当前服务商的 /models 接口同步最新模型")
        .onClick(async () => {
          await this.syncModelsFromProvider(provider);
        })
    );
    actions.addButton((button) =>
      button
        .setButtonText("恢复推荐模型")
        .setWarning()
        .setTooltip("用内置推荐列表替换当前服务商的模型列表")
        .onClick(async () => {
          await this.restoreRecommendedModels(provider);
        })
    );
  }

  /** 当前 provider 对应的模型列表 */
  private getProviderModels(provider: ProviderId): ModelConfig[] {
    return provider === "opencode-go" ? this.plugin.settings.opencodeModels : this.plugin.settings.deepseekModels;
  }

  /** 从服务商 /models 接口同步模型目录，仅追加尚不存在的条目 */
  private async syncModelsFromProvider(provider: ProviderId): Promise<void> {
    const settings = this.plugin.settings;
    const baseUrl = provider === "opencode-go" ? settings.opencodeBaseUrl : settings.deepseekBaseUrl;
    const apiKey = provider === "opencode-go" ? settings.opencodeApiKey : settings.deepseekApiKey;

    try {
      const remoteModels = await fetchProviderModels({ provider, baseUrl, apiKey });
      const models = this.getProviderModels(provider);
      const existingIds = new Set(models.map((model) => model.id.trim()));

      let added = 0;
      for (const remote of remoteModels) {
        const id = remote.id.trim();
        if (!id || existingIds.has(id)) continue;
        existingIds.add(id);
        models.push({
          id,
          name: remote.name || id,
          provider,
          protocol: remote.protocol,
          enabled: false,
          ...(remote.supportsTemperature ? {} : { supportsTemperature: false }),
        });
        added += 1;
      }

      await this.persist();
      new Notice(
        added > 0
          ? `新增 ${added} 个模型（默认停用，可在列表中按需启用），当前共 ${models.length} 个`
          : "模型列表已是最新"
      );
      this.display();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`获取模型列表失败：${message}`);
    }
  }

  /** 用内置推荐列表替换当前 provider 的模型列表 */
  private async restoreRecommendedModels(provider: ProviderId): Promise<void> {
    const recommended = (
      provider === "opencode-go" ? DEFAULT_SETTINGS.opencodeModels : DEFAULT_SETTINGS.deepseekModels
    ).map((model) => ({ ...model }));

    if (provider === "opencode-go") {
      this.plugin.settings.opencodeModels = recommended;
    } else {
      this.plugin.settings.deepseekModels = recommended;
    }

    new Notice("已恢复推荐模型列表");
    await this.persist();
    this.display();
  }

  /** 3) 对话：系统提示词 + 快捷指令 + 高级参数 */
  private renderChatSection(parentEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(parentEl)
      .setName("全局系统提示词")
      .setDesc("随每次请求发送。")
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area
          .setPlaceholder("你是运行在 Obsidian 中的 AI 笔记助手……")
          .setValue(settings.systemPrompt)
          .onChange(async (value) => {
            settings.systemPrompt = value;
            await this.persist();
          });
      });

    const prompts = settings.quickPrompts;
    const quickEl = this.createDetails(
      parentEl,
      `快捷指令（${prompts.length}）`,
      false,
      "pocket-agent-settings-subgroup"
    );
    this.renderQuickPromptSection(quickEl);

    const advancedEl = this.createDetails(
      parentEl,
      "高级参数",
      false,
      "pocket-agent-settings-subgroup"
    );

    new Setting(advancedEl)
      .setName("温度（temperature）")
      .setDesc("0-2，越低越稳定，越高越发散；常用 0.7。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.persist();
          })
      );

    new Setting(advancedEl)
      .setName("最大回复 token 数")
      .setDesc("单次回复上限，常用 4096。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder("4096")
          .setValue(String(settings.maxTokens))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              settings.maxTokens = parsed;
              await this.persist();
            }
          });
      });
  }

  /** 4) 快捷指令编辑（放在“对话”分组的折叠区中） */
  private renderQuickPromptSection(parentEl: HTMLElement): void {
    const prompts = this.plugin.settings.quickPrompts;

    prompts.forEach((prompt: QuickPrompt, index) => {
      const card = parentEl.createDiv({ cls: "pocket-agent-quick-prompt" });

      new Setting(card)
        .setName(prompt.label || `快捷指令 ${index + 1}`)
        .setDesc("{{selection}} 选中文本，{{note}} 当前笔记。")
        .addExtraButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("删除该快捷指令")
            .onClick(async () => {
              const position = prompts.indexOf(prompt);
              if (position >= 0) prompts.splice(position, 1);
              await this.persist();
              this.display();
            })
        );

      new Setting(card).setName("按钮文字").addText((text) =>
        text
          .setPlaceholder("✨ 润色选中")
          .setValue(prompt.label)
          .onChange(async (value) => {
            prompt.label = value;
            await this.persist();
          })
      );

      new Setting(card).setName("提示词模板").addTextArea((area) => {
        area.inputEl.rows = 3;
        area
          .setPlaceholder("请润色下面这段文字……\n\n{{selection}}")
          .setValue(prompt.prompt)
          .onChange(async (value) => {
            prompt.prompt = value;
            await this.persist();
          });
      });
    });

    new Setting(parentEl).addButton((button) =>
      button
        .setButtonText("添加快捷指令")
        .setCta()
        .onClick(async () => {
          const random = Math.random().toString(36).slice(2, 8);
          prompts.push({
            id: `prompt_${Date.now().toString(36)}_${random}`,
            label: "✨ 新指令",
            prompt: "",
          });
          await this.persist();
          this.display();
        })
    );
  }

  /** 5) 存储与 Agent */
  private renderStorageSection(parentEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(parentEl)
      .setName("会话存储路径")
      .setDesc("相对笔记库根目录。")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/pocket-agent/history")
          .setValue(settings.historyFolder)
          .onChange(async (value) => {
            settings.historyFolder = value.trim();
            await this.persist();
          })
      );

    new Setting(parentEl)
      .setName("存储格式")
      .setDesc("Markdown 会额外导出同名 .md。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("json", "JSON 数据")
          .addOption("markdown", "JSON + Markdown 文本")
          .setValue(settings.historyFormat)
          .onChange(async (value) => {
            settings.historyFormat = toHistoryFormat(value);
            await this.persist();
          })
      );

    new Setting(parentEl)
      .setName("最大历史会话数")
      .setDesc("超出后自动清理最旧的会话。")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setPlaceholder("50")
          .setValue(String(settings.maxHistorySessions))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              settings.maxHistorySessions = parsed;
              await this.persist();
            }
          });
      });

    new Setting(parentEl)
      .setName("默认开启笔记库 Agent 模式")
      .setDesc("可在聊天窗口随时切换。")
      .addToggle((toggle) =>
        toggle.setValue(settings.agentMode).onChange(async (value) => {
          settings.agentMode = value;
          await this.persist();
        })
      );

    new Setting(parentEl)
      .setName("默认附带当前笔记")
      .setDesc("发送时附带当前笔记内容。")
      .addToggle((toggle) =>
        toggle.setValue(settings.attachCurrentNote).onChange(async (value) => {
          settings.attachCurrentNote = value;
          await this.persist();
        })
      );
  }
}
