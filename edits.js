// Copilot-style review of agent edits: edits land on disk right away, and each changed
// file keeps its pre-edit snapshot until you Keep or Undo it (per file or per hunk).
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
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
  const ops = myers(A, B);
  // ponytail: past MAX_D changed lines the middle is one big hunk; nobody reviews line by line at that size anyway.
  if (!ops) return [{ oStart: pre, oEnd: pre + A.length, nStart: pre, nEnd: pre + B.length }];
  const hunks = [];
  let i = 0, j = 0, cur = null;
  for (const op of ops) {
    if (!op) { if (cur) { hunks.push(cur); cur = null; } i++; j++; continue; }
    cur ??= { oStart: pre + i, oEnd: pre + i, nStart: pre + j, nEnd: pre + j };
    if (op > 0) cur.nEnd = pre + ++j;
    else cur.oEnd = pre + ++i;
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Myers' O((N+M)·D) diff: work grows with the lines changed, not the file size (a big file edited at its top and
// bottom stays cheap). Returns the edit script in order (0 keep, 1 insert from b, -1 delete from a), or null past MAX_D.
const MAX_D = 2000;
function myers(a, b) {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_D), off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice()); // the furthest reach after d-1 edits, to walk back through
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x < n || y < m) continue;
      const ops = [];
      for (let e = d; e > 0; e--) {
        const t = trace[e], kk = x - y;
        const down = kk === -e || (kk !== e && t[off + kk - 1] < t[off + kk + 1]);
        const px = t[off + (down ? kk + 1 : kk - 1)], py = px - (down ? kk + 1 : kk - 1);
        for (; x > px + (down ? 0 : 1); x--, y--) ops.push(0);
        ops.push(down ? 1 : -1);
        x = px; y = py;
      }
      for (; x > 0; x--) ops.push(0);
      return ops.reverse();
    }
  }
  return null;
}

const lines = (text) => (text === "" ? [] : text.split("\n"));

// Binary the way git decides it: a NUL byte in the first 8 KB. Such files (images, say) have no lines,
// so they're snapshotted as bytes, reviewed by size and opened in their own viewer.
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const readSnapshot = (buf) => (isBinary(buf) ? buf : buf.toString("utf8"));

// SCM menu arguments -> paths: resource states (one, or the selection), or a whole group.
const scmFiles = (args) => args.flat().flatMap((x) => x?.resourceStates || [x]).filter((x) => x?.resourceUri).map((x) => x.resourceUri.fsPath);

function stats(hunks) {
  let added = 0, removed = 0;
  for (const h of hunks) { added += h.nEnd - h.nStart; removed += h.oEnd - h.oStart; }
  return { added, removed };
}

