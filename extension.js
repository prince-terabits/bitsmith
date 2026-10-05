const vscode = require("vscode");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { EditTracker, diffLines, lines, stats } = require("./edits");
const { showBrowser } = require("./browser-view");

const PROPOSED = "bitsmith-proposed";
const USAGE_POLL = 2 * 60 * 1000; // plan usage refresh while the window is focused
const proposed = new Map(); // proposed-file uri -> content, right side of an "ask first" diff
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const HIDDEN_TOOLS = new Set(["ToolSearch"]); // Claude loading its own tools: not a step worth showing
const EXCLUDE = "**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__,coverage}/**";

// Files that make something else run commands later: git/Claude/VS Code config and hooks, and shell startup files.
// Writing one of these is really "run a command", so it asks whatever the policy says, and so does any write
// outside the workspace (scratch files in the temp dir excepted).
const RUN_DIRS = ["/.git/", "/.claude/", "/.vscode/", "/.husky/", "/.devcontainer/", "/.github/workflows/"];
const RUN_FILES = new Set([".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", "config.fish"]);
let storageDir = null; // the extension's global storage folder, set on activation
const fwd = (p) => path.resolve(p).replace(/\\/g, "/");
function riskyEdit(file, inFolder) {
  const p = fwd(file);
  if (RUN_FILES.has(path.basename(p)) || RUN_DIRS.some((d) => p.includes(d))) return true;
  return !inFolder && !p.startsWith(fwd(os.tmpdir()) + "/");
}

// One long-lived Claude Code CLI process speaking stream-json, resumable by session id.
class Claude {
  constructor({ cwd, model, effort, resume, resumeAt, onMessage, onExit }) {
    const cfg = vscode.workspace.getConfiguration("bitsmith");
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "default"];
    if (model && model !== "default") args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (resume) args.push("--resume", resume);
    if (resume && resumeAt) args.push("--resume-session-at", resumeAt, "--fork-session"); // rewind: continue from that reply in a new branch
    const browser = cfg.get("browser");
    if (browser && browser !== "off") { // Bitsmith's own browser tools (browser-mcp.js), run on VS Code's Node, which has WebSocket
      this.browserState = path.join(os.tmpdir(), `bitsmith-browser-${process.pid}-${Math.random().toString(36).slice(2)}.json`); // where the live view finds the page
      const env = { ELECTRON_RUN_AS_NODE: "1", BITSMITH_BROWSER: browser, BITSMITH_STATE: this.browserState };
      if (cfg.get("browserKeepLogins") && storageDir) env.BITSMITH_PROFILE = path.join(storageDir, "browser-profile");
      const server = { command: process.execPath, args: [path.join(__dirname, "browser-mcp.js")], env };
      args.push("--mcp-config", JSON.stringify({ mcpServers: { browser: server } }),
        "--allowedTools", "mcp__browser__browser_snapshot,mcp__browser__browser_screenshot,mcp__browser__browser_console"); // looking never asks; acting does
    }
    this.effort = effort;
    this.waiting = new Map();
    this.stderr = "";
    this.proc = spawn(cfg.get("claudePath"), args, { cwd, env: process.env });
    this.proc.on("error", (e) => onExit(`Could not start Claude Code (${cfg.get("claudePath")}): ${e.message}`));
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.proc.stdin.on("error", () => {}); // EPIPE when the CLI dies just before a write; its exit is reported by "close"
    this.proc.on("close", (code) => !this.killed && onExit(code ? this.stderr.trim() || `Claude Code exited (${code})` : null));
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === "control_response") {
        const w = this.waiting.get(m.response.request_id);
        this.waiting.delete(m.response.request_id);
        return w?.(m.response);
      }
      onMessage(m);
    });
  }

  write(obj) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(request) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.write({ type: "control_request", request_id: id, request });
    });
  }

  respond(id, response) {
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }

  kill() {
    this.killed = true;
    this.proc.kill();
  }
}

// One conversation: its own Claude Code process, approvals, checkpoints and background tasks.
// Several run side by side; the panel shows one at a time and the rest keep going.
class Chat {
  constructor(provider, key) {
    this.p = provider;
    this.key = key; // stable id for the webview; the session id changes on forks
    this.claude = null;
    this.sessionId = null;
    this.busy = false;
    this.pending = new Map(); // permission request id -> { req, diff }
    this.tools = new Map(); // tool_use id -> { name, input }
    this.checkpoints = []; // one per live message: { id, sessionId, resumeAt, snaps: Map(file -> text | null) }
    this.lastUuid = null; // last top-level assistant message, the point to rewind the conversation to
    this.userCount = 0; // messages sent since lastUuid; with it, a key for each message that survives reopening and forks
    this.resumeAt = null;
    this.redoStack = []; // what each restore undid, newest last, until the next message is sent
    this.allowEdits = false; // "Allow all edits in this chat" on an edit card
    this.queue = []; // messages typed ahead in the panel, kept so a reload doesn't lose them
    this.turnMark = null; // git state when the current reply started (promise), to find shell-made changes
    this.tasks = []; // background tasks still running: { id, type, description, start, toolUseId, progress }
    this.background = new Set(); // ids of tasks started in the background (others are a sub-agent's own foreground work)
    this.known = new Map(); // task id -> { type, description }, kept after the task ends for its notification
    this.title = "";
    this.context = { used: 0, window: 0 }; // tokens in the conversation now, and the model's context window
  }

  get folder() { return this.p.folder; }
  get edits() { return this.p.edits; }
  rel(file) { return this.p.rel(file); }
  settings() { return this.p.settings(); }
  sessionDir() { return this.p.sessionDir(); }
  post(msg) { this.p.post({ ...msg, chat: this.key }); }
  get fresh() { return !this.sessionId && !this.busy && !this.checkpoints.length; }

  // ---- process lifecycle ----

  ensure() {
    if (this.claude || !this.folder) return this.claude;
    const s = this.settings();
    const claude = new Claude({
      cwd: this.folder, model: s.model, effort: s.effort, resume: this.sessionId, resumeAt: this.resumeAt,
      onMessage: (m) => this.claude === claude && this.handle(m), // lines a killed process still had buffered are dropped
      onExit: (err) => {
        if (this.claude !== claude) return;
        this.claude = null;
        this.dropPending();
        if (err) this.post({ type: "error", text: err });
        if (this.busy) this.finish();
        this.setTasks([]);
      },
    });
    claude.model = s.model;
    claude.mode = "default";
    this.claude = claude;
    this.resumeAt = null;
    claude.request({ subtype: "initialize" }).then((r) => this.p.onInit(r));
    this.syncSettings();
    return claude;
  }

  // Model and mode are global settings; a chat picks up changes made while it was in the background.
  syncSettings() {
    const c = this.claude, s = this.settings();
    if (!c) return;
    const mode = s.mode === "plan" ? "plan" : "default";
    if (c.model !== s.model) { c.model = s.model; c.request({ subtype: "set_model", model: s.model }); }
    if (c.mode !== mode) { c.mode = mode; c.request({ subtype: "set_permission_mode", mode }); }
  }

  restart() {
    this.claude?.kill();
    this.claude = null;
    if (this.tasks.length) this.setTasks([]); // they die with the process
    this.dropPending();
  }

  shutdown() {
    this.restart();
    if (this.busy) { this.busy = false; this.saveCheckpoints(); } // keep this message restorable
  }

  // Approvals nobody can answer any more: close their diffs and their cards.
  dropPending() {
    for (const id of this.pending.keys()) this.closeProposed(id);
    if (this.pending.size) this.post({ type: "approvalsCancelled" });
    this.pending.clear();
  }

  // Back to an empty chat in place.
  reset() {
    this.shutdown();
    this.sessionId = null;
    this.busy = false;
    this.checkpoints = [];
    this.redoStack = [];
    this.allowEdits = false;
    this.queue = [];
    this.lastUuid = null;
    this.title = "";
    this.post({ type: "clear" });
    this.setContext(0);
    this.p.chatChanged(this);
    this.ensure();
  }

  interrupt() {
    if (!this.claude || !this.busy) return;
    const claude = this.claude;
    claude.request({ subtype: "interrupt" });
    for (const id of this.pending.keys()) claude.respond(id, { behavior: "deny", message: "Interrupted by the user." });
    this.dropPending();
    const stopped = this.started; // only force-stop this turn, never a newer one sent within the timeout
    setTimeout(() => { if (this.busy && this.claude === claude && this.started === stopped) { this.restart(); this.finish(); } }, 4000);
  }

  finish(extra = {}) {
    this.busy = false;
    this.saveCheckpoints();
    if (this.turnMark) this.recordShell(this.turnMark, this.p.gitMark(), this.checkpoints[this.checkpoints.length - 1]);
    this.turnMark = null;
    for (const file of this.edits.snapshots.keys()) this.edits.syncFromDisk(file);
    this.post({ type: "done", ms: Date.now() - this.started, ...extra });
    this.edits.refresh();
    this.updateTitle();
    this.p.notify(this, "finished");
  }

  // ---- sending ----

