// Copilot-style review of agent edits: edits land on disk right away, and each changed
// file keeps its pre-edit snapshot until you Keep or Undo it (per file or per hunk).
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const ORIGINAL = "bitsmith-original";

// The path as VS Code spells it (uri.fsPath). On Windows the CLI says "C:\x" or "C:/x" where VS Code says "c:\x".
const norm = (file) => vscode.Uri.file(path.resolve(file)).fsPath;

// Line diff -> hunks {oStart, oEnd, nStart, nEnd} (half-open line ranges).
function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  // ponytail: plain LCS table on the changed middle; past ~4M cells the middle is one big hunk. Myers diff if that bites.
  if (A.length * B.length > 4e6) return [{ oStart: pre, oEnd: pre + A.length, nStart: pre, nEnd: pre + B.length }];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); i++; j++; continue; }
    cur ??= { oStart: pre + i, oEnd: pre + i, nStart: pre + j, nEnd: pre + j };
    if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { j++; cur.nEnd = pre + j; }
    else { i++; cur.oEnd = pre + i; }
  }
  flush();
  return hunks;
}

const lines = (text) => (text === "" ? [] : text.split("\n"));

function stats(hunks) {
  let added = 0, removed = 0;
  for (const h of hunks) { added += h.nEnd - h.nStart; removed += h.oEnd - h.oStart; }
  return { added, removed };
}

