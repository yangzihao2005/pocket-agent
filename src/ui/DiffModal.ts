import { App, Modal, setIcon } from "obsidian";
import type { VaultEditRequest } from "../types";

/**
 * 笔记写入确认弹窗。
 *
 * AI 通过 propose_note_edit 工具请求修改笔记时，必须先经过这里：
 * 用户看到逐行差异并在底部点击“确认写入”后才会真正落盘。
 */

type DiffKind = "same" | "add" | "del" | "skip";

interface DiffRow {
  kind: DiffKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

interface DiffOp {
  kind: "same" | "add" | "del";
  text: string;
}

/** 超过这个规模的差异直接按“整体删除 + 整体新增”降级，避免手机端卡顿 */
const MAX_DIFF_CELLS = 800_000;
/** 未变化区块的折叠阈值（行数） */
const COLLAPSE_THRESHOLD = 7;
/** 折叠后保留的上下文行数 */
const COLLAPSE_CONTEXT = 2;

function splitLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.split("\n");
}

/** 计算逐行差异操作（先剥离公共前后缀，再对中段做 LCS） */
function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "same", text: oldLines[i] });
  }

  const middleOld = oldLines.slice(prefix, oldLines.length - suffix);
  const middleNew = newLines.slice(prefix, newLines.length - suffix);

  if (middleOld.length === 0) {
    for (const line of middleNew) ops.push({ kind: "add", text: line });
  } else if (middleNew.length === 0) {
    for (const line of middleOld) ops.push({ kind: "del", text: line });
  } else if (middleOld.length * middleNew.length > MAX_DIFF_CELLS) {
    for (const line of middleOld) ops.push({ kind: "del", text: line });
    for (const line of middleNew) ops.push({ kind: "add", text: line });
  } else {
    const rows = middleOld.length;
    const cols = middleNew.length;
    const table: Int32Array[] = [];
    for (let i = 0; i <= rows; i += 1) table.push(new Int32Array(cols + 1));

    for (let i = rows - 1; i >= 0; i -= 1) {
      const row = table[i];
      const next = table[i + 1];
      for (let j = cols - 1; j >= 0; j -= 1) {
        row[j] =
          middleOld[i] === middleNew[j]
            ? next[j + 1] + 1
            : Math.max(next[j], row[j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (middleOld[i] === middleNew[j]) {
        ops.push({ kind: "same", text: middleOld[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ kind: "del", text: middleOld[i] });
        i += 1;
      } else {
        ops.push({ kind: "add", text: middleNew[j] });
        j += 1;
      }
    }
    while (i < rows) {
      ops.push({ kind: "del", text: middleOld[i] });
      i += 1;
    }
    while (j < cols) {
      ops.push({ kind: "add", text: middleNew[j] });
      j += 1;
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    ops.push({ kind: "same", text: oldLines[oldLines.length - suffix + k] });
  }

  return ops;
}

/** 给每一行标注旧/新行号，并折叠过长的未变化区块 */
function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  const numbered: DiffRow[] = [];

  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    numbered.push({
      kind: op.kind,
      oldNo: op.kind === "add" ? null : oldNo,
      newNo: op.kind === "del" ? null : newNo,
      text: op.text,
    });
    if (op.kind !== "add") oldNo += 1;
    if (op.kind !== "del") newNo += 1;
  }

  const collapsed: DiffRow[] = [];
  let index = 0;
  while (index < numbered.length) {
    const row = numbered[index];
    if (row.kind !== "same") {
      collapsed.push(row);
      index += 1;
      continue;
    }

    let end = index;
    while (end < numbered.length && numbered[end].kind === "same") end += 1;
    const runLength = end - index;

    if (runLength > COLLAPSE_THRESHOLD) {
      for (let i = 0; i < COLLAPSE_CONTEXT; i += 1) collapsed.push(numbered[index + i]);
      const hidden = runLength - COLLAPSE_CONTEXT * 2;
      collapsed.push({
        kind: "skip",
        oldNo: null,
        newNo: null,
        text: `… 省略 ${hidden} 行未变化的内容 …`,
      });
      for (let i = end - COLLAPSE_CONTEXT; i < end; i += 1) collapsed.push(numbered[i]);
    } else {
      for (let i = index; i < end; i += 1) collapsed.push(numbered[i]);
    }
    index = end;
  }

  return collapsed;
}

export function confirmVaultEdit(app: App, request: VaultEditRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const modal = new DiffModal(app, request, resolve);
    modal.open();
  });
}

