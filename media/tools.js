// MCP & Skills panel. All state comes from the extension ("data"); every change goes back as a message.
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}
const icon = (n) => h("i", { class: `codicon codicon-${n}` });
const button = (label, onclick, opts = {}) => h("button", { class: opts.primary ? "primary" : opts.icon && !label ? "icon" : "", title: opts.title, "aria-label": opts.title || label, onclick }, opts.icon && icon(opts.icon), label);
const select = (value, options, onchange, title) => h("select", { title, "aria-label": title, onchange: (e) => onchange(e.target.value) },
  options.map(([v, l]) => { const o = h("option", { value: v }, l); o.selected = v === value; return o; }));

const S = { data: null, tab: "mcp", open: new Set(), form: null, filter: "", busy: true, msg: null };

const STATUS = { connected: ["pass-filled", "ok"], pending: ["loading", "muted"], failed: ["error", "bad"], "needs-auth": ["key", "warn"], disabled: ["circle-slash", "muted"] };
const SKILL_STATES = [["on", "On"], ["name-only", "Name only"], ["user-invocable-only", "Only when I type /name"], ["off", "Off"]];
const RULE_CHOICES = [["", "Default (ask)"], ["allow", "Allow"], ["ask", "Always ask"], ["deny", "Block"]];

// The rule that decides a tool: its own entry, else the whole server's. Block beats ask beats allow, like the CLI.
function ruleFor(name) {
  const r = S.data.rules;
  for (const k of ["deny", "ask", "allow"]) if (r[k].includes(name) || r[k].includes(name + "__*")) return k;
  return "";
}

// Listing a skill costs its tokens in every chat; name-only costs about its name; the rest cost nothing.
const skillCost = (s) => (s.state === "on" ? s.tokens || 0 : s.state === "name-only" ? Math.ceil(s.name.length / 4) + 3 : 0);

function render() {
  const app = document.getElementById("app");
  if (!S.data) return app.replaceChildren(h("div", { class: "empty" }, S.msg ? message() : [icon("loading"), " Loading MCP servers and skills…"]));
  const tabs = h("div", { class: "tabs", role: "tablist" },
    [["mcp", "server", `MCP servers (${S.data.servers.length})`], ["skills", "sparkle", `Skills (${S.data.skills.length})`]].map(([k, i, l]) =>
      h("button", { role: "tab", "aria-selected": String(S.tab === k), class: S.tab === k ? "tab on" : "tab", onclick: () => { S.tab = k; render(); } }, icon(i), l)),
    h("span", { class: "grow" }),
    S.busy && h("span", { class: "muted" }, icon("loading"), " working…"),
    button("", () => send({ type: "refresh" }), { icon: "refresh", title: "Refresh" }));
  app.replaceChildren(...[tabs, message(), S.tab === "mcp" ? mcpTab() : skillsTab()].filter(Boolean));
}

function message() {
  if (!S.msg) return null;
  return h("div", { class: `msg ${S.msg.kind}` }, icon(S.msg.kind === "error" ? "error" : "info"), h("span", { class: "grow" }, S.msg.text),
    button("", () => { S.msg = null; render(); }, { icon: "close", title: "Dismiss" }));
}

// ---------- MCP ----------
function mcpTab() {
  const { servers } = S.data;
  const ok = servers.filter((s) => s.status === "connected").length;
  return h("div", {},
    h("div", { class: "bar" }, h("span", { class: "muted grow" }, `${ok} of ${servers.length} connected`),
      button("Permissions file", () => send({ type: "openSettings" }), { icon: "go-to-file", title: "Open the folder's .claude/settings.local.json" }),
      !S.form && button("Add server", () => { S.form = { type: "stdio", scope: "local" }; render(); }, { icon: "add", primary: true })),
    S.form && serverForm(),
    servers.length ? servers.map(serverRow) : h("div", { class: "empty muted" }, "No MCP servers yet. Add one to give Claude new tools."));
}