  async send({ text, images = [], context = [], useActive, checkpoint }) {
    if (!this.folder) return this.post({ type: "error", text: "Open a folder to chat with Bitsmith." });
    if (this.busy) return;
    this.busy = true;
    await vscode.workspace.saveAll(false); // Claude reads files from disk, so unsaved edits would be invisible to it
    if (this.claude && (this.claude.effort || "") !== this.settings().effort) this.restart(); // effort is a launch flag
    const claude = this.ensure();
    this.syncSettings();
    this.started = Date.now();
    this.redoStack = [];
    this.turnMark = this.p.gitMark();
    if (checkpoint != null) this.checkpoints.push({ id: checkpoint, key: `${this.lastUuid || "start"}#${this.userCount}`, sessionId: this.sessionId, resumeAt: this.lastUuid, snaps: new Map() });
    this.userCount++;
    const content = images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } }));
    content.push({ type: "text", text: this.p.withContext(text, context, useActive) });
    claude.write({ type: "user", message: { role: "user", content } });
  }

  // Claude replying on its own, e.g. after a background task finished.
  beginAuto() {
    this.busy = true;
    this.started = Date.now();
    this.turnMark = this.p.gitMark();
    this.post({ type: "autoTurn" });
  }

  // ---- CLI messages ----

  handle(m) {
    if (m.session_id && m.type === "system" && m.subtype === "init") this.sessionId = m.session_id;
    const parent = m.parent_tool_use_id || null; // set on a sub-agent's own messages
    if (!this.busy && !parent && (m.type === "stream_event" || m.type === "assistant")) this.beginAuto();
    if (m.type === "stream_event" && !parent) {
      const e = m.event;
      if (e.type === "content_block_start" && e.content_block.type === "thinking") this.post({ type: "thinkingStart" });
      if (e.type === "content_block_start" && e.content_block.type === "text") this.post({ type: "textStart" });
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") this.post({ type: "text", text: e.delta.text });
      if (e.type === "content_block_delta" && e.delta.type === "thinking_delta") this.post({ type: "thinking", text: e.delta.thinking });
    } else if (m.type === "assistant") {
      if (!parent && m.uuid) { this.lastUuid = m.uuid; this.userCount = 0; }
      if (!parent && m.message.usage) this.setContext(contextTokens(m.message.usage), m.message.model);
      for (const b of m.message.content) if (b.type === "tool_use") this.toolStart(b, parent);
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b.type === "tool_result") this.toolResult(b, parent);
    } else if (m.type === "system") {
      this.system(m);
    } else if (m.type === "rate_limit_event" && m.rate_limit_info) {
      this.p.setUsage(m.rate_limit_info);
    } else if (m.type === "result") {
      if (m.is_error && m.subtype !== "error_during_execution") this.post({ type: "error", text: m.result || "Claude Code reported an error." });
      for (const [model, u] of Object.entries(m.modelUsage || {})) if (u.contextWindow) this.p.rememberWindow(model, u.contextWindow);
      this.setContext(this.context.used, this.model);
      if (this.busy) this.finish({ cost: m.total_cost_usd });
    } else if (m.type === "control_request") {
      if (m.request.subtype === "can_use_tool") this.ask(m.request_id, m.request);
      else this.claude?.write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Not supported" } });
    }
  }

  // Background tasks: the CLI reports the running set, progress, and a notification when each one ends.
  system(m) {
    if (m.subtype === "status" && m.status === "compacting") this.post({ type: "status", text: "Compacting conversation…" });
    if (m.subtype === "compact_boundary") {
      const meta = m.compact_metadata || {};
      this.post({ type: "notice", icon: "fold", text: compactText(meta.pre_tokens, meta.post_tokens) });
      this.setContext(meta.post_tokens || 0, this.model);
    }
    if (m.subtype === "background_tasks_changed") {
      const known = new Map(this.tasks.map((t) => [t.id, t]));
      for (const t of m.tasks || []) this.known.set(t.task_id, { type: t.task_type, description: t.description });
      this.setTasks((m.tasks || []).map((t) => known.get(t.task_id) || { id: t.task_id, type: t.task_type, description: t.description, start: Date.now() }));
    } else if (m.subtype === "task_started" && m.is_backgrounded) {
      this.background.add(m.task_id);
      const t = this.tasks.find((x) => x.id === m.task_id);
      if (t) { t.toolUseId = m.tool_use_id; t.agentType = m.subagent_type; this.setTasks(this.tasks); }
    } else if (m.subtype === "task_progress") {
      this.post({ type: "agentProgress", toolUseId: m.tool_use_id, text: m.description, tools: m.usage?.tool_uses });
      const t = this.tasks.find((x) => x.id === m.task_id);
      if (t) { t.progress = m.description; this.setTasks(this.tasks); }
    } else if (m.subtype === "task_notification" && this.background.has(m.task_id)) {
      const k = this.known.get(m.task_id) || {};
      const agent = k.type === "local_agent"; // for an agent the CLI's "summary" is its answer
      const ended = m.status === "completed" ? "finished" : m.status;
      this.post({ type: "taskEvent", taskId: m.task_id, toolUseId: m.tool_use_id, status: m.status, outputFile: m.output_file || "",
        summary: agent ? `Agent "${k.description || "task"}" ${ended}` : m.summary, result: agent ? m.summary : "" });
    }
  }

  setContext(used, model) {
    if (model) this.model = model;
    this.context = { used, window: this.p.windowFor(this.model) };
    this.post({ type: "context", ...this.context });
  }

  setTasks(list) {
    this.tasks = list;
    this.post({ type: "tasks", tasks: list.map(({ id, type, description, start, toolUseId, progress }) => ({ id, type, description, start, toolUseId, progress })) });
  }

  stopTask(id) {
    this.claude?.request({ subtype: "stop_task", task_id: id });
  }

  // Where the CLI writes a background task's output.
  taskOutput(id) {
    if (!/^\w+$/.test(id || "") || !this.sessionId) return;
    const dir = path.join(os.tmpdir(), `claude-${os.userInfo().uid}`, (this.folder || "").replace(/[^a-zA-Z0-9]/g, "-"), this.sessionId, "tasks");
    const file = path.join(dir, id + ".output");
    if (fs.existsSync(file)) openFile(file);
    else vscode.window.showInformationMessage("This task hasn't written any output yet.");
  }

  toolStart(b, parent) {
    this.tools.set(b.id, { name: b.name, input: b.input });
    if (EDIT_TOOLS.has(b.name)) this.snapshot(b.input.file_path || b.input.notebook_path);
    if (b.name === "TodoWrite" && !parent) this.post({ type: "todos", todos: b.input.todos || [] });
    if (HIDDEN_TOOLS.has(b.name)) return;
    this.post({ type: "tool", id: b.id, parent, ...describeTool(b.name, b.input, (f) => this.rel(f)) });
  }

  toolResult(b, parent) {
    const t = this.tools.get(b.tool_use_id);
    if (!t) return;
    const item = resultItem(t, b, parent);
    if (t.name === "mcp__browser__browser_open" && !b.is_error && this.claude && !this.claude.browserShown) { // headless: nothing to watch otherwise
      this.claude.browserShown = true;
      try { if (JSON.parse(fs.readFileSync(this.claude.browserState, "utf8")).headless) showBrowser(this.claude.browserState); } catch {}
    }
    if (item.diff) this.edits.syncFromDisk(t.input.file_path || t.input.notebook_path).then(() => this.edits.refresh());
    this.post(item);
  }

  // Before any agent write: remember the file for Keep/Undo and for this message's checkpoint.
  snapshot(file) {
    if (!file) return;
    if (this.p.inFolder(file)) this.edits.snapshot(file); // scratch files elsewhere (e.g. /tmp) aren't changes to review
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (cp && !cp.snaps.has(file)) {
      try { cp.snaps.set(file, fs.readFileSync(file, "utf8")); } catch { cp.snaps.set(file, null); }
    }
  }

  // ---- checkpoints ----

  // What commands changed during a reply: tracked files that differ between the git states before and after it,
  // and untracked files that appeared. Edits made with the Edit/Write tools are covered by snapshots instead.
  async recordShell(startMark, endMark, cp) {
    const a = await startMark, b = await endMark;
    if (!a || !b || !cp) return;
    const changed = a.sha === b.sha ? [] : ((await git(b.root, ["diff", "--name-only", "-z", a.sha, b.sha])) || "").split("\0").filter(Boolean);
    const created = [...b.untracked].filter((p) => !a.untracked.has(p));
    if (!changed.length && !created.length) return;
    (cp.shell ||= []).push({ root: b.root, a: a.sha, changed, created });
    this.saveCheckpoints();
  }

  // File contents to put back for the shell changes of these checkpoints: each path as it was before the first reply that touched it.
  async shellTargets(later) {
    const out = new Map();
    for (const cp of later) for (const t of cp.shell || []) {
      const kept = (await git(t.root, ["cat-file", "-e", `${t.a}^{commit}`])) != null; // git gc may have pruned the snapshot
      if (kept) for (const p of t.changed) { const f = path.join(t.root, p); if (!out.has(f)) out.set(f, await git(t.root, ["show", `${t.a}:${p}`], true)); }
      for (const p of t.created) { const f = path.join(t.root, p); if (!out.has(f)) out.set(f, null); }
    }
    return out;
  }

  saveCheckpoints() {
    if (!this.sessionId) return;
    const file = this.p.checkpointFile(this.sessionId);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = this.checkpoints.map(({ key, sessionId, resumeAt, snaps, shell }) => ({ key, sessionId, resumeAt, snaps: [...snaps], shell }));
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {}
  }

  // Put files and the conversation back to how they were just before checkpoint `id`'s message.
  async restore(id, { edit } = {}) {
    const idx = this.checkpoints.findIndex((c) => c.id === id);
    if (idx < 0 || this.busy) return;
    const later = this.checkpoints.slice(idx);
    const files = new Map(); // earliest snapshot wins: that's the state before this message
    for (const cp of later) for (const [f, text] of cp.snaps) if (!files.has(f)) files.set(f, text);
    let shell = 0;
    for (const [f, data] of await this.shellTargets(later)) if (!files.has(f)) { files.set(f, data); shell++; }
    const edited = files.size - shell;
    const messages = later.length;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const what = [edited && `${plural(edited, "file")} the agent edited`, shell && `${plural(shell, "file")} changed by commands`].filter(Boolean).join(" and ") || "no files";
    // Editing a message only needs a confirm when files would be reverted; a plain restore always asks.
    if (!edit || files.size) {
      const pick = await vscode.window.showWarningMessage(
        edit
          ? `Edit and resend? This reverts ${what} from this message on and removes ${plural(messages, "message")}.`
          : `Restore checkpoint? This removes ${plural(messages, "message")} and reverts ${what} since then.`,
        { modal: true, detail: "Command changes come from git snapshots, so edits to untracked or ignored files that already existed aren't covered." }, edit ? "Edit and resend" : "Restore");
      if (!pick) return this.post({ type: "editCancelled", checkpoint: id });
    }
    if (this.busy) return this.post({ type: "editCancelled", checkpoint: id }); // Claude started replying meanwhile
    const after = new Map(); // bytes, so binary files survive a redo
    for (const f of files.keys()) { try { after.set(f, fs.readFileSync(f)); } catch { after.set(f, null); } }
    this.redoStack.push({ files: after, checkpoints: this.checkpoints.slice(idx), sessionId: this.sessionId, lastUuid: this.lastUuid });
    await this.writeFiles(files);
    const cp = this.checkpoints[idx];
    this.checkpoints.splice(idx);
    this.restart();
    this.sessionId = cp.sessionId;
    this.resumeAt = cp.sessionId ? cp.resumeAt : null;
    this.lastUuid = cp.resumeAt;
    this.edits.refresh();
    this.post({ type: "restored", checkpoint: id, resend: edit });
    this.ensure();
  }

  // Undo the latest restore: files, checkpoints and the conversation come back. Repeat for earlier restores.
  async redo() {
    const r = this.redoStack[this.redoStack.length - 1];
    if (!r || this.busy) return;
    this.redoStack.pop();
    await this.writeFiles(r.files);
    this.checkpoints.push(...r.checkpoints);
    this.restart();
    this.sessionId = r.sessionId;
    this.resumeAt = null;
    this.lastUuid = r.lastUuid;
    this.edits.refresh();
    this.saveCheckpoints();
    this.post({ type: "redone" });
    this.ensure();
  }

  async writeFiles(files) {
    for (const [f, text] of files) {
      if (text === null) { try { fs.unlinkSync(f); } catch {} continue; } // the file didn't exist then
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      await this.edits.syncFromDisk(f);
    }
  }

  // ---- approvals ----

  // Claude wants a tool that needs approval. What happens depends on the approval policy.
  ask(id, req) {
    const policy = this.settings().policy;
    const allow = (input = req.input, extra = {}) => this.claude?.respond(id, { behavior: "allow", updatedInput: input, ...extra });
    const file = req.input.file_path || req.input.notebook_path;

    if (req.tool_name === "ExitPlanMode") {
      this.pending.set(id, { req });
      return this.post({ type: "permission", id, kind: "plan", plan: req.input.plan || "" });
    }
    if (req.tool_name === "AskUserQuestion") {
      this.pending.set(id, { req });
      return this.post({ type: "permission", id, kind: "question", questions: req.input.questions || [] });
    }
    if (EDIT_TOOLS.has(req.tool_name)) {
      this.snapshot(file);
      const risk = this.p.editRisk(file); // "commands ask first" has to hold for edits that run commands, whatever the policy
      if (!risk && (policy !== "ask" || this.allowEdits)) return allow();
      let diff = null;
      const after = applyEdit(req.tool_name, req.input);
      if (after != null) {
        diff = vscode.Uri.from({ scheme: PROPOSED, path: file, query: id });
        proposed.set(diff.toString(), after);
      }
      this.pending.set(id, { req, diff });
      this.p.notify(this, "needs your approval");
      this.post({ type: "permission", id, kind: "edit", name: req.tool_name, hasDiff: !!diff,
        detail: risk && !this.p.inFolder(file) ? file : this.rel(file), // outside the folder, show where it really goes
        risk: risk || undefined });
      if (diff && this.p.active === this) this.showProposed(id);
      return;
    }
    if (policy === "bypass") return allow();
    this.pending.set(id, { req });
    this.p.notify(this, "needs your approval");
    const d = describeTool(req.tool_name, req.input, (f) => this.rel(f));
    this.post({ type: "permission", id, kind: "tool", name: req.tool_name, ...approvalText(req.tool_name, req.input, d), canAlways: !!req.permission_suggestions?.length });
  }

  answer({ id, allow, always, allEdits, answers, feedback }) {
    const p = this.pending.get(id);
    if (!p || !this.claude) return;
    if (allEdits) this.allowEdits = true; // the rest of this chat's edits apply without asking
    this.pending.delete(id);
    this.closeProposed(id, p);
    const { req } = p;
    if (!allow) {
      const file = EDIT_TOOLS.has(req.tool_name) && (req.input.file_path || req.input.notebook_path);
      if (file && !fs.existsSync(file)) { // it was never created: no "deleted" row, and a restore mustn't delete it if the user makes it later
        if (this.edits.snapshots.get(file) === null) this.edits.snapshots.delete(file);
        const cp = this.checkpoints[this.checkpoints.length - 1];
        if (cp?.snaps.get(file) === null) cp.snaps.delete(file);
        this.edits.refresh();
      }
      return this.claude.respond(id, { behavior: "deny", message: feedback ? `The user said: ${feedback}` : "The user rejected this. Ask what they want instead." });
    }
    let input = req.input;
    if (req.tool_name === "AskUserQuestion") input = { ...input, answers };
    const extra = always && req.permission_suggestions ? { updatedPermissions: req.permission_suggestions } : {};
    this.claude.respond(id, { behavior: "allow", updatedInput: input, ...extra });
    if (req.tool_name === "ExitPlanMode") {
      this.p.state.update("mode", "agent");
      this.syncSettings();
      this.p.post({ type: "settings", ...this.settings() });
    }
  }

  showProposed(id) {
    const p = this.pending.get(id);
    if (!p?.diff) return;
    const file = p.req.input.file_path;
    const left = fs.existsSync(file) ? vscode.Uri.file(file) : vscode.Uri.from({ scheme: PROPOSED, path: file, query: "empty" });
    vscode.commands.executeCommand("vscode.diff", left, p.diff, `${path.basename(file)} (proposed by Bitsmith)`, { preview: true });
  }

  closeProposed(id, p = this.pending.get(id)) {
    if (!p?.diff) return;
    const key = p.diff.toString();
    proposed.delete(key);
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === key) vscode.window.tabGroups.close(tab);
    }
  }

  // ---- history ----

  loadSession(id) {
    this.shutdown();
    this.sessionId = id;
    this.busy = false;
    this.checkpoints = [];
    this.redoStack = [];
    this.post({ type: "clear" });
    const file = path.join(this.sessionDir(), id + ".jsonl");
    this.lastUuid = lastAssistantUuid(file);
    const items = replay(file, (f) => this.rel(f));
    const saved = new Map(this.p.loadCheckpoints(id).map((c) => [c.key, c]));
    let n = 0;
    for (const it of items) {
      const cp = it.type === "user" && saved.get(it.key);
      if (cp) { cp.id = `saved-${++n}`; it.checkpoint = cp.id; this.checkpoints.push(cp); }
    }
    this.userCount = 0; // messages already sent after the last reply
    for (let i = items.length - 1; i >= 0 && items[i].type === "user"; i--) this.userCount++;
    this.post({ type: "replay", items });
    const last = lastUsage(file);
    if (last) this.setContext(last.used, last.model);
    this.updateTitle();
    if (this.p.active === this) this.ensure(); // restored background tabs start their process when shown
  }

  updateTitle() {
    if (!this.sessionId) return;
    const title = sessionTitle(path.join(this.sessionDir(), this.sessionId + ".jsonl"));
    if (title && title !== this.title) { this.title = title; this.p.chatChanged(this); }
  }
}