export class DiffModal extends Modal {
  private request: VaultEditRequest;
  private onResolve: (confirmed: boolean) => void;
  private settled = false;
  private confirmed = false;

  constructor(app: App, request: VaultEditRequest, onResolve: (confirmed: boolean) => void) {
    super(app);
    this.request = request;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass("pa-diff-modal");
    this.setTitle("确认写入笔记");
    this.contentEl.empty();
    this.contentEl.addClass("pa-diff-content");

    const rows = buildDiffRows(this.request.oldContent, this.request.newContent);
    const added = rows.filter((row) => row.kind === "add").length;
    const removed = rows.filter((row) => row.kind === "del").length;

    const header = this.contentEl.createDiv({ cls: "pa-diff-head" });
    const iconEl = header.createDiv({ cls: "pa-diff-icon" });
    setIcon(iconEl, "file-text");

    const headText = header.createDiv({ cls: "pa-diff-head-text" });
    headText.createDiv({ cls: "pa-diff-path", text: this.request.path });
    const meta = headText.createDiv({ cls: "pa-diff-meta" });
    meta.createSpan({
      cls: "pa-diff-mode",
      text: this.request.mode === "append" ? "追加到笔记末尾" : "整体覆盖原内容",
    });
    meta.createSpan({ cls: "pa-diff-stat pa-diff-stat-add", text: `+${added} 行` });
    meta.createSpan({ cls: "pa-diff-stat pa-diff-stat-del", text: `−${removed} 行` });

    this.contentEl.createDiv({
      cls: "pa-diff-note",
      text: "下面的内容还没有写入笔记。确认后才会保存，取消则保持原样。",
    });

    const body = this.contentEl.createDiv({ cls: "pa-diff-body" });

    if (rows.length === 0) {
      body.createDiv({ cls: "pa-diff-empty", text: "内容为空，没有可写入的文本。" });
    } else {
      const lines = body.createDiv({ cls: "pa-diff-lines" });
      for (const row of rows) {
        const rowEl = lines.createDiv({ cls: `pa-diff-row is-${row.kind}` });
        if (row.kind === "skip") {
          rowEl.createSpan({ cls: "pa-diff-skip-text", text: row.text });
          continue;
        }
        rowEl.createSpan({ cls: "pa-diff-no", text: row.oldNo === null ? "" : String(row.oldNo) });
        rowEl.createSpan({ cls: "pa-diff-no", text: row.newNo === null ? "" : String(row.newNo) });
        rowEl.createSpan({
          cls: "pa-diff-mark",
          text: row.kind === "add" ? "+" : row.kind === "del" ? "−" : "",
        });
        rowEl.createSpan({ cls: "pa-diff-text", text: row.text.length ? row.text : " " });
      }
    }

    const footer = this.contentEl.createDiv({ cls: "pa-diff-footer" });
    const cancelButton = footer.createEl("button", {
      cls: "pa-diff-btn pa-diff-btn-cancel",
      text: "取消",
      attr: { type: "button" },
    });
    cancelButton.addEventListener("click", () => {
      this.confirmed = false;
      this.close();
    });

    const confirmButton = footer.createEl("button", {
      cls: "pa-diff-btn pa-diff-btn-confirm",
      text: "✅ 确认写入",
      attr: { type: "button" },
    });
    confirmButton.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });

    window.setTimeout(() => confirmButton.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
    this.contentEl.removeClass("pa-diff-content");
    if (!this.settled) {
      this.settled = true;
      this.onResolve(this.confirmed);
    }
  }
}
