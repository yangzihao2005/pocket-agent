import { App, TFile, normalizePath } from "obsidian";
import type { ToolCall, ToolDefinition, ToolExecutionResult, VaultEditRequest } from "../types";

/** 搜索结果最多返回条数 */
const MAX_SEARCH_RESULTS = 5;
/** 单个笔记读取时返回给模型的最大字符数，避免撑爆上下文 */
const MAX_NOTE_CHARS = 60_000;
/** 搜索时单文件参与匹配的最大字符数 */
const MAX_SCAN_CHARS = 200_000;
/** 并发读取文件的批次大小 */
const SCAN_BATCH_SIZE = 24;

/** 笔记库工具的 OpenAI Function Calling Schema */
export const VAULT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_vault_notes",
      description:
        "在用户 Obsidian 笔记库中按关键词搜索笔记。会匹配文件名与正文内容，返回相关性最高的前 5 篇笔记的路径、标题与摘要片段。需要先了解笔记库内容时优先调用。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词，可以是多个词，用空格分隔。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note_content",
      description: "读取指定路径笔记的完整 Markdown 内容。路径必须来自 search_vault_notes 的返回结果或用户明确指定的文件。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "笔记在 Vault 中的相对路径，例如 '项目/周报.md'。",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_note_edit",
      description:
        "向用户提出修改或追加笔记的建议。不会直接写入文件：插件会弹出差异对比窗口，只有用户点击确认后才会真正保存。修改已有笔记前应先调用 read_note_content。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "目标笔记的相对路径。文件不存在时会在用户确认后新建。",
          },
          content: {
            type: "string",
            description: "mode 为 overwrite 时是完整的新内容；mode 为 append 时是要追加的文本片段。",
          },
          mode: {
            type: "string",
            description: "overwrite 表示用 content 整体替换笔记；append 表示追加到笔记末尾。",
            enum: ["append", "overwrite"],
          },
        },
        required: ["path", "content", "mode"],
        additionalProperties: false,
      },
    },
  },
];

/** 笔记编辑确认回调（由 UI 层提供 DiffModal 实现） */
export type EditConfirmationHandler = (request: VaultEditRequest) => Promise<boolean>;