function serverRow(s) {
  const [ic, cls] = STATUS[s.status] || ["question", "muted"];
  const open = S.open.has(s.name);
  const t = s.config?.type || "stdio";
  const oauth = t === "http" || t === "sse";
  const tools = s.tools || [];
  return h("div", { class: `card ${s.status}` },
    h("div", { class: "row" },
      button("", () => { open ? S.open.delete(s.name) : S.open.add(s.name); render(); }, { icon: open ? "chevron-down" : "chevron-right", title: open ? "Hide tools" : "Show tools and permissions" }),
      h("span", { class: `status ${cls}`, title: s.status }, icon(ic)),
      h("div", { class: "grow" }, h("b", {}, s.name), h("div", { class: "muted small" }, [s.status, s.scope || s.source, t, tools.length ? `${tools.length} tools` : null, s.serverInfo ? `v${s.serverInfo.version}` : null].filter(Boolean).join(" · "))),
      s.status === "needs-auth" && button("Sign in", () => send({ type: "signIn", name: s.name }), { icon: "sign-in", primary: true }),
      oauth && s.status === "connected" && button("", () => send({ type: "signOut", name: s.name }), { icon: "sign-out", title: "Sign out (clear the saved login)" }),
      (s.status === "failed" || s.status === "needs-auth") && button("", () => send({ type: "reconnect", name: s.name }), { icon: "debug-restart", title: "Retry the connection" }),
      s.editable && button("", () => { S.form = formFrom(s); render(); window.scrollTo(0, 0); }, { icon: "edit", title: "Edit" }),
      s.editable && button("", () => send({ type: "removeServer", name: s.name, scope: s.scope }), { icon: "trash", title: "Remove" }),
      h("label", { class: "switch", title: s.status === "disabled" ? "Turn on" : "Turn off" },
        h("input", { type: "checkbox", "aria-label": `${s.name} on`, onchange: (e) => send({ type: "toggleServer", name: s.name, enabled: e.target.checked }), ...(s.status !== "disabled" ? { checked: true } : {}) }), h("span", {}))),
    s.status === "failed" && h("div", { class: "error" }, icon("warning"), h("div", {}, h("b", {}, "Couldn't connect. "), s.error || "No error message from the server.",
      h("div", { class: "muted small" }, hint(s)))),
    s.status === "needs-auth" && h("div", { class: "warn-box" }, icon("key"), "This server needs you to sign in before Claude can use it."),
    open && toolsList(s, tools));
}

// What usually fixes a failed server, from its config and error.
function hint(s) {
  const e = (s.error || "").toLowerCase(), c = s.config || {};
  if (s.error_code === "APPROVAL_REQUIRED") return "This project's .mcp.json server is waiting for approval: run `claude` in a terminal here once and approve it.";
  if (/enoent|not found|no such file/.test(e)) return `"${c.command}" isn't installed or isn't on PATH. Install it, or edit the server to use its full path.`;
  if (/401|403|unauthori|forbidden/.test(e)) return "The server refused the credentials: check the token or headers, or sign in again.";
  if (/timeout|timed out/.test(e)) return "The server didn't answer in time: check that it starts on its own (run its command in a terminal).";
  if (/econnrefused|fetch failed|getaddrinfo/.test(e)) return `Nothing answered at ${c.url || "the server's address"}: is it running, and is the URL right?`;
  return "Edit the server to fix its settings, then Retry.";
}

function toolsList(s, tools) {
  const all = s.rule;
  return h("div", { class: "tools" },
    h("div", { class: "tool all" }, h("div", { class: "grow" }, h("b", {}, "All tools of this server"), h("div", { class: "muted small" }, "A rule for one tool below beats this one.")),
      select(ruleFor(all), RULE_CHOICES, (v) => send({ type: "setRule", rule: all, value: v }), "Permission for all tools")),
    !tools.length && h("div", { class: "muted small pad" }, s.status === "connected" ? "This server has no tools." : "Tools show once the server is connected."),
    tools.map((t) => {
      const name = `${all}__${t.name}`;
      const own = ["deny", "ask", "allow"].find((k) => S.data.rules[k].includes(name)) || "";
      const a = t.annotations || {};
      return h("div", { class: "tool" },
        h("div", { class: "grow" }, h("code", {}, t.name),
          a.readOnly && h("span", { class: "tag ok" }, "read-only"), a.destructive && h("span", { class: "tag bad" }, "destructive"),
          t.description && h("div", { class: "muted small clamp", title: t.description }, t.description)),
        select(own, own ? RULE_CHOICES : [["", `Like the server (${(RULE_CHOICES.find(([v]) => v === ruleFor(all)) || RULE_CHOICES[0])[1].replace(" (ask)", "")})`], ...RULE_CHOICES.slice(1)],
          (v) => send({ type: "setRule", rule: name, value: v }), `Permission for ${t.name}`));
    }));
}