// The panel: shared settings, usage, editor context and history, plus the open chats.
class ChatProvider {
  constructor(context) {
    this.context = context;
    this.state = context.globalState;
    this.view = null;
    this.lastFile = null;
    this.usage = this.state.get("usage", null); // last plan-limit reading from the CLI, kept across restarts
    this.plan = this.state.get("plan", "");
    this.edits = new EditTracker((files) => this.post({ type: "changes", files: files.map((f) => ({ ...f, rel: this.rel(f.file) })) }));
    this.chats = new Map(); // key -> Chat, in tab order
    this.nextKey = 1;
    this.active = this.createChat();
    this.ws = context.workspaceState || this.state; // open tabs are per workspace
    this.windows = this.state.get("contextWindows", {}); // model -> context window, learned from the CLI
  }

  rememberWindow(model, size) {
    if (this.windows[model] === size) return;
    this.windows[model] = size;
    this.state.update("contextWindows", this.windows);
  }

  windowFor(model) {
    return this.windows[model] || 200000;
  }

  // A chat in the background, or the panel hidden: say so with a toast that jumps to it.
  notify(c, what) {
    if (c.panel ? c.panel.visible : c === this.active && this.view?.visible !== false) return;
    vscode.window.showInformationMessage?.(`Bitsmith: "${c.title || "New chat"}" ${what}.`, "Show").then((pick) => {
      if (!pick || !this.chats.has(c.key)) return;
      if (c.panel) return c.panel.reveal();
      vscode.commands.executeCommand("bitsmith.chat.focus");
      this.switchTo(c);
    });
  }

  // Tabs survive a window reload: their session ids (and typed-ahead messages) are saved and reopened when the panel loads.
  saveTabs() {
    if (!this.restored) return; // the saved tabs haven't been reopened yet; don't overwrite them
    const list = [...this.chats.values()].filter((c) => c.sessionId);
    const queues = {};
    for (const c of list) if (c.queue.length) queues[c.sessionId] = c.queue.map(({ text, items, chips, useActive }) => ({ text, items, chips, useActive, images: [] }));
    this.ws.update("openChats", { ids: list.map((c) => c.sessionId), active: this.active.sessionId || null, queues });
  }

