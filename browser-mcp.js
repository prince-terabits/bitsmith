// Bitsmith browser tools: a tiny MCP server (JSON-RPC, one message per line on stdin/stdout) that drives
// its own Chrome over the DevTools protocol. Claude Code starts it from --mcp-config; it needs Node 22+
// (global WebSocket), which is why Bitsmith runs it with VS Code's own runtime.
// Env: BITSMITH_BROWSER=window|headless, BITSMITH_CHROME=/path/to/chrome (optional).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const headless = process.env.BITSMITH_BROWSER === "headless";
let chrome = null, profile = null, ws = null, seq = 0, loaded = null;
const waiting = new Map(), logs = [];

function findChrome() {
  if (process.env.BITSMITH_CHROME) return process.env.BITSMITH_CHROME;
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  throw new Error("Chrome not found. Install Chrome or Chromium, or set BITSMITH_CHROME.");
}

// VS Code's snap points GTK/GIO/locale at its own libraries; a system Chrome crashes or warns with them.
// Undo it like VS Code does for its terminals: restore each *_VSCODE_SNAP_ORIG value and drop the snap-only paths.
// On Wayland, Chrome's window also has to go through X11 (--ozone-platform=x11): its Wayland path aborts in Qt here.
function hostEnv() {
  const env = { ...process.env };
  if (!env.SNAP) return env;
  for (const k of Object.keys(env)) if (k.endsWith("_VSCODE_SNAP_ORIG")) {
    const name = k.slice(0, -"_VSCODE_SNAP_ORIG".length);
    if (env[k]) env[name] = env[k]; else delete env[name];
    delete env[k];
  }
  for (const k of ["GTK_PATH", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE", "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR", "GIO_MODULE_DIR", "LOCPATH", "GDK_BACKEND"])
    if (env[k]?.includes("/snap/")) delete env[k];
  return env;
}

// ponytail: a fresh throwaway profile per server (Chrome locks a profile to one instance), so logins don't persist between chats
async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "bitsmith-browser-"));
  const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,800", ...(headless ? ["--headless=new"] : process.env.DISPLAY ? ["--ozone-platform=x11"] : []), "about:blank"];
  chrome = spawn(findChrome(), args, { stdio: ["ignore", "ignore", "pipe"], env: hostEnv() });
  const port = await new Promise((resolve, reject) => {
    let err = "";
    const fail = (why) => { clearTimeout(timer); try { chrome.kill(); } catch {} fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); reject(new Error(`Chrome did not start (${why}): ${err.trim().split("\n").slice(-6).join("\n")}`)); };
    const timer = setTimeout(() => fail("no answer in 20 s"), 20000);
    chrome.on("error", (e) => fail(e.message));
    chrome.on("exit", (code) => fail(`exit ${code}`)); // ignored once resolved
    chrome.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  chrome.on("exit", () => { chrome = null; ws = null; }); // closed by hand: the next call starts a new one
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Could not connect to Chrome")); });
  ws.onclose = () => { ws = null; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
    const p = m.params;
    if (m.method === "Page.loadEventFired") loaded?.();
    else if (m.method === "Runtime.consoleAPICalled") log(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
    else if (m.method === "Runtime.exceptionThrown") log(`uncaught: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    else if (m.method === "Log.entryAdded") log(`${p.entry.level} (${p.entry.source}): ${p.entry.text}${p.entry.url ? " " + p.entry.url : ""}`);
  };
  for (const d of ["Page.enable", "Runtime.enable", "Log.enable"]) await send(d);
}

function log(s) { logs.push(s.slice(0, 500)); if (logs.length > 200) logs.shift(); }

async function cdp(method, params) {
  if (!ws) await launch();
  return send(method, params);
}
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result))));
}

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// Wait until the page has loaded and the DOM has been quiet for a moment (single-page apps keep rendering after load).
const QUIET = `new Promise((done) => { let t = setTimeout(fin, 400); const end = setTimeout(fin, 4000);
  const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, 400); });
  function fin() { o.disconnect(); clearTimeout(end); done(true); }
  o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); })`;
async function settle(navigating) {
  if (navigating) await Promise.race([navigating, new Promise((r) => setTimeout(r, 15000))]);
  for (let i = 0; i < 3; i++) {
    try { await evaluate(`document.readyState === "complete" || new Promise((r) => addEventListener("load", r, { once: true }))`); return await evaluate(QUIET); }
    catch { await new Promise((r) => setTimeout(r, 500)); } // the page navigated mid-check: try the new one
  }
}

// What Claude "sees": numbered interactive elements plus the visible text. Refs are stamped on the elements.
const SNAPSHOT = `(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; };
  const clean = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  document.querySelectorAll("[data-bs-ref]").forEach((e) => e.removeAttribute("data-bs-ref"));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=switch], [contenteditable=""], [contenteditable=true], [onclick]';
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!seen(el) || n >= 300) continue;
    el.setAttribute("data-bs-ref", ++n);
    const tag = el.tagName.toLowerCase(), role = el.getAttribute("role") || (tag === "a" ? "link" : tag);
    const type = tag === "input" ? " " + (el.type || "text") : "";
    const label = el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.innerText || el.placeholder || el.title || el.name || el.alt || "";
    let extra = "";
    if (tag === "input" || tag === "textarea") extra = el.type === "password" ? (el.value ? " (filled)" : "") : el.value && el.type !== "checkbox" && el.type !== "radio" ? " value=" + JSON.stringify(clean(el.value, 60)) : "";
    if (tag === "select") extra = " value=" + JSON.stringify(clean(el.selectedOptions[0]?.text, 60)) + " options=" + JSON.stringify([...el.options].slice(0, 20).map((o) => clean(o.text, 30)));
    if (tag === "a") extra += " -> " + clean(el.getAttribute("href"), 80);
    out.push("[" + n + "] " + role + type + " " + JSON.stringify(clean(label, 80)) + extra + (el.checked ? " checked" : "") + (el.disabled ? " disabled" : ""));
  }
  const text = (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 8000);
  return "URL: " + location.href + "\\nTitle: " + document.title + "\\n\\nElements:\\n" + (out.join("\\n") || "(none)") + "\\n\\nText:\\n" + text;
})()`;
const snapshot = () => evaluate(SNAPSHOT);

function refOf(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) throw new Error("ref must be an element number from browser_snapshot");
  return n;
}
// Scroll the element into view and return its centre, for real mouse input (synthetic .click() misses many frameworks).
async function centre(ref) {
  const p = await evaluate(`(() => { const el = document.querySelector('[data-bs-ref="${refOf(ref)}"]'); if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!p) throw new Error(`No element [${ref}] on the page now. Take a new browser_snapshot; refs change when the page changes.`);
  return p;
}
async function click({ x, y }) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