// ---------- add / edit form ----------
const lines = (t) => (t || "").split("\n").map((l) => l.trim()).filter(Boolean);
function formFrom(s) {
  const c = s.config || {};
  return {
    old: { name: s.name, scope: s.scope, config: c }, name: s.name, scope: s.scope, type: c.type || "stdio",
    command: c.command || "", args: (c.args || []).join("\n"), env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join("\n"),
    url: c.url || "", headers: Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
}

function serverForm() {
  const f = S.form;
  const field = (label, key, opts = {}) => h("label", { class: "field" }, h("span", {}, label),
    h(opts.area ? "textarea" : "input", { value: f[key] || "", placeholder: opts.placeholder || "", rows: opts.area ? 3 : null, spellcheck: "false", oninput: (e) => { f[key] = e.target.value; } }),
    opts.help && h("span", { class: "muted small" }, opts.help));
  const stdio = f.type === "stdio";
  const save = () => {
    const config = stdio
      ? { type: "stdio", command: (f.command || "").trim(), args: lines(f.args), env: Object.fromEntries(lines(f.env).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]).filter(([k]) => k)) }
      : { type: f.type, url: (f.url || "").trim(), headers: Object.fromEntries(lines(f.headers).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]).filter(([k]) => k)) };
    if (stdio && !config.command) return flash("error", "Command is required.");
    if (!stdio && !/^https?:\/\//.test(config.url)) return flash("error", "URL must start with http:// or https://");
    if (stdio && !Object.keys(config.env).length) delete config.env;
    if (!stdio && !Object.keys(config.headers).length) delete config.headers;
    send({ type: "saveServer", name: (f.name || "").trim(), scope: f.scope, config, old: f.old });
  };
  return h("div", { class: "card form" },
    h("b", {}, f.old ? `Edit ${f.old.name}` : "Add an MCP server"),
    h("div", { class: "grid" },
      field("Name", "name", { placeholder: "e.g. odoo-local" }),
      h("label", { class: "field" }, h("span", {}, "Type"), select(f.type, [["stdio", "Command (stdio)"], ["http", "HTTP"], ["sse", "SSE"]], (v) => { f.type = v; render(); }, "Type")),
      h("label", { class: "field" }, h("span", {}, "Saved for"), select(f.scope, [["local", "Just me, this folder"], ["project", "Everyone, this folder (.mcp.json)"], ["user", "Just me, every folder"]], (v) => { f.scope = v; }, "Scope"))),
    stdio ? [field("Command", "command", { placeholder: "uvx, npx, /path/to/server" }),
      field("Arguments", "args", { area: true, placeholder: "one per line\nmcp-server-odoo", help: "One argument per line." }),
      field("Environment", "env", { area: true, placeholder: "ODOO_URL=http://localhost:8019\nODOO_API_KEY=…", help: "KEY=value, one per line." })]
      : [field("URL", "url", { placeholder: "https://example.com/mcp" }),
        field("Headers", "headers", { area: true, placeholder: "Authorization: Bearer …", help: "Name: value, one per line. Leave empty if the server uses sign-in (OAuth)." })],
    h("div", { class: "bar" }, h("span", { class: "grow" }), button("Cancel", () => { S.form = null; render(); }), button(f.old ? "Save" : "Add server", save, { primary: true, icon: "check" })));
}

// ---------- skills ----------
function skillsTab() {
  const skills = S.data.skills;
  const now = skills.reduce((n, s) => n + skillCost(s), 0);
  const full = skills.reduce((n, s) => n + (s.tokens || 0), 0);
  const q = S.filter.toLowerCase();
  const shown = skills.filter((s) => !q || `${s.name} ${s.display_name} ${s.description} ${s.source}`.toLowerCase().includes(q));
  return h("div", {},
    h("div", { class: "budget" },
      h("div", { class: "grow" }, h("b", {}, `~${now.toLocaleString()} tokens`), " of every chat go to listing skills",
        h("div", { class: "muted small" }, now < full ? `Saving ~${(full - now).toLocaleString()} of ${full.toLocaleString()} tokens. ` : "", "\"Name only\" keeps a skill usable for less; \"Only when I type /name\" hides it from Claude until you call it.")),
      meter(full ? now / full : 0, `${now} of ${full} tokens`)),
    h("input", { class: "search", type: "search", placeholder: "Filter skills", value: S.filter, oninput: (e) => { S.filter = e.target.value; const pos = e.target.selectionStart; render(); const el = document.querySelector(".search"); el.focus(); el.setSelectionRange(pos, pos); } }),
    shown.map((s) => h("div", { class: `card skill ${s.state}` },
      h("div", { class: "row" },
        h("div", { class: "grow" }, h("b", {}, s.display_name || s.name),
          h("div", { class: "muted small" }, [s.source, `${s.tokens || 0} tokens`, s.state !== "on" && s.state !== "off" ? `now ~${skillCost(s)}` : null].filter(Boolean).join(" · ")),
          s.description && h("div", { class: "small clamp", title: s.description }, s.description)),
        select(s.state, SKILL_STATES, (v) => send({ type: "setSkill", name: s.name, state: v }), `${s.name} level`)))),
    !shown.length && h("div", { class: "empty muted" }, "No skills match."));
}

function meter(part, title) {
  const fill = h("span", { class: "fill" });
  fill.style.width = `${Math.round(part * 100)}%`; // the CSP blocks style attributes, not CSSOM
  return h("div", { class: "meter", title }, fill);
}

function flash(kind, text) { S.msg = { kind, text }; render(); }

window.addEventListener("message", ({ data: m }) => {
  switch (m.type) {
    case "data": S.data = m; S.busy = false; break;
    case "busy": S.busy = m.on; break;
    case "error": S.busy = false; S.msg = { kind: "error", text: m.text }; break;
    case "notice": S.msg = { kind: "info", text: m.text }; break;
    case "saved": S.form = null; break;
  }
  render();
});
render();
send({ type: "ready" });