  // The working tree's git state right now, without touching it: a stash-like commit of tracked files, plus untracked paths.
  // ponytail: these commits are unreferenced, so a `git gc` after ~2 weeks can drop them and old checkpoints lose command reverts.
  async gitMark() {
    if (this.gitRoot === undefined) this.gitRoot = this.folder ? ((await git(this.folder, ["rev-parse", "--show-toplevel"])) || "").trim() || null : null;
    const root = this.gitRoot;
    if (!root) return null;
    const sha = ((await git(root, ["stash", "create"])) || "").trim() || ((await git(root, ["rev-parse", "HEAD"])) || "").trim();
    const status = await git(root, ["status", "--porcelain", "-z", "-uall"]);
    if (!sha || status == null) return null;
    return { root, sha, untracked: new Set(status.split("\0").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3))) };
  }

  restoreTabs() {
    const saved = this.ws.get("openChats");
    if (this.restored || !saved?.ids?.length || this.chats.size > 1 || !this.active.fresh) return (this.restored = true);
    this.restored = true;
    const ids = saved.ids.filter((id) => fs.existsSync(path.join(this.sessionDir(), id + ".jsonl")));
    ids.forEach((id, i) => {
      const c = i ? this.createChat() : this.active;
      if (i) this.post({ type: "openChat", chat: c.key });
      c.loadSession(id);
      c.queue = saved.queues?.[id] || [];
      if (c.queue.length) c.post({ type: "queue", items: c.queue });
    });
    const show = [...this.chats.values()].find((c) => c.sessionId === saved.active);
    if (show) this.switchTo(show);
  }

  // The chat on screen; the commands and tests drive it through these.
  get sessionId() { return this.active.sessionId; }
  set sessionId(v) { this.active.sessionId = v; }
  get claude() { return this.active.claude; }
  get redoState() { return this.active.redoStack[this.active.redoStack.length - 1] || null; }
  handle(m) { return this.active.handle(m); }
  restore(id, opts) { return this.active.restore(id, opts); }
  redo() { return this.active.redo(); }
  loadSession(id) { return this.openSession(id); }

  get folder() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  rel(file) {
    return this.folder ? path.relative(this.folder, file) || path.basename(file) : file;
  }

  inFolder(file) {
    return !!this.folder && path.resolve(file).startsWith(this.folder + path.sep);
  }

  // Why an edit must be approved whatever the policy (see riskyEdit), or "" when it's an ordinary file.
  // Real paths, so a symlink inside the folder can't point at ~/.bashrc.
  editRisk(file) {
    if (!file) return "";
    const folder = this.folder && realPath(this.folder);
    const real = realPath(path.resolve(this.folder || os.homedir(), file));
    const inside = !!folder && real.startsWith(folder + path.sep);
    if (!riskyEdit(real, inside)) return "";
    return inside || fwd(real).startsWith(fwd(os.tmpdir()) + "/") ? "This file can run commands later (hooks, tasks, settings or shell startup)" : `Outside this folder: ${real}`;
  }

  settings() {
    return {
      model: this.state.get("model", "default"),
      effort: this.state.get("effort", ""),
      mode: this.state.get("mode", "agent"),
      policy: this.state.get("policy", vscode.workspace.getConfiguration("bitsmith").get("defaultPolicy")),
    };
  }

  resolveWebviewView(view) {
    this.view = view;
    const root = this.context.extensionUri;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(root, "media")] };
    view.webview.html = html(view.webview, root, this.active.key);
    view.webview.onDidReceiveMessage((m) => this.onWebview(m));
    view.onDidDispose(() => { for (const c of this.chats.values()) if (!c.panel) c.shutdown(); }); // editor-tab chats live on
  }

  // A chat's messages go to wherever it's shown: the sidebar, or its own editor tab. Panel-wide ones go everywhere.
  post(msg) {
    const c = msg.chat && this.chats.get(msg.chat);
    if (c?.panel) return c.panel.webview.postMessage(msg);
    this.view?.webview.postMessage(msg);
    if (!msg.chat && msg.type !== "addContext") for (const x of this.chats.values()) x.panel?.webview.postMessage(msg);
  }

  // ---- a chat in an editor tab ----

  openInEditor(c = this.active) {
    if (c.panel) return c.panel.reveal();
    if (c.busy) return vscode.window.showInformationMessage("Bitsmith: wait for this reply to finish, then open the chat in an editor tab.");
    if (!c.sessionId) return vscode.window.showInformationMessage("Bitsmith: send a message first, then the chat can open in an editor tab.");
    const root = this.context.extensionUri;
    // out of the sidebar first, while its messages still go there
    this.post({ type: "closeChat", chat: c.key });
    if (c === this.active) {
      const next = [...this.chats.values()].filter((x) => x !== c && !x.panel).pop();
      if (next) this.switchTo(next);
      else { const fresh = this.createChat(); this.post({ type: "openChat", chat: fresh.key }); this.switchTo(fresh); }
    }
    const panel = vscode.window.createWebviewPanel("bitsmith.chatTab", c.title || "Bitsmith", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(root, "media")] });
    panel.iconPath = vscode.Uri.joinPath(root, "media", "icon.svg");
    c.panel = panel;
    panel.webview.html = html(panel.webview, root, c.key);
    panel.webview.onDidReceiveMessage((m) => this.onWebview({ ...m, chat: c.key }, c));
    panel.onDidDispose(() => { c.panel = null; c.shutdown(); this.chats.delete(c.key); this.saveTabs(); });
  }

  // An editor-tab chat's webview loaded: settings, then the conversation from its transcript.
  panelReady(c) {
    c.panel.webview.postMessage({ type: "settings", ...this.settings() });
    c.panel.webview.postMessage({ type: "usage", usage: this.usage, plan: this.plan });
    if (this.info) c.panel.webview.postMessage({ type: "init", ...this.info });
    c.panel.webview.postMessage({ type: "chats", chats: [{ key: c.key, title: c.title }], active: c.key });
    this.postActiveFile();
    this.edits.refresh();
    c.loadSession(c.sessionId);
    if (c.queue.length) c.post({ type: "queue", items: c.queue });
    c.ensure();
  }

  // ---- export, commit message ----

  async exportChat(c = this.active) {
    if (!c.sessionId) return vscode.window.showInformationMessage("Bitsmith: this chat has no messages yet.");
    const text = chatMarkdown(replay(path.join(this.sessionDir(), c.sessionId + ".jsonl"), (f) => this.rel(f)), c.title);
    const pick = await vscode.window.showQuickPick([
      { label: "$(copy) Copy as Markdown", id: "copy" },
      { label: "$(save) Save as Markdown file…", id: "save" },
      { label: "$(go-to-file) Open in an editor", id: "open" },
    ], { placeHolder: `Export "${c.title || "chat"}"` });
    if (pick?.id === "copy") { await vscode.env.clipboard.writeText(text); vscode.window.showInformationMessage("Bitsmith: chat copied as Markdown."); }
    if (pick?.id === "open") vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content: text }));
    if (pick?.id === "save") {
      const name = (c.title || "chat").replace(/[^\w .-]+/g, "").trim().slice(0, 60) || "chat";
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(this.folder || os.homedir(), name + ".md")), filters: { Markdown: ["md"] } });
      if (uri) { fs.writeFileSync(uri.fsPath, text); vscode.window.showInformationMessage(`Bitsmith: saved ${path.basename(uri.fsPath)}.`); }
    }
  }

  // Source Control title button: Claude (haiku, one-shot) writes a message for the staged changes, or all changes if none are staged.
  async commitMessage(arg) {
    const api = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1);
    const repo = (arg?.rootUri && api?.getRepository(arg.rootUri)) || api?.repositories[0];
    if (!repo) return vscode.window.showWarningMessage("Bitsmith: no Git repository found.");
    let diff = await repo.diff(true);
    if (!diff.trim()) diff = await repo.diff(false);
    if (!diff.trim()) return vscode.window.showInformationMessage("Bitsmith: nothing to describe, there are no changes.");
    const prompt = "Write a git commit message for the diff on stdin. Conventional Commits style: a summary line under 72 characters, " +
      "then, only if it helps, a blank line and a few short bullets. Describe what changed and why, not file by file. Output only the message, no code fences.";
    await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: "Bitsmith is writing a commit message" }, async () => {
      const out = await new Promise((res) => {
        const p = spawn(vscode.workspace.getConfiguration("bitsmith").get("claudePath"), ["-p", "--model", "haiku", "--output-format", "text", prompt], { cwd: repo.rootUri.fsPath, env: process.env });
        let text = "", err = "";
        p.stdout.on("data", (d) => (text += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("error", (e) => res({ err: e.message }));
        const timer = setTimeout(() => { p.kill(); res({ err: "timed out after 2 minutes" }); }, 120000);
        p.on("close", (code) => { clearTimeout(timer); res(code ? { err: err.trim() || `exit ${code}` } : { text }); });
        p.stdin.on("error", () => {}); // it exited before reading all of the diff
        p.stdin.end(diff.length > 60000 ? diff.slice(0, 60000) + "\n[diff truncated]" : diff);
      });
      if (out.err) return vscode.window.showErrorMessage(`Bitsmith couldn't write a commit message: ${out.err.slice(0, 200)}`);
      repo.inputBox.value = out.text.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
    });
  }

  async onWebview(m, from = null) {
    const c = this.chats.get(m.chat) || this.active;
    if (from && m.type === "ready") return this.panelReady(from);
    switch (m.type) {
      case "queue": c.queue = m.items || []; return this.saveTabs();
      case "openInEditor": return this.openInEditor(c);
      case "ready":
        this.post({ type: "settings", ...this.settings() });
        this.post({ type: "usage", usage: this.usage, plan: this.plan });
        if (this.usageRequested) { this.usageRequested = false; this.post({ type: "showUsage" }); }
        if (this.info) this.post({ type: "init", ...this.info });
        this.post({ type: "chats", chats: [...this.chats.values()].filter((x) => !x.panel).map((x) => ({ key: x.key, title: x.title })), active: this.active.key });
        this.postActiveFile();
        this.postSessions();
        this.edits.refresh();
        this.restoreTabs();
        this.active.ensure(); // warm start: fetches models and slash commands
        break;
      case "fileSearch": return this.post({ type: "fileResults", q: m.q, items: await this.searchFiles(m.q) });
      case "renameChat": return c.sessionId && this.renameSession(c.sessionId);
      case "send": return c.send(m);
      case "stop": return c.interrupt();
      case "open": return this.openPath(c, m.file, m.line);
      case "openImage": return openImage(m.mediaType, m.data);
      case "permission": return c.answer(m);
      case "showProposed": return c.showProposed(m.id);
      case "setting": return this.setSetting(m.key, m.value);
      case "pickContext": return this.pickContext();
      case "drop": return this.addUris(m.uris.map((u) => vscode.Uri.parse(u)));
      case "keep": return this.edits.keep(m.file);
      case "undo": return this.edits.undo(m.file);
      case "diffFile": return this.edits.showDiff(m.file);
      case "copy": return vscode.env.clipboard.writeText(m.text);
      case "history": return this.history();
      case "loadSession": return this.openSession(m.id);
      case "deleteSession": return this.deleteSession(m.id);
      case "newChat": return this.newChat();
      case "switchChat": return this.chats.has(m.chat) && this.switchTo(c, false);
      case "closeChat": return this.closeChat(c);
      case "stopTask": return c.stopTask(m.taskId);
      case "taskOutput": return c.taskOutput(m.taskId);
      case "restore": return c.restore(m.checkpoint);
      case "editMessage": return c.restore(m.checkpoint, { edit: m.text });
      case "redo": return c.redo();
      case "refreshUsage": return this.fetchUsage(true);
      case "openUsagePage": return vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/settings/usage"));
    }
  }

  abs(file) {
    return path.isAbsolute(file) ? file : path.join(this.folder || "", file);
  }

  // A file named in a reply. Replies often give a path relative to where Claude was working, or just a name,
  // so when it isn't at the folder root, look for it: files this chat touched first, then shortest path.
  async openPath(c, file, line) {
    if (!file) return;
    const direct = this.abs(file.replace(/^~(?=\/|$)/, os.homedir()));
    if (fs.existsSync(direct)) return openFile(direct, line);
    const rel = file.replace(/^(\.{1,2}\/)+/, "");
    const found = (await vscode.workspace.findFiles(`**/${rel}`, EXCLUDE, 50)).map((u) => u.fsPath);
    if (!found.length) return vscode.window.showInformationMessage(`Bitsmith couldn't find ${file} in this workspace.`);
    const touched = new Set([...(c?.tools.values() || [])].map((t) => t.input?.file_path).filter(Boolean));
    found.sort((a, b) => touched.has(b) - touched.has(a) || a.length - b.length);
    if (found.length === 1 || touched.has(found[0])) return openFile(found[0], line);
    const pick = await vscode.window.showQuickPick(found.map((f) => ({ label: path.basename(f), description: this.rel(f), f })), { placeHolder: `Several files match ${file}` });
    if (pick) openFile(pick.f, line);
  }

  onInit(r) {
    if (r.subtype !== "success") return;
    const { models = [], commands = [], account } = r.response;
    if (account?.subscriptionType && account.subscriptionType !== this.plan) {
      this.plan = account.subscriptionType;
      this.state.update("plan", this.plan);
      this.updateUsage();
    }
    this.info = { models, commands: commands.map((c) => ({ name: c.name, description: c.description, hint: c.argumentHint })) };
    this.post({ type: "init", ...this.info });
  }

  shutdown() {
    for (const c of this.chats.values()) c.shutdown();
  }

  setSetting(key, value) {
    this.state.update(key, value);
    if (key === "model" || key === "mode") this.active.syncSettings();
  }

  // ---- open chats ----

  createChat() {
    const c = new Chat(this, `c${this.nextKey++}`);
    this.chats.set(c.key, c);
    return c;
  }

  // A fresh chat is reused; otherwise the current one keeps running in its own tab.
  newChat() {
    this.postSessions(); // the empty chat lists recent chats, including ones from this window
    if (this.active.fresh) return this.active.reset();
    const c = this.createChat();
    this.post({ type: "openChat", chat: c.key });
    this.switchTo(c);
    c.ensure();
  }

  switchTo(c, tell = true) {
    const prev = this.active;
    if (c === prev) return;
    this.active = c;
    this.saveTabs();
    // An idle chat in the background doesn't need its process; it resumes on the next message.
    if (!prev.busy && !prev.tasks.length && !prev.pending.size) prev.restart();
    if (tell) this.post({ type: "showChat", chat: c.key });
    if (this.view) this.view.description = c.title || undefined;
    c.ensure();
  }

  closeChat(c) {
    if (!this.chats.has(c.key)) return;
    c.shutdown();
    this.chats.delete(c.key);
    this.post({ type: "closeChat", chat: c.key });
    this.saveTabs();
    if (c !== this.active) return;
    const next = [...this.chats.values()].filter((x) => !x.panel).pop();
    if (next) return this.switchTo(next);
    this.active = this.createChat();
    this.post({ type: "openChat", chat: this.active.key });
    this.post({ type: "showChat", chat: this.active.key });
    this.view && (this.view.description = undefined);
    this.active.ensure();
  }

  // A chat already open in a tab is shown; otherwise it opens in the current tab if that's empty, or a new one.
  openSession(id) {
    const open = [...this.chats.values()].find((c) => c.sessionId === id);
    if (open) return open.panel ? open.panel.reveal() : this.switchTo(open);
    let c = this.active;
    if (!c.fresh || c.busy) {
      c = this.createChat();
      this.post({ type: "openChat", chat: c.key });
      this.switchTo(c);
    }
    c.loadSession(id);
  }

  chatChanged(c) {
    this.saveTabs();
    this.postSessions(); // a chat got its title: it now belongs in Recent chats
    if (c.panel) c.panel.title = c.title || "Bitsmith";
    this.post({ type: "chatTitle", chat: c.key, title: c.title });
    if (c === this.active && this.view) this.view.description = c.title || undefined;
  }

  withContext(text, items, useActive) {
    const out = [];
    const active = useActive && this.activeFile();
    if (active) {
      out.push(`Current file: ${active.rel}${active.selection ? ` (lines ${active.selection.start}-${active.selection.end} selected)` : ""}`);
      if (active.selection) out.push("```\n" + active.selection.text + "\n```");
    }
    const attached = items.filter((i) => i.kind !== "selection" && !(active && !active.selection && i.file === active.file)); // listed once
    if (attached.length) out.push("Attached:", ...attached.map((i) => `- ${i.rel}${i.kind === "folder" ? "/" : ""} (${i.kind})`));
    for (const s of items.filter((i) => i.kind === "selection")) out.push(`Selection from ${s.rel} lines ${s.start}-${s.end}:`, "```\n" + s.text + "\n```");
    return out.length ? `<context>\n${out.join("\n")}\n</context>\n\n${text}` : text;
  }

  // ---- plan usage: the CLI's rate_limit_event while chatting, plus a poll of the account's usage endpoint ----
  // Other Claude sessions (terminal, other windows) use the same limits, so the reading from our last message goes stale.

  async fetchUsage(force = false) {
    if (this.fetchingUsage || (!force && this.usage?.updated > Date.now() - USAGE_POLL / 2)) return;
    this.fetchingUsage = true;
    try {
      const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      const auth = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth;
      if (!auth?.accessToken || auth.expiresAt < Date.now()) return; // the CLI refreshes it on its next run
      const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return;
      const j = await r.json();
      const win = (x) => x && { used: (x.utilization ?? 0) / 100, resetsAt: x.resets_at ? Date.parse(x.resets_at) / 1000 : null };
      const session = win(j.five_hour), weekly = win(j.seven_day);
      if (!session && !weekly) return;
      const full = [session, weekly].filter((x) => x?.used >= 1);
      this.usage = {
        ...this.usage, session, weekly,
        status: full.length ? "rejected" : "allowed",
        resetsAt: full.length ? Math.max(...full.map((x) => x.resetsAt || 0)) : null,
        usingOverage: this.usage?.usingOverage && !!j.extra_usage?.is_enabled,
        overage: j.extra_usage ? (j.extra_usage.is_enabled ? this.usage?.overage || "allowed" : "rejected") : this.usage?.overage,
        updated: Date.now(),
      };
      this.state.update("usage", this.usage);
      this.updateUsage();
    } catch {} // offline, no credentials file (e.g. macOS keychain): keep the last reading
    finally { this.fetchingUsage = false; }
  }

  setUsage(info) {
    const w = info.unifiedWindows || {};
    const five = w.five_hour || (info.rateLimitType === "five_hour" ? { utilization: info.utilization, resetsAt: info.resetsAt } : null);
    this.usage = {
      session: five && { used: five.utilization ?? null, resetsAt: five.resetsAt ?? null },
      weekly: w.seven_day && { used: w.seven_day.utilization ?? null, resetsAt: w.seven_day.resetsAt ?? null },
      status: info.status, // allowed | allowed_warning | rejected
      resetsAt: info.resetsAt,
      overage: info.overageStatus, usingOverage: !!info.isUsingOverage,
      updated: Date.now(),
    };
    this.state.update("usage", this.usage);
    this.updateUsage();
  }

  updateUsage() {
    this.post({ type: "usage", usage: this.usage, plan: this.plan });
    const item = this.statusItem;
    if (!item) return;
    const pct = (x) => (x?.used == null ? null : Math.round(x.used * 100));
    const s = pct(this.usage?.session), wk = pct(this.usage?.weekly);
    const worst = Math.max(s ?? 0, wk ?? 0);
    item.text = "$(bitsmith-logo)" + (worst >= 70 ? ` ${worst}%` : "");
    item.backgroundColor = this.usage?.status === "rejected" || worst >= 95 ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : worst >= 80 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const when = (t) => t ? new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Bitsmith**${this.plan ? ` · ${this.plan}` : ""}\n\n`);
    if (s == null && wk == null) md.appendMarkdown("No usage data yet. Send a message to load your limits.\n\n");
    if (s != null) md.appendMarkdown(`$(clock) Session: **${s}%** used · resets ${when(this.usage.session.resetsAt)}\n\n`);
    if (wk != null) md.appendMarkdown(`$(calendar) Weekly: **${wk}%** used · resets ${when(this.usage.weekly.resetsAt)}\n\n`);
    md.appendMarkdown("_Click for details_");
    item.tooltip = md;
  }

  showUsage() {
    this.fetchUsage();
    if (this.view) { this.view.show?.(true); this.post({ type: "showUsage" }); }
    else this.usageRequested = true; // panel not open yet: show the card once it loads
    vscode.commands.executeCommand("bitsmith.chat.focus");
  }

  checkpointFile(sessionId) {
    return path.join(this.context.globalStorageUri.fsPath, "checkpoints", sessionId + ".json");
  }

  loadCheckpoints(sessionId) {
    try {
      return JSON.parse(fs.readFileSync(this.checkpointFile(sessionId), "utf8")).map((c) => ({ ...c, snaps: new Map(c.snaps) }));
    } catch { return []; }
  }

  // ---- editor context ----

  activeFile() {
    const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === this.lastFile);
    if (!editor || editor.document.uri.scheme !== "file") return null;
    const sel = editor.selection;
    return {
      file: editor.document.uri.fsPath,
      rel: this.rel(editor.document.uri.fsPath),
      selection: sel.isEmpty ? null : { start: sel.start.line + 1, end: sel.end.line + 1, text: editor.document.getText(sel) },
    };
  }

  postActiveFile() {
    const a = this.activeFile();
    if (a) this.lastFile = a.file;
    this.post({ type: "activeFile", file: a && { file: a.file, rel: a.rel, selection: a.selection && { start: a.selection.start, end: a.selection.end } } });
  }

  addItems(items) {
    if (!items.length) return;
    vscode.commands.executeCommand("bitsmith.chat.focus");
    this.post({ type: "addContext", items });
  }

  async addUris(uris) {
    const items = [];
    for (const uri of uris) {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        items.push({ kind: st.type & vscode.FileType.Directory ? "folder" : "file", file: uri.fsPath, rel: this.rel(uri.fsPath) });
      } catch {}
    }
    this.addItems(items);
  }

  addSelection() {
    const e = vscode.window.activeTextEditor;
    if (!e || e.selection.isEmpty) return;
    this.addItems([{ kind: "selection", file: e.document.uri.fsPath, rel: this.rel(e.document.uri.fsPath), start: e.selection.start.line + 1, end: e.selection.end.line + 1, text: e.document.getText(e.selection) }]);
  }

  async pickContext() {
    if (!this.folder) return;
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input?.uri).filter((u) => u?.scheme === "file");
    const files = await vscode.workspace.findFiles("**/*", EXCLUDE, 5000);
    const folders = new Set();
    for (const f of files) for (let d = path.dirname(f.fsPath); d.startsWith(this.folder) && d !== this.folder; d = path.dirname(d)) folders.add(d);
    const item = (file, kind, desc) => ({ label: `$(${kind === "folder" ? "folder" : "file"}) ${path.basename(file)}`, description: desc ?? path.dirname(this.rel(file)).replace(/^\.$/, ""), file, kind });
    const seen = new Set(open.map((u) => u.fsPath));
    const picks = await vscode.window.showQuickPick([
      { label: "Open editors", kind: vscode.QuickPickItemKind.Separator },
      ...[...seen].map((f) => item(f, "file")),
      { label: "Files & folders", kind: vscode.QuickPickItemKind.Separator },
      ...[...folders].sort().map((f) => item(f, "folder")),
      ...files.filter((f) => !seen.has(f.fsPath)).map((f) => item(f.fsPath, "file")),
    ], { canPickMany: true, matchOnDescription: true, placeHolder: "Add files and folders to the chat" });
    if (picks) this.addItems(picks.map((p) => ({ kind: p.kind, file: p.file, rel: this.rel(p.file) })));
  }

  // ---- history (shared with the Claude Code CLI) ----

  sessionDir() {
    return path.join(os.homedir(), ".claude", "projects", (this.folder || "").replace(/[^a-zA-Z0-9]/g, "-"));
  }

  sessions(limit) {
    let files = [];
    try { files = fs.readdirSync(this.sessionDir()).filter((f) => f.endsWith(".jsonl")); } catch {}
    return files
      .map((f) => { const file = path.join(this.sessionDir(), f); try { return { id: f.slice(0, -6), file, time: fs.statSync(file).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map((s) => ({ ...s, title: sessionTitle(s.file) }))
      .filter((s) => s.title);
  }

  postSessions() {
    if (this.folder) this.post({ type: "sessions", items: this.sessions(6).map(({ id, title, time }) => ({ id, title, time })) });
  }

  async history() {
    const trash = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete chat" };
    const rename = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Rename chat" };
    const qp = vscode.window.createQuickPick();
    let recent = [];
    const item = (s, found) => ({ label: s.title, description: (found ? "$(search) in chat · " : "") + new Date(s.time).toLocaleString(), id: s.id, buttons: [rename, trash], alwaysShow: found });
    const load = () => {
      recent = this.sessions(60);
      qp.items = recent.map((s) => item(s));
      qp.placeholder = recent.length ? "Resume a chat · type to search titles and messages" : "No past chats for this folder";
    };
    load();
    qp.matchOnDescription = true;
    // Typing also searches inside every chat of this folder; matches outside the title list stay visible.
    let timer, seq = 0;
    qp.onDidChangeValue((q) => {
      clearTimeout(timer);
      if (q.trim().length < 3) return void (qp.items = recent.map((s) => item(s)));
      timer = setTimeout(async () => {
        const mine = ++seq;
        qp.busy = true;
        const ids = await searchSessions(this.sessionDir(), q.trim());
        if (mine !== seq) return;
        qp.busy = false;
        const byId = new Map(recent.map((s) => [s.id, s]));
        const found = ids.map((id) => byId.get(id) || this.session(id)).filter((s) => s?.title);
        const hit = new Set(found.map((s) => s.id));
        qp.items = [...found.map((s) => item(s, true)), ...recent.filter((s) => !hit.has(s.id)).map((s) => item(s))];
      }, 250);
    });
    qp.onDidAccept(() => { const pick = qp.selectedItems[0]; qp.hide(); if (pick) this.loadSession(pick.id); });
    qp.onDidTriggerItemButton(async ({ item: it, button }) => {
      qp.ignoreFocusOut = true; // keep the list open behind the dialog
      if (button === rename ? await this.renameSession(it.id) : await this.deleteSession(it.id)) load();
      qp.ignoreFocusOut = false;
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  session(id) {
    const file = path.join(this.sessionDir(), id + ".jsonl");
    try { return { id, file, time: fs.statSync(file).mtimeMs, title: sessionTitle(file) }; } catch { return null; }
  }

  // The same title record the CLI's /rename writes, so the name shows in both.
  async renameSession(id) {
    const file = path.join(this.sessionDir(), id + ".jsonl");
    const title = await vscode.window.showInputBox({ title: "Rename chat", value: sessionTitle(file) || "", prompt: "Shown in Bitsmith and in Claude Code's /resume" });
    if (!title?.trim()) return false;
    fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: title.trim(), sessionId: id }) + "\n");
    for (const c of this.chats.values()) if (c.sessionId === id) { c.title = title.trim(); this.chatChanged(c); }
    this.postSessions();
    return true;
  }

  // Files for "@" mentions: the workspace list is cached briefly, then filtered on each keystroke.
  async searchFiles(q) {
    if (!this.folder) return [];
    if (!this.fileCache || Date.now() - this.fileCache.at > 30000) {
      const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, 20000);
      this.fileCache = { at: Date.now(), files: uris.map((u) => u.fsPath) };
    }
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input?.uri?.fsPath).filter(Boolean);
    const query = String(q || "").toLowerCase();
    const score = (f) => {
      const rel = this.rel(f).toLowerCase(), name = path.basename(rel);
      if (!query) return open.includes(f) ? 0 : -1;
      return name.startsWith(query) ? 3 : name.includes(query) ? 2 : rel.includes(query) ? 1 : -1;
    };
    return [...new Set([...open, ...this.fileCache.files])]
      .map((f) => ({ f, s: score(f) })).filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || this.rel(a.f).length - this.rel(b.f).length).slice(0, 12)
      .map(({ f }) => ({ kind: "file", file: f, rel: this.rel(f) }));
  }

  // Delete a chat everywhere Claude Code keeps it. Files go to the system trash, so it can be recovered.
  async deleteSession(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) return false;
    const open = [...this.chats.values()].find((c) => c.sessionId === id);
    if (open?.busy) {
      vscode.window.showWarningMessage("Stop the current reply before deleting this chat.");
      return false;
    }
    const title = sessionTitle(path.join(this.sessionDir(), id + ".jsonl")) || "this chat";
    const pick = await vscode.window.showWarningMessage(`Delete "${title}"?`,
      { modal: true, detail: "It also disappears from Claude Code's history. The files go to your system trash." }, "Delete");
    if (pick !== "Delete") return false;
    const claudeDir = path.join(os.homedir(), ".claude");
    const targets = [
      path.join(this.sessionDir(), id + ".jsonl"),
      path.join(this.sessionDir(), id), // sub-agent transcripts, when present
      path.join(claudeDir, "file-history", id),
      path.join(claudeDir, "session-env", id),
      this.checkpointFile(id),
    ];
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      try { await vscode.workspace.fs.delete(vscode.Uri.file(t), { recursive: true, useTrash: true }); }
      catch { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} } // no trash available (e.g. some Linux setups)
    }
    if (open) open.reset();
    this.postSessions();
    return true;
  }
}

// ---- helpers ----

function editStats(tool, input) {
  if (tool === "Write") return { added: lines(input.content || "").length, removed: 0 };
  const edits = tool === "MultiEdit" ? input.edits || [] : [input];
  const total = { added: 0, removed: 0 };
  for (const e of edits) {
    const s = stats(diffLines(lines(e.old_string || ""), lines(e.new_string || "")));
    total.added += s.added;
    total.removed += s.removed;
  }
  return tool === "NotebookEdit" ? null : total;
}

// What the file would look like after the edit; null if it can't be worked out.
function applyEdit(tool, input) {
  if (tool === "Write") return input.content;
  if (tool === "NotebookEdit") return null;
  let text;
  try { text = fs.readFileSync(input.file_path, "utf8"); } catch { return null; }
  const edits = tool === "MultiEdit" ? input.edits : [input];
  for (const e of edits) {
    if (!text.includes(e.old_string)) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}

// How an approval card asks: a question, an optional explanation, and the exact thing to approve.
function approvalText(name, input = {}, d) {
  const full = (s) => String(s ?? "");
  switch (name) {
    case "Bash": return { question: "Run this command?", sub: input.description || "", detail: full(input.command) };
    case "WebFetch": return { question: "Fetch this page?", sub: input.prompt ? `To ${input.prompt.charAt(0).toLowerCase()}${input.prompt.slice(1, 120)}` : "", detail: full(input.url) };
    case "WebSearch": return { question: "Search the web?", sub: "", detail: full(input.query) };
    case "Task": case "Agent": return { question: "Start a sub-agent?", sub: full(input.subagent_type), detail: full(input.description) };
    case "mcp__browser__browser_open": return { question: "Open this page in the browser?", sub: "", detail: full(input.url) };
    case "mcp__browser__browser_click": return { question: "Click in the browser?", sub: "", detail: d.detail };
    case "mcp__browser__browser_type": return { question: "Type in the browser?", sub: input.submit ? "Then press Enter" : "", detail: d.detail };
    case "mcp__browser__browser_press": return { question: "Press a key in the browser?", sub: "", detail: d.detail };
    default:
      if (name.startsWith("mcp__")) return { question: `Use ${name.replace(/^mcp__/, "").replace(/__/g, " › ")}?`, sub: "", detail: d.detail };
      return { question: `Allow ${name}?`, sub: "", detail: d.detail };
  }
}

// What a step folds out to show. Files are opened from their chip instead, so their contents are skipped.
const QUIET_TOOLS = new Set([...EDIT_TOOLS, "Read", "TodoWrite"]);
function stepInput(name, input) {
  if (name === "Bash") return input.command || "";
  if (name === "Task" || name === "Agent") return input.prompt || "";
  return QUIET_TOOLS.has(name) || !Object.keys(input).length ? "" : JSON.stringify(input, null, 2);
}
function stepOutput(name, text) {
  if (QUIET_TOOLS.has(name) || !text.trim()) return "";
  return text.length > 8000 ? text.slice(0, 8000) + `\n… ${text.length - 8000} more characters` : text;
}
// How a finished step reads: a short summary for its row, and the output it folds out to.
function resultInfo(name, text, isError) {
  const background = !isError && /^(Command running in background with ID:|Async agent launched)/.test(text);
  let summary = "";
  if (background) summary = "in background";
  else if (!isError && name === "Read") summary = `${text.split("\n").length} lines`;
  else if (!isError && (name === "Grep" || name === "Glob")) {
    const n = text.split("\n").filter((l) => l.trim() && !/^Found \d+/.test(l)).length;
    summary = /^No (files|matches)/.test(text) ? "no results" : `${n} result${n === 1 ? "" : "s"}`;
  }
  if (name === "Task" || name === "Agent") text = text.replace(/\n*agentId: [\s\S]*$/, "").trim(); // CLI bookkeeping after the answer
  return { isError, summary, background, error: isError ? text.slice(0, 300) : "", output: background ? "" : stepOutput(name, text) };
}

function resultItem(tool, b, parent = null) {
  const diff = EDIT_TOOLS.has(tool.name) && !b.is_error ? editStats(tool.name, tool.input) : null;
  // Images a tool returned (e.g. Read on a screenshot): shown in the step, a few and not huge
  const images = (Array.isArray(b.content) ? b.content : []).filter((c) => c.type === "image" && c.source?.type === "base64" && c.source.data.length < 6e6).slice(0, 4)
    .map(({ source: s }) => ({ mediaType: s.media_type, data: s.data, url: `data:${s.media_type};base64,${s.data}` }));
  return { type: "toolResult", id: b.tool_use_id, parent, ...resultInfo(tool.name, resultText(b), !!b.is_error), diff, images };
}

// "<task-notification>" is how the CLI tells Claude a background task ended; it's stored as a user message.
function taskNotification(e) {
  const c = e.type === "user" && e.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  if (!text.startsWith("<task-notification>")) return null;
  const tag = (n) => text.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1].trim() || "";
  return { type: "taskEvent", taskId: tag("task-id"), toolUseId: tag("tool-use-id"), status: tag("status"), summary: tag("summary"), result: tag("result"), outputFile: tag("output-file") };
}

// git in `cwd`; stdout (a Buffer with `raw`), or null when it fails.
function git(cwd, args, raw = false) {
  const { execFile } = require("child_process");
  return new Promise((res) => execFile("git", args, { cwd, encoding: raw ? "buffer" : "utf8", maxBuffer: 64 << 20 }, (err, out) => res(err ? null : out)));
}

// A chat as Markdown: what was asked, what Claude said, and one line per step.
function chatMarkdown(items, title) {
  const out = [`# ${title || "Bitsmith chat"}`, ""];
  let speaker = null;
  const say = (who) => { if (speaker !== who) { if (out[out.length - 1] !== "") out.push(""); out.push(`## ${who}`, ""); speaker = who; } };
  const para = (text) => { if (out[out.length - 1]?.startsWith("- ")) out.push(""); out.push(text, ""); };
  for (const it of items) {
    if (it.type === "user") { say("You"); para(it.text + (it.chips?.length ? `\n\n_Attached: ${it.chips.map((c) => c.rel).join(", ")}_` : "")); speaker = "You"; }
    else if (it.type === "text" && it.text.trim()) { say("Claude"); para(it.text.trim()); }
    else if (it.type === "tool" && !it.parent) { say("Claude"); out.push(`- ${it.title}${it.detail ? ` \`${String(it.detail).replace(/`/g, "'")}\`` : ""}`); }
    else if (it.type === "taskEvent" || it.type === "notice") para(`> ${it.summary || it.text}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Everything the model saw for this reply: the conversation so far, including the cached part.
function contextTokens(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
}

const kTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n || 0}`);
function compactText(pre, post) {
  return pre ? `Conversation compacted · ${kTokens(pre)} → ${kTokens(post)} tokens` : "Conversation compacted";
}

// Context size at the end of a saved chat: the last reply's usage, or what a later compaction left.
function lastUsage(file) {
  let out = null;
  try {
    for (const e of activeBranch(fs.readFileSync(file, "utf8").split("\n").map(parse).filter(Boolean))) {
      if (e.type === "assistant" && !e.isSidechain && e.message?.usage) out = { used: contextTokens(e.message.usage), model: e.message.model };
      if (e.type === "system" && e.subtype === "compact_boundary") out = { used: e.compactMetadata?.postTokens || 0, model: out?.model };
    }
  } catch {}
  return out;
}

// Chat ids whose transcript mentions `q` (case-insensitive), newest first. ripgrep when present, else grep.
function searchSessions(dir, q) {
  const { execFile } = require("child_process");
  const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { cwd: dir, maxBuffer: 4 << 20 }, (err, out) => res(err && !out ? null : out || "")));
  return (async () => {
    let out = await run("rg", ["-l", "-i", "-F", "--max-depth", "1", "-g", "*.jsonl", "--", q, "."]);
    if (out === null) out = (await run("grep", ["-l", "-i", "-F", "--include=*.jsonl", "-r", "--", q, "."])) || "";
    return out.split("\n").map((f) => path.basename(f.trim(), ".jsonl")).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
      .map((id) => ({ id, t: fs.statSync(path.join(dir, id + ".jsonl")).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 40).map((x) => x.id);
  })();
}

function resultText(b) {
  return typeof b.content === "string" ? b.content : (b.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// A step line the way Copilot words it: verb + subject.
function describeTool(name, input = {}, rel = (f) => f) {
  const file = input.file_path || input.notebook_path;
  const short = (s, n = 80) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const base = { name, file: file || null, full: stepInput(name, input) };
  switch (name) {
    case "Read": return { ...base, icon: "eye", title: "Read", detail: rel(file), range: input.offset ? `${input.offset}-${input.offset + (input.limit || 0)}` : "" };
    case "Edit": case "MultiEdit": return { ...base, icon: "edit", title: "Edited", detail: rel(file) };
    case "Write": return { ...base, icon: "new-file", title: "Wrote", detail: rel(file) };
    case "NotebookEdit": return { ...base, icon: "notebook", title: "Edited notebook", detail: rel(file) };
    case "Grep": return { ...base, icon: "search", title: "Searched for", detail: `"${short(input.pattern, 60)}"${input.path ? ` in ${rel(input.path)}` : ""}` };
    case "Glob": return { ...base, icon: "file-directory", title: "Found files matching", detail: `"${short(input.pattern, 60)}"` };
    case "Bash": return { ...base, icon: "terminal", title: input.description ? short(input.description, 70) : "Ran", detail: short(input.command, 120), code: true };
    case "WebFetch": return { ...base, icon: "globe", title: "Fetched", detail: short(input.url, 90) };
    case "WebSearch": return { ...base, icon: "globe", title: "Searched the web for", detail: `"${short(input.query, 70)}"` };
    case "Task": case "Agent": return { ...base, icon: "hubot", title: "Ran agent", detail: short(input.description || input.subagent_type, 80) };
    case "TodoWrite": {
      const t = input.todos || [];
      return { ...base, icon: "checklist", title: "Updated todos", detail: `${t.filter((x) => x.status === "completed").length}/${t.length} done` };
    }
    case "Skill": return { ...base, icon: "sparkle", title: "Used skill", detail: short(input.skill || input.command, 60) };
    case "ExitPlanMode": return { ...base, icon: "list-ordered", title: "Proposed a plan", detail: "" };
    case "AskUserQuestion": return { ...base, icon: "question", title: "Asked a question", detail: "" };
    case "mcp__browser__browser_open": return { ...base, icon: "globe", title: "Opened", detail: short(input.url, 90), full: input.url || "" };
    case "mcp__browser__browser_snapshot": return { ...base, icon: "eye", title: "Read the page", detail: "" };
    case "mcp__browser__browser_click": return { ...base, icon: "target", title: "Clicked", detail: `[${input.ref}]` };
    case "mcp__browser__browser_type": return { ...base, icon: "keyboard", title: input.submit ? "Typed and submitted" : "Typed", detail: `"${short(input.text, 50)}" into [${input.ref}]` };
    case "mcp__browser__browser_press": return { ...base, icon: "keyboard", title: "Pressed", detail: input.key || "" };
    case "mcp__browser__browser_screenshot": return { ...base, icon: "device-camera", title: "Took a screenshot", detail: "" };
    case "mcp__browser__browser_console": return { ...base, icon: "debug-console", title: "Checked the console", detail: "" };
    default: return { ...base, icon: name.startsWith("mcp__") ? "plug" : "tools", title: name.replace(/^mcp__/, "").replace(/__/g, " › "), detail: short(file ? rel(file) : input.command || input.query || input.description || "", 80) };
  }
}

const CONTEXT_PREFIX = /^<context>\n([\s\S]*?)\n<\/context>\n\n/;
const OLD_PREFIX = /^\[Active file: [^\]]*\]\n(```\n[\s\S]*?\n```\n)?\n/;

// Turn a stored prompt back into what the user typed plus the chips they attached.
function parseUserText(raw) {
  const m = raw.match(CONTEXT_PREFIX);
  const chips = [];
  if (m) {
    for (const line of m[1].split("\n")) {
      const cur = line.match(/^Current file: (.+?)(?: \(lines (\d+)-(\d+) selected\))?$/);
      if (cur) chips.push({ kind: "file", rel: cur[1], range: cur[2] ? `${cur[2]}-${cur[3]}` : "" });
      const att = line.match(/^- (.+?) \((file|folder)\)$/);
      if (att) chips.push({ kind: att[2], rel: att[1].replace(/\/$/, "") });
      const sel = line.match(/^Selection from (.+) lines (\d+)-(\d+):$/);
      if (sel) chips.push({ kind: "selection", rel: sel[1], range: `${sel[2]}-${sel[3]}` });
    }
  }
  return { text: raw.replace(CONTEXT_PREFIX, "").replace(OLD_PREFIX, ""), chips };
}

function readLines(file, from, size) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, from);
    return buf.subarray(0, n).toString("utf8").split("\n");
  } finally { fs.closeSync(fd); }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function userText(entry) {
  const c = entry.message?.content;
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary || !c) return null;
  const text = typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!text || /^(<command-|<local-command|<task-notification>|\[Request interrupted)/.test(text)) return null;
  return text;
}

// Title from the tail (AI or custom title) or the first prompt.
function sessionTitle(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const tail = readLines(file, Math.max(0, size - 65536), 65536).map(parse).filter(Boolean);
  const named = tail.filter((e) => e.customTitle).pop() || tail.filter((e) => e.aiTitle).pop(); // a rename beats the AI title
  if (named) return named.customTitle || named.aiTitle;
  // A first prompt with a pasted image can be a single line far past 64 KB, so grow the read until it parses.
  for (let n = 65536; ; n *= 4) {
    for (const e of readLines(file, 0, Math.min(n, size)).map(parse).filter(Boolean)) {
      const t = userText(e);
      if (t) return parseUserText(t).text.split("\n")[0].slice(0, 80);
    }
    if (n >= size || n >= 1 << 26) return null;
  }
}

function replay(file, rel) {
  const items = [];
  const tools = new Map();
  let lastUuid = null, userCount = 0;
  let content = "";
  try { content = fs.readFileSync(file, "utf8"); } catch { return items; }
  const all = content.split("\n").map(parse).filter(Boolean);
  // A CLI rewind resends a prompt as plain "[Image #N]" text without the image, so look it up from the original paste.
  const pasted = new Map();
  for (const e of all) (e.imagePasteIds || []).forEach((id, i) => { const img = imagesOf(e)[i]; if (img) pasted.set(id, img); });
  const subs = subagentFiles(file);
  for (const e of activeBranch(all)) {
    if (e.isSidechain) continue;
    const note = taskNotification(e);
    if (note) { items.push(note); continue; }
    if (e.type === "system" && e.subtype === "compact_boundary") { items.push({ type: "notice", icon: "fold", text: compactText(e.compactMetadata?.preTokens, e.compactMetadata?.postTokens) }); continue; }
    const t = userText(e);
    if (t) {
      let images = imagesOf(e);
      if (!images.length) images = [...t.matchAll(/\[Image #(\d+)\]/g)].map((m) => pasted.get(+m[1])).filter(Boolean);
      const u = parseUserText(t);
      // The CLI writes "[Image #N]" placeholders into the text; the chips replace them.
      if (images.length) u.text = u.text.replace(/\[Image #\d+\]\s*/g, "").trim() || "See the attached image.";
      items.push({ type: "user", key: `${lastUuid || "start"}#${userCount++}`, ...u, images });
      continue;
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        const tool = b.type === "tool_result" && tools.get(b.tool_use_id);
        if (tool) items.push(resultItem(tool, b));
      }
    } else if (e.type === "assistant") {
      if (e.uuid) { lastUuid = e.uuid; userCount = 0; }
      for (const b of e.message?.content || []) {
        if (b.type === "text") items.push({ type: "textStart" }, { type: "text", text: b.text });
        if (b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
          tools.set(b.id, b);
          if (b.name === "TodoWrite") items.push({ type: "todos", todos: b.input?.todos || [] });
          items.push({ type: "tool", id: b.id, ...describeTool(b.name, b.input, rel) });
          if (subs.has(b.id)) items.push(...subagentItems(subs, b.id, rel));
        }
      }
    }
  }
  return items;
}

