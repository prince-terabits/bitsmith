// The MCP Servers & Skills panel (an editor tab). Data comes from the current chat's CLI process:
// mcp_status (servers, their tools and errors) and get_skills_dialog (skills, their state and token cost).
// Servers are added and removed with `claude mcp add-json/remove`, toggled with mcp_toggle, signed in with mcp_authenticate.
// Skill levels and MCP tool permissions live in the folder's .claude/settings.local.json (skillOverrides, permissions),
// which the CLI's update_settings won't write.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SCOPES = ["local", "project", "user"]; // the ones `claude mcp` can add to and remove from
const RULES = ["allow", "ask", "deny"];

// Tool names in permission rules use the server name with everything but letters, digits, _ and - turned into _.
const ruleName = (server, tool) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}${tool ? `__${tool}` : ""}`;

class ToolsPanel {
  constructor(provider, extensionUri, bin) {
    this.p = provider;
    this.uri = extensionUri;
    this.bin = bin;
    this.panel = null;
  }

  get folder() { return this.p.folder; }
  get settingsFile() { return path.join(this.folder, ".claude", "settings.local.json"); }
  cli() { return this.p.current().ensure(); }
  live() { return [...new Set([this.p.active, ...this.p.chats.values()])].map((c) => c?.claude).filter(Boolean); }
  post(m) { this.panel?.webview.postMessage(m); }

  open() {
    if (!this.folder) return vscode.window.showInformationMessage("Open a folder first.");
    if (this.panel) return this.panel.reveal();
    this.panel = vscode.window.createWebviewPanel("bitsmith.tools", "MCP & Skills", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.uri, "media")] });
    this.panel.iconPath = new vscode.ThemeIcon("plug");
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m) => this.handle(m).catch((e) => this.post({ type: "error", text: e.message })));
    this.panel.onDidDispose(() => { this.panel = null; });
  }

  async handle(m) {
    switch (m.type) {
      case "ready": case "refresh": return this.load();
      case "toggleServer":
        for (const cl of this.live()) await cl.request({ subtype: "mcp_toggle", serverName: m.name, enabled: m.enabled });
        return this.load();
      case "reconnect": {
        this.post({ type: "busy", on: true });
        const r = await this.cli().request({ subtype: "mcp_reconnect", serverName: m.name });
        if (r.subtype !== "success") this.post({ type: "error", text: `${m.name}: ${r.error || "couldn't reconnect"}` });
        return this.load();
      }
      case "signIn": return this.signIn(m.name);
      case "signOut": {
        const r = await this.cli().request({ subtype: "mcp_clear_auth", serverName: m.name });
        if (r.subtype !== "success") this.post({ type: "error", text: `${m.name}: ${r.error || "couldn't sign out"}` });
        else this.post({ type: "notice", text: `Signed out of ${m.name}.` });
        return this.load();
      }
      case "saveServer": return this.saveServer(m);
      case "removeServer": {
        const ok = await vscode.window.showWarningMessage(`Remove the MCP server "${m.name}" (${m.scope})?`, { modal: true }, "Remove");
        if (ok !== "Remove") return;
        await this.mcp(["remove", m.name, "-s", m.scope]);
        return this.reloadServers(`Removed ${m.name}.`);
      }
      case "setRule": this.setRule(m.rule, m.value); return this.load();
      case "setSkill": {
        this.editSettings((s) => {
          const o = s.skillOverrides = s.skillOverrides || {};
          if (m.state === "on") delete o[m.name]; else o[m.name] = m.state;
          if (!Object.keys(o).length) delete s.skillOverrides;
        });
        for (const cl of this.live()) await cl.request({ subtype: "reload_skills" });
        return this.load();
      }
      case "openSettings":
        if (!fs.existsSync(this.settingsFile)) this.editSettings(() => {}); // not made until the first rule: start it as {}
        return vscode.window.showTextDocument(vscode.Uri.file(this.settingsFile));
    }
  }

  async load() {
    const cl = this.cli();
    if (!cl) return this.post({ type: "error", text: "Open a folder first." });
    this.post({ type: "busy", on: true });
    const [mcp, sk] = await Promise.all([cl.request({ subtype: "mcp_status" }), cl.request({ subtype: "get_skills_dialog" })]);
    const perms = this.readSettings().permissions || {};
    this.post({
      type: "data",
      servers: (mcp.response?.mcpServers || []).map((s) => ({ ...s, rule: ruleName(s.name), editable: SCOPES.includes(s.scope) })),
      skills: sk.response?.skills || [],
      rules: Object.fromEntries(RULES.map((k) => [k, perms[k] || []])),
      settingsFile: this.settingsFile,
    });
  }

  // OAuth for an HTTP/SSE server: the CLI gives a URL to open; for a localhost redirect it catches the callback itself.
  async signIn(name) {
    this.post({ type: "busy", on: true });
    const r = await this.cli().request({ subtype: "mcp_authenticate", serverName: name });
    if (r.subtype !== "success") { this.post({ type: "error", text: `${name}: ${r.error || "couldn't start sign-in"}` }); return this.load(); }
    const { authUrl, callbackExpected, redirectScheme } = r.response || {};
    if (!authUrl) { this.post({ type: "notice", text: `${name} is signed in.` }); return this.load(); }
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    if (callbackExpected && redirectScheme !== "localhost") {
      const url = await vscode.window.showInputBox({ prompt: `Signing in to ${name}: paste the address the browser ended on`, ignoreFocusOut: true });
      if (url) {
        const c = await this.cli().request({ subtype: "mcp_oauth_callback_url", serverName: name, callbackUrl: url });
        if (c.subtype !== "success") this.post({ type: "error", text: `${name}: ${c.error || "sign-in failed"}` });
      }
    } else this.post({ type: "notice", text: `Finish signing in to ${name} in the browser, then press Refresh.` });
    return this.load();
  }

  // Add, or edit (remove the old entry, add the new one, put the old one back if that fails).
  async saveServer({ name, scope, config, old }) {
    if (!/^[\w.-]+$/.test(name || "")) return this.post({ type: "error", text: "Name: letters, digits, '.', '_' and '-' only." });
    if (!SCOPES.includes(scope)) return this.post({ type: "error", text: "Pick a scope." });
    this.post({ type: "busy", on: true });
    if (old) await this.mcp(["remove", old.name, "-s", old.scope]);
    try {
      await this.mcp(["add-json", name, JSON.stringify(config), "-s", scope]);
    } catch (e) {
      if (old) await this.mcp(["add-json", old.name, JSON.stringify(old.config), "-s", old.scope]).catch(() => {});
      throw e;
    }
    this.post({ type: "saved" });
    return this.reloadServers(`${old ? "Saved" : "Added"} ${name}.`);
  }

  // New or removed servers only load when the CLI starts: restart every chat that isn't in the middle of something.
  async reloadServers(notice) {
    let waiting = 0;
    for (const c of new Set([this.p.active, ...this.p.chats.values()])) {
      if (!c?.claude) continue;
      if (c.busy || c.pending.size || c.tasks.length) waiting++;
      else c.restart();
    }
    this.post({ type: "notice", text: notice + (waiting ? ` ${waiting} busy chat${waiting > 1 ? "s" : ""} will pick it up when restarted.` : "") });
    return this.load();
  }

  mcp(args) {
    return new Promise((res, rej) => execFile(this.bin(), ["mcp", ...args], { cwd: this.folder, timeout: 60000 },
      (err, out, errOut) => (err ? rej(new Error((errOut || out || err.message).trim())) : res(out))));
  }

  // One rule per tool (or for the whole server): drop it from every list, then add it to the chosen one.
  setRule(rule, value) {
    this.editSettings((s) => {
      const p = s.permissions = s.permissions || {};
      for (const k of RULES) if (p[k]) p[k] = p[k].filter((r) => r !== rule && r !== `${rule}__*`);
      if (RULES.includes(value)) (p[value] = p[value] || []).push(rule);
    });
  }

  readSettings() {
    if (!fs.existsSync(this.settingsFile)) return {};
    try { return JSON.parse(fs.readFileSync(this.settingsFile, "utf8")); }
    catch { throw new Error(`${this.settingsFile} isn't valid JSON, so Bitsmith left it alone. Fix it and press Refresh.`); }
  }

  editSettings(change) {
    const s = this.readSettings();
    change(s);
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(s, null, 2) + "\n");
  }

  html(webview) {
    const nonce = require("crypto").randomUUID();
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.uri, "media", f));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("vendor/codicon.css")}"><link rel="stylesheet" href="${uri("tools.css")}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${uri("tools.js")}"></script></body></html>`;
  }
}

module.exports = { ToolsPanel, ruleName };