const KEYS = { Enter: [13, "\r"], Tab: [9, ""], Escape: [27, ""], Backspace: [8, ""], Delete: [46, ""], ArrowUp: [38, ""], ArrowDown: [40, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""], PageUp: [33, ""], PageDown: [34, ""], Home: [36, ""], End: [35, ""], Space: [32, " "] };
async function press(key) {
  const k = KEYS[key];
  if (!k) throw new Error(`Unknown key ${key}. Use one of: ${Object.keys(KEYS).join(", ")}`);
  const base = { key: key === "Space" ? " " : key, code: key, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k[1] ? { text: k[1] } : {}) });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const afterAction = async () => { await new Promise((r) => setTimeout(r, 150)); await settle(); return text(await snapshot()); };

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const tools = {
  browser_open: {
    description: "Open a URL in Bitsmith's browser and return a snapshot of the page (numbered elements and visible text).",
    props: { url: str("Full URL, e.g. http://localhost:8069/web") }, required: ["url"],
    run: async ({ url }) => {
      if (!/^(https?|file):/i.test(url) && url !== "about:blank") url = "http://" + url;
      if (!ws) await launch();
      const navigating = new Promise((r) => (loaded = r));
      const r = await send("Page.navigate", { url });
      if (r.errorText) throw new Error(`Could not open ${url}: ${r.errorText}`);
      await settle(navigating);
      return text(await snapshot());
    },
  },
  browser_snapshot: { description: "Snapshot the current page: numbered interactive elements [ref] and the visible text. Use refs with browser_click and browser_type.", props: {}, run: async () => text(await snapshot()) },
  browser_click: {
    description: "Click element [ref] from the latest snapshot. Returns the page snapshot afterwards.",
    props: { ref: num("Element number from browser_snapshot") }, required: ["ref"],
    run: async ({ ref }) => { await click(await centre(ref)); return afterAction(); },
  },
  browser_type: {
    description: "Replace the text in field [ref] (or choose an option in a <select> by its text). submit=true presses Enter afterwards.",
    props: { ref: num("Element number from browser_snapshot"), text: str("Text to type, or the option to choose"), submit: { type: "boolean", description: "Press Enter after typing" } },
    required: ["ref", "text"],
    run: async ({ ref, text: value, submit }) => {
      const r = refOf(ref);
      const isSelect = await evaluate(`(() => { const el = document.querySelector('[data-bs-ref="${r}"]'); if (!el) return null;
        if (el.tagName !== "SELECT") return false;
        const want = ${JSON.stringify(String(value))}.toLowerCase(), o = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
        if (!o) throw new Error("No option " + JSON.stringify(want) + ". Options: " + [...el.options].map((o) => o.text.trim()).join(", "));
        el.value = o.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
      if (isSelect === null) throw new Error(`No element [${ref}] on the page now. Take a new browser_snapshot.`);
      if (!isSelect) {
        await click(await centre(r));
        await evaluate(`(() => { const el = document.querySelector('[data-bs-ref="${r}"]'); el.focus(); if (typeof el.select === "function") el.select(); else document.execCommand("selectAll"); })()`);
        if (value === "") await press("Delete");
        else await cdp("Input.insertText", { text: String(value) });
      }
      if (submit) await press("Enter");
      return afterAction();
    },
  },
  browser_press: {
    description: "Press a key on the focused element: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End.",
    props: { key: str("Key name") }, required: ["key"],
    run: async ({ key }) => { await press(key); return afterAction(); },
  },
  browser_screenshot: {
    description: "Screenshot what is visible in the browser now. Use when layout or visuals matter; browser_snapshot is cheaper for reading the page.",
    props: { full_page: { type: "boolean", description: "Capture the whole page, not just the visible part" } },
    run: async ({ full_page }) => {
      const r = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: !!full_page });
      return { content: [{ type: "image", mimeType: "image/jpeg", data: r.data }] };
    },
  },
  browser_console: {
    description: "Console messages, uncaught errors and failed requests since the last call (then cleared).",
    props: {}, run: async () => { if (!ws) await launch(); return text(logs.splice(0).join("\n") || "(no messages)"); },
  },
};

// Stop Chrome, then delete its throwaway profile once it has let go of the files.
function quit() {
  const done = () => { try { if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} process.exit(0); };
  if (!chrome) return done();
  chrome.once("exit", done);
  chrome.kill();
  setTimeout(done, 3000);
}
process.on("exit", () => { try { chrome?.kill(); } catch {} });
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, quit);

const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications need no answer
  if (method === "initialize") return reply(id, { result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bitsmith-browser", version: "1.0.0" } } });
  if (method === "ping") return reply(id, { result: {} });
  if (method === "tools/list") return reply(id, { result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: t.props, required: t.required || [] } })) } });
  if (method === "tools/call") {
    const t = tools[params.name];
    if (!t) return reply(id, { error: { code: -32602, message: `Unknown tool ${params.name}` } });
    try { return reply(id, { result: await t.run(params.arguments || {}) }); }
    catch (e) { return reply(id, { result: { ...text(`Error: ${e.message}`), isError: true } }); }
  }
  reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
}).on("close", quit);