class EditTracker {
  constructor(onChange) {
    this.snapshots = new Map(); // abs path -> original text, or null if the agent created the file
    this.onChange = onChange; // (files) => void, for the chat's "N files changed" bar
    this.lensEmitter = new vscode.EventEmitter();
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: new vscode.ThemeColor("editorGutter.deletedBackground"),
      borderStyle: "solid",
      borderWidth: "2px 0 0 0",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    // What a hunk replaced or removed, as faded text after its first line; the full old lines are in the hover.
    // ponytail: editors can't show real deleted lines without a diff view, so it's an inline hint plus a hover diff.
    this.was = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor("editorGutter.deletedBackground"), fontStyle: "italic", margin: "0 0 0 2.5em" },
    });
  }

  register(context) {
    context.subscriptions.push(
      this.added, this.removed, this.was,
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL, {
        provideTextDocumentContent: (uri) => this.snapshots.get(vscode.Uri.file(uri.path).fsPath) ?? "",
      }),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: (doc) => this.lenses(doc),
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.snapshots.has(e.document.uri.fsPath)) this.refresh();
      }),
      vscode.commands.registerCommand("bitsmith.keepFile", (file) => this.keep(file)),
      vscode.commands.registerCommand("bitsmith.undoFile", (file) => this.undo(file)),
      vscode.commands.registerCommand("bitsmith.keepHunk", (file, h) => this.keepHunk(file, h)),
      vscode.commands.registerCommand("bitsmith.undoHunk", (file, h) => this.undoHunk(file, h)),
      vscode.commands.registerCommand("bitsmith.diffFile", (file) => this.showDiff(file)),
    );
  }

  // Call before the agent writes a file; the first snapshot wins until kept or undone.
  snapshot(file) {
    file = norm(file);
    if (this.snapshots.has(file)) return;
    try { this.snapshots.set(file, fs.readFileSync(file, "utf8")); } catch { this.snapshots.set(file, null); }
  }

  current(file) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (open) return open.getText();
    try { return fs.readFileSync(file, "utf8"); } catch { return null; }
  }

  hunks(file) {
    const before = this.snapshots.get(file), after = this.current(file);
    return diffLines(lines(before ?? ""), lines(after ?? ""));
  }

  files() {
    const out = [];
    for (const file of this.snapshots.keys()) {
      const h = this.hunks(file);
      if (!h.length && this.current(file) !== null) { this.snapshots.delete(file); continue; } // nothing left to review
      out.push({ file, ...stats(h), created: this.snapshots.get(file) === null, deleted: this.current(file) === null });
    }
    return out;
  }

  statsFor(file) {
    return this.snapshots.has(file) ? stats(this.hunks(file)) : null;
  }

  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.decorate();
      this.lensEmitter.fire();
      this.onChange(this.files());
    }, 100);
  }

  decorate() {
    for (const editor of vscode.window.visibleTextEditors) {
      const file = editor.document.uri.fsPath;
      if (!this.snapshots.has(file)) { for (const d of [this.added, this.removed, this.was]) editor.setDecorations(d, []); continue; }
      const add = [], del = [], was = [];
      const last = editor.document.lineCount - 1;
      const old = lines(this.snapshots.get(file) ?? "");
      for (const h of this.hunks(file)) {
        if (h.nEnd > h.nStart) add.push(new vscode.Range(h.nStart, 0, Math.min(h.nEnd - 1, last), 0));
        else if (h.oEnd > h.oStart) del.push(new vscode.Range(Math.min(h.nStart, last), 0, Math.min(h.nStart, last), 0));
        if (h.oEnd <= h.oStart) continue;
        const gone = old.slice(h.oStart, h.oEnd);
        const at = Math.max(0, Math.min(h.nEnd > h.nStart ? h.nStart : h.nStart - 1, last));
        const label = gone.length === 1 ? `− was: ${gone[0].trim().slice(0, 120)}` : `− ${gone.length} lines ${h.nEnd > h.nStart ? "replaced" : "removed"} (hover to see them)`;
        const hover = new vscode.MarkdownString(`**Bitsmith changed this.** Before:\n\n\`\`\`diff\n${gone.slice(0, 60).map((l) => "- " + l).join("\n")}${gone.length > 60 ? `\n… ${gone.length - 60} more` : ""}\n\`\`\``);
        was.push({ range: new vscode.Range(at, Number.MAX_SAFE_INTEGER, at, Number.MAX_SAFE_INTEGER), hoverMessage: hover, renderOptions: { after: { contentText: label } } });
      }
      editor.setDecorations(this.added, add);
      editor.setDecorations(this.removed, del);
      editor.setDecorations(this.was, was);
    }
  }

  lenses(doc) {
    const file = doc.uri.fsPath;
    if (!this.snapshots.has(file)) return [];
    const hunks = this.hunks(file);
    const top = new vscode.Range(0, 0, 0, 0);
    const out = [
      new vscode.CodeLens(top, { title: `$(sparkle) Bitsmith: ${hunks.length} change${hunks.length === 1 ? "" : "s"}`, command: "bitsmith.diffFile", arguments: [file] }),
      new vscode.CodeLens(top, { title: "$(check) Keep all", command: "bitsmith.keepFile", arguments: [file] }),
      new vscode.CodeLens(top, { title: "$(discard) Undo all", command: "bitsmith.undoFile", arguments: [file] }),
    ];
    for (const h of hunks) {
      const at = new vscode.Range(Math.min(h.nStart, doc.lineCount - 1), 0, Math.min(h.nStart, doc.lineCount - 1), 0);
      out.push(
        new vscode.CodeLens(at, { title: "$(check) Keep", command: "bitsmith.keepHunk", arguments: [file, h] }),
        new vscode.CodeLens(at, { title: "$(discard) Undo", command: "bitsmith.undoHunk", arguments: [file, h] }),
      );
    }
    return out;
  }

  keep(file) {
    if (file) this.snapshots.delete(file); else this.snapshots.clear();
    this.refresh();
  }

  async undo(file) {
    for (const f of file ? [file] : [...this.snapshots.keys()]) {
      const original = this.snapshots.get(f);
      this.snapshots.delete(f);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f);
      if (original === null) {
        try { fs.unlinkSync(f); } catch {}
        continue;
      }
      if (doc) {
        await this.replaceText(doc, original);
      } else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, original);
      }
    }
    this.refresh();
  }

  // Accept one hunk: fold it into the snapshot so it stops showing as a change.
  keepHunk(file, h) {
    const before = lines(this.snapshots.get(file) ?? ""), after = lines(this.current(file) ?? "");
    this.snapshots.set(file, [...before.slice(0, h.oStart), ...after.slice(h.nStart, h.nEnd), ...before.slice(h.oEnd)].join("\n"));
    this.refresh();
  }

  async undoHunk(file, h) {
    const before = lines(this.snapshots.get(file) ?? "");
    const doc = await vscode.workspace.openTextDocument(file);
    const after = lines(doc.getText());
    await this.replaceText(doc, [...after.slice(0, h.nStart), ...before.slice(h.oStart, h.oEnd), ...after.slice(h.nEnd)].join("\n"));
    this.refresh();
  }

  // The CLI writes files itself; if VS Code's watcher misses that (large workspaces), the open
  // editor keeps showing the old text. Push the disk version into any clean editor.
  async syncFromDisk(file) {
    if (!file) return;
    file = norm(file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (!doc) return;
    let disk;
    try { disk = fs.readFileSync(file, "utf8"); } catch { return; }
    if (doc.getText() === disk) return;
    if (doc.isDirty) {
      vscode.window.showWarningMessage(`Bitsmith changed ${path.basename(file)} on disk, but the editor has unsaved changes.`, "Use agent's version").then((pick) => pick && this.replaceText(doc, disk));
      return;
    }
    await this.replaceText(doc, disk);
  }

  async replaceText(doc, text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount + 1, 0)), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  showDiff(file) {
    const left = vscode.Uri.from({ scheme: ORIGINAL, path: vscode.Uri.file(file).path });
    vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(file), `${path.basename(file)} (Bitsmith changes)`);
  }
}

module.exports = { EditTracker, diffLines, lines, stats, norm };
