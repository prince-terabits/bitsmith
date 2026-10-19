// End-to-end check of the extension host against the real Claude Code CLI, with a stubbed `vscode`.
// Run from an empty scratch folder:  node /path/to/bitsmith/test/e2e.js
const Module = require("module");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const cwd = process.cwd();
fs.writeFileSync("a.txt", "hello\n");
fs.writeFileSync("b.txt", "one\ntwo\nthree\nfour\n");

// ---------- vscode stub ----------
const posts = [], commands = [], state = new Map();
class Emitter { constructor() { this.l = []; this.event = (f) => this.l.push(f); } fire(x) { this.l.forEach((f) => f(x)); } }
class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
const uri = (o) => ({ ...o, fsPath: o.path, toString: () => `${o.scheme}:${o.path}?${o.query || ""}` });
const noop = () => ({ dispose() {} });
const vscode = {
  EventEmitter: Emitter, Range, CodeLens: class { constructor(r, c) { this.range = r; this.command = c; } },
  ThemeColor: class {}, OverviewRulerLane: { Left: 1 }, FileType: { Directory: 2, File: 1 }, QuickPickItemKind: { Separator: -1 },
  TabInputTextDiff: class {},
  StatusBarAlignment: { Right: 2 }, MarkdownString: class { constructor() { this.value = ""; } appendMarkdown(t) { this.value += t; } },
  TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
  WorkspaceEdit: class { replace(u, r, t) { this.t = t; this.u = u; } },
  Uri: { joinPath: () => "", file: (f) => uri({ scheme: "file", path: f }), from: uri, parse: (s) => uri({ scheme: "file", path: s.replace("file://", "") }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: cwd } }],
    getConfiguration: () => ({ get: (k) => ({ claudePath: "claude", defaultPolicy: "review" })[k] }),
    registerTextDocumentContentProvider: noop, onDidChangeTextDocument: noop, textDocuments: [],
    applyEdit: async (e) => { fs.writeFileSync(e.u.fsPath, e.t); return true; },
    openTextDocument: async (f) => ({ uri: vscode.Uri.file(f), getText: () => fs.readFileSync(f, "utf8"), lineCount: 1, validateRange: (r) => r, save: async () => true }),
    fs: { stat: async (u) => ({ type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 }) },
    findFiles: async () => [],
    saveAll: async () => true,
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [], tabGroups: { all: [] },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    createStatusBarItem: () => (statusItem = { show() {}, dispose() {} }),
    registerWebviewViewProvider: (_, p) => { provider = p; return noop(); },
    registerWebviewPanelSerializer: (_, s) => { serializer = s; return noop(); },
    createTreeView: (_, o) => { tree = o.treeDataProvider; return noop(); }, showWarningMessage: async () => undefined,
    onDidChangeActiveTextEditor: noop, onDidChangeTextEditorSelection: noop, onDidChangeVisibleTextEditors: noop,
  },
  languages: { registerCodeLensProvider: noop },
  commands: { registerCommand: noop, executeCommand: (...a) => commands.push(a) },
  env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
};
let provider, tree, statusItem, serializer;
global.fetch = async () => ({ ok: false }); // no real plan-usage requests from tests
const load = Module._load;
Module._load = (req, ...a) => (req === "vscode" ? vscode : load(req, ...a));
const ext = require(path.join(__dirname, "..", "extension.js"));
const { diffLines, lines } = require(path.join(__dirname, "..", "edits.js"));

// ---------- pure checks ----------
assert.deepStrictEqual(diffLines(["a", "b", "c"], ["a", "x", "c"]), [{ oStart: 1, oEnd: 2, nStart: 1, nEnd: 2 }]);
assert.deepStrictEqual(diffLines(["a", "c"], ["a", "b", "c"]), [{ oStart: 1, oEnd: 1, nStart: 1, nEnd: 2 }]);
assert.deepStrictEqual(diffLines(["a", "b", "c"], ["a", "c"]), [{ oStart: 1, oEnd: 2, nStart: 1, nEnd: 1 }]);
assert.strictEqual(diffLines(lines("1\n2\n3\n4\n5"), lines("1\nX\n3\n4\nY")).length, 2);
assert.deepStrictEqual(ext.editStats("Edit", { old_string: "a\nb", new_string: "a\nc\nd" }), { added: 2, removed: 1 });
// diff rows: 2 lines of context around each hunk, a gap between far-apart hunks and between edits
assert.deepStrictEqual(ext.diffRows("Edit", { old_string: "1\n2\n3\n4\n5\n6\n7\n8\n9", new_string: "1\nX\n3\n4\n5\n6\n7\nY\n9" }).map((r) => r.k + r.t).join(","),
  " 1,-2,+X, 3, 4,…, 6, 7,-8,+Y, 9");
assert.deepStrictEqual(ext.diffRows("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }).map((r) => r.k + r.t).join(","), "-a,+b,…,-c,+d");
assert.strictEqual(ext.diffRows("Write", { content: "x\n".repeat(500) }, 400).at(-1).t, "101 more lines");
{ // pages cut at user messages: the last 2 turns, then whatever is left
  const items = ["user", "text", "user", "text", "user", "text"].map((type) => ({ type }));
  assert.strictEqual(ext.pageStart(items, 6, 2), 2);
  assert.strictEqual(ext.pageStart(items, 2, 2), 0);
}
{ // undoing one step works back from the file now, keeping later edits; anything ambiguous refuses
  const edit = (o, n, extra) => ({ name: "Edit", input: { old_string: o, new_string: n, ...extra } });
  assert.strictEqual(ext.stepBefore([edit("a", "b")], "x b LATER"), "x a LATER");
  assert.strictEqual(ext.stepBefore([edit("a", "b"), edit("c", "d")], "b d"), "a c");
  assert.strictEqual(ext.stepBefore([edit("a", "b")], "b b"), undefined, "which b?");
  assert.strictEqual(ext.stepBefore([edit("a", "b", { replace_all: true })], "b b"), "a a");
  assert.strictEqual(ext.stepBefore([edit("a", "")], "x"), undefined, "a deletion has nothing to find");
  assert.strictEqual(ext.stepBefore([edit("a", "b")], "gone"), undefined);
  assert.strictEqual(ext.stepBefore([{ name: "Write", input: { content: "new" }, before: null }], "new"), null, "it created the file");
  assert.strictEqual(ext.stepBefore([{ name: "Write", input: { content: "new" }, before: "old" }], "new"), "old");
  assert.strictEqual(ext.stepBefore([{ name: "Write", input: { content: "new" } }], "new"), undefined, "unknown before");
  assert.strictEqual(ext.stepBefore([{ name: "Write", input: { content: "new" }, before: "old" }], "edited"), undefined);
}
// A fork of a compacted chat starts at the compaction; replay pulls what came before from the session the summary names.
{
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "bs-fork-")), older = path.join(dir, "old.jsonl"), fork = path.join(dir, "fork.jsonl");
  const say = (uuid, parentUuid, type, text) => ({ uuid, parentUuid, type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  const boundary = { uuid: "b", parentUuid: null, logicalParentUuid: "a2", type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 9000, postTokens: 900 } };
  const summary = { ...say("s", "b", "user", `Summary. read the full transcript at: ${older}`), isCompactSummary: true };
  const jsonl = (es) => es.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(older, jsonl([say("u1", null, "user", "first"), say("a1", "u1", "assistant", "one"), say("u2", "a1", "user", "second"), say("a2", "u2", "assistant", "two"), boundary, summary]));
  fs.writeFileSync(fork, jsonl([boundary, summary, say("u3", "s", "user", "third"), say("a3", "u3", "assistant", "three")]));
  const items = ext.replay(fork, (f) => f).filter((x) => x.type === "user" || x.type === "notice").map((x) => x.type === "user" ? x.text : "notice");
  assert.deepStrictEqual(items, ["first", "second", "notice", "third"], "history before the compaction comes back");
  fs.rmSync(dir, { recursive: true });
}
const parsed = ext.parseUserText("<context>\nCurrent file: src/x.ts (lines 3-5 selected)\n```\ncode\n```\nAttached:\n- src/lib/ (folder)\n- a.txt (file)\n</context>\n\nfix it");
assert.strictEqual(parsed.text, "fix it");
assert.deepStrictEqual(parsed.chips.map((c) => c.kind + ":" + c.rel), ["file:src/x.ts", "folder:src/lib", "file:a.txt"]);
assert.strictEqual(ext.describeTool("Grep", { pattern: "foo" }).title, "Searched for");
// Edits that can run commands later always need approval; ordinary files in the folder (and temp scratch) don't.
assert.strictEqual(ext.riskyEdit(path.join(cwd, "src/app.js"), true), false);
assert.strictEqual(ext.riskyEdit(path.join(require("os").tmpdir(), "scratch.py"), false), false);
assert.strictEqual(ext.riskyEdit(path.join(cwd, ".vscode/tasks.json"), true), true);
assert.strictEqual(ext.riskyEdit(path.join(cwd, ".git/hooks/pre-commit"), true), true);
assert.strictEqual(ext.riskyEdit(path.join(cwd, ".claude/settings.json"), true), true);
assert.strictEqual(ext.riskyEdit(path.join(require("os").homedir(), ".bashrc"), false), true);
assert.strictEqual(ext.riskyEdit(path.join(require("os").homedir(), "notes.txt"), false), true); // outside the workspace
assert.strictEqual(ext.riskyEdit(path.join(cwd, ".gitignore"), true), false); // not inside .git/
console.log("pure checks ok");

// ---------- live checks ----------
const ctx = { subscriptions: { push() {} }, extensionUri: "", globalStorageUri: { fsPath: path.join(cwd, ".storage") }, globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: (k, v) => state.set(k, v) } };
ext.activate(ctx);
let onPerm = () => {};
provider.view = { webview: { postMessage: (m) => { posts.push(m); if (m.type === "permission") setTimeout(() => onPerm(m), 30); } } };
const waitFor = (pred, start, ms = 180000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const t = setInterval(() => { const hit = posts.slice(start).find(pred); if (hit) { clearInterval(t); res(hit); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error("timeout")); } }, 100);
});
const turn = async (text, opts = {}) => {
  const start = posts.length;
  provider.onWebview({ type: "send", text, context: opts.context || [], useActive: false });
  await waitFor((m) => m.type === "done", start);
  await new Promise((r) => setTimeout(r, 300)); // let the debounced changes post land
  return posts.slice(start);
};
const said = (p) => p.filter((m) => m.type === "text").map((m) => m.text).join("").trim();