// Sub-agent transcripts sit next to the session: <id>/subagents/agent-*.jsonl, each with a .meta.json naming the Agent call.
function subagentFiles(file) {
  const dir = path.join(file.slice(0, -6), "subagents");
  const subs = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json")); } catch {}
  for (const f of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (meta.toolUseId) subs.set(meta.toolUseId, path.join(dir, f.replace(/\.meta\.json$/, ".jsonl")));
    } catch {}
  }
  return subs;
}

// A sub-agent's own steps, nested under the Agent step that started it (and so on for its own sub-agents).
function subagentItems(subs, parent, rel) {
  const file = subs.get(parent);
  subs.delete(parent); // each transcript once, even if ids ever loop
  const items = [], tools = new Map();
  let content = "";
  try { content = fs.readFileSync(file, "utf8"); } catch { return items; }
  for (const e of content.split("\n").map(parse).filter(Boolean)) {
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (e.type === "assistant" && b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
        tools.set(b.id, b);
        items.push({ type: "tool", id: b.id, parent, ...describeTool(b.name, b.input, rel) });
        if (subs.has(b.id)) items.push(...subagentItems(subs, b.id, rel));
      }
      const tool = e.type === "user" && b.type === "tool_result" && tools.get(b.tool_use_id);
      if (tool) items.push(resultItem(tool, b, parent));
    }
  }
  return items;
}