interface SearchResultItem {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

/** 解析工具参数 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 提取摘要片段 */
function buildSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) {
    return content.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * 笔记库 Agent 工具集：全程仅使用 Obsidian Vault API，无任何 Node.js 依赖。
 */
export class VaultTools {
  private app: App;
  private confirmEdit: EditConfirmationHandler;

  constructor(app: App, confirmEdit: EditConfirmationHandler) {
    this.app = app;
    this.confirmEdit = confirmEdit;
  }

  /** 执行一个工具调用，返回给模型的文本结果 */
  async execute(call: ToolCall): Promise<ToolExecutionResult> {
    const args = parseArgs(call.arguments);
    switch (call.name) {
      case "search_vault_notes":
        return this.searchNotes(String(args.query ?? ""));
      case "read_note_content":
        return this.readNote(String(args.path ?? ""));
      case "propose_note_edit":
        return this.proposeNoteEdit(
          String(args.path ?? ""),
          String(args.content ?? ""),
          args.mode === "append" ? "append" : "overwrite"
        );
      default:
        return { content: `未知工具：${call.name}`, isError: true };
    }
  }

  /** 遍历 Vault 中所有 Markdown 笔记，按文件名与正文相关性排序 */
  private async searchNotes(query: string): Promise<ToolExecutionResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { content: "搜索关键词为空，请提供 query。", isError: true };
    }

    const terms = trimmed
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) {
      return { content: "搜索关键词为空，请提供 query。", isError: true };
    }

    const files = this.app.vault.getMarkdownFiles();
    const results: SearchResultItem[] = [];

    for (let start = 0; start < files.length; start += SCAN_BATCH_SIZE) {
      const batch = files.slice(start, start + SCAN_BATCH_SIZE);
      const scanned = await Promise.all(
        batch.map(async (file) => {
          const fileName = file.basename.toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (fileName.includes(term)) score += 12;
            if (fileName === term) score += 20;
            if (file.path.toLowerCase().includes(term)) score += 2;
          }

          let content = "";
          try {
            content = await this.app.vault.cachedRead(file);
          } catch {
            return null;
          }
          const lower = content.slice(0, MAX_SCAN_CHARS).toLowerCase();
          for (const term of terms) {
            let cursor = 0;
            let occurrences = 0;
            while (occurrences < 20) {
              const found = lower.indexOf(term, cursor);
              if (found === -1) break;
              occurrences += 1;
              cursor = found + term.length;
            }
            score += occurrences * 2;
          }

          if (score <= 0) return null;
          return {
            path: file.path,
            title: file.basename,
            score,
            snippet: buildSnippet(content, terms),
          } satisfies SearchResultItem;
        })
      );

      for (const item of scanned) {
        if (item) results.push(item);
      }
    }

    if (results.length === 0) {
      return { content: `没有找到与“${trimmed}”相关的笔记。`, isError: false };
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, MAX_SEARCH_RESULTS);
    const payload = top.map((item, index) => ({
      rank: index + 1,
      title: item.title,
      path: item.path,
      snippet: item.snippet,
    }));
    return { content: JSON.stringify(payload, null, 2), isError: false };
  }

  /** 读取指定路径笔记的完整内容 */
  private async readNote(path: string): Promise<ToolExecutionResult> {
    const normalized = normalizePath(path.trim());
    if (!normalized) {
      return { content: "笔记路径为空。", isError: true };
    }
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      return { content: `未找到笔记：${normalized}`, isError: true };
    }
    try {
      const content = await this.app.vault.cachedRead(file);
      if (content.length > MAX_NOTE_CHARS) {
        return {
          content: `${content.slice(0, MAX_NOTE_CHARS)}\n\n[内容过长，已截断。原文件共 ${content.length} 字符]`,
          isError: false,
        };
      }
      return { content: content || "(空笔记)", isError: false };
    } catch (error) {
      return { content: `读取失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }

  /** 提出笔记编辑建议，必须经用户 DiffModal 确认后才落盘 */
  private async proposeNoteEdit(path: string, content: string, mode: "append" | "overwrite"): Promise<ToolExecutionResult> {
    const normalized = normalizePath(path.trim());
    if (!normalized) {
      return { content: "笔记路径为空。", isError: true };
    }

    const file = this.app.vault.getAbstractFileByPath(normalized);
    let oldContent = "";
    if (file instanceof TFile) {
      try {
        oldContent = await this.app.vault.cachedRead(file);
      } catch (error) {
        return { content: `读取目标笔记失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    } else if (file) {
      return { content: `目标路径不是文件：${normalized}`, isError: true };
    }

    const newContent = mode === "append" ? `${oldContent}${oldContent.endsWith("\n") || oldContent === "" ? "" : "\n"}\n${content}` : content;

    const confirmed = await this.confirmEdit({ path: normalized, oldContent, newContent, mode });
    if (!confirmed) {
      return { content: `用户拒绝了写入 ${normalized} 的修改，文件未发生变化。`, isError: false };
    }

    try {
      if (file instanceof TFile) {
        await this.app.vault.modify(file, newContent);
      } else {
        await this.ensureParentFolder(normalized);
        await this.app.vault.create(normalized, newContent);
      }
      const verb = mode === "append" ? "追加" : "写入";
      return { content: `已成功${verb}笔记：${normalized}`, isError: false };
    } catch (error) {
      return { content: `写入失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }

  /** 确保新文件的父目录存在 */
  private async ensureParentFolder(filePath: string): Promise<void> {
    const slashIndex = filePath.lastIndexOf("/");
    if (slashIndex <= 0) return;
    const folderPath = filePath.slice(0, slashIndex);
    const segments = folderPath.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // 目录可能已被并发创建，忽略
        }
      }
    }
  }
}
