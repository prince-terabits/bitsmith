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
    openTextDocument: async (f) => ({ uri: vscode.Uri.file(f), getText: () => fs.readFileSync(f, "utf8"), lineCount: 1, save: async () => true }),
    fs: { stat: async (u) => ({ type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 }) },
    findFiles: async () => [],
    saveAll: async () => true,
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [], tabGroups: { all: [] },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    createStatusBarItem: () => (statusItem = { show() {}, dispose() {} }),
    registerWebviewViewProvider: (_, p) => { provider = p; return noop(); },
    createTreeView: (_, o) => { tree = o.treeDataProvider; return noop(); }, showWarningMessage: async () => undefined,
    onDidChangeActiveTextEditor: noop, onDidChangeTextEditorSelection: noop, onDidChangeVisibleTextEditors: noop,
  },
  languages: { registerCodeLensProvider: noop },
  commands: { registerCommand: noop, executeCommand: (...a) => commands.push(a) },
  env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
};
let provider, tree, statusItem;
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
    vscode.window.showTextDocument = async (u) => opened.push(u.fsPath);
    vscode.window.showQuickPick = async (items) => { picks.push(items.map((i) => i.description)); return items[0]; };
    await provider.openPath(c, "notes.md");
    await provider.openPath(c, "deep/notes.md");
    await provider.openPath(c, "package.json"); // two match: ask, shortest first
    c.tools.set("t1", { name: "Edit", input: { file_path: path.join(cwd, "y/z/package.json") } });
    await provider.openPath(c, "package.json"); // the one this chat edited wins
    assert.deepStrictEqual(opened.map((f) => path.relative(cwd, f)), ["docs/deep/notes.md", "docs/deep/notes.md", "x/package.json", "y/z/package.json"]);
    assert.deepStrictEqual(picks, [["x/package.json", "y/z/package.json"]]);
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
    assert(tab.posts.some((m) => m.type === "replay" && m.items.some((i) => i.text === "panel me")), "the tab replays the chat");
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
  if (process.argv.includes("--quick")) process.exit(0);

  // background work: an async sub-agent and a background command, Claude's own follow-up, Stop, and two chats at once
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
  provider.loadSession(reopened);
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