function imagesOf(e) {
  const c = e.message?.content;
  return Array.isArray(c) ? c.filter((b) => b.type === "image" && b.source?.type === "base64")
    .map(({ source: s }) => ({ mediaType: s.media_type, data: s.data, url: `data:${s.media_type};base64,${s.data}` })) : [];
}

// Transcripts are trees: a CLI rewind starts a new branch in the same file. Keep only the branch ending at the latest message.
function activeBranch(all) {
  const byId = new Map(all.filter((e) => e.uuid).map((e) => [e.uuid, e]));
  const keep = new Set();
  let e = all.findLast((x) => x.uuid && !x.isSidechain && (x.type === "user" || x.type === "assistant"));
  for (; e && !keep.has(e.uuid); e = byId.get(e.parentUuid || e.logicalParentUuid)) keep.add(e.uuid);
  return all.filter((x) => keep.has(x.uuid));
}

function lastAssistantUuid(file) {
  let uuid = null;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const e = parse(line);
      if (e?.type === "assistant" && !e.isSidechain && e.uuid) uuid = e.uuid;
    }
  } catch {}
  return uuid;
}

// Pasted images only live inside the transcript, so write one to a temp file for VS Code's image viewer.
// The real path of a file that may not exist yet: resolve its closest existing parent.
function realPath(file) {
  try { return fs.realpathSync.native(file); } catch {}
  const parent = path.dirname(file);
  return parent === file ? file : path.join(realPath(parent), path.basename(file));
}

