const vscode = require("vscode");
const { spawn, exec } = require("child_process");
const { ToolsPanel } = require("./tools");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { EditTracker, diffLines, lines, stats, norm, isBinary } = require("./edits");
const { showBrowser } = require("./browser-view");

const PROPOSED = "bitsmith-proposed";
const USAGE_POLL = 2 * 60 * 1000; // plan usage refresh while the window is focused
const proposed = new Map(); // proposed-file uri -> content, right side of an "ask first" diff
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const ASK_PROMPT = "You are in Ask mode: answer questions about the code, explain, and suggest. You can read and search files, but you can't edit files or run commands. When a change would help, show it as a code block in your answer instead of applying it.";
// Agent mode plans on its own, like Claude Code in a terminal: big work goes through plan mode first, small work just happens.
const AGENT_PROMPT = "Decide first whether the request is heavy or small. Heavy means a new feature or subsystem, changes to several files, an unclear approach, or a design choice the user should weigh in on. For a heavy request your very first tool call must be EnterPlanMode, before any edit or command: research read-only, present the plan with ExitPlanMode, and implement it once the user approves. Once a plan is approved, create one task per step with TaskCreate, then mark each in_progress and completed with TaskUpdate as you work through them. Small means a fix, a question, or a change to one or two files: just do it without planning. When the user explicitly asks to skip planning, skip it.";
// Copilot's user-profile agents live next to globalStorage: <User>/prompts/*.agent.md
const userAgentDir = () => storageDir && path.join(storageDir, "..", "..", "prompts");

// Adding, editing or deleting an .agent.md updates the Mode picker; a running chat picks it up on its next message.
function agentWatchers(provider) {
  const changed = () => { provider.agentList = null; for (const c of provider.chats.values()) c.postSettings(); };
  const globs = ["**/.github/agents/*.agent.md", userAgentDir() && new vscode.RelativePattern(vscode.Uri.file(userAgentDir()), "*.agent.md")];
  return globs.filter(Boolean).map((g) => {
    const w = vscode.workspace.createFileSystemWatcher(g);
    w.onDidCreate(changed); w.onDidChange(changed); w.onDidDelete(changed);
    return w;
  });
}