(async () => {
  // a clean editor showing stale text gets the disk version pushed in
  const afile = path.join(cwd, "a.txt");
  let saved = 0;
  const doc = { uri: vscode.Uri.file(afile), isDirty: false, text: "stale\n", getText() { return this.text; }, lineCount: 1, validateRange: (r) => r, save: async () => { saved++; } };
  vscode.workspace.textDocuments.push(doc);
  vscode.workspace.applyEdit = async (e) => { doc.text = e.t; return true; };
  await provider.edits.syncFromDisk(afile);
  assert.strictEqual(doc.text, "hello\n");
  assert.strictEqual(saved, 1);
  doc.isDirty = true; doc.text = "user typing";
  await provider.edits.syncFromDisk(afile);
  assert.strictEqual(doc.text, "user typing", "dirty editors are never overwritten silently");
  vscode.workspace.textDocuments.length = 0;
  vscode.workspace.applyEdit = async (e) => { fs.writeFileSync(e.u.fsPath, e.t); return true; };
  console.log("stale editor sync ok");

  // the current file attached as a chip is listed once in the prompt
  const realActive = provider.activeFile;
  provider.activeFile = () => ({ file: path.join(cwd, "a.txt"), rel: "a.txt", selection: null });
  const prompt = provider.withContext("ok", [{ kind: "file", rel: "a.txt", file: path.join(cwd, "a.txt") }, { kind: "folder", rel: "sub", file: path.join(cwd, "sub") }], true);
  assert.strictEqual((prompt.match(/a\.txt/g) || []).length, 1, prompt);
  assert(/- sub\/ \(folder\)/.test(prompt));
  provider.activeFile = realActive;
  console.log("context dedupe ok");

  // a chat started in this window shows in Recent chats on New Chat, without a reload
  {
    const id = "99999999-2222-3333-4444-555555555555", dir = provider.sessionDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + ".jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "fresh from this window" } }) + "\n");
    const st = posts.length;
    provider.newChat();
    const list = posts.slice(st).filter((m) => m.type === "sessions").pop();
    assert(list?.items.some((s) => s.id === id && s.title === "fresh from this window"), "new chat listed");
    fs.rmSync(path.join(dir, id + ".jsonl"));
    console.log("recent chats refresh ok");
  }

  // forks (Retry/Restore copies) and continuations after compaction list once, as their newest file
  {
    const dir = provider.sessionDir(), ids = ["a", "b", "c", "d"].map((x) => `${x.repeat(8)}-2222-3333-4444-555555555555`);
    const line = (e) => JSON.stringify({ type: "user", ...e }) + "\n";
    const write = (id, text, t) => { fs.writeFileSync(path.join(dir, id + ".jsonl"), text); fs.utimesSync(path.join(dir, id + ".jsonl"), t, t); };
    write(ids[0], line({ uuid: "u1", message: { content: "fork me" } }), 1000);
    write(ids[1], line({ uuid: "u1", message: { content: "fork me" } }) + line({ uuid: "u2", message: { content: "retried" } }), 2000);
    write(ids[2], line({ uuid: "u3", isCompactSummary: true, message: { content: `continued… transcript at: ${dir}/${ids[1]}.jsonl` } }) + JSON.stringify({ type: "ai-title", aiTitle: "Fork me" }) + "\n", 3000);
    write(ids[3], line({ uuid: "u4", message: { content: "another chat" } }), 500);
    const listed = provider.sessions(60).map((s) => s.id).filter((id) => ids.includes(id));
    assert.deepStrictEqual(listed, [ids[2], ids[3]], "one entry per chat: " + listed);
    for (const id of ids) fs.rmSync(path.join(dir, id + ".jsonl"));
    console.log("history dedupe ok");
  }

  // delete chat: transcript and its per-session folders go away; bad ids are refused
  {
    const id = "11111111-2222-3333-4444-555555555555";
    const dir = provider.sessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, id + ".jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "delete me please" } }) + "\n");
    const fh = path.join(require("os").homedir(), ".claude", "file-history", id);
    fs.mkdirSync(fh, { recursive: true });
    vscode.window.showWarningMessage = async () => "Delete";
    assert.strictEqual(await provider.deleteSession("../../etc/passwd"), false, "non-uuid ids are refused");
    let st = posts.length;
    assert.strictEqual(await provider.deleteSession(id), true);
    assert(!fs.existsSync(transcript) && !fs.existsSync(fh), "transcript and file-history removed");
    assert(posts.slice(st).some((m) => m.type === "sessions"), "recent list refreshed");
    // deleting the open chat starts a fresh one
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "open chat" } }) + "\n");
    provider.sessionId = id;
    st = posts.length;
    await provider.deleteSession(id);
    assert(posts.slice(st).some((m) => m.type === "clear") && provider.sessionId === null, "open chat cleared");
    provider.shutdown();
    try { fs.rmdirSync(dir); } catch {}
    console.log("delete chat ok");
  }

  // rename: the custom title beats the AI title, even one the CLI writes later; search finds words inside chats
  {
    const id = "22222222-3333-4444-5555-666666666666";
    const dir = provider.sessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + ".jsonl");
    fs.writeFileSync(file, [{ type: "user", message: { role: "user", content: "the zebra needle is here" } }, { type: "ai-title", aiTitle: "AI title" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    vscode.window.showInputBox = async () => "My own name";
    assert.strictEqual(await provider.renameSession(id), true);
    fs.appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "Later AI title" }) + "\n");
    assert.strictEqual(ext.sessionTitle(file), "My own name");
    assert.deepStrictEqual(await ext.searchSessions(dir, "ZEBRA needle"), [id], "case-insensitive search inside chats");
    assert.deepStrictEqual(await ext.searchSessions(dir, "no such words here"), []);
    fs.rmSync(file);
    try { fs.rmdirSync(dir); } catch {}
    console.log("rename + search ok");
  }

  // Keep/Undo only covers workspace files; scratch files elsewhere still get a checkpoint snapshot
  {
    const c = provider.active;
    c.checkpoints.push({ id: 99, snaps: new Map() });
    fs.writeFileSync("/tmp/bitsmith-outside.txt", "x");
    c.snapshot("/tmp/bitsmith-outside.txt");
    c.snapshot(path.join(cwd, "a.txt"));
    assert(!provider.edits.snapshots.has("/tmp/bitsmith-outside.txt") && provider.edits.snapshots.has(path.join(cwd, "a.txt")));
    assert(c.checkpoints[0].snaps.has("/tmp/bitsmith-outside.txt"), "checkpoint still covers it");
    provider.edits.snapshots.clear();
    c.checkpoints = [];
    fs.rmSync("/tmp/bitsmith-outside.txt");
    console.log("workspace-only changes ok");
  }

  // edits that could run commands later always ask, even when edits normally apply on their own
  {
    const c = provider.active;
    assert.strictEqual(provider.editRisk(path.join(cwd, "src/app.js")), "");
    assert.match(provider.editRisk(path.join(require("os").homedir(), ".bashrc")), /^Outside this folder/);
    for (const f of [".git/hooks/pre-commit", ".vscode/tasks.json", ".claude/settings.json", ".github/workflows/ci.yml"])
      assert.match(provider.editRisk(path.join(cwd, f)), /run commands/, f);
    fs.symlinkSync(require("os").homedir(), path.join(cwd, "home-link"));
    assert.match(provider.editRisk(path.join(cwd, "home-link/.bashrc")), /^Outside this folder/, "a symlink can't hide the real path");
    fs.rmSync(path.join(cwd, "home-link"));
    const realClaude = c.claude, said = [], st = posts.length;
    c.claude = { respond: (id, r) => said.push([id, r.behavior]) };
    c.ask("r1", { tool_name: "Write", input: { file_path: path.join(cwd, "notes.txt"), content: "x" } });
    c.ask("r2", { tool_name: "Write", input: { file_path: path.join(cwd, ".vscode/tasks.json"), content: "{}" } });
    assert.deepStrictEqual(said, [["r1", "allow"]], "an ordinary edit applies, the tasks file waits");
    assert(posts.slice(st).some((m) => m.type === "permission" && m.id === "r2" && /run commands/.test(m.risk)));
    c.answer({ id: "r2", allow: false });
    // a file with unsaved changes asks too, with the change shown on the card
    const dirtyFile = path.join(cwd, "dirty.txt");
    vscode.workspace.textDocuments.push({ uri: vscode.Uri.file(dirtyFile), isDirty: true });
    c.ask("r3", { tool_name: "Edit", input: { file_path: dirtyFile, old_string: "a", new_string: "b" } });
    vscode.workspace.textDocuments.length = 0;
    assert(!said.some(([id]) => id === "r3"), "not applied on its own");
    const card = posts.slice(st).find((m) => m.type === "permission" && m.id === "r3");
    assert.match(card.risk, /unsaved changes/);
    assert.deepStrictEqual(card.rows.map((r) => r.k + r.t), ["-a", "+b"]);
    c.answer({ id: "r3", allow: false });
    c.claude = realClaude;
    provider.edits.snapshots.clear();
    console.log("risky edits ask ok");

    // a git snapshot that's gone (pruned) must not make Restore delete the files commands changed
    const t = await c.shellTargets([{ shell: [{ root: cwd, a: "0123456789abcdef0123456789abcdef01234567", changed: ["a.txt"], created: ["made.txt"] }] }]);
    assert.deepStrictEqual([...t], [[path.join(cwd, "made.txt"), null]], "only the created file is undone");
    console.log("pruned snapshot ok");

    // clicking a file named in a reply finds it even when the path isn't from the folder root
    for (const f of ["docs/deep/notes.md", "x/package.json", "y/z/package.json"]) { fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true }); fs.writeFileSync(path.join(cwd, f), "{}"); }
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const realFind = vscode.workspace.findFiles, opened = [], picks = [];
    vscode.workspace.findFiles = async (glob) => walk(cwd).filter((f) => f.endsWith("/" + glob.slice(3))).map((f) => vscode.Uri.file(f));
    const openedFrom = commands.length; // files open with vscode.open, so images get the image viewer
    vscode.window.showQuickPick = async (items) => { picks.push(items.map((i) => i.description)); return items[0]; };
    await provider.openPath(c, "notes.md");
    await provider.openPath(c, "deep/notes.md");
    await provider.openPath(c, "package.json"); // two match: ask, shortest first
    c.tools.set("t1", { name: "Edit", input: { file_path: path.join(cwd, "y/z/package.json") } });
    await provider.openPath(c, "package.json"); // the one this chat edited wins
    opened.push(...commands.slice(openedFrom).filter((a) => a[0] === "vscode.open").map((a) => a[1].fsPath));
    assert.deepStrictEqual(opened.map((f) => path.relative(cwd, f)), ["docs/deep/notes.md", "docs/deep/notes.md", "x/package.json", "y/z/package.json"]);
    assert.deepStrictEqual(picks, [["x/package.json", "y/z/package.json"]]);
    // outside the workspace (a screenshot in /tmp): found next to a path this chat's tools used
    const shots = fs.mkdtempSync(path.join(require("os").tmpdir(), "bitsmith-shots-"));
    fs.writeFileSync(path.join(shots, "board.png"), Buffer.from([0x89, 0x50, 0, 0]));
    c.tools.set("t2", { name: "Bash", input: { command: `node shoot.js --out ${shots}/home.png` } });
    const fromShots = commands.length;
    await provider.openPath(c, "board.png");
    assert.deepStrictEqual(commands.slice(fromShots).filter((a) => a[0] === "vscode.open").map((a) => a[1].fsPath), [path.join(shots, "board.png")]);
    c.tools.delete("t2");
    fs.rmSync(shots, { recursive: true });
    vscode.workspace.findFiles = realFind;
    c.tools.delete("t1");
    for (const d of ["docs", "x", "y"]) fs.rmSync(path.join(cwd, d), { recursive: true });
    console.log("open file from reply ok");

    // plan usage refreshes from the account endpoint, not only when a message comes back
    const cfg = fs.mkdtempSync(path.join(require("os").tmpdir(), "bs-cfg-")), noFetch = global.fetch, oldDir = process.env.CLAUDE_CONFIG_DIR, calls = [];
    fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3600e3 } }));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    global.fetch = async (url, o) => { calls.push([url, o.headers.Authorization]); return { ok: true, json: async () => ({
      five_hour: { utilization: 81, resets_at: "2026-10-05T09:20:00+00:00" }, seven_day: { utilization: 100, resets_at: "2026-10-09T19:00:00+00:00" }, extra_usage: { is_enabled: false } }) }; };
    await provider.fetchUsage(true);
    await provider.fetchUsage(); // just updated: no second request
    assert.deepStrictEqual(calls, [["https://api.anthropic.com/api/oauth/usage", "Bearer tok"]]);
    assert.strictEqual(provider.usage.session.used, 0.81);
    assert.strictEqual(provider.usage.session.resetsAt, Date.parse("2026-10-05T09:20:00Z") / 1000);
    assert.strictEqual(provider.usage.status, "rejected");
    assert.strictEqual(provider.usage.overage, "rejected");
    assert.match(statusItem.text, / 100%$/);
    global.fetch = async () => { throw new Error("offline"); };
    const before = provider.usage;
    await provider.fetchUsage(true);
    assert.strictEqual(provider.usage, before); // offline keeps the last reading
    provider.usage = null; provider.updateUsage();
    global.fetch = noFetch;
    if (oldDir == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldDir;
    fs.rmSync(cfg, { recursive: true });
    console.log("usage refresh ok");
  }

  // a background chat that finishes (or needs approval) raises a toast; the chat on screen doesn't
  {
    const toasts = [];
    vscode.window.showInformationMessage = async (msg) => { toasts.push(msg); };
    const bg = provider.createChat();
    bg.title = "Side job";
    bg.started = Date.now();
    bg.finish();
    provider.active.started = Date.now();
    provider.active.finish();
    assert.deepStrictEqual(toasts, ['Bitsmith: "Side job" finished.']);
    provider.chats.delete(bg.key);
    console.log("notifications ok");
  }

  // export: a chat as Markdown, with who said what and one line per step
  {
    const md = ext.chatMarkdown([
      { type: "user", text: "fix it", chips: [{ rel: "a.txt" }] }, { type: "tool", title: "Ran", detail: "ls `x`" },
      { type: "text", text: "Done." }, { type: "taskEvent", summary: "Agent finished" }, { type: "tool", parent: "x", title: "hidden" },
    ], "My chat");
    assert.strictEqual(md, "# My chat\n\n## You\n\nfix it\n\n_Attached: a.txt_\n\n## Claude\n\n- Ran `ls 'x'`\n\nDone.\n\n> Agent finished\n");
    console.log("export ok");
  }

  // a chat in an editor tab: it leaves the sidebar, its messages go to the tab, and the tab replays it on load
  {
    const id = "33333333-4444-5555-6666-777777777777";
    const dir = provider.sessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + ".jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "panel me" } }) + "\n");
    const tab = { posts: [], handlers: [] };
    vscode.ViewColumn = { Active: -1 };
    vscode.window.createWebviewPanel = () => (tab.panel = { webview: { postMessage: (m) => tab.posts.push(m), onDidReceiveMessage: (f) => tab.handlers.push(f), asWebviewUri: (u) => u, cspSource: "" }, onDidDispose: (f) => (tab.dispose = f), reveal() {}, visible: true });
    const c = provider.createChat();
    c.sessionId = id;
    c.ensure = () => {}; // no CLI needed here
    const st = posts.length;
    provider.openInEditor(c);
    assert(posts.slice(st).some((m) => m.type === "closeChat" && m.chat === c.key), "left the sidebar");
    c.post({ type: "text", text: "to the tab" });
    assert(tab.posts.some((m) => m.text === "to the tab") && !posts.slice(st).some((m) => m.text === "to the tab"), "routed to the tab");
    tab.handlers[0]({ type: "ready" });
    assert(tab.posts.some((m) => m.type === "loading") && !tab.posts.some((m) => m.type === "replay"), "the loading screen goes out before the slow replay");
    await new Promise((r) => setTimeout(r, 100));
    assert(tab.posts.some((m) => m.type === "replay" && m.items.some((i) => i.text === "panel me")), "the tab replays the chat");
    assert(tab.posts.some((m) => m.type === "tabState" && m.sessionId === id), "the tab remembers its chat for a reload");

    // the tab's title bar: commands act on the focused tab, + opens another tab, history loads into an empty tab
    const tabs = [];
    const fakePanel = () => { const t = { posts: [], handlers: [] }; tabs.push(t); return (t.panel = { webview: { postMessage: (m) => t.posts.push(m), onDidReceiveMessage: (f) => t.handlers.push(f), asWebviewUri: (u) => u, cspSource: "" }, onDidDispose: (f) => (t.dispose = f), reveal() {}, visible: true }); };
    vscode.window.createWebviewPanel = fakePanel;
    tab.panel.active = true;
    assert.strictEqual(provider.current(), c, "the focused tab's chat");
    provider.newChat();
    assert.strictEqual(tabs.length, 1, "+ in a tab opens a new tab");
    const fresh = [...provider.chats.values()].find((x) => x.panel === tabs[0].panel);
    fresh.ensure = () => {};
    tab.panel.active = false;
    tabs[0].handlers[0]({ type: "loadSession", id: "44444444-4444-5555-6666-777777777777" });
    assert.strictEqual(fresh.sessionId, "44444444-4444-5555-6666-777777777777", "a chat picked in an empty tab opens there");
    assert(!posts.slice(st).some((m) => m.type === "openChat"), "the sidebar is left alone");
    tabs[0].dispose();

    // a fresh sidebar chat opens a new editor tab instead of refusing
    const side = provider.active;
    provider.openInEditor(side.fresh ? side : provider.createChat());
    assert.strictEqual(tabs.length, 2, "Open Chat in Editor works on a new chat");
    assert.strictEqual(provider.active, side, "the sidebar keeps its chat");
    tabs[1].dispose();

    // after a reload VS Code hands the tab back with its saved state
    const restored = fakePanel();
    serializer.deserializeWebviewPanel(restored, { sessionId: id });
    const back = [...provider.chats.values()].find((x) => x.panel === restored);
    back.ensure = () => {};
    tabs[2].handlers[0]({ type: "ready" });
    await new Promise((r) => setTimeout(r, 100)); // replay follows the loading screen
    assert(tabs[2].posts.some((m) => m.type === "replay" && m.items.some((i) => i.text === "panel me")), "the restored tab replays its chat");
    tabs[2].dispose();

    tab.dispose();
    assert(!provider.chats.has(c.key), "closing the tab closes the chat");
    fs.rmSync(file);
    try { fs.rmdirSync(dir); } catch {}
    console.log("editor tab ok");
  }

  // plan usage: status bar shows the icon, adds % and a warning color when high
  assert.strictEqual(statusItem.text, "$(bitsmith-logo)");
  assert.strictEqual(statusItem.command, "bitsmith.showUsage");
  const now = Math.floor(Date.now() / 1000);
  provider.handle({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.64, resetsAt: now + 3600 }, seven_day: { utilization: 0.09, resetsAt: now + 86400 } } } });
  assert.strictEqual(statusItem.text, "$(bitsmith-logo)");
  assert(/Session: \*\*64%\*\*/.test(statusItem.tooltip.value) && /Weekly: \*\*9%\*\*/.test(statusItem.tooltip.value), statusItem.tooltip.value);
  provider.handle({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.86, resetsAt: now + 3600 }, seven_day: { utilization: 0.3, resetsAt: now + 86400 } } } });
  assert.strictEqual(statusItem.text, "$(bitsmith-logo) 86%");
  assert(statusItem.backgroundColor, "warning color at 80%+");
  assert.strictEqual(state.get("usage").session.used, 0.86, "persisted for the next start");
  const usagePost = posts.filter((m) => m.type === "usage").pop();
  assert.strictEqual(usagePost.usage.weekly.used, 0.3);
  console.log("usage status bar ok");

  // Each chat lists only the files it changed; Keep all / Undo all in one chat leave the other's alone
  {
    const a = provider.createChat(), b = provider.createChat();
    fs.writeFileSync("pa.txt", "a\n"); fs.writeFileSync("pb.txt", "b\n");
    a.snapshot(path.join(cwd, "pa.txt")); fs.writeFileSync("pa.txt", "A\n");
    b.snapshot(path.join(cwd, "pb.txt")); fs.writeFileSync("pb.txt", "B\n");
    const st = posts.length;
    provider.edits.refresh();
    const last = async (c) => { await waitFor((m) => m.type === "changes" && m.chat === c.key, st, 3000); return posts.filter((m) => m.type === "changes" && m.chat === c.key).pop().files.map((f) => f.rel); };
    assert.deepStrictEqual(await last(a), ["pa.txt"], "chat A sees only its file");
    assert.deepStrictEqual(await last(b), ["pb.txt"], "chat B sees only its file");
    await provider.onWebview({ type: "undo", chat: a.key });
    assert.strictEqual(fs.readFileSync("pa.txt", "utf8"), "a\n", "Undo all in A reverts A's file");
    assert.strictEqual(fs.readFileSync("pb.txt", "utf8"), "B\n", "and leaves B's change");
    const st2 = posts.length;
    provider.edits.refresh();
    await waitFor((m) => m.type === "changes" && m.chat === b.key, st2, 3000);
    assert.deepStrictEqual(posts.filter((m) => m.type === "changes" && m.chat === b.key).pop().files.map((f) => f.rel), ["pb.txt"]);
    provider.onWebview({ type: "keep", chat: b.key });
    for (const c of [a, b]) { provider.chats.delete(c.key); c.shutdown(); }
    console.log("per-chat changes ok");
  }

  // Binary files (images): reviewed by size, not counted as lines, and Undo puts the exact bytes back
  {
    const c = provider.createChat();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 10, 10, 10, 0xff, 0xfe]);
    fs.writeFileSync("old.png", png);
    c.snapshot(path.join(cwd, "old.png")); fs.writeFileSync("old.png", Buffer.concat([png, png]));
    c.snapshot(path.join(cwd, "new.png")); fs.writeFileSync("new.png", png);
    const st = posts.length;
    provider.edits.refresh();
    await waitFor((m) => m.type === "changes" && m.chat === c.key, st, 3000);
    const files = Object.fromEntries(posts.filter((m) => m.type === "changes" && m.chat === c.key).pop().files.map((f) => [f.rel, f]));
    assert.deepStrictEqual([files["old.png"].binary, files["old.png"].before, files["old.png"].after, files["old.png"].added], [true, 17, 34, 0]);
    assert(files["new.png"].binary && files["new.png"].created && files["new.png"].after === 17, "new image shows as created");
    await provider.onWebview({ type: "undo", chat: c.key });
    assert(fs.readFileSync("old.png").equals(png), "Undo restores the image's exact bytes");
    assert(!fs.existsSync("new.png"), "Undo removes the created image");
    provider.chats.delete(c.key); c.shutdown();
    console.log("binary changes ok");
  }

  // Two quick lens clicks: the second hunk's lens still has the line numbers from before the first Keep
  {
    const f = path.join(cwd, "hunks.txt"), e = provider.edits;
    e.snapshotText(f, "a\nb\nc\nd\ne\n");
    fs.writeFileSync(f, "A\nX\nY\nb\nc\nd\nE\n");
    const [h1, h2] = e.hunks(f).map((h) => ({ ...h, key: e.hunkKey(f, h) }));
    e.keepHunk(f, h1);
    await e.undoHunk(f, h2); // stale: the snapshot grew by two lines above it
    assert.strictEqual(fs.readFileSync(f, "utf8"), "A\nX\nY\nb\nc\nd\ne\n", "stale lens undoes the right hunk");
    assert.strictEqual(e.hunks(f).length, 0, "nothing left to review");
    e.keep(f); fs.rmSync(f);
    console.log("stale hunk lens ok");
  }

  // Created files: an empty one still shows for review, and undoing a created file's hunk deletes it.
  // A binary file Claude overwrites keeps its bytes in the checkpoint, through a save and load.
  {
    const e = provider.edits, empty = path.join(cwd, "empty.txt"), made = path.join(cwd, "made.txt");
    e.snapshot(empty); fs.writeFileSync(empty, "");
    assert(e.files().some((f) => f.file === empty && f.created), "empty created file is listed");
    e.snapshot(made); fs.writeFileSync(made, "x\n");
    await e.undoHunk(made, e.hunks(made)[0]);
    assert(!fs.existsSync(made), "undoing a created file's hunk deletes it");
    e.keep(empty); fs.rmSync(empty);
    const c = provider.createChat(), bin = Buffer.from([0x89, 0x50, 0, 1, 0xff]), f = path.join(cwd, "pic.bin");
    fs.writeFileSync(f, bin);
    c.checkpoints.push({ id: 1, snaps: new Map() });
    c.snapshot(f);
    c.sessionId = "test-binary-snap";
    c.saveCheckpoints();
    assert(provider.loadCheckpoints(c.sessionId)[0].snaps.get(f).equals(bin), "binary snapshot round-trips");
    fs.rmSync(provider.checkpointFile(c.sessionId));
    e.keep(f); fs.rmSync(f);
    provider.chats.delete(c.key); c.shutdown();
    console.log("created and binary snapshots ok");
  }

  // Background compaction: skipped below 85% or with messages queued; the chat moves onto the compacted fork
  // only if it hasn't moved on since.
  {
    const c = provider.createChat();
    c.ensure = () => {}; // no real CLI
    c.sessionId = "from"; c.lastUuid = "u1"; c.threshold = 1000; c.context = { used: 500 };
    c.idleCompact({});
    assert(!c.bg, "not below 85%");
    c.context = { used: 900 }; c.queue = [{ text: "next" }]; c.idleCompact({});
    assert(!c.bg, "not with a message queued");
    c.lastUuid = "u2"; c.adopt("fork", { pre_tokens: 900, post_tokens: 100 }, "from", "u1");
    assert(c.sessionId === "from", "the chat moved on: fork dropped");
    c.adopt("fork", { pre_tokens: 900, post_tokens: 100 }, "from", "u2");
    assert(c.sessionId === "fork" && c.context.used === 100 && c.lastUuid === "u2", "continues in the fork");
    provider.chats.delete(c.key);
    console.log("background compact ok");
  }

  // A command that `git add`s a file that was untracked: Undo and Restore must not treat it as created and delete it
  {
    const { execSync } = require("child_process");
    const repo = fs.mkdtempSync(path.join(cwd, "repo-"));
    const sh = (cmd) => execSync(cmd, { cwd: repo, stdio: "pipe" });
    fs.writeFileSync(path.join(repo, "t.txt"), "one\n");
    fs.writeFileSync(path.join(repo, "notes.txt"), "mine\n");
    sh("git init -q && git add t.txt && git -c user.email=t@t -c user.name=t commit -qm init");
    const c = provider.createChat();
    c.checkpoints.push({ id: 1, snaps: new Map() });
    const marks = [await provider.gitMark(repo)];
    fs.writeFileSync(path.join(repo, "t.txt"), "two\n");
    sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm all");
    await c.captureShell(marks);
    assert.deepStrictEqual(c.checkpoints[0].shell[0].changed, ["t.txt"], "notes.txt isn't recorded as changed");
    assert(!provider.edits.snapshots.has(path.join(repo, "notes.txt")), "nor offered for Undo");
    for (const [file, data] of await c.shellTargets(c.checkpoints)) assert.strictEqual(String(data), "one\n", file);
    provider.edits.keep(path.join(repo, "t.txt"));
    provider.chats.delete(c.key); c.shutdown();
    fs.rmSync(repo, { recursive: true });
    console.log("git add of untracked file ok");
  }
  if (process.argv.includes("--live-usage")) {
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    const st = posts.length;
    provider.onWebview({ type: "send", text: "Reply with just OK.", context: [] });
    await waitFor((m) => m.type === "done", st);
    const live = posts.slice(st).filter((m) => m.type === "usage").pop();
    assert(live && typeof live.usage.session.used === "number", "real CLI usage arrives");
    console.log(`live usage ok: session ${Math.round(live.usage.session.used * 100)}%, weekly ${Math.round(live.usage.weekly.used * 100)}%, plan ${live.plan}`);
    provider.shutdown();
    process.exit(0);
  }
  // next-message suggestion: the CLI only guesses from the second reply on
  if (process.argv.includes("--live-suggest")) {
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    for (const text of ["I am building a todo app in python. Write add_todo(items, text). Just code, no tools.", "Now write remove_todo(items, index). Just code, no tools."]) {
      const st = posts.length;
      provider.onWebview({ type: "send", text, context: [] });
      await waitFor((m) => m.type === "done", st);
    }
    const s = await waitFor((m) => m.type === "suggestion", 0, 60000);
    assert(s.text.trim(), "a suggestion arrives after the second reply");
    console.log("live suggestion ok:", s.text);
    provider.shutdown();
    process.exit(0);
  }
  if (process.argv.includes("--quick")) {
    // unreviewed changes survive a window reload and come back in the chat that made them
    const f = path.join(cwd, "r.txt");
    fs.writeFileSync(f, "old\n");
    provider.edits.snapshot(f);
    fs.writeFileSync(f, "new\n");
    provider.active.sessionId = "11111111-1111-1111-1111-111111111111";
    provider.active.touched.add(f);
    provider.edits.refresh();
    await new Promise((r) => setTimeout(r, 200));
    provider.shutdown();
    ext.activate(ctx);
    assert.strictEqual(provider.edits.snapshots.get(f), "old\n", "snapshot restored");
    provider.active.sessionId = "11111111-1111-1111-1111-111111111111";
    provider.edits.refresh();
    await new Promise((r) => setTimeout(r, 200));
    assert(provider.active.touched.has(f), "back in its chat's changed files");
    await provider.edits.undo([f]);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "old\n", "Undo still works after the reload");
    console.log("pending edits survive reload ok");
    process.exit(0);
  }

  // background work: an async sub-agent and a background command, Claude's own follow-up, Stop, and two chats at once
  // Shell commands get Keep/Undo and checkpoints like Edit/Write, also in a nested repo the folder's .gitignore excludes
  // (the user's Workspace: web/chatbot-development, extensions/bitsmith, apps_main are their own repos).
  if (process.argv.includes("--live-shell")) {
    const { execSync } = require("child_process");
    const sh = (c, dir = cwd) => execSync(c, { cwd: dir, stdio: "pipe" }).toString();
    fs.writeFileSync("root.txt", "one\n");
    fs.writeFileSync(".gitignore", "nested/\n");
    fs.mkdirSync("nested", { recursive: true });
    fs.writeFileSync("nested/n.txt", "one\n");
    sh("git init -q && git add root.txt .gitignore && git -c user.email=t@t -c user.name=t commit -qm init");
    sh("git init -q && git add n.txt && git -c user.email=t@t -c user.name=t commit -qm init", path.join(cwd, "nested"));
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    provider.setSetting("policy", "bypass");
    vscode.window.showWarningMessage = async () => "Restore";
    const ch = provider.active;
    const send = async (text, checkpoint) => { const s0 = posts.length; provider.onWebview({ type: "send", chat: ch.key, context: [], text, checkpoint }); await waitFor((m) => m.type === "done" && m.chat === ch.key, s0); await new Promise((r) => setTimeout(r, 1500)); return posts.slice(s0); };
    const nested = path.join(cwd, "nested");
    await send(`Run exactly this one shell command with the Bash tool, nothing else: sed -i 's/one/two/' root.txt && sed -i 's/one/two/' ${nested}/n.txt && printf 'made\\n' > ${nested}/made.txt`, 701);
    assert.strictEqual(fs.readFileSync("root.txt", "utf8"), "two\n", "the command ran");
    assert.strictEqual(fs.readFileSync("nested/n.txt", "utf8"), "two\n");
    const changed = posts.filter((m) => m.type === "changes").pop()?.files.map((f) => f.rel).sort();
    assert.deepStrictEqual(changed, ["nested/made.txt", "nested/n.txt", "root.txt"], "shell changes show in 'files changed': " + JSON.stringify(changed));
    console.log("shell changes listed ok:", changed.join(", "));
    // Undo one file from the panel: back to the text before the command
    await provider.edits.undo(path.join(nested, "n.txt"));
    assert.strictEqual(fs.readFileSync("nested/n.txt", "utf8"), "one\n", "Undo reverts a nested-repo shell change");
    console.log("undo shell change ok");
    // Restore the whole message: every file it touched comes back, the created one goes away
    await send(`Run exactly this one shell command with the Bash tool, nothing else: sed -i 's/two/three/' root.txt`, 702);
    assert.strictEqual(fs.readFileSync("root.txt", "utf8"), "three\n");
    await provider.restore(701);
    assert.strictEqual(fs.readFileSync("root.txt", "utf8"), "one\n", "restore reverts both messages' commands");
    assert.strictEqual(fs.readFileSync("nested/n.txt", "utf8"), "one\n");
    assert(!fs.existsSync("nested/made.txt"), "file created by the command is removed");
    await provider.redo();
    assert.strictEqual(fs.readFileSync("root.txt", "utf8"), "three\n", "redo re-applies");
    assert.strictEqual(fs.readFileSync("nested/made.txt", "utf8"), "made\n");
    console.log("restore + redo of shell changes ok");
    // the rewind survives the CLI restarting before the next message (switching chats, a settings change, a crash)
    await send("The secret word is ZEBRA. Reply with just OK.", 703);
    await provider.restore(703);
    ch.restart();
    const asked = await send("What secret word did I give you in this conversation? If none, reply with just NONE.", 704);
    const answer = asked.filter((m) => m.type === "text").map((m) => m.text).join("");
    assert(!/ZEBRA/i.test(answer), "the restored message is gone after a restart: " + answer);
    console.log("rewind survives restart ok:", answer.trim());
    provider.shutdown();
    process.exit(0);
  }

  // Edit plan: the plan opened in an editor and changed there is what Claude gets. MCP & Skills: a skill turned off.
  if (process.argv.includes("--live-tools")) {
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    provider.setSetting("policy", "bypass");
    let planFile;
    vscode.window.showTextDocument = async (u) => { planFile = u.fsPath; };
    vscode.window.showInformationMessage = async () => undefined;
    provider.setSetting("mode", "plan");
    onPerm = async (m) => {
      if (m.kind !== "plan") return;
      await provider.onWebview({ type: "editPlan", id: m.id });
      fs.writeFileSync(planFile, "1. Create c.txt containing exactly the word EDITED-BY-USER\n");
      provider.onWebview({ type: "permission", id: m.id, allow: true });
    };
    const p = await turn("Plan how to add a c.txt file containing the word hi. Keep the plan to 2 short steps, then present it for approval.");
    assert(p.some((m) => m.type === "planText" && /EDITED-BY-USER/.test(m.plan)), "the card shows the edited plan");
    assert(!fs.existsSync(planFile), "the temp plan file is removed");
    const log = fs.readFileSync(path.join(provider.sessionDir(), provider.sessionId + ".jsonl"), "utf8");
    assert(/edited by user[^"]*EDITED-BY-USER/.test(log), "Claude got the edited plan");
    console.log("edit plan ok");

    // The MCP & Skills panel, driven by its messages: a tiny MCP server is added, connects, lists its tool and gets a
    // permission; a broken one shows its error; skills change level; edit and remove go through `claude mcp`.
    const panelPosts = [];
    let onPanel;
    vscode.ViewColumn = { Active: -1 };
    vscode.window.createWebviewPanel = () => ({ webview: { asWebviewUri: (u) => u, cspSource: "", postMessage: (m) => panelPosts.push(m), onDidReceiveMessage: (f) => { onPanel = f; } }, onDidDispose() {}, reveal() {} });
    vscode.Uri.joinPath = (...a) => a.join("/");
    vscode.window.showWarningMessage = async () => "Remove";
    const tp = provider.tools;
    const data = async (pred, label) => { // refresh until the panel's data passes
      for (let i = 0; i < 40; i++) {
        const st = panelPosts.length;
        await tp.handle({ type: "refresh" });
        const d = panelPosts.slice(st).find((m) => m.type === "data");
        if (d && pred(d)) return d;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("panel data never showed: " + label + " " + JSON.stringify(panelPosts.filter((m) => m.type !== "data").slice(-3)));
    };
    tp.open();
    onPanel({ type: "ready" });
    let d = await data((x) => x.skills.length, "skills");
    const skill = d.skills.find((s) => s.state === "on");
    await tp.handle({ type: "setSkill", name: skill.name, state: "name-only" });
    assert.strictEqual(JSON.parse(fs.readFileSync(".claude/settings.local.json", "utf8")).skillOverrides[skill.name], "name-only");
    d = await data((x) => x.skills.find((s) => s.name === skill.name).state === "name-only", "skill name-only");
    await tp.handle({ type: "setSkill", name: skill.name, state: "on" });
    assert(!fs.readFileSync(".claude/settings.local.json", "utf8").includes("skillOverrides"), "back on removes the override");
    console.log("skill levels ok:", skill.name);

    fs.writeFileSync("mcp-echo.js", `require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
      const m = JSON.parse(l); if (m.id === undefined) return;
      const result = m.method === "initialize" ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.2.3" } }
        : m.method === "tools/list" ? { tools: [{ name: "shout", description: "Shouts back", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    });`);
    await tp.handle({ type: "saveServer", name: "bs-echo", scope: "local", config: { type: "stdio", command: "node", args: [path.join(cwd, "mcp-echo.js")] } });
    await tp.handle({ type: "saveServer", name: "bs-broken", scope: "local", config: { type: "stdio", command: "bitsmith-no-such-command" } });
    d = await data((x) => x.servers.find((s) => s.name === "bs-echo")?.status === "connected" && x.servers.find((s) => s.name === "bs-broken")?.status === "failed", "echo connected, broken failed");
    const echo = d.servers.find((s) => s.name === "bs-echo");
    assert.deepStrictEqual(echo.tools.map((t) => t.name), ["shout"], "tools listed");
    assert(echo.editable && echo.serverInfo.version === "1.2.3");
    console.log("add server ok; broken server error:", d.servers.find((s) => s.name === "bs-broken").error);

    await tp.handle({ type: "setRule", rule: "mcp__bs-echo__shout", value: "allow" });
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo", value: "ask" });
    let perms = JSON.parse(fs.readFileSync(".claude/settings.local.json", "utf8")).permissions;
    assert(perms.allow.includes("mcp__bs-echo__shout") && perms.ask.includes("mcp__bs-echo"), JSON.stringify(perms));
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo__shout", value: "" });
    perms = JSON.parse(fs.readFileSync(".claude/settings.local.json", "utf8")).permissions;
    assert(!perms.allow.includes("mcp__bs-echo__shout"));
    // the running CLI obeys it: allowed runs without a card, blocked never runs
    provider.setSetting("policy", "review");
    provider.setSetting("mode", "agent");
    let cards = 0;
    onPerm = (m) => { cards++; provider.onWebview({ type: "permission", id: m.id, allow: false }); };
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo", value: "" }); // a server-wide "ask" would win over the tool's allow
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo__shout", value: "allow" });
    let q = await turn("Call the mcp__bs-echo__shout tool once with no arguments, then reply just DONE.");
    assert(q.some((m) => m.type === "tool" && /shout/.test(m.name || m.title || "")) && cards === 0, "allowed tool runs without asking; cards: " + cards);
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo__shout", value: "deny" });
    q = await turn("Call the mcp__bs-echo__shout tool once with no arguments, then reply just DONE.");
    assert(cards === 0 && !q.some((m) => m.type === "permission"), "blocked tool never asks");
    await tp.handle({ type: "setRule", rule: "mcp__bs-echo__shout", value: "" });
    console.log("tool permissions ok (allow + block applied live)");

    await tp.handle({ type: "toggleServer", name: "bs-echo", enabled: false });
    await data((x) => x.servers.find((s) => s.name === "bs-echo")?.status === "disabled", "echo disabled");
    await tp.handle({ type: "toggleServer", name: "bs-echo", enabled: true });
    await tp.handle({ type: "saveServer", name: "bs-echo2", scope: "local", config: echo.config, old: { name: "bs-echo", scope: "local", config: echo.config } });
    d = await data((x) => x.servers.some((s) => s.name === "bs-echo2") && !x.servers.some((s) => s.name === "bs-echo"), "renamed");
    for (const name of ["bs-echo2", "bs-broken"]) await tp.handle({ type: "removeServer", name, scope: "local" });
    await data((x) => !x.servers.some((s) => s.name.startsWith("bs-")), "removed");
    console.log("toggle + edit + remove ok");
    provider.shutdown();
    process.exit(0);
  }

  // Auto-compact: with a tiny limit the real CLI compacts on its own; the meter knows the threshold, the notice says "auto".
  if (process.argv.includes("--live-compact")) {
    const base = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({ get: (k) => (k === "autoCompactAt" ? "100000" : base().get(k)) });
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    provider.setSetting("policy", "bypass");
    const ch = provider.active;
    const st = posts.length;
    await turn("Reply with just OK.");
    const ctx = await waitFor((m) => m.type === "context" && m.threshold > 0, st, 30000);
    assert(ctx.threshold < 100000, "threshold below the 100k limit: " + ctx.threshold); // the CLI won't go under a 100k window
    const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".split(" ");
    for (const f of ["big1.txt", "big2.txt", "big3.txt"]) fs.writeFileSync(f, Array.from({ length: 1400 }, (_, i) => `${i} ` + Array.from({ length: 12 }, (_, j) => words[(i * 7 + j * 3) % words.length] + ((i + j) % 97)).join(" ")).join("\n"));
    console.log("threshold on the meter ok:", ctx.threshold, "used", ctx.used);
    vscode.window.showWarningMessage = async () => "Restore";
    const s0 = posts.length;
    provider.onWebview({ type: "send", chat: ch.key, context: [], text: "Use the Write tool to create note.txt containing exactly: BEFORE", checkpoint: 801 });
    await waitFor((m) => m.type === "done", s0);
    assert(fs.existsSync("note.txt"), "note written");
    let auto;
    for (let i = 0; i < 6 && !auto; i++) {
      const p = await turn(`Read ${["big1.txt", "big2.txt", "big3.txt"][i % 3]} with the Read tool (the whole file), then reply just OK.`);
      auto = p.find((m) => m.type === "notice" && /auto-compacted/.test(m.text));
    }
    assert(auto, "the CLI auto-compacted");
    console.log("auto-compact ok:", auto.text);
    const items = ext.replay(path.join(provider.sessionDir(), ch.sessionId + ".jsonl"), (f) => f);
    assert(items.some((i) => i.type === "notice" && /auto-compacted/.test(i.text)), "history shows it as auto");
    // Restore to a message from before the compaction: files go back and the conversation continues from there
    await provider.restore(801);
    assert(!fs.existsSync("note.txt"), "restore across a compaction reverts the file");
    const after = await turn("Reply with just the word PONG.");
    assert(/PONG/.test(said(after)) && !after.some((m) => m.type === "error"), "the chat continues after restoring past a compaction: " + JSON.stringify(after.map((m) => m.type + (m.text ? ":" + String(m.text).slice(0, 120) : ""))));
    const t2 = fs.readFileSync(path.join(provider.sessionDir(), ch.sessionId + ".jsonl"), "utf8");
    assert(/BEFORE/.test(t2) && !/compact_boundary/.test(t2.split("PONG")[0].split("BEFORE").pop()), "the branch keeps the early messages and drops the compaction");
    console.log("restore across auto-compact ok");
    vscode.workspace.getConfiguration = () => ({ get: (k) => (k === "autoCompactAt" ? "off" : base().get(k)) });
    const st2 = posts.length;
    await turn("Reply with just OK.");
    await waitFor((m) => m.type === "context" && m.threshold === 0, st2, 30000);
    console.log("off: meter says auto-compact is off ok");
    provider.shutdown();
    process.exit(0);
  }

  if (process.argv.includes("--live-bg")) {
    provider.onWebview({ type: "ready" });
    provider.setSetting("model", "haiku");
    provider.setSetting("policy", "bypass");
    const first = provider.active;
    const st = posts.length;
    provider.onWebview({ type: "send", chat: first.key, context: [], text: "In ONE message call two tools in parallel: (1) Agent tool, subagent_type general-purpose, description 'multiply', run in the background, prompt: run `sleep 3; echo $((17*23))` in Bash and report the number. (2) Bash `sleep 120` with run_in_background true. Then reply just 'launched'." });
    await waitFor((m) => m.type === "done", st);
    assert(posts.slice(st).some((m) => m.type === "toolResult" && m.background), "a step reports running in background");
    const running = await waitFor((m) => m.type === "tasks" && m.tasks.some((t) => t.type === "local_bash"), st);
    await waitFor((m) => m.type === "taskEvent" && /multiply/.test(m.summary) && m.result, st);
    const auto = posts.length;
    await waitFor((m) => m.type === "autoTurn", st, 60000);
    await waitFor((m) => m.type === "done", auto);
    assert(posts.slice(st).some((m) => m.type === "tool" && m.parent), "sub-agent steps nest under the agent");
    assert(posts.slice(st).every((m) => m.chat === first.key || !m.chat), "everything lands in the first chat");
    const bash = running.tasks.find((t) => t.type === "local_bash");
    const st2 = posts.length;
    provider.onWebview({ type: "stopTask", chat: first.key, taskId: bash.id });
    await waitFor((m) => m.type === "taskEvent" && m.taskId === bash.id && m.status === "stopped", st2, 30000);
    console.log("background tasks ok");

    // two chats reply at the same time, each into its own pane
    await new Promise((r) => setTimeout(r, 2000));
    while (first.busy) await new Promise((r) => setTimeout(r, 200)); // Claude may reply about the stop first
    provider.newChat();
    const second = provider.active;
    assert(second !== first && provider.chats.size === 2, "a second chat opens in its own tab");
    const st3 = posts.length;
    provider.onWebview({ type: "send", chat: first.key, context: [], text: "Reply with just the word ALPHA." });
    provider.onWebview({ type: "send", chat: second.key, context: [], text: "Reply with just the word BRAVO." });
    const words = (key) => said(posts.slice(st3).filter((m) => m.chat === key));
    // an auto turn about the stopped task may finish first, so wait for the reply itself
    await waitFor((m) => m.type === "done" && m.chat === first.key && /ALPHA/.test(words(first.key)), st3);
    await waitFor((m) => m.type === "done" && m.chat === second.key, st3);
    assert(/ALPHA/.test(words(first.key)) && !/BRAVO/.test(words(first.key)), "first chat: " + words(first.key));
    assert(/BRAVO/.test(words(second.key)) && !/ALPHA/.test(words(second.key)), "second chat: " + words(second.key));
    assert(first.sessionId !== second.sessionId);
    console.log("two chats at once ok");

    // /compact from the panel (sent like any message) compacts and reports it
    const st4 = posts.length;
    provider.onWebview({ type: "send", chat: second.key, context: [], text: "/compact" });
    const note = await waitFor((m) => m.type === "notice" && m.chat === second.key, st4, 120000);
    assert(/compacted/.test(note.text), note.text);
    await waitFor((m) => m.type === "done" && m.chat === second.key, st4);
    assert(posts.slice(st4).some((m) => m.type === "context" && m.chat === second.key), "context meter updated");
    console.log("compact ok:", note.text);

    // tabs come back after a reload: a new panel reopens both sessions, the active one on screen
    const ids = [first.sessionId, second.sessionId];
    provider.shutdown();
    ext.activate(ctx);
    provider.view = { webview: { postMessage: (m) => posts.push(m) } };
    const st5 = posts.length;
    provider.onWebview({ type: "ready" });
    assert.deepStrictEqual([...provider.chats.values()].map((c) => c.sessionId), ids, "both tabs reopened");
    await new Promise((r) => setTimeout(r, 100)); // replay follows the loading screen
    assert.strictEqual(provider.active.sessionId, second.sessionId, "the tab that was on screen");
    assert.strictEqual(posts.slice(st5).filter((m) => m.type === "replay").length, 2);
    assert.strictEqual([...provider.chats.values()].filter((c) => c.claude).length, 1, "only the shown tab starts a process");
    console.log("tabs restored ok");

    // shell commands: Restore puts back what a command changed (tracked files from git, new untracked files deleted); Redo re-applies
    const { execSync } = require("child_process");
    execSync("git init -q && git add a.txt b.txt && git -c user.email=t@t -c user.name=t commit -qm init", { cwd });
    const sh = provider.active;
    const send = async (text, checkpoint) => { const s0 = posts.length; provider.onWebview({ type: "send", chat: sh.key, context: [], text, checkpoint }); await waitFor((m) => m.type === "done" && m.chat === sh.key, s0); };
    vscode.window.showWarningMessage = async () => "Restore";
    await send("Run exactly this shell command with Bash, nothing else: printf 'by shell\\n' > a.txt && printf 'new\\n' > shell-made.txt", 501);
    await new Promise((r) => setTimeout(r, 1500)); // the after-reply git snapshot is async
    assert.strictEqual(fs.readFileSync("a.txt", "utf8"), "by shell\n", "the command ran");
    await provider.restore(501);
    assert.strictEqual(fs.readFileSync("a.txt", "utf8"), "hello\n", "tracked file put back from git");
    assert(!fs.existsSync("shell-made.txt"), "file the command created is removed");
    await provider.redo();
    assert.strictEqual(fs.readFileSync("a.txt", "utf8"), "by shell\n", "redo re-applies the command's change");
    assert.strictEqual(fs.readFileSync("shell-made.txt", "utf8"), "new\n");
    console.log("shell revert ok");

    // several restores in a row, then redo them one at a time
    await send("Reply with just ONE.", 502);
    await send("Reply with just TWO.", 503);
    const n = sh.checkpoints.length;
    await provider.restore(503);
    await provider.restore(502);
    assert.strictEqual(sh.checkpoints.length, n - 2);
    await provider.redo();
    assert.strictEqual(sh.checkpoints.length, n - 1, "first redo brings back the later restore's messages only");
    assert(provider.redoState, "one more to redo");
    await provider.redo();
    assert.strictEqual(sh.checkpoints.length, n);
    assert.strictEqual(provider.redoState, null);
    console.log("multi-step redo ok");

    // Source Control button: a commit message for the working-tree diff lands in the commit box
    const repo = { rootUri: { fsPath: cwd }, diff: async (staged) => (staged ? "" : execSync("git diff", { cwd }).toString()), inputBox: { value: "" } };
    vscode.extensions = { getExtension: () => ({ exports: { getAPI: () => ({ repositories: [repo], getRepository: () => repo }) } }) };
    vscode.ProgressLocation = { SourceControl: 1 };
    vscode.window.withProgress = (o, f) => f();
    await provider.commitMessage();
    assert(repo.inputBox.value.length > 8 && !/```/.test(repo.inputBox.value), "commit message: " + repo.inputBox.value);
    console.log("commit message ok:", repo.inputBox.value.split("\n")[0]);
    provider.shutdown();
    process.exit(0);
  }

  provider.onWebview({ type: "ready" });
  const init = await waitFor((m) => m.type === "init", 0, 60000);
  assert(init.models.length && init.commands.length, "init lists models and commands");
  console.log(`init ok: ${init.models.length} models, ${init.commands.length} commands`);

  // review policy: edit lands, changes bar shows it, undo restores
  provider.setSetting("model", "haiku");
  let p = await turn("Use the Edit tool to change hello to goodbye in a.txt. Nothing else.");
  assert.strictEqual(fs.readFileSync("a.txt", "utf8"), "goodbye\n");
  const res = p.find((m) => m.type === "toolResult" && m.diff);
  assert.deepStrictEqual(res.diff, { added: 1, removed: 1 });
  const changes = p.filter((m) => m.type === "changes").pop();
  assert.strictEqual(changes.files[0].rel, "a.txt");
  await provider.edits.undo(path.join(cwd, "a.txt"));
  assert.strictEqual(fs.readFileSync("a.txt", "utf8"), "hello\n");
  console.log("review policy + undo ok");

  // ask policy: reject leaves the file alone
  provider.setSetting("policy", "ask");
  onPerm = (m) => provider.onWebview({ type: "permission", id: m.id, allow: false });
  p = await turn("Use the Edit tool to change two to TWO in b.txt. If rejected, stop and say REJECTED.");
  assert(p.some((m) => m.type === "permission" && m.kind === "edit" && m.hasDiff));
  assert.strictEqual(fs.readFileSync("b.txt", "utf8"), "one\ntwo\nthree\nfour\n");
  console.log("ask policy reject ok:", said(p).slice(-40));

  // command approval with attached context
  onPerm = (m) => provider.onWebview({ type: "permission", id: m.id, allow: true });
  p = await turn("Run exactly this shell command: mkdir -p made-by-agent && echo bitsmith-ok   then reply with its output only.", { context: [{ kind: "file", rel: "b.txt", file: path.join(cwd, "b.txt") }] });
  const perm = p.find((m) => m.type === "permission");
  assert(perm && perm.kind === "tool" && /mkdir -p made-by-agent/.test(perm.detail), "bash asks first");
  assert(/bitsmith-ok/.test(said(p)));
  assert(fs.existsSync("made-by-agent"));
  console.log("command approval ok");

  // keep-hunk: two separate edits, keep one hunk, undo the rest
  provider.setSetting("policy", "review");
  await turn("Use one MultiEdit (or two Edit calls) on b.txt: change one to ONE and four to FOUR. Nothing else.");
  const bfile = path.join(cwd, "b.txt");
  const hunks = provider.edits.hunks(bfile);
  assert.strictEqual(hunks.length, 2, "two hunks");
  provider.edits.keepHunk(bfile, hunks[0]);
  assert.strictEqual(provider.edits.hunks(bfile).length, 1);
  await provider.edits.undo(bfile);
  assert.strictEqual(fs.readFileSync("b.txt", "utf8"), "ONE\ntwo\nthree\nfour\n");
  console.log("keep hunk + undo rest ok");

  // interrupt keeps the session usable
  let start = posts.length;
  provider.onWebview({ type: "send", text: "Count from 1 to 300, one number per line.", context: [] });
  await waitFor((m) => m.type === "text", start);
  provider.onWebview({ type: "stop" });
  await waitFor((m) => m.type === "done", start, 20000);
  p = await turn("Reply with just the word PONG, after a short pause to think.");
  assert(/PONG/.test(said(p)));
  await new Promise((r) => setTimeout(r, 4500)); // past the stop fallback timer
  assert(provider.claude, "a turn sent right after Stop must not be killed by the stop timer");
  console.log("interrupt + continue ok");

  // history: replay shows our turns with chips and steps
  const file = path.join(provider.sessionDir(), provider.sessionId + ".jsonl");
  const items = ext.replay(file, (f) => path.relative(cwd, f));
  const users = items.filter((i) => i.type === "user");
  assert(users.length >= 5, "replayed user turns: " + users.length);
  assert(users.some((u) => u.chips.some((c) => c.rel === "b.txt")), "chips restored");
  assert(items.some((i) => i.type === "tool" && i.title === "Edited"));
  console.log("history ok:", ext.sessionTitle(file));

  // plan mode: Claude proposes a plan, approving it switches back to agent mode
  provider.setSetting("mode", "plan");
  onPerm = (m) => provider.onWebview({ type: "permission", id: m.id, allow: m.kind === "plan" });
  p = await turn("Plan how to add a c.txt file containing the word hi. Keep the plan to 2 short steps, then present it for approval.");
  assert(p.some((m) => m.type === "permission" && m.kind === "plan" && m.plan), "plan card shown. tools: " + p.filter((m) => m.type === "tool").map((m) => m.name).join(",") + " text: " + said(p).slice(0, 300));
  assert(p.some((m) => m.type === "settings" && m.mode === "agent"), "approving the plan returns to agent mode");
  console.log("plan mode ok");

  // restore checkpoint: files and conversation go back to before message 2
  vscode.window.showWarningMessage = async () => "Restore";
  provider.newChat();
  provider.setSetting("model", "haiku");
  provider.setSetting("policy", "review");
  provider.setSetting("mode", "agent");
  fs.writeFileSync("c.txt", "zero\n");
  const send = async (text, checkpoint) => { const st = posts.length; provider.onWebview({ type: "send", text, context: [], checkpoint }); await waitFor((m) => m.type === "done", st); return posts.slice(st); };
  let q = await send("My favourite fruit is APPLE. Use the Write tool to set c.txt to exactly: one", 1);
  assert.strictEqual(fs.readFileSync("c.txt", "utf8").trim(), "one", "reply: " + said(q) + " | events: " + q.map((m) => m.type + (m.type === "permission" ? ":" + m.kind : "")).join(","));
  await send("I also like the fruit BANANA. Use the Write tool to set c.txt to exactly: two", 2);
  assert.strictEqual(fs.readFileSync("c.txt", "utf8").trim(), "two");
  start = posts.length;
  await provider.restore(2);
  assert(posts.slice(start).some((m) => m.type === "restored" && m.checkpoint === 2));
  assert.strictEqual(fs.readFileSync("c.txt", "utf8").trim(), "one", "file back to before message 2");
  // redo brings back the file and the full conversation
  start = posts.length;
  await provider.redo();
  assert(posts.slice(start).some((m) => m.type === "redone"));
  assert.strictEqual(fs.readFileSync("c.txt", "utf8").trim(), "two", "redo re-applies the edit");
  p = await send("Which fruits have I told you I like in this chat? Reply with only the fruit names, comma separated.", 3);
  assert(/APPLE/.test(said(p)) && /BANANA/.test(said(p)), "conversation back after redo: " + said(p));
  console.log("redo ok:", said(p));
  assert.strictEqual(provider.redoState, null);
  // restore again, then a new message: rewound, and redo is gone
  await provider.restore(2);
  assert.strictEqual(fs.readFileSync("c.txt", "utf8").trim(), "one");
  p = await send("Which fruits have I told you I like in this chat? Reply with only the fruit names, comma separated.", 4);
  assert(/APPLE/.test(said(p)) && !/BANANA/.test(said(p)), "conversation rewound: " + said(p));
  assert.strictEqual(provider.redoState, null, "sending drops redo");
  await provider.restore(1);
  assert.strictEqual(fs.readFileSync("c.txt", "utf8"), "zero\n", "restoring the first message reverts everything");
  assert.strictEqual(provider.sessionId, null);
  console.log("restore checkpoint ok:", said(p));

  // checkpoints survive closing and reopening the chat
  provider.newChat();
  fs.writeFileSync("d.txt", "zero\n");
  await send("My favourite fruit is CHERRY. Use the Write tool to set d.txt to exactly: one", 11);
  await send("I also like the fruit MANGO. Use the Write tool to set d.txt to exactly: two", 12);
  const reopened = provider.sessionId;
  provider.closeChat(provider.active); // close its tab
  start = posts.length;
  await provider.loadSession(reopened);
  const replayed = posts.slice(start).find((m) => m.type === "replay").items.filter((i) => i.type === "user");
  assert.strictEqual(replayed.length, 2);
  assert(replayed[1].checkpoint, "second message has its restore checkpoint after reopening");
  await provider.restore(replayed[1].checkpoint);
  assert.strictEqual(fs.readFileSync("d.txt", "utf8").trim(), "one", "file restored after reopening");
  p = await send("Which fruits have I told you I like in this chat? Reply with only the fruit names, comma separated.", 13);
  assert(/CHERRY/.test(said(p)) && !/MANGO/.test(said(p)), "conversation rewound after reopening: " + said(p));
  console.log("checkpoints after reopen ok:", said(p));

  // edit a message: files and conversation rewind to before it, then the edited text is sent
  provider.newChat();
  fs.writeFileSync("e.txt", "zero\n");
  await send("My favourite fruit is PLUM. Use the Write tool to set e.txt to exactly: one", 21);
  await send("I also like the fruit PEAR. Use the Write tool to set e.txt to exactly: two", 22);
  start = posts.length;
  provider.onWebview({ type: "editMessage", checkpoint: 22, text: "I also like the fruit KIWI. Use the Write tool to set e.txt to exactly: kiwi" });
  const restored = await waitFor((m) => m.type === "restored", start, 30000);
  assert.strictEqual(restored.resend, "I also like the fruit KIWI. Use the Write tool to set e.txt to exactly: kiwi");
  assert.strictEqual(fs.readFileSync("e.txt", "utf8").trim(), "one", "edit reverts the old message's file change first");
  await send(restored.resend, 23); // what the panel does with `resend`
  assert.strictEqual(fs.readFileSync("e.txt", "utf8").trim(), "kiwi");
  p = await send("Which fruits have I told you I like in this chat? Reply with only the fruit names, comma separated.", 24);
  assert(/PLUM/.test(said(p)) && /KIWI/.test(said(p)) && !/PEAR/.test(said(p)), "conversation has the edited message only: " + said(p));
  console.log("edit message ok:", said(p));

  provider.shutdown();
  console.log("ALL PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.stack || e.message); provider?.shutdown(); process.exit(1); });