class EditTracker {
  constructor(onChange) {
    this.snapshots = new Map(); // abs path -> original text (a Buffer if binary), or null if the agent created the file
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
      // A multi-file diff mounts an editor per file as it scrolls: one pass per burst, not per editor.
      vscode.window.onDidChangeVisibleTextEditors(() => { clearTimeout(this.decoTimer); this.decoTimer = setTimeout(() => this.decorate(), 100); }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.snapshots.has(e.document.uri.fsPath)) this.refresh();
      }),
      vscode.commands.registerCommand("bitsmith.keepFile", (file) => this.keep(file)),
      vscode.commands.registerCommand("bitsmith.undoFile", (file) => this.undo(file)),
      vscode.commands.registerCommand("bitsmith.keepHunk", (file, h) => this.keepHunk(file, h)),
      vscode.commands.registerCommand("bitsmith.undoHunk", (file, h) => this.undoHunk(file, h)),
      vscode.commands.registerCommand("bitsmith.diffFile", (file) => this.showDiff(file)),
      // Source Control view: a row's or a group's inline Keep / Undo, for the clicked or selected rows
      vscode.commands.registerCommand("bitsmith.scmKeep", (...a) => this.keep(scmFiles(a))),
      vscode.commands.registerCommand("bitsmith.scmUndo", (...a) => this.undo(scmFiles(a))),
      { dispose: () => this.sc?.dispose() },
    );
  }

  // The files waiting for Keep / Undo also show in the Source Control view, while there are any.
  showInScm(files) {
    if (!files.length) { this.sc?.dispose(); this.sc = null; return; }
    if (!this.sc) {
      this.sc = vscode.scm.createSourceControl("bitsmith", "Bitsmith");
      this.group = this.sc.createResourceGroup("changes", "Agent changes");
    }
    this.sc.count = files.length;
    this.group.resourceStates = files.map((f) => ({
      resourceUri: vscode.Uri.file(f.file),
      command: { title: "Show changes", command: "bitsmith.diffFile", arguments: [f.file] },
      decorations: { strikeThrough: f.deleted, tooltip: f.created ? "Created by Bitsmith" : f.deleted ? "Deleted by Bitsmith" : f.binary ? "Changed by Bitsmith" : `Changed by Bitsmith: +${f.added} -${f.removed}` },
    }));
  }

  // Call before the agent writes a file; the first snapshot wins until kept or undone.
  snapshot(file) {
    file = norm(file);
    if (this.snapshots.has(file)) return;
    try { this.snapshots.set(file, readSnapshot(fs.readFileSync(file))); } catch { this.snapshots.set(file, null); }
  }

  // Same, when the pre-change text is already known (a shell command's file, from a git snapshot taken before it ran).
  snapshotText(file, text) {
    file = norm(file);
    if (!this.snapshots.has(file)) this.snapshots.set(file, Buffer.isBuffer(text) ? readSnapshot(text) : text);
  }

  // Snapshots as JSON-safe values (binary as base64), so pending reviews survive a window reload.
  dump() {
    return Object.fromEntries([...this.snapshots].map(([f, v]) => [f, Buffer.isBuffer(v) ? { b: v.toString("base64") } : v]));
  }

  load(saved) {
    for (const [f, v] of Object.entries(saved || {})) if (!this.snapshots.has(f)) this.snapshots.set(f, v && typeof v === "object" ? Buffer.from(v.b, "base64") : v);
  }

  bytes(file) {
    try { return fs.readFileSync(file); } catch { return null; }
  }

  // Bytes before and after, if either side is binary; null for a text file.
  binary(file) {
    const before = this.snapshots.get(file), after = this.bytes(file);
    if (!Buffer.isBuffer(before) && !(after && isBinary(after))) return null;
    return { before: before == null ? null : Buffer.from(before), after };
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
      const bin = this.binary(file);
      if (bin) {
        if (bin.before && bin.after?.equals(bin.before)) { this.snapshots.delete(file); continue; }
        out.push({ file, added: 0, removed: 0, binary: true, before: bin.before?.length ?? null, after: bin.after?.length ?? null, created: !bin.before, deleted: !bin.after });
        continue;
      }
      const h = this.hunks(file);
      if (!h.length && this.current(file) !== null && this.snapshots.get(file) !== null) { this.snapshots.delete(file); continue; } // nothing left to review (a created empty file still is)
      out.push({ file, ...stats(h), created: this.snapshots.get(file) === null, deleted: this.current(file) === null });
    }
    return out;
  }

  statsFor(file) {
    if (!this.snapshots.has(file)) return null;
    return this.binary(file) ? { added: 0, removed: 0 } : stats(this.hunks(file));
  }

  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.decorate();
      this.lensEmitter.fire();
      const files = this.files();
      this.showInScm(files);
      this.onChange(files);
    }, 100);
  }

  decorate() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== "file") continue; // diff sides (original, proposed) share the file's path
      const file = editor.document.uri.fsPath;
      if (!this.snapshots.has(file) || this.binary(file)) { for (const d of [this.added, this.removed, this.was]) editor.setDecorations(d, []); continue; }
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
    if (!this.snapshots.has(file) || this.binary(file)) return [];
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
        new vscode.CodeLens(at, { title: "$(check) Keep", command: "bitsmith.keepHunk", arguments: [file, { ...h, key: this.hunkKey(file, h) }] }),
        new vscode.CodeLens(at, { title: "$(discard) Undo", command: "bitsmith.undoHunk", arguments: [file, { ...h, key: this.hunkKey(file, h) }] }),
      );
    }
    return out;
  }

  // One file, a list of files (a chat's own), or with nothing given, every file.
  keep(file) {
    for (const f of Array.isArray(file) ? file : file ? [file] : [...this.snapshots.keys()]) this.snapshots.delete(f);
    this.refresh();
  }

  async undo(file) {
    for (const f of Array.isArray(file) ? file : file ? [file] : [...this.snapshots.keys()]) {
      if (!this.snapshots.has(f)) continue;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === f);
      if (doc?.isDirty && !(await vscode.window.showWarningMessage(`${path.basename(f)} has unsaved changes. Undo puts it back to how it was before Bitsmith changed it, so they'd be lost too.`, { modal: true }, "Undo anyway"))) continue;
      const original = this.snapshots.get(f);
      this.snapshots.delete(f);
      if (original === null) {
        try { fs.unlinkSync(f); } catch {}
        continue;
      }
      if (doc && !Buffer.isBuffer(original)) {
        await this.replaceText(doc, original);
      } else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, original);
      }
    }
    this.refresh();
  }

  hunkKey(file, h) {
    return JSON.stringify([lines(this.snapshots.get(file) ?? "").slice(h.oStart, h.oEnd), lines(this.current(file) ?? "").slice(h.nStart, h.nEnd)]);
  }

  // A lens's hunk as it is now: an earlier Keep/Undo (lenses refresh a moment later) or typing shifts the line numbers,
  // so look it up by its text, nearest first. Gone: null, and the click does nothing.
  liveHunk(file, h) {
    if (!h?.key) return h;
    const same = this.hunks(file).filter((x) => this.hunkKey(file, x) === h.key);
    return same.sort((a, b) => Math.abs(a.nStart - h.nStart) - Math.abs(b.nStart - h.nStart))[0] || null;
  }

  // Accept one hunk: fold it into the snapshot so it stops showing as a change.
  keepHunk(file, h) {
    h = this.liveHunk(file, h);
    if (!h) return this.refresh();
    const before = lines(this.snapshots.get(file) ?? ""), after = lines(this.current(file) ?? "");
    this.snapshots.set(file, [...before.slice(0, h.oStart), ...after.slice(h.nStart, h.nEnd), ...before.slice(h.oEnd)].join("\n"));
    this.refresh();
  }

  async undoHunk(file, h) {
    h = this.liveHunk(file, h);
    if (!h) return this.refresh();
    if (this.snapshots.get(file) === null) return this.undo(file); // a created file is one hunk: undoing it deletes the file
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
    if (this.binary(file)) return;
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
    const bin = this.binary(file);
    if (bin) { // VS Code's image viewer diffs two files, so the old bytes go to a temp copy with the same name
      if (!bin.before || !bin.after) return bin.after && vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
      const old = path.join(os.tmpdir(), `bitsmith-original-${process.pid}`, require("crypto").createHash("md5").update(file).digest("hex").slice(0, 8), path.basename(file));
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.writeFileSync(old, bin.before);
      return vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(old), vscode.Uri.file(file), `${path.basename(file)} (Bitsmith changes)`);
    }
    const left = vscode.Uri.from({ scheme: ORIGINAL, path: vscode.Uri.file(file).path });
    vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(file), `${path.basename(file)} (Bitsmith changes)`);
  }
}

module.exports = { EditTracker, diffLines, lines, stats, norm, isBinary };