// A Copilot-style .agent.md: optional front matter (name, description, tools: [...]) and the instructions after it.
// `file` is "<name>.agent.md" for the folder's agents and "~/<name>.agent.md" for the user profile's.
function parseAgent(file, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  for (const line of (m?.[1] || "").split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  let tools = null;
  try { if (meta.tools) tools = JSON.parse(meta.tools.replace(/'/g, '"')); } catch {}
  const label = meta.name || file.replace(/^~\//, "").replace(/\.agent\.md$/, "");
  const description = meta.description && meta.description.length > 90 ? meta.description.slice(0, 89) + "…" : meta.description || "Custom agent";
  return { value: `agent:${file}`, label, description, tools: Array.isArray(tools) ? tools : null, prompt: (m ? text.slice(m[0].length) : text).trim() };
}
const PRE_BASH = "bitsmith_pre_bash"; // hook callback the CLI calls (and waits for) before each shell command
const POST_EDIT = "bitsmith_post_edit"; // after each edit: VS Code's errors in that file go back to Claude
const HIDDEN_TOOLS = new Set(["ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]); // Claude loading its own tools, or its todos (the Todos panel shows those): not steps worth showing

// Claude's task tools (on with CLAUDE_CODE_ENABLE_TODO_TOOLS) as the Todos panel's list: [{ id, content, activeForm, status }].
function applyTask(list, tool, b) {
  if (b.is_error) return list;
  const { name, input = {} } = tool;
  const id = name === "TaskCreate" && /Task #(\S+) created/.exec(resultText(b))?.[1];
  if (id) return [...(list.every((t) => t.status === "completed") ? [] : list), // a finished list makes way for the next plan
    { id, content: input.subject || "", activeForm: input.activeForm, status: "pending" }];
  if (name !== "TaskUpdate") return list;
  if (input.status === "deleted") return list.filter((t) => t.id !== input.taskId);
  return list.map((t) => t.id !== input.taskId ? t : { ...t, ...(input.status && { status: input.status }),
    ...(input.subject && { content: input.subject }), ...(input.activeForm && { activeForm: input.activeForm }) });
}
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

// The CLI to launch. A bare "claude" that isn't on VS Code's PATH falls back to where the native installer puts it:
// that folder often reaches only new terminals' PATH, not an editor that was already running or started from a shortcut.
function claudeBin() {
  const bin = vscode.workspace.getConfiguration("bitsmith").get("claudePath");
  if (bin !== "claude") return bin;
  const exts = process.platform === "win32" ? [".exe", ".com"] : [""]; // what spawn can run without a shell
  const onPath = (process.env.PATH || "").split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, bin + e))));
  if (onPath) return bin;
  const home = os.homedir(), exe = process.platform === "win32" ? "claude.exe" : "claude";
  return [path.join(home, ".local", "bin", exe), path.join(home, ".claude", "local", exe)].find((p) => fs.existsSync(p)) || bin;
}

// When the CLI compacts on its own. By default it waits until the model's window is nearly full (~967k of 1M), far past
// where long chats get slow and costly; CLAUDE_CODE_AUTO_COMPACT_WINDOW makes it compact at that size minus a summary buffer.
function autoCompactAt() {
  return vscode.workspace.getConfiguration("bitsmith").get("autoCompactAt") || "200000";
}

// One long-lived Claude Code CLI process speaking stream-json, resumable by session id.
class Claude {
  constructor({ cwd, model, effort, ultracode, resume, resumeAt, agent, dirs = [], hidden, onMessage, onExit }) {
    const cfg = vscode.workspace.getConfiguration("bitsmith");
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "default"];
    if (model && model !== "default") args.push("--model", model);
    this.fallback = cfg.get("fallbackModel") || "";
    if (this.fallback) args.push("--fallback-model", this.fallback); // overloaded or unavailable: the reply goes on with this one
    if (dirs.length) args.push("--add-dir", ...dirs); // folders beyond the workspace Claude may read without asking
    this.dirsKey = dirs.join("\n");
    if (agent?.prompt) args.push("--append-system-prompt", agent.prompt); // Ask mode or a custom agent
    if (agent?.disallowed?.length) args.push("--disallowedTools", agent.disallowed.join(","));
    this.agentKey = agent?.key || "";
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
    const compactAt = autoCompactAt();
    // next-message guesses (without it they stop once plan usage passes 75%), and the task tools behind the Todos panel
    const env = { ...process.env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "1", CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
      CLAUDE_CODE_ENTRYPOINT: hidden ? "sdk-cli" : "bitsmith" }; // -p's default "sdk-cli" is hidden by the CLI's /resume and the Claude Code extension
    const settings = {};
    if (compactAt === "off") env.DISABLE_AUTO_COMPACT = "1";
    else {
      if (/^\d+$/.test(compactAt)) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = compactAt;
      settings.precomputeCompactionEnabled = true; // the summary is mostly ready when it's needed
    }
    if (ultracode) settings.ultracode = true; // big tasks run as multi-agent workflows, at any effort
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    this.ultracode = !!ultracode;
    this.compactAt = compactAt;
    this.effort = effort;
    this.waiting = new Map();
    this.stderr = "";
    const bin = claudeBin();
    this.proc = spawn(bin, args, { cwd, env });
    this.proc.on("error", (e) => onExit(`Could not start Claude Code (${bin}): ${e.message}` +
      (e.code === "ENOENT" ? ". Install it, or set bitsmith.claudePath to its full path." : "")));
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

// A Map that says when it changes: a chat's pending approvals drive the status bar.
class WatchedMap extends Map {
  constructor(onChange) { super(); this.onChange = onChange; }
  set(k, v) { super.set(k, v); this.onChange(); return this; }
  delete(k) { const had = super.delete(k); this.onChange(); return had; }
  clear() { super.clear(); this.onChange(); }
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
    this.pending = new WatchedMap(() => this.p.updateWork()); // permission request id -> { req, diff }
    this.tools = new Map(); // tool_use id -> { name, input }
    this.befores = new Map(); // Write tool_use id -> the file's text before it (null: new file), to undo or diff just that step
    this.bashMarks = new Map();
    this.touched = new Set(); // files this chat changed: its own "files changed" list, Keep all and Undo all // Bash tool_use id -> git snapshots of the repos it may touch, taken just before it ran
    this.checkpoints = []; // one per live message: { id, sessionId, resumeAt, snaps: Map(file -> text | null) }
    this.lastUuid = null; // last top-level assistant message, the point to rewind the conversation to
    this.userCount = 0; // messages sent since lastUuid; with it, a key for each message that survives reopening and forks
    this.resumeAt = null;
    this.redoStack = []; // what each restore undid, newest last, until the next message is sent
    this.allowEdits = false; // "Allow all edits in this chat" on an edit card
    this.queue = []; // messages typed ahead in the panel, kept so a reload doesn't lose them
    this.tasks = []; // background tasks still running: { id, type, description, start, toolUseId, progress }
    this.background = new Set(); // ids of tasks started in the background (others are a sub-agent's own foreground work)
    this.known = new Map(); // task id -> { type, description }, kept after the task ends for its notification
    this.title = "";
    this.context = { used: 0, window: 0 }; // tokens in the conversation now, and the model's context window
  }

  get busy() { return this._busy; }
  set busy(v) { this._busy = v; this.p.updateWork(); } // the status bar's "Working"
  get folder() { return this.p.folder; }
  get edits() { return this.p.edits; }
  rel(file) { return this.p.rel(file); }
  settings() { return { ...this.p.settings(), ...this.prefs() }; }
  // Model, effort and mode belong to the chat: a new one starts from the last picked, a reopened one gets its own back.
  prefs() {
    if (this._prefs) return this._prefs;
    const { model, effort, ultracode, mode } = this.p.settings();
    const saved = this.sessionId && this.p.ws.get("chatPrefs")?.[this.sessionId];
    return (this._prefs = { model, effort, ultracode, mode, ...saved, ...(saved?.mode === "plan" && { mode: "agent" }) });
  }
  // ponytail: one small entry per chat ever tuned, never pruned; trim it alongside session deletes if it grows.
  savePrefs() {
    if (this.sessionId && this._prefs) this.p.ws.update("chatPrefs", { ...this.p.ws.get("chatPrefs"), [this.sessionId]: this._prefs });
  }
  postSettings() { if (this.panel || this === this.p.active) this.post({ type: "settings", ...this.settings() }); } // the webview shows one chat's
  sessionDir() { return this.p.sessionDir(); }
  post(msg) { this.tap?.(msg); this.p.post({ ...msg, chat: this.key }); } // tap: @bitsmith in Copilot's chat panel
  get fresh() { return !this.sessionId && !this.busy && !this.checkpoints.length; }

  // ---- process lifecycle ----

  ensure() {
    if (this.claude || !this.folder) return this.claude;
    if (this.sessionId && this.resumeAt) { // rewinding past a compaction: the CLI can't find that message, so branch from a copy
      const cut = cutBeforeCompaction(this.sessionDir(), this.sessionId, this.resumeAt);
      if (cut) { this.sessionId = cut; this.resumeAt = null; }
    }
    const s = this.settings();
    const claude = new Claude({
      cwd: this.folder, model: s.model, effort: s.effort, ultracode: s.ultracode, resume: this.sessionId, resumeAt: this.resumeAt, agent: this.p.launchAgent(s.mode), dirs: s.dirs || [],
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
    claude.memory = this.p.memoryStamp;
    this.claude = claude;
    claude.request({ subtype: "initialize", promptSuggestions: true, hooks: { PreToolUse: [{ matcher: "Bash", hookCallbackIds: [PRE_BASH] }],
      PostToolUse: [{ matcher: "Edit|MultiEdit|Write|NotebookEdit", hookCallbackIds: [POST_EDIT] }] } }).then((r) => { this.p.onInit(r); this.refreshThreshold(); });
    this.syncSettings();
    return claude;
  }

  // The running process follows the chat's model picks. (Modes are launch flags,
  // and planning is Claude's own EnterPlanMode / ExitPlanMode, so the CLI keeps its permission mode itself.)
  syncSettings() {
    const c = this.claude, s = this.settings();
    if (!c) return;
    if (c.model !== s.model) { c.model = s.model; c.request({ subtype: "set_model", model: s.model }); }
  }

  restart() {
    this.claude?.kill();
    this.claude = null;
    if (this.tasks.length) this.setTasks([]); // they die with the process
    this.dropPending();
  }

  shutdown() {
    this.restart();
    if (this.bg) { this.bg.kill(); this.bg.resolve(); this.bg = null; }
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
    this.resumeAt = null;
    this.busy = false;
    this.checkpoints = [];
    this.redoStack = [];
    this.allowEdits = false;
    this.queue = [];
    this.lastUuid = null;
    this.title = "";
    this.older = null;
    this.todos = [];
    this._prefs = null;
    this.post({ type: "clear" });
    this.postSettings();
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
    if (this.bg) { // a background compaction is nearly done: wait for it rather than send to the long conversation
      this.post({ type: "status", text: "Compacting conversation…" });
      this.holding = true;
      await this.bg.done;
      this.holding = false;
      if (!this.busy) return; // stopped meanwhile
    }
    const s = this.settings(), cfg = vscode.workspace.getConfiguration("bitsmith");
    if (this.claude && ((this.claude.effort || "") !== s.effort || this.claude.ultracode !== !!s.ultracode || this.claude.compactAt !== autoCompactAt()
      || this.claude.agentKey !== this.p.launchAgent(s.mode).key || this.claude.dirsKey !== (s.dirs || []).join("\n")
      || this.claude.fallback !== (cfg.get("fallbackModel") || "") || this.claude.memory !== this.p.memoryStamp)) this.restart(); // launch flags, and CLAUDE.md is read at launch
    const claude = this.ensure();
    this.syncSettings();
    this.started = Date.now();
    this.redoStack = [];
    if (checkpoint != null) this.checkpoints.push({ id: checkpoint, key: `${this.lastUuid || "start"}#${this.userCount}`, sessionId: this.sessionId, resumeAt: this.lastUuid, snaps: new Map() });
    this.userCount++;
    const content = images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } }));
    const files = images.map((img) => { try { return imageFile(img.mediaType, img.data); } catch { return null; } }).filter(Boolean); // a path for tools (browser, Read) too
    content.push({ type: "text", text: this.p.withContext(text, context, useActive, this.shellNotes, files) });
    this.shellNotes = [];
    claude.write({ type: "user", message: { role: "user", content } });
  }

  // Claude replying on its own, e.g. after a background task finished.
  beginAuto() {
    this.busy = true;
    this.started = Date.now();
    this.post({ type: "autoTurn" });
  }

  // A reply that ends near the auto-compact point is compacted in the background: a second CLI forks the session
  // there and runs /compact while the chat stays usable. The fork keeps the message ids, so when it's done
  // and the chat hasn't moved on, the chat simply continues in the fork.
  idleCompact(m) {
    const at = this.lastUuid, from = this.sessionId, s = this.settings();
    if (m.is_error || this.bg || this.queue.length || !from || !at || this.resumeAt || this.compactTried === at ||
      !this.threshold || this.context.used < this.threshold * 0.85) return;
    this.compactTried = at; // once per reply, so a failing compaction doesn't loop
    let id = null, meta = null, bg;
    const end = () => {
      bg.kill();
      if (this.bg !== bg) return;
      this.bg = null;
      if (meta && id) this.adopt(id, meta, from, at);
      bg.resolve();
    };
    bg = this.bg = new Claude({ cwd: this.folder, model: s.model, effort: s.effort, resume: from, resumeAt: at, hidden: true, onExit: end,
      onMessage: (x) => {
        if (x.type === "system" && x.subtype === "init") id = x.session_id;
        if (x.type === "system" && x.subtype === "compact_boundary") meta = x.compact_metadata || {};
        if (x.type === "result") end();
      } });
    bg.done = new Promise((r) => (bg.resolve = r));
    bg.write({ type: "user", message: { role: "user", content: [{ type: "text", text: "/compact" }] } });
  }

  // Continue in the compacted fork, unless the chat moved on since it was made.
  adopt(id, meta, from, at) {
    if (this.sessionId !== from || this.lastUuid !== at || this.resumeAt || this.tasks.length || this.pending.size || (this.busy && !this.holding)) return;
    this.restart();
    this.sessionId = id;
    setEntrypoint(path.join(this.sessionDir(), id + ".jsonl"), "bitsmith");
    setEntrypoint(path.join(this.sessionDir(), from + ".jsonl"), "sdk-cli");
    this.post({ type: "notice", icon: "fold", text: compactText(meta.pre_tokens, meta.post_tokens, "auto") });
    this.setContext(meta.post_tokens || 0, this.model);
    this.p.chatChanged(this);
    this.ensure();
  }

  // ---- CLI messages ----

  handle(m) {
    if (m.session_id && m.type === "system" && m.subtype === "init") { // a rewind is kept until the CLI has branched, so a restart before that still rewinds
      const moved = m.session_id !== this.sessionId;
      if (moved && this.sessionId) setEntrypoint(path.join(this.sessionDir(), this.sessionId + ".jsonl"), "sdk-cli"); // the old branch
      this.sessionId = m.session_id;
      this.resumeAt = null;
      if (moved) this.p.chatChanged(this); // a branch has a new id: a reload must reopen it, not the old one
    }
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
    } else if (m.type === "prompt_suggestion" && m.suggestion) {
      this.post({ type: "suggestion", text: m.suggestion });
    } else if (m.type === "rate_limit_event" && m.rate_limit_info) {
      this.p.setUsage(m.rate_limit_info);
    } else if (m.type === "result") {
      if (m.is_error && m.subtype !== "error_during_execution") this.post({ type: "error", text: m.result || "Claude Code reported an error." });
      else if (m.is_error && !m.num_turns && this.claude?.stderr.trim()) this.post({ type: "error", text: this.claude.stderr.trim().split("\n").pop() }); // failed before starting, e.g. a bad --resume
      for (const [model, u] of Object.entries(m.modelUsage || {})) if (u.contextWindow) this.p.rememberWindow(model, u.contextWindow);
      this.setContext(this.context.used, this.model);
      this.refreshThreshold(); // the model may have changed
      if (this.busy) this.finish({ cost: m.total_cost_usd });
      this.idleCompact(m);
    } else if (m.type === "control_request") {
      if (m.request.subtype === "can_use_tool") this.ask(m.request_id, m.request);
      else if (m.request.subtype === "hook_callback") m.request.callback_id === POST_EDIT ? this.postEdit(m.request_id, m.request) : this.preBash(m.request_id, m.request);
      else this.claude?.write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Not supported" } });
    }
  }

  // Background tasks: the CLI reports the running set, progress, and a notification when each one ends.
  system(m) {
    if (m.subtype === "status" && m.status === "compacting") this.post({ type: "status", text: "Compacting conversation…" });
    if (m.subtype === "compact_boundary") {
      const meta = m.compact_metadata || {};
      this.post({ type: "notice", icon: "fold", text: compactText(meta.pre_tokens, meta.post_tokens, meta.trigger) });
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
    this.context = { used, window: this.p.windowFor(this.model), threshold: this.threshold };
    this.post({ type: "context", ...this.context });
  }

  // Where the CLI will compact on its own (0 when auto-compact is off), for the context meter.
  refreshThreshold() {
    const claude = this.claude;
    claude?.request({ subtype: "get_context_usage", detail: "summary" }).then((r) => {
      if (this.claude !== claude || r.subtype !== "success" || !r.response) return;
      this.threshold = r.response.isAutoCompactEnabled ? r.response.autoCompactThreshold || 0 : 0;
      this.setContext(this.context.used, this.model);
    });
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
    if (b.name === "Write" && b.input.file_path) this.befores.set(b.id, readText(b.input.file_path)); // it hasn't run yet
    if (b.name === "TodoWrite" && !parent) this.post({ type: "todos", todos: b.input.todos || [] });
    if (HIDDEN_TOOLS.has(b.name)) return;
    this.post({ type: "tool", id: b.id, parent, ...describeTool(b.name, b.input, (f) => this.rel(f)) });
  }

  toolResult(b, parent) {
    const t = this.tools.get(b.tool_use_id);
    if (!t) return;
    if (/^Task(Create|Update)$/.test(t.name) && !parent) this.post({ type: "todos", todos: (this.todos = applyTask(this.todos || [], t, b)) });
    if (HIDDEN_TOOLS.has(t.name)) return; // no step card to put a result on
    const item = resultItem(t, b, parent);
    if (t.name === "mcp__browser__browser_open" && !b.is_error && this.claude && !this.claude.browserShown) { // headless: nothing to watch otherwise
      this.claude.browserShown = true;
      try { if (JSON.parse(fs.readFileSync(this.claude.browserState, "utf8")).headless) showBrowser(this.claude.browserState); } catch {}
    }
    if (item.diff) this.edits.syncFromDisk(t.input.file_path || t.input.notebook_path).then(() => this.edits.refresh());
    const marks = this.bashMarks.get(b.tool_use_id);
    if (marks) { this.bashMarks.delete(b.tool_use_id); this.captureShell(marks); }
    this.post(item);
  }

  // Before any agent write: remember the file for Keep/Undo and for this message's checkpoint.
  snapshot(file) {
    if (!file) return;
    if (this.p.inFolder(file)) { this.edits.snapshot(file); this.touched.add(norm(file)); } // scratch files elsewhere (e.g. /tmp) aren't changes to review
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (cp && !cp.snaps.has(file)) {
      try { const buf = fs.readFileSync(file); cp.snaps.set(file, isBinary(buf) ? buf : buf.toString("utf8")); } catch { cp.snaps.set(file, null); }
    }
  }

  // Same as snapshot(), with the pre-change text already known.
  snapshotText(file, text) {
    if (this.p.inFolder(file)) { this.edits.snapshotText(file, text); this.touched.add(norm(file)); }
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (cp && !cp.snaps.has(file) && !Buffer.isBuffer(text)) cp.snaps.set(file, text); // binary: the command's git record covers it on Restore
  }

  // Before a shell command runs (the CLI waits for this): git-snapshot every repo it may touch,
  // so files it changes get Keep/Undo and a checkpoint exactly like Edit/Write.
  async preBash(id, req) {
    const claude = this.claude;
    try {
      const input = req.input || {};
      if (input.tool_name === "Bash" && req.tool_use_id) {
        const roots = await this.p.reposFor(input.cwd || this.folder, input.tool_input?.command || "");
        const marks = (await Promise.all(roots.map((r) => this.p.gitMark(r)))).filter(Boolean);
        if (marks.length) this.bashMarks.set(req.tool_use_id, marks);
      }
    } catch {}
    claude?.write({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
  }

  // After an edit (the CLI waits for this): the errors VS Code's language servers now see in the file go back to Claude,
  // so it fixes what it broke. Language servers mostly check open files only, hence openTextDocument.
  // ponytail: a file no language server checks waits the full 1.5 s; skip by language if that gets noticeable.
  async postEdit(id, req) {
    const claude = this.claude;
    let response = {};
    try {
      const t = req.input?.tool_input || {};
      const file = t.file_path || t.notebook_path;
      if (file && this.p.inFolder(file) && vscode.workspace.getConfiguration("bitsmith").get("diagnostics")) {
        const uri = vscode.Uri.file(file);
        await new Promise((resolve) => {
          const sub = vscode.languages.onDidChangeDiagnostics((e) => e.uris.some((u) => u.fsPath === uri.fsPath) && done());
          const timer = setTimeout(() => done(), 1500);
          function done() { sub.dispose(); clearTimeout(timer); resolve(); }
          vscode.workspace.openTextDocument(uri).then(null, done);
        });
        const errors = vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).slice(0, 10);
        if (errors.length) response = { hookSpecificOutput: { hookEventName: "PostToolUse",
          additionalContext: `VS Code reports these errors in ${this.rel(file)} after the edit:\n` +
            errors.map((d) => `- line ${d.range.start.line + 1}: ${d.message}${d.source ? ` (${d.source})` : ""}`).join("\n") } };
      }
    } catch {}
    claude?.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }

  // "!command" in the input: it runs in the folder's shell right away, and its output goes along with the next message.
  shell(command) {
    if (!this.folder || !command) return;
    exec(command, { cwd: this.folder, timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trimEnd().slice(-20000);
      const code = err ? (typeof err.code === "number" ? err.code : err.killed ? "timed out" : 1) : 0;
      (this.shellNotes ||= []).push({ command, output, code });
      this.post({ type: "shell", command, output, code });
    });
  }

  // "/btw question": a quick answer from a throwaway fork of this conversation, without tools,
  // while the chat itself carries on. Nothing is saved, as in Claude Code.
  btw(text) {
    const id = Math.random().toString(36).slice(2), s = this.settings();
    this.post({ type: "btw", id, text });
    const args = ["-p", "--no-session-persistence", "--tools", "", "--output-format", "text"];
    if (this.sessionId) args.push("--resume", this.sessionId, "--fork-session");
    if (s.model && s.model !== "default") args.push("--model", s.model);
    args.push(`Side question (answer briefly from what you already know, then stop; don't continue the task): ${text}`);
    let out = "", errText = "";
    const p = spawn(claudeBin(), args, { cwd: this.folder || os.homedir(), env: process.env });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (errText += d));
    p.on("error", (e) => (errText = e.message));
    p.on("close", (code) => this.post({ type: "btwAnswer", id, ...(code || !out.trim() ? { error: errText.trim() || `Claude Code exited (${code})` } : { answer: out.trim() }) }));
  }

  // After the command: what changed since its snapshots becomes reviewable and restorable.
  async captureShell(marks) {
    const touched = [];
    const cp = this.checkpoints[this.checkpoints.length - 1];
    for (const a of marks) {
      const b = await this.p.gitMark(a.root);
      if (!b) continue;
      // A file untracked before the command (say it ran `git add`) isn't in the snapshot: its old content is unknown,
      // and reading it as "created" would delete it on Undo or Restore, so it's left alone.
      const changed = ((await git(a.root, ["diff", "--name-only", "-z", a.sha])) || "").split("\0").filter((p) => p && !a.untracked.has(p));
      const created = [...b.untracked].filter((p) => !a.untracked.has(p));
      if (cp && (changed.length || created.length)) (cp.shell ||= []).push({ root: a.root, a: a.sha, changed, created }); // for Restore, binary files included
      for (const p of changed) {
        const before = await git(a.root, ["show", `${a.sha}:${p}`], true); // null: not in the snapshot, so the command created it
        touched.push(path.join(a.root, p));
        this.snapshotText(touched[touched.length - 1], before == null ? null : isBinary(before) ? before : before.toString("utf8"));
      }
      for (const p of created) { touched.push(path.join(a.root, p)); this.snapshotText(touched[touched.length - 1], null); }
    }
    if (!touched.length) return;
    for (const f of touched) await this.edits.syncFromDisk(f);
    this.edits.refresh();
    this.saveCheckpoints();
  }

  // ---- checkpoints ----

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
      const data = this.checkpoints.map(({ key, sessionId, resumeAt, snaps, shell }) => ({ key, sessionId, resumeAt, snaps: [...snaps].map(([f, t]) => [f, Buffer.isBuffer(t) ? { b64: t.toString("base64") } : t]), shell }));
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {}
  }

  // Put files and the conversation back to how they were just before checkpoint `id`'s message.
  async restore(id, { edit, retry } = {}) {
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
    if (!edit || files.size || (retry && messages > 1)) {
      const choose = !edit && files.size; // a plain restore can keep either side, like Claude Code's rewind
      const pick = await vscode.window.showWarningMessage(
        retry
          ? `Retry this message? This reverts ${what} from this message on${messages > 1 ? ` and removes the ${plural(messages - 1, "message")} after it` : ""}.`
          : edit
          ? `Edit and resend? This reverts ${what} from this message on and removes ${plural(messages, "message")}.`
          : `Restore checkpoint? This removes ${plural(messages, "message")} and reverts ${what} since then.`,
        { modal: true, detail: "Command changes come from git snapshots, so edits to untracked or ignored files that already existed aren't covered." +
          (choose ? "\n\nConversation only: keep the files as they are now. Code only: keep the messages; this one can't be redone." : "") },
        ...(retry ? ["Retry"] : edit ? ["Edit and resend"] : choose ? ["Restore", "Conversation only", "Code only"] : ["Restore"]));
      if (!pick) return this.post({ type: "editCancelled", checkpoint: id });
      if (pick === "Code only") {
        if (this.busy) return;
        await this.writeFiles(files);
        this.edits.refresh();
        return this.post({ type: "notice", icon: "discard", text: `Reverted ${what} to before this message; the conversation is unchanged.` });
      }
      if (pick === "Conversation only") files.clear();
    }
    if (this.busy) return this.post({ type: "editCancelled", checkpoint: id }); // Claude started replying meanwhile
    const after = new Map(); // bytes, so binary files survive a redo
    for (const f of files.keys()) { try { after.set(f, fs.readFileSync(f)); } catch { after.set(f, null); } }
    this.redoStack.push({ files: after, checkpoints: this.checkpoints.slice(idx), sessionId: this.sessionId, resumeAt: this.resumeAt, lastUuid: this.lastUuid });
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
    this.resumeAt = r.resumeAt;
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

    if (req.tool_name === "EnterPlanMode") return allow(); // planning only reads; the plan itself asks
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
      const dirty = vscode.workspace.textDocuments?.some((d) => d.isDirty && d.uri.scheme === "file" && norm(d.uri.fsPath) === norm(file));
      const risk = this.p.editRisk(file) // "commands ask first" has to hold for edits that run commands, whatever the policy
        || (dirty ? "You have unsaved changes in this file. Claude edits the saved copy, so it will clash with them; save or revert first" : "");
      if (!risk && (policy !== "ask" || this.allowEdits)) return allow();
      let diff = null;
      const after = applyEdit(req.tool_name, req.input);
      if (after != null) {
        diff = vscode.Uri.from({ scheme: PROPOSED, path: file, query: id });
        proposed.set(diff.toString(), after);
      }
      this.pending.set(id, { req, diff });
      this.p.notify(this, "needs your approval");
      const rows = diffRows(req.tool_name, req.input); // shown on the card itself
      this.post({ type: "permission", id, kind: "edit", name: req.tool_name, hasDiff: !!diff,
        detail: risk && !this.p.inFolder(file) ? file : this.rel(file), // outside the folder, show where it really goes
        risk: risk || undefined, rows });
      if (diff && !rows.length && this.p.active === this) this.showProposed(id);
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
    const plan = this.editedPlan(p);
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
      const said = [plan && `The user edited the plan to:\n\n${plan}`, feedback && `The user said: ${feedback}`].filter(Boolean).join("\n\n");
      return this.claude.respond(id, { behavior: "deny", message: said || "The user rejected this. Ask what they want instead." });
    }
    let input = req.input;
    if (req.tool_name === "AskUserQuestion") input = { ...input, answers };
    if (plan) { input = { ...input, plan }; this.post({ type: "planText", id, plan }); } // "Approved Plan (edited by user)"
    const extra = always && req.permission_suggestions ? { updatedPermissions: req.permission_suggestions } : {};
    this.claude.respond(id, { behavior: "allow", updatedInput: input, ...extra });
  }

  // Open a proposed plan as a Markdown file; whatever it says when the plan is approved is what Claude builds.
  async editPlan(id) {
    const p = this.pending.get(id);
    if (!p || p.req.tool_name !== "ExitPlanMode") return;
    if (!p.planFile) {
      p.planFile = path.join(os.tmpdir(), `bitsmith-plan-${require("crypto").randomUUID()}.md`);
      fs.writeFileSync(p.planFile, p.req.input.plan || "");
    }
    await vscode.window.showTextDocument(vscode.Uri.file(p.planFile), { preview: false });
  }

  showProposed(id) {
    const p = this.pending.get(id);
    if (!p?.diff) return;
    const file = p.req.input.file_path;
    const left = fs.existsSync(file) ? vscode.Uri.file(file) : vscode.Uri.from({ scheme: PROPOSED, path: file, query: "empty" });
    vscode.commands.executeCommand("vscode.diff", left, p.diff, `${path.basename(file)} (proposed by Bitsmith)`, { preview: true });
  }

  closeProposed(id, p = this.pending.get(id)) {
    if (p?.planFile) {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input?.uri?.fsPath === p.planFile);
      const file = p.planFile;
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.save() // so closing doesn't ask to save a throwaway file
        .then(() => vscode.window.tabGroups.close(tabs)).then(() => fs.rmSync(file, { force: true }));
      if (!tabs.length) fs.rmSync(file, { force: true });
    }
    if (!p?.diff) return;
    const key = p.diff.toString();
    proposed.delete(key);
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === key) vscode.window.tabGroups.close(tab);
    }
  }

  // The plan's text if the user changed it in the editor, else null.
  editedPlan(p) {
    if (!p.planFile) return null;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p.planFile);
    const plan = (doc ? doc.getText() : fs.existsSync(p.planFile) ? fs.readFileSync(p.planFile, "utf8") : "").trim();
    return plan && plan !== (p.req.input.plan || "").trim() ? plan : null;
  }

  // ---- history ----

  // Async: a long chat takes a while to read and render, so the loading screen goes out first.
  async loadSession(id) {
    this.shutdown();
    this.older = null;
    this.sessionId = id;
    this.resumeAt = null;
    this.allowEdits = false; // "Allow all edits" was for the conversation that was here
    this.busy = false;
    this.checkpoints = [];
    this.redoStack = [];
    this._prefs = null;
    this.post({ type: "clear" });
    this.postSettings();
    this.edits.refresh(); // its unreviewed changes from before a reload come back
    this.p.postDraft(this); // and its unsent message
    this.updateTitle();
    this.post({ type: "loading", title: this.title });
    const load = (this.loads = (this.loads || 0) + 1);
    await new Promise((r) => setTimeout(r, 30)); // messages only leave the extension host once it is free
    if (this.loads !== load || this.sessionId !== id) return; // opened again, or cleared, meanwhile
    const file = path.join(this.sessionDir(), id + ".jsonl");
    this.lastUuid = lastAssistantUuid(file);
    let items = [];
    try { items = replay(file, (f) => this.rel(f)); } catch {} // an unreadable chat still ends the loading screen
    const saved = new Map(this.p.loadCheckpoints(id).map((c) => [c.key, c]));
    let n = 0;
    for (const it of items) {
      const cp = it.type === "user" && saved.get(it.key);
      if (cp) { cp.id = `saved-${++n}`; it.checkpoint = cp.id; this.checkpoints.push(cp); }
      if ("before" in it) { this.befores.set(it.id, it.before); delete it.before; } // stays here, not in the webview
    }
    this.userCount = 0; // messages already sent after the last reply
    for (let i = items.length - 1; i >= 0 && items[i].type === "user"; i--) this.userCount++;
    const cut = pageStart(items, items.length, 8); // the latest messages now; older ones as the user scrolls up
    this.older = items.slice(0, cut);
    this.post({ type: "replay", items: items.slice(cut), more: cut > 0 });
    this.todos = items.findLast((it) => it.type === "todos")?.todos || [];
    const last = lastUsage(file);
    if (last) this.setContext(last.used, last.model);
    if (this.p.active === this) this.ensure(); // restored background tabs start their process when shown
  }

  // The next page up of a reopened chat.
  loadOlder(all) {
    if (!this.older?.length) return;
    const cut = all ? 0 : pageStart(this.older, this.older.length, 10); // all: find in chat searches the whole chat
    this.post({ type: "older", items: this.older.slice(cut), more: cut > 0 });
    this.older = this.older.slice(0, cut);
  }

  // ---- step changes ----

  // Put a file back to how it was before one edit step, leaving later edits alone.
  async undoStep({ id, edit }) {
    const file = edit?.input?.file_path;
    if (!file) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && norm(d.uri.fsPath) === norm(file));
    if (doc?.isDirty) return vscode.window.showWarningMessage(`${path.basename(file)} has unsaved changes. Save or revert them first.`);
    const before = stepBefore([{ ...edit, before: this.befores.get(id) }], readText(file));
    if (before === undefined) return vscode.window.showInformationMessage(`Can't undo just this step: ${path.basename(file)} has changed since, or the edit can't be told apart. Undo the whole file from the changes list instead.`);
    if (before === null) fs.rmSync(file, { force: true }); // the step created it
    else if (doc) await this.edits.replaceText(doc, before);
    else fs.writeFileSync(file, before);
    this.edits.refresh();
    this.post({ type: "stepUndone", id });
  }

  // Everything one reply changed, in one multi-file diff: each file as it was before the reply against how it was after.
  turnDiff({ checkpoint, files }) {
    const at = this.checkpoints.findIndex((c) => c.id === checkpoint);
    const doc = virtualDoc;
    const res = [];
    for (const { file, steps } of files || []) {
      const later = at < 0 ? undefined : this.checkpoints.slice(at + 1).find((c) => c.snaps.has(file));
      const after = later ? later.snaps.get(file) : readText(file); // a later reply changed it again: stop where it took over
      const before = at >= 0 && this.checkpoints[at].snaps.has(file) ? this.checkpoints[at].snaps.get(file)
        : stepBefore(steps.map((s) => ({ ...s, before: this.befores.get(s.id) })), after);
      if (Buffer.isBuffer(before) || Buffer.isBuffer(after) || before === undefined) continue; // binary, or can't be worked out
      // Both sides virtual: the real file would get Keep/Undo lenses and highlights in every pane, which jolt the layout while scrolling.
      res.push([vscode.Uri.file(file), doc(file, "before", before ?? ""), doc(file, "after", after ?? "")]);
    }
    if (!res.length) return vscode.window.showInformationMessage("Can't show this reply's changes: the files have changed too much since.");
    if (res.length === 1) return vscode.commands.executeCommand("vscode.diff", res[0][1], res[0][2], `${path.basename(res[0][0].fsPath)} (this reply's changes)`, { preview: true });
    vscode.commands.executeCommand("vscode.changes", "Bitsmith: this reply's changes", res)
      .then(undefined, () => vscode.commands.executeCommand("vscode.diff", res[0][1], res[0][2])); // older VS Code: the first file
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
    // Each chat lists only the files it changed. A file that's been kept or undone leaves every chat's list.
    this.edits = new EditTracker((files) => {
      for (const c of this.chats.values()) {
        for (const f of c.touched) if (!this.edits.snapshots.has(f)) c.touched.delete(f);
        for (const f of this.edits.snapshots.keys()) if (c.sessionId && this.editOwners[f] === c.sessionId) c.touched.add(f); // reopened after a reload
        c.post({ type: "changes", files: files.filter((f) => c.touched.has(f.file)).map((f) => ({ ...f, rel: this.rel(f.file) })) });
      }
      this.saveEdits();
    });
    this.chats = new Map(); // key -> Chat, in tab order
    this.nextKey = 1;
    this.active = this.createChat();
    this.ws = context.workspaceState || this.state; // open tabs are per workspace
    // Unreviewed agent changes (Keep / Undo) and the chat that made each, kept across window reloads.
    const pending = this.ws.get("pendingEdits");
    this.editOwners = pending?.owners || {};
    this.edits.load(pending?.snapshots);
    this.edits.refresh();
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

  // A chat in the background, the panel hidden, or the window not in front: say so with a toast that jumps to it.
  // ponytail: a VS Code toast, not an OS notification; it waits in the window until you come back.
  notify(c, what) {
    const shown = c.panel ? c.panel.visible : c === this.active && this.view?.visible !== false;
    if (shown && vscode.window.state?.focused !== false) return;
    vscode.window.showInformationMessage?.(`Bitsmith: "${c.title || "New chat"}" ${what}.`, "Show").then((pick) => pick && this.reveal(c));
  }

  reveal(c) {
    if (!c || !this.chats.has(c.key)) return;
    if (c.panel) return c.panel.reveal();
    vscode.commands.executeCommand("bitsmith.chat.focus");
    this.switchTo(c);
  }

  // The status bar while any chat works: "Needs approval" first; clicking opens that chat.
  updateWork() {
    const item = this.workItem;
    if (!item) return;
    const all = [...this.chats.values()], waiting = all.find((c) => c.pending.size), busy = all.filter((c) => c.busy);
    this.workChat = waiting || busy[0];
    if (!this.workChat) return item.hide();
    item.text = waiting ? "$(bell-dot) Needs approval" : `$(loading~spin) Working${busy.length > 1 ? ` (${busy.length})` : ""}`;
    item.tooltip = `Bitsmith: "${this.workChat.title || "New chat"}" ${waiting ? "is waiting for your approval" : "is working"}. Click to open it.`;
    item.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    item.show();
  }

  // A chat's unsent message, kept across reloads: by session id, or "new" for the sidebar's not-yet-started chat.
  draftKey(c) { return c.sessionId || (!c.panel && c === this.active ? "new" : null); }

  saveDraft(c, { text, items, images }) {
    const key = this.draftKey(c);
    if (!key) return;
    const drafts = { ...this.ws.get("drafts") };
    if (text?.trim() || items?.length || images?.length) drafts[key] = { text, items, images };
    else delete drafts[key];
    this.ws.update("drafts", drafts);
  }

  postDraft(c) {
    const d = this.ws.get("drafts")?.[this.draftKey(c)];
    if (d) c.post({ type: "draft", ...d });
  }

  saveEdits() {
    const owners = {};
    for (const f of this.edits.snapshots.keys()) owners[f] = [...this.chats.values()].find((c) => c.sessionId && c.touched.has(f))?.sessionId || this.editOwners[f] || null;
    this.editOwners = owners;
    const data = JSON.stringify({ snapshots: this.edits.dump(), owners });
    if (data === this.savedEdits) return; // refresh runs on every keystroke in a changed file
    this.savedEdits = data;
    this.ws.update("pendingEdits", JSON.parse(data));
  }

  // Tabs survive a window reload: their session ids (and typed-ahead messages) are saved and reopened when the panel loads.
  saveTabs() {
    if (!this.restored) return; // the saved tabs haven't been reopened yet; don't overwrite them
    const list = [...this.chats.values()].filter((c) => c.sessionId && !c.panel); // editor tabs come back through their serializer
    const queues = {};
    for (const c of list) if (c.queue.length) queues[c.sessionId] = c.queue.map(({ text, items, chips, useActive }) => ({ text, items, chips, useActive, images: [] }));
    this.ws.update("openChats", { ids: list.map((c) => c.sessionId), active: this.active.sessionId || null, queues });
  }

  // The working tree's git state right now, without touching it: a stash-like commit of tracked files, plus untracked paths.
  // ponytail: these commits are unreferenced, so a `git gc` after ~2 weeks can drop them and old checkpoints lose command reverts.
  async gitMark(root) {
    if (root === undefined) {
      if (this.gitRoot === undefined) this.gitRoot = this.folder ? await this.repoRoot(this.folder) : null;
      root = this.gitRoot;
    }
    if (!root) return null;
    const sha = ((await git(root, ["stash", "create"])) || "").trim() || ((await git(root, ["rev-parse", "HEAD"])) || "").trim();
    const status = await git(root, ["status", "--porcelain", "-z", "-uall"]);
    if (!sha || status == null) return null;
    return { root, sha, untracked: new Set(status.split("\0").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3))) };
  }

  // "Configure Custom Agents…" in the Mode menu: open an .agent.md, or start a new one in the folder or the user profile.
  async configureAgents() {
    const where = (file) => file.startsWith("~/") ? path.join(userAgentDir(), file.slice(2)) : path.join(this.folder, ".github", "agents", file);
    const picks = [
      ...this.agents().map((a) => ({ label: a.label, description: a.value.startsWith("agent:~/") ? "user" : "workspace", file: where(a.value.slice(6)) })),
      { label: "$(add) Create new agent in this folder", dir: this.folder && path.join(this.folder, ".github", "agents") },
      { label: "$(add) Create new agent in your user profile", dir: userAgentDir() },
    ].filter((p) => p.file || p.dir);
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Open or create a custom agent" });
    if (!pick) return;
    let file = pick.file;
    if (!file) {
      const name = (await vscode.window.showInputBox({ prompt: "Agent name", placeHolder: "Reviewer" }))?.trim();
      if (!name) return;
      file = path.join(pick.dir, name.replace(/[\\/:*?"<>|]/g, "-") + ".agent.md");
      if (!fs.existsSync(file)) {
        fs.mkdirSync(pick.dir, { recursive: true });
        fs.writeFileSync(file, `---\nname: ${name}\ndescription: What this agent does\ntools: ['read', 'search', 'edit', 'execute']\n---\nInstructions for the agent.\n`);
        this.agentList = null;
        for (const c of this.chats.values()) c.postSettings();
      }
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  // Everything in the folder changed since the last commit (staged or not, plus new files), in one multi-file diff.
  async diffHead() {
    const dir = this.folder;
    const list = dir && (await git(dir, ["diff", "HEAD", "--name-status", "--no-renames", "--relative", "-z"]));
    if (list == null) return vscode.window.showInformationMessage("Can't compare: this folder isn't in a git repository with a commit.");
    const p = list.split("\0").filter(Boolean), changed = [];
    for (let i = 0; i + 1 < p.length; i += 2) changed.push([p[i], p[i + 1]]);
    for (const rel of ((await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])) || "").split("\0").filter(Boolean)) changed.push(["A", rel]);
    if (!changed.length) return vscode.window.showInformationMessage("No changes since the last commit.");
    const MAX = 200; // ponytail: one diff of the first 200 files; page it if a bigger working tree matters
    const res = [];
    for (const [status, rel] of changed.slice(0, MAX)) {
      const file = path.join(dir, rel);
      const before = status === "A" ? Buffer.alloc(0) : (await git(dir, ["show", `HEAD:./${rel}`], true)) || Buffer.alloc(0);
      const after = status === "D" ? Buffer.alloc(0) : (() => { try { return fs.readFileSync(file); } catch { return Buffer.alloc(0); } })();
      if (isBinary(before) || isBinary(after)) continue;
      res.push([vscode.Uri.file(file), virtualDoc(file, "head", before.toString("utf8")), virtualDoc(file, "now", after.toString("utf8"))]);
    }
    if (changed.length > MAX) vscode.window.showInformationMessage(`Showing the first ${MAX} of ${changed.length} changed files.`);
    if (!res.length) return vscode.window.showInformationMessage("Only binary files changed since the last commit.");
    vscode.commands.executeCommand("vscode.changes", "Bitsmith: changes since last commit", res)
      .then(undefined, () => vscode.commands.executeCommand("vscode.diff", res[0][1], res[0][2])); // older VS Code: the first file
  }

  async repoRoot(dir) {
    if (!this.roots) this.roots = new Map();
    if (!this.roots.has(dir)) this.roots.set(dir, ((await git(dir, ["rev-parse", "--show-toplevel"])) || "").trim() || null);
    return this.roots.get(dir);
  }

  // The git repos a shell command may change: its working directory, absolute and ~ paths in it, and cd targets.
  // Nested repos count (e.g. a project the folder's own .gitignore excludes); repos outside the folder don't.
  async reposFor(cwd, command) {
    const dirs = new Set([cwd]);
    const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
    for (const m of command.matchAll(/(?:^|[\s'"=:;&|(<>])((?:~|\/)[^\s'"|;&<>()]*)/g)) dirs.add(home(m[1]));
    for (const m of command.matchAll(/\bcd\s+(['"]?)([^\s'";&|]+)\1/g)) dirs.add(path.resolve(cwd, home(m[2])));
    const roots = new Set();
    for (let d of dirs) {
      d = path.resolve(cwd, d);
      while (d !== path.dirname(d) && !fs.existsSync(d)) d = path.dirname(d); // a file the command will create
      try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch { continue; }
      const root = await this.repoRoot(d);
      const f = this.folder;
      if (root && f && (root === f || this.inFolder(root) || (f + path.sep).startsWith(root + path.sep))) roots.add(root); // inside the folder, or the folder's own repo
    }
    return [...roots];
  }

  restoreTabs() {
    const saved = this.ws.get("openChats");
    if (this.restored || !saved?.ids?.length || [...this.chats.values()].some((c) => !c.panel && c !== this.active) || !this.active.fresh) return (this.restored = true);
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
    return !!this.folder && norm(file).startsWith(norm(this.folder) + path.sep);
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
      ultracode: this.state.get("ultracode", false),
      mode: this.state.get("mode", "agent").replace(/^plan$/, "agent"), // Plan mode is now part of Agent
      policy: this.state.get("policy", vscode.workspace.getConfiguration("bitsmith").get("defaultPolicy")),
      agents: this.agents().map(({ value, label, description }) => ({ value, label, description })),
    };
  }

  // Custom agents, as in Copilot Chat: .github/agents/*.agent.md in the folder, then the user profile's, in the Mode picker.
  agents() {
    if (this.agentList) return this.agentList;
    const read = (dir, prefix) => {
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".agent.md")).sort(); } catch {}
      return files.map((f) => parseAgent(prefix + f, fs.readFileSync(path.join(dir, f), "utf8")));
    };
    return (this.agentList = [...read(this.folder && path.join(this.folder, ".github", "agents"), ""), ...read(userAgentDir(), "~/")]);
  }

  // What a mode adds to the CLI's launch: instructions and the tools it may not use. `key` changes when either does.
  launchAgent(mode) {
    if (mode === "ask") return { key: "ask", prompt: ASK_PROMPT, disallowed: [...EDIT_TOOLS, "Bash", "EnterPlanMode"] };
    const a = mode?.startsWith("agent:") && this.agents().find((x) => x.value === mode);
    if (!a) return { key: "agent", prompt: AGENT_PROMPT };
    const t = a.tools; // Copilot's tool names; no list means all tools
    const disallowed = !t ? [] : [...(t.some((x) => x === "edit" || x.startsWith("edit/")) ? [] : EDIT_TOOLS),
      ...(t.some((x) => ["execute", "execute/runInTerminal", "runCommands", "terminal"].includes(x)) ? [] : ["Bash"])];
    const prompt = `You are acting as the "${a.label}" agent the user picked. Follow its instructions:\n\n${a.prompt}`;
    return { key: JSON.stringify([mode, prompt, disallowed]), prompt, disallowed };
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
    if (!c.sessionId) return this.openTab(); // nothing to move yet: a new chat in its own tab
    // out of the sidebar first, while its messages still go there
    this.post({ type: "closeChat", chat: c.key });
    if (c === this.active) {
      const next = [...this.chats.values()].filter((x) => x !== c && !x.panel).pop();
      if (next) this.switchTo(next);
      else { const fresh = this.createChat(); this.post({ type: "openChat", chat: fresh.key }); this.switchTo(fresh); }
    }
    this.attach(c);
  }

  // A chat in a new editor tab: empty, or showing a past session. `panel` is one VS Code restored after a reload.
  openTab(sessionId = null, panel = null) {
    const c = this.createChat();
    c.sessionId = sessionId;
    this.attach(c, panel);
    return c;
  }

  attach(c, panel) {
    const root = this.context.extensionUri;
    const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(root, "media")] };
    if (panel) panel.webview.options = options;
    else {
      // like Claude Code: a split beside the code, and later chats join the group Bitsmith tabs are already in
      const group = [...this.chats.values()].find((x) => x.panel?.viewColumn)?.panel.viewColumn;
      panel = vscode.window.createWebviewPanel("bitsmith.chatTab", c.title || "Bitsmith", group || vscode.ViewColumn.Beside, options);
    }
    panel.title = c.title || "Bitsmith";
    panel.iconPath = vscode.Uri.joinPath(root, "media", "icon.svg");
    c.panel = panel;
    panel.webview.html = html(panel.webview, root, c.key, true);
    panel.webview.onDidReceiveMessage((m) => this.onWebview({ ...m, chat: c.key }, c));
    panel.onDidDispose(() => { c.panel = null; c.shutdown(); this.chats.delete(c.key); this.saveTabs(); });
  }

  // The chat you're looking at: the focused editor tab's, otherwise the sidebar's. Title-bar commands act on it.
  current() {
    return [...this.chats.values()].find((c) => c.panel?.active) || this.active;
  }

  // An editor-tab chat's webview loaded: settings, then the conversation from its transcript.
  panelReady(c) {
    c.panel.webview.postMessage({ type: "settings", ...c.settings() });
    c.panel.webview.postMessage({ type: "usage", usage: this.usage, plan: this.plan });
    if (this.info) c.panel.webview.postMessage({ type: "init", ...this.info });
    c.panel.webview.postMessage({ type: "chats", chats: [{ key: c.key, title: c.title }], active: c.key });
    if (this.folder) c.panel.webview.postMessage(this.sessionsMsg());
    this.postActiveFile();
    this.edits.refresh();
    if (c.sessionId) c.loadSession(c.sessionId);
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
        const p = spawn(claudeBin(), ["-p", "--model", "haiku", "--output-format", "text", prompt], { cwd: repo.rootUri.fsPath, env: process.env });
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
    if (from && m.type === "loadSession") return this.openSession(m.id, from);
    if (from && m.type === "newChat") return this.newChat(from);
    if (from && m.type === "history") return this.history(from);
    switch (m.type) {
      case "queue": c.queue = m.items || []; return this.saveTabs();
      case "draft": return this.saveDraft(c, m);
      case "diffHead": return this.diffHead();
      case "configureAgents": return this.configureAgents();
      case "openInEditor": return this.openInEditor(c);
      case "ready":
        this.active.postSettings();
        this.post({ type: "usage", usage: this.usage, plan: this.plan });
        if (this.usageRequested) { this.usageRequested = false; this.post({ type: "showUsage" }); }
        if (this.info) this.post({ type: "init", ...this.info });
        this.post({ type: "chats", chats: [...this.chats.values()].filter((x) => !x.panel).map((x) => ({ key: x.key, title: x.title })), active: this.active.key });
        this.postActiveFile();
        this.postSessions();
        this.edits.refresh();
        this.restoreTabs();
        if (!this.active.sessionId) this.postDraft(this.active);
        this.active.ensure(); // warm start: fetches models and slash commands
        break;
      case "fileSearch": return this.post({ type: "fileResults", q: m.q, items: await this.searchFiles(m.q) });
      case "renameChat": return c.sessionId ? this.renameSession(c.sessionId) : vscode.window.showInformationMessage("Send a message first; then the chat can be named.");
      case "deleteChat": return c.sessionId ? this.deleteSession(c.sessionId) : vscode.window.showInformationMessage("This chat hasn't been saved yet.");
      case "exportChat": return this.exportChat(c);
      case "send": return c.send(m);
      case "shell": return c.shell(m.command);
      case "btw": return c.btw(m.text);
      case "memory": return this.memory(c, m.text);
      case "addDir": return this.addDir(c);
      case "stop": return c.interrupt();
      case "open": return this.openPath(c, m.file, m.line, m.end);
      case "openImage": return openImage(m.mediaType, m.data);
      case "permission": return c.answer(m);
      case "editPlan": return c.editPlan(m.id);
      case "showProposed": return c.showProposed(m.id);
      case "setting": return this.setSetting(m.key, m.value, c);
      case "pickContext": return this.pickContext(c);
      case "pinActive": { // the current-file chip clicked: attach it (its selection, if any) for good
        const a = this.activeFile();
        return a && this.addItems([a.selection ? { kind: "selection", file: a.file, rel: a.rel, ...a.selection } : { kind: "file", file: a.file, rel: a.rel }], c);
      }
      case "drop": return this.addUris(m.uris.map((u) => vscode.Uri.parse(u)), c);
      case "pastePaths": return this.pastePaths(m.paths, c, m.raw);
      case "keep": return this.edits.keep(m.file || [...c.touched]); // no file: everything this chat changed
      case "undo": return this.edits.undo(m.file || [...c.touched]);
      case "diffFile": return this.edits.showDiff(m.file);
      case "loadOlder": return c.loadOlder(m.all);
      case "stepDiff": return m.edit && showStepDiff({ ...m.edit, before: c.befores.get(m.id) });
      case "undoStep": return c.undoStep(m);
      case "turnDiff": return c.turnDiff(m);
      case "copy": return vscode.env.clipboard.writeText(m.text);
      case "insertCode": return this.insertCode(m.text);
      case "applyCode": { // Claude does the merge: a code block is usually a fragment, and its edit then lands in Keep/Undo
        const f = this.activeFile();
        return c.post({ type: "quickAction", text: `Apply this code to ${f ? `\`${f.rel}\`` : "the file it belongs to"}:\n\n\`\`\`${m.lang || ""}\n${m.text.replace(/\n$/, "")}\n\`\`\``, items: [] });
      }
      case "history": return this.history();
      case "loadSession": return this.openSession(m.id);
      case "deleteSession": return this.deleteSession(m.id);
      case "pinSession": return this.togglePin(m.id);
      case "newChat": return this.newChat();
      case "switchChat": return this.chats.has(m.chat) && this.switchTo(c, false);
      case "closeChat": return this.closeChat(c);
      case "stopTask": return c.stopTask(m.taskId);
      case "taskOutput": return c.taskOutput(m.taskId);
      case "restore": return c.restore(m.checkpoint);
      case "editMessage": return c.restore(m.checkpoint, { edit: m.text, retry: m.retry });
      case "redo": return c.redo();
      case "refreshUsage": return this.fetchUsage(true);
      case "openUsagePage": return vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/settings/usage"));
    }
  }

  abs(file) {
    return path.isAbsolute(file) ? file : path.join(this.folder || "", file);
  }

  // A file outside the workspace (screenshots in /tmp, say): look next to the paths this chat's tools used.
  mentionedPath(c, rel) {
    const text = [...(c?.tools.values() || [])].map((t) => JSON.stringify(t.input || {})).join("\n");
    for (const p of new Set(text.match(/~?\/[^\s'"`\\,;()]+/g) || [])) {
      const abs = path.resolve(p.replace(/^~/, os.homedir()));
      const near = [path.join(abs, rel), path.join(path.dirname(abs), rel)]; // abs is a folder, or a file beside it
      if (abs.endsWith("/" + rel)) near.unshift(abs);
      for (const f of near) if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    return null;
  }

  // A file named in a reply. Replies often give a path relative to where Claude was working, or just a name,
  // so when it isn't at the folder root, look for it: files this chat touched first, then shortest path.
  async openPath(c, file, line, end) {
    if (!file) return;
    const direct = this.abs(file.replace(/^~(?=\/|$)/, os.homedir()));
    if (fs.existsSync(direct)) return openFile(direct, line, end);
    const rel = file.replace(/^(\.{1,2}\/)+/, "");
    const found = (await vscode.workspace.findFiles(`**/${rel}`, EXCLUDE, 50)).map((u) => u.fsPath);
    if (!found.length) {
      const near = this.mentionedPath(c, rel);
      return near ? openFile(near, line, end) : vscode.window.showInformationMessage(`Bitsmith couldn't find ${file} in this workspace.`);
    }
    const touched = new Set([...(c?.tools.values() || [])].map((t) => t.input?.file_path).filter(Boolean));
    found.sort((a, b) => touched.has(b) - touched.has(a) || a.length - b.length);
    if (found.length === 1 || touched.has(found[0])) return openFile(found[0], line, end);
    const pick = await vscode.window.showQuickPick(found.map((f) => ({ label: path.basename(f), description: this.rel(f), f })), { placeHolder: `Several files match ${file}` });
    if (pick) openFile(pick.f, line, end);
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

  setSetting(key, value, c = this.active) {
    this.state.update(key, value); // also the starting point for new chats
    if (["model", "effort", "ultracode", "mode"].includes(key)) { c.prefs()[key] = value; c.savePrefs(); }
    if (key === "model" || key === "mode") c.syncSettings(); // the chat it was changed in (an editor tab's isn't the sidebar's)
  }

  // "# note" saves a line to a CLAUDE.md; "/memory" (no text) opens one. Running chats reread it on their next message.
  async memory(c, text) {
    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const items = [
      this.folder && { label: "Project memory", description: "CLAUDE.md · shared with the repo", file: path.join(this.folder, "CLAUDE.md") },
      this.folder && { label: "Project memory (local)", description: "CLAUDE.local.md · just you", file: path.join(this.folder, "CLAUDE.local.md") },
      { label: "User memory", description: "~/.claude/CLAUDE.md · all your projects", file: path.join(home, "CLAUDE.md") },
    ].filter(Boolean);
    const pick = await vscode.window.showQuickPick(items, { title: text ? `Save to memory: ${text}` : "Open memory file", placeHolder: "Which CLAUDE.md?" });
    if (!pick) return;
    if (!text) {
      if (!fs.existsSync(pick.file)) { fs.mkdirSync(path.dirname(pick.file), { recursive: true }); fs.writeFileSync(pick.file, ""); }
      this.memoryStamp = (this.memoryStamp || 0) + 1; // edited there, probably
      return openFile(pick.file);
    }
    const old = readText(pick.file) || "";
    fs.mkdirSync(path.dirname(pick.file), { recursive: true });
    fs.writeFileSync(pick.file, old + (old && !old.endsWith("\n") ? "\n" : "") + `- ${text}\n`);
    this.memoryStamp = (this.memoryStamp || 0) + 1;
    c.post({ type: "notice", icon: "book", text: `Saved to ${pick.label.toLowerCase()} (${path.basename(pick.file)}): ${text}` });
  }

  // "/add-dir": folders beyond the workspace this chat's Claude may read without asking (edits there still ask).
  async addDir(c) {
    const dirs = c.prefs().dirs || [];
    let keep = dirs;
    if (dirs.length) {
      const add = { label: "$(add) Add a folder…", add: true };
      const picked = await vscode.window.showQuickPick([...dirs.map((d) => ({ label: d, picked: true })), add],
        { canPickMany: true, title: "Extra folders for this chat", placeHolder: "Untick a folder to remove it" });
      if (!picked) return;
      keep = picked.filter((p) => !p.add).map((p) => p.label);
      if (!picked.includes(add)) return this.setDirs(c, keep);
    }
    const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: "Add to chat",
      defaultUri: this.folder ? vscode.Uri.file(path.dirname(this.folder)) : undefined });
    this.setDirs(c, [...new Set([...keep, ...(uris || []).map((u) => u.fsPath)])]);
  }

  setDirs(c, dirs) {
    const before = c.prefs().dirs || [];
    if (before.join("\n") === dirs.join("\n")) return;
    c.prefs().dirs = dirs;
    c.savePrefs();
    const name = (d) => (this.folder ? path.relative(this.folder, d) : d);
    c.post({ type: "notice", icon: "folder", text: dirs.length ? `Claude can read ${dirs.map(name).join(", ")} without asking; edits there still ask. Applies from the next message.` : "No extra folders for this chat any more." });
  }

  // ---- open chats ----

  createChat() {
    const c = new Chat(this, `c${this.nextKey++}`);
    this.chats.set(c.key, c);
    return c;
  }

  // A fresh chat is reused; otherwise the current one keeps running in its own tab.
  newChat(from = this.current()) {
    if (from.panel) return from.fresh ? from.panel.reveal() : this.openTab(); // from an editor tab: another tab, like the sidebar's +
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
    c.postSettings();
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
  openSession(id, tab = null) {
    const open = [...this.chats.values()].find((c) => c.sessionId === id);
    if (open) return open.panel ? open.panel.reveal() : this.switchTo(open);
    // Written in the last minute, but not by this window: likely a Claude still running in a terminal on the same file.
    const s = this.session(id);
    if (s && Date.now() - s.time < 60000 && !this.seen?.has(id))
      vscode.window.showWarningMessage(`Bitsmith: "${s.title || "this chat"}" changed under a minute ago, so it may still be open in a terminal. Exit Claude there before replying here, or both write into the same chat.`);
    (this.seen ||= new Set()).add(id); // warned once
    if (tab) return tab.fresh ? tab.loadSession(id) : this.openTab(id); // picked from an editor tab: stay in the editor area
    let c = this.active;
    if (!c.fresh || c.busy) {
      c = this.createChat();
      this.post({ type: "openChat", chat: c.key });
      this.switchTo(c);
    }
    return c.loadSession(id);
  }

  // A terminal session picked up here (right-click a terminal tab → Continue in Bitsmith).
  // ponytail: the newest chat not open here, not necessarily that terminal's; match by terminal name if several run at once.
  continueFromTerminal() {
    const open = new Set([...this.chats.values()].map((c) => c.sessionId));
    const s = this.sessions(20).find((x) => !open.has(x.id));
    if (!s) return vscode.window.showInformationMessage("Bitsmith: no other chat in this folder to continue.");
    return this.openSession(s.id);
  }

  chatChanged(c) {
    if (c.sessionId) (this.seen ||= new Set()).add(c.sessionId); // written by this window, so no "open in a terminal" warning
    this.saveTabs();
    if (c.sessionId && !this.ws.get("chatPrefs")?.[c.sessionId]) c.savePrefs(); // a new chat's picks, now it has an id to keep them under
    c.panel?.webview.postMessage({ type: "tabState", sessionId: c.sessionId }); // what a reload reopens in this tab
    this.postSessions(); // a chat got its title: it now belongs in Recent chats
    if (c.panel) c.panel.title = c.title || "Bitsmith";
    this.post({ type: "chatTitle", chat: c.key, title: c.title });
    if (c === this.active && this.view) this.view.description = c.title || undefined;
  }

  withContext(text, items, useActive, shellNotes = [], imageFiles = []) {
    const out = [];
    for (const n of shellNotes) out.push(`I ran \`${n.command}\` in the folder (exit ${n.code}):`, "```\n" + (n.output || "(no output)") + "\n```");
    const active = useActive && this.activeFile();
    if (active) {
      out.push(`Current file: ${active.rel}${active.selection ? ` (lines ${active.selection.start}-${active.selection.end} selected)` : ""}`);
      if (active.selection) out.push("```\n" + active.selection.text + "\n```");
    }
    const attached = items.filter((i) => i.kind !== "selection" && !(active && !active.selection && i.file === active.file)); // listed once
    if (attached.length) out.push("Attached:", ...attached.map((i) => `- ${i.rel}${i.kind === "folder" ? "/" : ""} (${i.kind})`));
    for (const s of items.filter((i) => i.kind === "selection")) out.push(`Selection from ${s.rel} lines ${s.start}-${s.end}:`, "```\n" + s.text + "\n```");
    if (imageFiles.length) out.push("Pasted images, also saved as files for tools that need a path:", ...imageFiles.map((f) => `- ${f} (image)`));
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
      return JSON.parse(fs.readFileSync(this.checkpointFile(sessionId), "utf8")).map((c) => ({ ...c, snaps: new Map(c.snaps.map(([f, t]) => [f, t?.b64 != null ? Buffer.from(t.b64, "base64") : t])) }));
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

  // c: the chat that asked (a drop or the + picker); its editor tab gets the items instead of the sidebar
  addItems(items, c) {
    if (!items.length) return;
    if (c?.panel) return c.panel.webview.postMessage({ type: "addContext", items });
    vscode.commands.executeCommand("bitsmith.chat.focus");
    this.post({ type: "addContext", items });
  }

  async addUris(uris, c) {
    const items = [];
    for (const uri of uris) {
      try {
        const st = await vscode.workspace.fs.stat(uri);
        items.push({ kind: st.type & vscode.FileType.Directory ? "folder" : "file", file: uri.fsPath, rel: this.rel(uri.fsPath) });
      } catch {}
    }
    this.addItems(items, c);
  }

  // Pasted text that looked like paths: existing ones become chips, the rest goes back into the input as typed.
  pastePaths(paths, c, raw = paths.join("\n")) {
    const items = [], rest = [];
    for (const p of paths) {
      const file = p.startsWith("file://") ? vscode.Uri.parse(p).fsPath : this.abs(p.replace(/^~(?=\/|$)/, os.homedir()));
      try {
        items.push({ kind: fs.statSync(file).isDirectory() ? "folder" : "file", file, rel: this.rel(file) });
      } catch { rest.push(p); }
    }
    // all real paths: chips; otherwise it was just text that looked like paths ("// comment", "/api/v1"), pasted as is
    if (!rest.length) return this.addItems(items, c);
    (c?.panel ? c.panel.webview : this.view?.webview)?.postMessage({ type: "insertText", text: raw });
  }

  addSelection() {
    const e = vscode.window.activeTextEditor;
    if (!e || e.selection.isEmpty) return;
    this.addItems([{ kind: "selection", file: e.document.uri.fsPath, rel: this.rel(e.document.uri.fsPath), start: e.selection.start.line + 1, end: e.selection.end.line + 1, text: e.document.getText(e.selection) }]);
  }

  // Explain / Fix / Tests from the editor: the selection (or the lightbulb's error lines, or else the whole file) goes to the chat with a ready prompt.
  quickAction(kind, uri, diag) {
    const e = vscode.window.activeTextEditor;
    const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : e?.document;
    if (!doc || doc.uri.scheme !== "file") return;
    const sel = !diag && e?.document === doc && !e.selection.isEmpty ? e.selection : null;
    const [from, to] = diag ? [diag.range.start.line, diag.range.end.line] : sel ? [sel.start.line, sel.end.line] : [];
    const file = doc.uri.fsPath, rel = this.rel(file);
    const items = [from != null ? { kind: "selection", file, rel, start: from + 1, end: to + 1, text: doc.getText(sel || new vscode.Range(from, 0, to + 1, 0)) } : { kind: "file", file, rel }];
    const text = kind === "explain" ? "Explain this code." : kind === "tests" ? "Write tests for this code, following the project's existing test setup."
      : diag ? `Fix this error at line ${diag.range.start.line + 1}: ${diag.message}${diag.source ? ` (${diag.source})` : ""}` : "Fix this code.";
    vscode.commands.executeCommand("bitsmith.chat.focus");
    this.active.post({ type: "quickAction", text, items });
  }

  // A code block's "Insert at cursor": into the editor last used, replacing its selection. Ctrl+Z takes it back out.
  async insertCode(text) {
    const e = vscode.window.activeTextEditor || vscode.window.visibleTextEditors.find((x) => x.document.uri.fsPath === this.lastFile);
    if (!e) return vscode.window.showInformationMessage("Open a file first; the code goes in at its cursor.");
    await e.edit((b) => b.replace(e.selection, text));
  }

  async pickContext(c) {
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
    if (picks) this.addItems(picks.map((p) => ({ kind: p.kind, file: p.file, rel: this.rel(p.file) })), c);
  }

  // ---- history (shared with the Claude Code CLI) ----

  sessionDir() {
    return path.join(os.homedir(), ".claude", "projects", (this.folder || "").replace(/[^a-zA-Z0-9]/g, "-"));
  }

  sessions(limit) {
    let files = [];
    try { files = fs.readdirSync(this.sessionDir()).filter((f) => f.endsWith(".jsonl")); } catch {}
    const moved = new Map();
    const list = latestCopies(files
      .map((f) => { const file = path.join(this.sessionDir(), f); try { const st = fs.statSync(file); return { id: f.slice(0, -6), file, time: st.mtimeMs, born: st.birthtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time), moved)
      .slice(0, limit)
      .map((s) => ({ ...s, title: sessionTitle(s.file) }))
      .filter((s) => s.title);
    // Chats with the same title (e.g. one conversation carried on in the terminal and here) show their last prompt to tell them apart.
    for (const s of list) if (list.some((o) => o !== s && o.title === s.title)) s.note = lastPrompt(s.file);
    this.followPins(moved);
    return list;
  }

  // Pinned chats (up to 5 per folder) lead the empty screen; Recent lists the rest.
  sessionsMsg() {
    const pick = ({ id, title, time, note }) => ({ id, title, time, note });
    const recent = this.sessions(11); // first, so the pins follow chats that moved to a newer file
    const pinned = this.pins().map((id) => this.session(id)).filter((s) => s?.title).map(pick);
    const ids = new Set(pinned.map((s) => s.id));
    return { type: "sessions", items: recent.filter((s) => !ids.has(s.id)).slice(0, 6).map(pick), pinned };
  }

  pins() { return this.ws.get("pinnedChats") || []; }

  // A pinned chat that went on in a newer file (compacted, retried, edited) keeps its pin there.
  followPins(moved) {
    const pins = this.pins();
    const next = [...new Set(pins.map((id) => { for (let n = 0; moved.has(id) && n < 100; n++) id = moved.get(id); return id; }))];
    if (next.join() !== pins.join()) this.ws.update("pinnedChats", next);
  }

  togglePin(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) return;
    const pins = this.pins().filter((p) => p !== id && this.session(p)); // deleted chats drop out
    if (!this.pins().includes(id)) {
      if (pins.length >= 5) return void vscode.window.showInformationMessage("Up to 5 chats can be pinned. Unpin one first.");
      pins.unshift(id);
    }
    this.ws.update("pinnedChats", pins);
    this.postSessions();
  }

  postSessions() {
    if (this.folder) this.post(this.sessionsMsg());
  }

  async history(tab = this.current().panel ? this.current() : null) {
    const trash = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete chat" };
    const rename = { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Rename chat" };
    const qp = vscode.window.createQuickPick();
    let recent = [];
    const pin = { iconPath: new vscode.ThemeIcon("pin"), tooltip: "Pin to the top here and on the empty screen" };
    const unpin = { iconPath: new vscode.ThemeIcon("pinned"), tooltip: "Unpin" };
    const item = (s, found) => { const on = this.pins().includes(s.id); return { label: (on ? "$(pinned) " : "") + s.title,
      description: (found ? "$(search) in chat · " : "") + new Date(s.time).toLocaleString(), detail: s.note && `Last: ${s.note}`, id: s.id, buttons: [on ? unpin : pin, rename, trash], alwaysShow: found }; };
    const load = () => { // pinned chats first, then the rest newest first
      const list = this.sessions(60), pins = this.pins(); // sessions() first: it moves pins to the chats' newest files
      recent = [...pins.map((id) => this.session(id)).filter((s) => s?.title), ...list.filter((s) => !pins.includes(s.id))];
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
    qp.onDidAccept(() => { const pick = qp.selectedItems[0]; qp.hide(); if (pick) this.openSession(pick.id, tab); });
    qp.onDidTriggerItemButton(async ({ item: it, button }) => {
      if (button === pin || button === unpin) {
        this.togglePin(it.id);
        if (!qp.value.trim()) return load(); // re-sorted: it moves to or off the top
        return void (qp.items = qp.items.map((x) => x.id === it.id ? item(this.session(x.id), x.alwaysShow) : x));
      }
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

// A step's change as rows for the panel: each hunk with 2 lines of context; k is "+", "-", " ", or "…" for a gap.
function diffRows(tool, input, max = 400) {
  const rows = [];
  if (tool === "Write") for (const t of lines(input.content || "")) rows.push({ k: "+", t });
  for (const e of tool === "MultiEdit" ? input.edits || [] : tool === "Edit" ? [input] : []) {
    const a = lines(e.old_string || ""), b = lines(e.new_string || ""), hunks = diffLines(a, b);
    let at = 0;
    if (rows.length && hunks.length) rows.push({ k: "…", t: "" });
    hunks.forEach((h, n) => {
      const from = Math.max(at, h.oStart - 2), to = Math.min(a.length, h.oEnd + 2, hunks[n + 1]?.oStart ?? Infinity);
      if (from > at && n) rows.push({ k: "…", t: "" });
      for (const t of a.slice(from, h.oStart)) rows.push({ k: " ", t });
      for (const t of a.slice(h.oStart, h.oEnd)) rows.push({ k: "-", t });
      for (const t of b.slice(h.nStart, h.nEnd)) rows.push({ k: "+", t });
      for (const t of a.slice(h.oEnd, to)) rows.push({ k: " ", t });
      at = to;
    });
  }
  return rows.length > max ? [...rows.slice(0, max), { k: "…", t: `${rows.length - max} more lines` }] : rows;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

// A read-only copy of `text` for one side of a diff, named like `file` so it gets its language.
function virtualDoc(file, side, text) {
  const uri = vscode.Uri.from({ scheme: PROPOSED, path: file, query: `${side}-${Math.random().toString(36).slice(2)}` });
  proposed.set(uri.toString(), text);
  return uri;
}

// A file's text before these edit steps (oldest first), worked back from its text now. null: it didn't exist yet;
// undefined: can't tell, because the file has moved on or the edit is ambiguous to reverse. A Write step needs
// `before`, what the file held when it ran.
function stepBefore(steps, now) {
  let text = now;
  for (const { name, input, before } of [...steps].reverse()) {
    if (typeof text !== "string") return undefined;
    if (name === "Write") {
      if (text !== input.content || before === undefined) return undefined;
      text = before;
      continue;
    }
    for (const e of [...(name === "MultiEdit" ? input.edits || [] : [input])].reverse()) {
      const n = e.new_string || "", at = text.indexOf(n);
      if (!n || at < 0 || (!e.replace_all && text.indexOf(n, at + 1) >= 0)) return undefined; // gone, or which copy was it?
      text = e.replace_all ? text.split(n).join(e.old_string) : text.slice(0, at) + e.old_string + text.slice(at + n.length);
    }
  }
  return text;
}

// One step's change in VS Code's diff editor. The current file with the step undone on the left, so later edits
// don't show as part of it; when the file has moved on too far for that, just the replaced and new text.
function showStepDiff(step) {
  const { name, input } = step;
  const file = input?.file_path;
  if (!file) return;
  const b = stepBefore([step], readText(file)), before = b === null ? "" : b ?? null; // a created file: empty on the left
  const doc = (side, text) => virtualDoc(file, side, text);
  const edits = name === "Write" ? [{ old_string: "", new_string: input.content }] : name === "MultiEdit" ? input.edits : [input];
  const [left, right] = before != null ? [doc("before", before), vscode.Uri.file(file)]
    : [doc("before", edits.map((e) => e.old_string).join("\n⋯\n")), doc("after", edits.map((e) => e.new_string).join("\n⋯\n"))];
  vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(file)} (Bitsmith edit)`, { preview: true });
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
  if (diff) return { type: "toolResult", id: b.tool_use_id, parent, ...resultInfo(tool.name, resultText(b), false), diff,
    rows: diffRows(tool.name, tool.input), edit: { name: tool.name, input: tool.input } }; // the change folds out; edit reopens it in VS Code
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
// A resumed session only loads messages after its last compaction, so --resume-session-at can't reach a message before
// one ("No message found with message.uuid"). Copy the transcript up to that message into a new session and resume that.
function cutBeforeCompaction(dir, sessionId, uuid) {
  const file = path.join(dir, sessionId + ".jsonl");
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }
  const at = lines.findIndex((l) => l.includes(uuid) && (() => { try { return JSON.parse(l).uuid === uuid; } catch { return false; } })());
  if (at < 0 || !lines.slice(at + 1).some((l) => l.includes('"compact_boundary"'))) return null;
  const id = require("crypto").randomUUID();
  const kept = lines.slice(0, at + 1).map((l) => { try { const e = JSON.parse(l); if (e.sessionId) e.sessionId = id; return JSON.stringify(e); } catch { return l; } });
  fs.writeFileSync(path.join(dir, id + ".jsonl"), kept.join("\n") + "\n");
  return id;
}

function compactText(pre, post, trigger) {
  const what = trigger === "auto" ? "Conversation auto-compacted" : "Conversation compacted";
  return pre ? `${what} · ${kTokens(pre)} → ${kTokens(post)} tokens` : what;
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
    case "Grep": return { ...base, searchPath: input.path, icon: "search", title: "Searched for", detail: `"${short(input.pattern, 60)}"${input.path ? ` in ${rel(input.path)}` : ""}` };
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
    case "EnterPlanMode": return { ...base, icon: "list-ordered", title: "Planning first", detail: "" };
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

// One chat can span several session files: Retry, Restore and Edit fork a copy (same first prompt), and a chat
// continued after compaction starts a new file whose summary names the previous one ("…transcript at: <id>.jsonl").
// Given newest first, keeps only the newest file of each chat. A file with the same first prompt is only a copy if it
// stopped changing before a newer one was created (the chat moved on to the fork); two branches both still written
// after the split, like the same conversation carried on in the terminal and in Bitsmith, are both kept.
// `moved` gets each dropped id -> the newer file that replaced it, so a pin can follow the chat.
// ponytail: only the first 64 KB is read, so a first prompt longer than that (a pasted image) isn't matched.
function latestCopies(list, moved = new Map()) {
  const firstPrompt = (file) => { try { return readLines(file, 0, 65536).map(parse).find((e) => e && ((e.isCompactSummary && typeof e.message?.content === "string") || userText(e))); } catch {} };
  const withFirst = list.map((s) => [s, firstPrompt(s.file)]);
  const older = new Map(); // id -> the newest file whose compaction summary names it
  for (const [s, f] of withFirst) {
    const old = f?.isCompactSummary && f.message.content.match(/transcript at: \S*?([0-9a-f-]{36})\.jsonl/)?.[1];
    if (old && !older.has(old)) older.set(old, s.id);
  }
  const born = new Map(); // first prompt -> the newer files' ids and creation times (0: the filesystem has none, so any is a copy)
  return withFirst.filter(([s, f]) => {
    const newer = born.get(f?.uuid) || [];
    const by = older.get(s.id) || newer.find((n) => !n.born || n.born >= s.time - 5000)?.id;
    if (f?.uuid) born.set(f.uuid, [...newer, { id: s.id, born: s.born || 0 }]);
    if (by) moved.set(s.id, by);
    return !by;
  }).map(([s]) => s);
}

// Claude Code's session lists hide a file whose first entry says "sdk-cli". A chat that moved to a new file (a fork,
// a compaction) hides its old copy there too, as latestCopies does here. The mtime is kept: latestCopies relies on it.
function setEntrypoint(file, to) {
  try {
    const st = fs.statSync(file), text = fs.readFileSync(file, "utf8");
    const out = text.replace(/"entrypoint":"(bitsmith|sdk-cli)"/, `"entrypoint":"${to}"`);
    if (out === text) return;
    fs.writeFileSync(file, out);
    fs.utimesSync(file, st.atime, st.mtime);
  } catch {}
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

// The last thing the user typed in a chat, from the end of its file ("" if none there).
function lastPrompt(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return ""; }
  const t = readLines(file, Math.max(0, size - 65536), 65536).map(parse).filter(Boolean).map(userText).filter(Boolean).pop();
  return t ? parseUserText(t).text.replace(/\s+/g, " ").trim().slice(0, 60) : "";
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
  let todos = [];
  for (const e of withHistory(file, activeBranch(all))) {
    if (e.isSidechain) continue;
    const note = taskNotification(e);
    if (note) { items.push(note); continue; }
    if (e.type === "system" && e.subtype === "compact_boundary") { items.push({ type: "notice", icon: "fold", text: compactText(e.compactMetadata?.preTokens, e.compactMetadata?.postTokens, e.compactMetadata?.trigger) }); continue; }
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
        if (!tool) continue;
        if (HIDDEN_TOOLS.has(tool.name)) { // only task tools get here: they rebuild the Todos panel
          todos = applyTask(todos, tool, b);
          items.push({ type: "todos", todos });
          continue;
        }
        const it = { ...resultItem(tool, b), at: Date.parse(e.timestamp) || undefined };
        if (tool.name === "Write" && it.edit && e.toolUseResult && "originalFile" in e.toolUseResult) it.before = e.toolUseResult.originalFile ?? null; // for undoing just this step
        items.push(it);
      }
    } else if (e.type === "assistant") {
      if (e.uuid) { lastUuid = e.uuid; userCount = 0; }
      for (const b of e.message?.content || []) {
        if (b.type === "text") items.push({ type: "textStart" }, { type: "text", text: b.text });
        if (b.type === "tool_use" && /^Task(Create|Update)$/.test(b.name)) tools.set(b.id, b);
        if (b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
          tools.set(b.id, b);
          if (b.name === "TodoWrite") items.push({ type: "todos", todos: b.input?.todos || [] });
          items.push({ type: "tool", id: b.id, at: Date.parse(e.timestamp) || undefined, ...describeTool(b.name, b.input, rel) });
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
        items.push({ type: "tool", id: b.id, parent, at: Date.parse(e.timestamp) || undefined, ...describeTool(b.name, b.input, rel) });
        if (subs.has(b.id)) items.push(...subagentItems(subs, b.id, rel));
      }
      const tool = e.type === "user" && b.type === "tool_result" && tools.get(b.tool_use_id);
      if (tool) items.push({ ...resultItem(tool, b, parent), at: Date.parse(e.timestamp) || undefined });
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
  // Parallel tool calls chain their tool_use entries, but each result hangs off its own call, beside the chain.
  const isResult = (x) => x.type === "user" && Array.isArray(x.message?.content) && x.message.content.some((b) => b.type === "tool_result");
  return all.filter((x) => keep.has(x.uuid) || (keep.has(x.parentUuid) && isResult(x)));
}

// A fork of a compacted chat (a rewind, an edit, a background compaction) starts at the compaction: the CLI copies
// nothing before it. That history is still in the session it was forked from, which the compaction summary names.
function withHistory(file, branch, depth = 0) {
  const first = branch.find((e) => e.uuid);
  if (depth > 8 || first?.subtype !== "compact_boundary") return branch;
  const c = branch.find((e) => e.isCompactSummary)?.message?.content;
  const older = (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text || "").join("") : "").match(/read the full transcript at: (\S+?\.jsonl)/)?.[1];
  if (!older || path.resolve(older) === path.resolve(file)) return branch;
  let all;
  try { all = fs.readFileSync(older, "utf8").split("\n").map(parse).filter(Boolean); } catch { return branch; }
  const at = all.findIndex((e) => e.uuid === first.uuid);
  if (at < 0) return branch;
  const own = new Set(branch.map((e) => e.uuid));
  const before = activeBranch(all.slice(0, at)).filter((e) => !own.has(e.uuid)); // the messages the compaction kept are in both
  return [...withHistory(older, before, depth + 1), ...branch];
}

// Where the last `n` messages before `end` start, so a page always holds whole turns.
function pageStart(items, end, n) {
  let i = end;
  while (i > 0 && n > 0) if (items[--i].type === "user") n--;
  return n ? 0 : i;
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

function imageFile(mediaType, data) {
  const ext = (/^image\/(\w+)$/.exec(mediaType || "")?.[1] || "png").replace("jpeg", "jpg");
  const file = path.join(os.tmpdir(), "bitsmith-images", require("crypto").createHash("sha1").update(data).digest("hex").slice(0, 16) + "." + ext);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

function openImage(mediaType, data) {
  if (data) vscode.commands.executeCommand("vscode.open", vscode.Uri.file(imageFile(mediaType, data)), { preview: true });
}

// At a line, or with lines line..end selected (e.g. what a Read step read).
function openFile(file, line, end) {
  if (!file || !fs.existsSync(file)) return;
  if (fs.statSync(file).isDirectory()) return vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(file));
  const opts = { preview: true };
  if (line) opts.selection = new vscode.Range(line - 1, 0, end > line ? end - 1 : line - 1, 0); // a Read of offset 425, limit 25 says "425-450": lines 425..449
  vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), opts); // not showTextDocument: it refuses images and other binaries
}

function html(webview, root, chat, tab = false) {
  const nonce = require("crypto").randomUUID(); // unguessable, so a script tag can't be forged into the page
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(root, "media", f));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("vendor/codicon.css")}"><link rel="stylesheet" href="${uri("chat.css")}"></head>
<body data-chat="${chat}"${tab ? " data-tab" : ""}><div id="app"></div>
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

// @bitsmith in Copilot's chat panel, whose native input takes files dragged from the Explorer (webviews can't).
// Each conversation is a real Bitsmith chat: the same CLI process, session file and settings, also shown as a Bitsmith tab.
// Copilot keeps each turn's result, so the session id in it finds the chat again, even after a reload.
// ponytail: plan and question pickers, step diffs and Keep/Undo stay in the Bitsmith panel ("Open in Bitsmith").
function participant(provider) {
  if (!vscode.chat?.createChatParticipant) return [];
  const bySession = (id) => [...provider.chats.values()].find((c) => c.sessionId === id);
  const findChat = async (history) => {
    const id = history.findLast((t) => t.result?.metadata?.sessionId)?.result.metadata.sessionId;
    if (id && !bySession(id) && fs.existsSync(path.join(provider.sessionDir(), id + ".jsonl"))) await provider.openSession(id);
    let c = id && bySession(id);
    if (!c) { c = provider.createChat(); provider.post({ type: "openChat", chat: c.key }); }
    return c;
  };
  const attachments = async (refs) => { // dropped or #-mentioned files and folders, selections, pasted images
    const context = [], images = [];
    for (const { value: v } of refs) {
      try {
        if (v?.scheme === "file" && v.fsPath) {
          const st = await vscode.workspace.fs.stat(v);
          context.push({ kind: st.type & vscode.FileType.Directory ? "folder" : "file", file: v.fsPath, rel: provider.rel(v.fsPath) });
        } else if (v?.uri?.scheme === "file" && v.range) {
          const doc = await vscode.workspace.openTextDocument(v.uri);
          context.push({ kind: "selection", file: v.uri.fsPath, rel: provider.rel(v.uri.fsPath), start: v.range.start.line + 1, end: v.range.end.line + 1, text: doc.getText(v.range) });
        } else if (v?.mimeType?.startsWith("image/") && v.data) images.push({ mediaType: v.mimeType, data: Buffer.from(await v.data()).toString("base64") });
      } catch {}
    }
    return { context, images };
  };
  const handler = async (request, ctx, stream, token) => {
    const c = await findChat(ctx.history);
    const result = () => ({ metadata: { sessionId: c.sessionId } });
    const open = (title) => stream.button({ title, command: "bitsmith.showChat", arguments: [c.key] });
    if (c.busy) { stream.markdown("This chat is still replying. Wait for it, or follow it in Bitsmith.\n\n"); open("Open in Bitsmith"); return result(); }
    const { context, images } = await attachments(request.references || []);
    let wrote = false;
    const ask = (m) => {
      if (m.kind === "plan" || m.kind === "question") { stream.markdown(`\n\n**Claude needs your answer:** ${m.kind === "plan" ? "a plan to approve" : "a question"}.\n\n`); return open("Answer in Bitsmith"); }
      const detail = m.kind === "tool" && m.detail ? "\n~~~\n" + m.detail + "\n~~~\n" : "";
      stream.markdown(`\n\n**${m.kind === "edit" ? `${m.name} ${m.detail}?` : m.question}**${m.sub ? ` ${m.sub}` : ""}\n${detail}${m.risk ? `\n> ${m.risk}\n` : ""}\n`);
      for (const allow of [true, false]) stream.button({ title: allow ? "Allow" : "Deny", command: "bitsmith.participantAnswer", arguments: [c.key, m.id, allow] });
      if (m.kind === "edit") open("Review in Bitsmith");
    };
    let stop;
    await new Promise((resolve) => {
      c.tap = (m) => {
        if (m.type === "textStart") { if (wrote) stream.markdown("\n\n"); }
        else if (m.type === "text") { wrote = true; stream.markdown(m.text); }
        else if (m.type === "tool" && !m.parent) stream.progress(`${m.title} ${m.detail || ""}`.trim());
        else if (m.type === "todos") stream.progress(`Todos ${m.todos.filter((t) => t.status === "completed").length}/${m.todos.length}`);
        else if (m.type === "permission") ask(m);
        else if (m.type === "error") { stream.markdown(`\n\n> ⚠️ ${m.text}\n`); if (!c.busy) resolve(); } // a running turn still ends with "done"
        else if (m.type === "done") resolve();
      };
      stop = token.onCancellationRequested(() => { c.interrupt(); resolve(); });
      c.post({ type: "user", text: request.prompt, chips: context.map((i) => ({ ...i, range: i.kind === "selection" ? `${i.start}-${i.end}` : "" })) });
      c.post({ type: "autoTurn" }); // the Bitsmith tab shows the message and goes busy, as if typed there
      c.send({ text: request.prompt, context, images });
    });
    c.tap = null;
    stop?.dispose();
    stream.markdown("\n\n");
    open("Continue in Bitsmith");
    return result();
  };
  const p = vscode.chat.createChatParticipant("bitsmith.chat", handler);
  p.iconPath = vscode.Uri.joinPath(provider.context.extensionUri, "media", "logo.png");
  return [p,
    vscode.commands.registerCommand("bitsmith.participantAnswer", (key, id, allow) => {
      const c = provider.chats.get(key);
      if (!c?.pending.has(id)) return; // answered already, here or in the Bitsmith panel
      c.answer({ id, allow });
      c.post({ type: "answered", id, allow });
    }),
    vscode.commands.registerCommand("bitsmith.showChat", (key) => {
      const c = provider.chats.get(key);
      if (!c) return;
      if (c.panel) return c.panel.reveal();
      vscode.commands.executeCommand("bitsmith.chat.focus");
      provider.switchTo(c);
    }),
  ];
}

function activate(context) {
  migrateFromMyAgent(context);
  storageDir = context.globalStorageUri.fsPath;
  const provider = new ChatProvider(context);
  const tools = new ToolsPanel(provider, context.extensionUri, claudeBin);
  provider.tools = tools;
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
  const work = vscode.window.createStatusBarItem("bitsmith.work", vscode.StatusBarAlignment.Right, 101);
  work.name = "Bitsmith Activity";
  work.command = "bitsmith.showWorking";
  provider.workItem = work;
  context.subscriptions.push(work, vscode.commands.registerCommand("bitsmith.showWorking", () => provider.reveal(provider.workChat)));
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
    vscode.commands.registerCommand("bitsmith.manageTools", () => tools.open()),
    vscode.commands.registerCommand("bitsmith.exportChat", () => provider.exportChat(provider.current())),
    vscode.commands.registerCommand("bitsmith.openInEditor", () => provider.openInEditor()),
    vscode.commands.registerCommand("bitsmith.commitMessage", (repo) => provider.commitMessage(repo)),
    vscode.commands.registerCommand("bitsmith.renameChat", () => { const id = provider.current().sessionId; id ? provider.renameSession(id) : vscode.window.showInformationMessage("Send a message first; then the chat can be named."); }),
    vscode.commands.registerCommand("bitsmith.deleteChat", () => { const id = provider.current().sessionId; id ? provider.deleteSession(id) : vscode.window.showInformationMessage("This chat hasn't been saved yet."); }),
    vscode.commands.registerCommand("bitsmith.newChatInEditor", () => provider.openTab()),
    // The same session in the Claude Code CLI: run directly, no shell, so the id needs no quoting.
    vscode.commands.registerCommand("bitsmith.openInTerminal", () => {
      const c = provider.current();
      if (!c.sessionId) return vscode.window.showInformationMessage("Send a message first; then the chat can be opened in the terminal.");
      if (c.busy) return vscode.window.showWarningMessage("Stop the current reply first, so the terminal and Bitsmith don't both write to the chat.");
      vscode.window.createTerminal({ name: `Claude: ${c.title || "chat"}`, cwd: provider.folder || undefined, shellPath: claudeBin(), shellArgs: ["--resume", c.sessionId], iconPath: new vscode.ThemeIcon("terminal") }).show();
    }),
    vscode.window.registerWebviewPanelSerializer("bitsmith.chatTab", { deserializeWebviewPanel: async (panel, state) => {
      const id = state?.sessionId && fs.existsSync(path.join(provider.sessionDir(), state.sessionId + ".jsonl")) ? state.sessionId : null; // deleted meanwhile: an empty chat
      provider.openTab(id, panel);
    } }),
    vscode.commands.registerCommand("bitsmith.continueFromTerminal", () => provider.continueFromTerminal()),
    vscode.commands.registerCommand("bitsmith.addContext", () => provider.pickContext()),
    vscode.commands.registerCommand("bitsmith.addToChat", (uri, uris) => provider.addUris(uris?.length ? uris : uri ? [uri] : [])),
    vscode.commands.registerCommand("bitsmith.addSelection", () => provider.addSelection()),
    ...["explain", "fix", "tests"].map((k) => vscode.commands.registerCommand(`bitsmith.${k}`, (uri, diag) => provider.quickAction(k, uri?.scheme ? uri : null, diag))),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions: (doc, range, ctx) => ctx.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 3).map((d) => {
        const a = new vscode.CodeAction(`Fix with Bitsmith: ${d.message.split("\n")[0].slice(0, 60)}`, vscode.CodeActionKind.QuickFix);
        a.command = { title: "Fix with Bitsmith", command: "bitsmith.fix", arguments: [doc.uri, d] };
        a.diagnostics = [d];
        return a;
      }),
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand("bitsmith.showBrowser", () => {
      const live = [provider.active, ...provider.chats.values()].map((c) => c.claude?.browserState).filter((f) => f && fs.existsSync(f));
      live.length ? showBrowser(live[0]) : vscode.window.showInformationMessage("No chat has the browser open. Turn on Settings → Bitsmith → Browser and ask Claude to open a page.");
    }),
    vscode.commands.registerCommand("bitsmith.diffHead", () => provider.diffHead()),
    ...agentWatchers(provider),
    ...participant(provider),
    vscode.commands.registerCommand("bitsmith.keepAll", () => provider.edits.keep([...provider.current().touched])),
    vscode.commands.registerCommand("bitsmith.undoAll", () => provider.edits.undo([...provider.current().touched])),
    { dispose: () => provider.shutdown() },
  );
  return provider;
}

module.exports = { activate, applyEdit, replay, sessionTitle, describeTool, parseUserText, editStats, lastUsage, searchSessions, chatMarkdown, git, riskyEdit, diffRows, pageStart, stepBefore };
