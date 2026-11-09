import { App, PluginSettingTab, Setting } from "obsidian";
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
    { id: "deepseek-chat", name: "DeepSeek V3 对话", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "deepseek-reasoner", name: "DeepSeek R1 推理", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "glm-4.6", name: "GLM 4.6 通用", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "qwen3-coder", name: "Qwen3 Coder 编程", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "kimi-k2", name: "Kimi K2 长文本", provider: "opencode-go", protocol: "openai-chat", enabled: true },
    { id: "minimax-m2", name: "MiniMax M2 推理", provider: "opencode-go", protocol: "anthropic-messages", enabled: true },
  ],
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com/v1",
  deepseekModels: [
    { id: "deepseek-chat", name: "DeepSeek V3 对话", provider: "deepseek", protocol: "openai-chat", enabled: true },
    { id: "deepseek-reasoner", name: "DeepSeek R1 推理", provider: "deepseek", protocol: "openai-chat", enabled: true },
  ],
  selectedModelId: "opencode-go:deepseek-chat",
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
      text: "移动端优先的 AI 对话与笔记 Agent 插件。所有密钥仅保存在本地插件数据中。",
    });

    this.renderOpenCodeSection();
    this.renderDeepSeekSection();
    this.renderModelAndPromptSection();
    this.renderQuickPromptSection();
    this.renderSessionSection();
  }

  /** 保存设置（统一入口） */
  private async persist(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private addSectionHeading(title: string, description?: string): void {
    new Setting(this.containerEl).setName(title).setHeading();
    if (description) {
      this.containerEl.createEl("p", { cls: "setting-item-description", text: description });
    }
  }

  /** 1) OpenCode Go 专区 */
  private renderOpenCodeSection(): void {
    const settings = this.plugin.settings;
    this.addSectionHeading(
      "OpenCode Go",
      "OpenCode Go 使用原生 ses_ 会话头，移动端推荐 requestUrl 免跨域直连。"
    );

    new Setting(this.containerEl)
      .setName("API Key")
      .setDesc("OpenCode Go 访问密钥，留空则无法发起请求。")
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

    new Setting(this.containerEl)
      .setName("Base URL")
      .setDesc("默认 https://opencode.ai/zen/go/v1，末尾无需斜杠。")
      .addText((text) =>
        text
          .setPlaceholder("https://opencode.ai/zen/go/v1")
          .setValue(settings.opencodeBaseUrl)
          .onChange(async (value) => {
            settings.opencodeBaseUrl = value.trim();
            await this.persist();
          })
      );

    new Setting(this.containerEl)
      .setName("请求模式")
      .setDesc(
        "requestUrl 免跨域直连：使用 Obsidian 原生请求，移动端最稳定；fetch 流式输出：逐字显示回复，但要求接口允许跨域，网络层失败时会自动降级为 requestUrl。"
      )
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

    this.renderModelList(settings.opencodeModels, "opencode-go", "OpenCode Go");
  }

  /** 2) DeepSeek / 自定义 OpenAI 专区 */
  private renderDeepSeekSection(): void {
    const settings = this.plugin.settings;
    this.addSectionHeading(
      "DeepSeek / 自定义 OpenAI",
      "兼容 OpenAI 接口的第三方服务也可填入自定义 Base URL。"
    );

    new Setting(this.containerEl)
      .setName("API Key")
      .setDesc("DeepSeek 或自定义 OpenAI 兼容服务的访问密钥。")
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

    new Setting(this.containerEl)
      .setName("Base URL")
      .setDesc("默认 https://api.deepseek.com/v1，末尾无需斜杠。")
      .addText((text) =>
        text
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(settings.deepseekBaseUrl)
          .onChange(async (value) => {
            settings.deepseekBaseUrl = value.trim();
            await this.persist();
          })
      );

    this.renderModelList(settings.deepseekModels, "deepseek", "DeepSeek");
  }

  /** 模型列表管理：id / 名称 / 协议 / 启用 / 删除 */
  private renderModelList(models: ModelConfig[], provider: ProviderId, providerLabel: string): void {
    const container = this.containerEl.createDiv({ cls: "pocket-agent-model-list" });
    new Setting(container)
      .setName(`${providerLabel} 模型列表`)
      .setDesc("至少保留一个启用的模型，聊天窗口顶部会列出所有启用模型。");

    models.forEach((model, index) => {
      const card = container.createDiv({ cls: "pocket-agent-model-card" });

      new Setting(card)
        .setName(model.name || model.id || `模型 ${index + 1}`)
        .setDesc(`ID：${model.id || "未填写"}　状态：${model.enabled ? "已启用" : "已停用"}`)
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

      new Setting(card)
        .setName("模型 ID")
        .setDesc("发送给服务端的 model 字段。")
        .addText((text) =>
          text
            .setPlaceholder("deepseek-chat")
            .setValue(model.id)
            .onChange(async (value) => {
              model.id = value.trim();
              await this.persist();
            })
        );

      new Setting(card)
        .setName("显示名称")
        .setDesc("聊天窗口模型下拉中的展示文字。")
        .addText((text) =>
          text
            .setPlaceholder("DeepSeek V3 对话")
            .setValue(model.name)
            .onChange(async (value) => {
              model.name = value;
              await this.persist();
            })
        );

      new Setting(card)
        .setName("协议类型")
        .setDesc("不同协议对应不同端点与请求体格式。")
        .addDropdown((dropdown) => {
          (Object.keys(PROTOCOL_LABELS) as ProtocolType[]).forEach((protocol) => {
            dropdown.addOption(protocol, PROTOCOL_LABELS[protocol]);
          });
          dropdown.setValue(model.protocol).onChange(async (value) => {
            model.protocol = toProtocol(value);
            await this.persist();
            this.display();
          });
        });
    });

    new Setting(container).addButton((button) =>
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
  }

  /** 3) 模型与提示词 */
  private renderModelAndPromptSection(): void {
    const settings = this.plugin.settings;
    this.addSectionHeading("模型与提示词", "默认模型与全局系统提示词，对新的对话立即生效。");

    const enabledModels = this.plugin.getAllModels();

    new Setting(this.containerEl)
      .setName("默认模型")
      .setDesc("新建对话时默认使用，可在聊天窗口顶部随时切换。")
      .addDropdown((dropdown) => {
        enabledModels.forEach((model) => {
          const key = `${model.provider}:${model.id}`;
          dropdown.addOption(key, `${model.name || model.id}（${model.provider === "opencode-go" ? "OpenCode Go" : "DeepSeek"}）`);
        });

        const current = settings.selectedModelId;
        const currentKnown = enabledModels.some((model) => `${model.provider}:${model.id}` === current);
        if (current && !currentKnown) {
          dropdown.addOption(current, `${current}（当前未启用）`);
        }
        if (!current && enabledModels.length === 0) {
          dropdown.addOption("", "暂无可用模型，请先在下方启用");
        }

        const fallback = enabledModels.length > 0 ? `${enabledModels[0].provider}:${enabledModels[0].id}` : "";
        dropdown.setValue(current || fallback).onChange(async (value) => {
          settings.selectedModelId = value;
          await this.persist();
        });
      });

    new Setting(this.containerEl)
      .setName("全局系统提示词")
      .setDesc("定义 AI 的角色、语言与回复风格，会随每次请求发送。")
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area
          .setPlaceholder("你是运行在 Obsidian 中的 AI 笔记助手……")
          .setValue(settings.systemPrompt)
          .onChange(async (value) => {
            settings.systemPrompt = value;
            await this.persist();
          });
      });

    new Setting(this.containerEl)
      .setName("温度（temperature）")
      .setDesc("0-2，数值越低越稳定严谨，越高越发散有创意。常用 0.7。")
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

    new Setting(this.containerEl)
      .setName("最大回复 token 数")
      .setDesc("单次回复上限，常用 4096；长文写作可适当调高。")
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

  /** 4) 快捷指令 */
  private renderQuickPromptSection(): void {
    const prompts = this.plugin.settings.quickPrompts;
    this.addSectionHeading(
      "快捷指令胶囊",
      "显示在聊天输入框上方，可在提示词中使用 {{selection}}（选中文本）与 {{note}}（当前笔记）占位符。"
    );

    prompts.forEach((prompt: QuickPrompt, index) => {
      const card = this.containerEl.createDiv({ cls: "pocket-agent-quick-prompt" });

      new Setting(card)
        .setName(`快捷指令 ${index + 1}`)
        .setDesc(prompt.label || "未命名按钮")
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

      new Setting(card)
        .setName("按钮文字")
        .setDesc("建议保留一个 emoji 前缀，便于移动端快速识别。")
        .addText((text) =>
          text
            .setPlaceholder("✨ 润色选中")
            .setValue(prompt.label)
            .onChange(async (value) => {
              prompt.label = value;
              await this.persist();
            })
        );

      new Setting(card)
        .setName("提示词模板")
        .setDesc("支持 {{selection}} 与 {{note}} 占位符。")
        .addTextArea((area) => {
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

    new Setting(this.containerEl).addButton((button) =>
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

  /** 5) 会话与 Agent */
  private renderSessionSection(): void {
    const settings = this.plugin.settings;
    this.addSectionHeading("会话与 Agent", "历史记录通过 Vault 适配器读写，不会使用任何 Node.js 文件接口。");

    new Setting(this.containerEl)
      .setName("会话存储路径")
      .setDesc("相对笔记库根目录，默认 .obsidian/plugins/pocket-agent/history。")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/plugins/pocket-agent/history")
          .setValue(settings.historyFolder)
          .onChange(async (value) => {
            settings.historyFolder = value.trim();
            await this.persist();
          })
      );

    new Setting(this.containerEl)
      .setName("存储格式")
      .setDesc("JSON 便于程序读取；Markdown 会额外导出同名 .md 可读文本。")
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

    new Setting(this.containerEl)
      .setName("最大历史会话数")
      .setDesc("超出后按更新时间自动清理最旧的会话。")
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

    new Setting(this.containerEl)
      .setName("默认开启笔记库 Agent 模式")
      .setDesc("开启后 AI 可搜索、读取笔记，并在你确认差异后写入笔记。")
      .addToggle((toggle) =>
        toggle.setValue(settings.agentMode).onChange(async (value) => {
          settings.agentMode = value;
          await this.persist();
        })
      );

    new Setting(this.containerEl)
      .setName("默认附带当前笔记")
      .setDesc("发送消息时自动附带当前激活笔记的标题与内容作为上下文。")
      .addToggle((toggle) =>
        toggle.setValue(settings.attachCurrentNote).onChange(async (value) => {
          settings.attachCurrentNote = value;
          await this.persist();
        })
      );
  }
}