function openImage(mediaType, data) {
  if (!data) return;
  const ext = (/^image\/(\w+)$/.exec(mediaType || "")?.[1] || "png").replace("jpeg", "jpg");
  const file = path.join(os.tmpdir(), "bitsmith-images", require("crypto").createHash("sha1").update(data).digest("hex").slice(0, 16) + "." + ext);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, "base64"));
  vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: true });
}

function openFile(file, line) {
  if (!file || !fs.existsSync(file)) return;
  if (fs.statSync(file).isDirectory()) return vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(file));
  const opts = { preview: true };
  if (line) opts.selection = new vscode.Range(line - 1, 0, line - 1, 0);
  vscode.window.showTextDocument(vscode.Uri.file(file), opts);
}

function html(webview, root, chat) {
  const nonce = require("crypto").randomUUID(); // unguessable, so a script tag can't be forged into the page
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(root, "media", f));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("vendor/codicon.css")}"><link rel="stylesheet" href="${uri("chat.css")}"></head>
<body data-chat="${chat}"><div id="app"></div>
<script nonce="${nonce}" src="${uri("vendor/marked.umd.js")}"></script>
<script nonce="${nonce}" src="${uri("chat.js")}"></script></body></html>`;
}

// Checkpoints saved before the rename live under the old extension id; bring them along once.
function migrateFromMyAgent(context) {
  const dir = path.join(context.globalStorageUri.fsPath, "checkpoints");
  const old = path.join(path.dirname(context.globalStorageUri.fsPath), "prince-terabits.my-agent", "checkpoints");
  if (fs.existsSync(dir) || !fs.existsSync(old)) return;
  try { fs.cpSync(old, dir, { recursive: true }); } catch {}
}

function activate(context) {
  migrateFromMyAgent(context);
  storageDir = context.globalStorageUri.fsPath;
  const provider = new ChatProvider(context);
  const status = vscode.window.createStatusBarItem("bitsmith.status", vscode.StatusBarAlignment.Right, 100);
  status.name = "Bitsmith";
  status.command = "bitsmith.showUsage";
  provider.statusItem = status;
  provider.updateUsage();
  status.show();
  provider.fetchUsage();
  const poll = setInterval(() => vscode.window.state?.focused !== false && provider.fetchUsage(), USAGE_POLL); // only while this window is in front
  poll.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && provider.fetchUsage()));
  context.subscriptions.push(status, vscode.commands.registerCommand("bitsmith.showUsage", () => provider.showUsage()));
  provider.edits.register(context);
  let timer;
  const activeChanged = () => { clearTimeout(timer); timer = setTimeout(() => provider.postActiveFile(), 150); };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED, { provideTextDocumentContent: (uri) => proposed.get(uri.toString()) ?? "" }),
    vscode.window.registerWebviewViewProvider("bitsmith.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor(activeChanged),
    vscode.window.onDidChangeTextEditorSelection(activeChanged),
    vscode.commands.registerCommand("bitsmith.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("bitsmith.history", () => provider.history()),
    vscode.commands.registerCommand("bitsmith.exportChat", () => provider.exportChat()),
    vscode.commands.registerCommand("bitsmith.openInEditor", () => provider.openInEditor()),
    vscode.commands.registerCommand("bitsmith.commitMessage", (repo) => provider.commitMessage(repo)),
    vscode.commands.registerCommand("bitsmith.renameChat", () => provider.sessionId ? provider.renameSession(provider.sessionId) : vscode.window.showInformationMessage("Send a message first; then the chat can be named.")),
    vscode.commands.registerCommand("bitsmith.deleteChat", () => provider.sessionId ? provider.deleteSession(provider.sessionId) : vscode.window.showInformationMessage("This chat hasn't been saved yet.")),
    vscode.commands.registerCommand("bitsmith.addContext", () => provider.pickContext()),
    vscode.commands.registerCommand("bitsmith.addToChat", (uri, uris) => provider.addUris(uris?.length ? uris : uri ? [uri] : [])),
    vscode.commands.registerCommand("bitsmith.addSelection", () => provider.addSelection()),
    vscode.commands.registerCommand("bitsmith.showBrowser", () => {
      const live = [provider.active, ...provider.chats.values()].map((c) => c.claude?.browserState).filter((f) => f && fs.existsSync(f));
      live.length ? showBrowser(live[0]) : vscode.window.showInformationMessage("No chat has the browser open. Turn on Settings → Bitsmith → Browser and ask Claude to open a page.");
    }),
    vscode.commands.registerCommand("bitsmith.keepAll", () => provider.edits.keep()),
    vscode.commands.registerCommand("bitsmith.undoAll", () => provider.edits.undo()),
    { dispose: () => provider.shutdown() },
  );
  return provider;
}

module.exports = { activate, applyEdit, replay, sessionTitle, describeTool, parseUserText, editStats, lastUsage, searchSessions, chatMarkdown, git, riskyEdit };
