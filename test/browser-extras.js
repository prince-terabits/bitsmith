// Kept logins and the live view, headless. Run with Node 22+:
//   ELECTRON_RUN_AS_NODE=1 /snap/code/current/usr/share/code/code test/browser-extras.js
const { spawn } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const Module = require("module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs-extras-"));
const profile = path.join(tmp, "profile");
const temps = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("bitsmith-browser-")).length;

// A page that logs you in with a cookie, a button that says it was clicked and a field that echoes typing.
const server = http.createServer((req, res) => {
  if (req.url === "/login") res.setHeader("Set-Cookie", "sid=secret42; Max-Age=3600; Path=/");
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Shop</title><body style="margin:0">
    <p id="who">${/sid=secret42/.test(req.headers.cookie || "") ? "Signed in" : "Signed out"}</p>
    <button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="this.textContent='clicked'">Press me</button>
    <input id="t" style="position:absolute;left:100px;top:200px">`);
});

function mcp(env) {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "browser-mcp.js")], { env: { ...process.env, BITSMITH_BROWSER: "headless", ...env } });
  srv.stderr.pipe(process.stderr);
  const waiting = new Map();
  let seq = 0;
  readline.createInterface({ input: srv.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  return {
    call: async (name, args = {}) => { const m = await rpc("tools/call", { name, arguments: args }); assert(!m.result.isError, m.result.content[0].text); return m.result.content.map((c) => c.text || "").join(""); },
    stop: () => new Promise((r) => { srv.on("exit", r); srv.stdin.end(); }),
  };
}

// browser-view.js with a stand-in for the vscode module: records what the panel is sent and lets the test "click".
const panel = { sent: [], webview: { postMessage: (m) => panel.sent.push(m), onDidReceiveMessage: (f) => (panel.fromView = f) }, reveal() {}, onDidDispose: (f) => (panel.dispose = f) };
const fake = { window: { createWebviewPanel: () => panel, showInformationMessage: (s) => { throw new Error(s); } }, ViewColumn: { Beside: -2 }, ThemeIcon: class {} };
const load = Module._load;
Module._load = (name, ...rest) => (name === "vscode" ? fake : load(name, ...rest));
const { showBrowser } = require("../browser-view");

const until = async (what, test) => { for (let i = 0; i < 100; i++) { const v = await test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + what); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = temps();

  // 1. Log in with a kept profile; the state file appears for the live view and goes when the chat ends.
  const state = path.join(tmp, "state.json");
  let a = mcp({ BITSMITH_PROFILE: profile, BITSMITH_STATE: state });
  assert.match(await a.call("browser_open", { url: base + "/login" }), /Signed out/);
  const info = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.match(info.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\//);
  assert.strictEqual(info.headless, true);
  await a.stop();
  assert(!fs.existsSync(state), "state file removed at the end");
  assert(fs.existsSync(path.join(profile, "Default")), "kept profile stays");
  console.log("kept profile ok");

  // 2. The next chat is still signed in.
  a = mcp({ BITSMITH_PROFILE: profile, BITSMITH_STATE: state });
  assert.match(await a.call("browser_open", { url: base + "/" }), /Signed in/);
  console.log("login remembered ok");

  // 3. A second chat at the same time gets a throwaway profile instead of fighting over the lock.
  const b = mcp({ BITSMITH_PROFILE: profile });
  assert.match(await b.call("browser_open", { url: base + "/" }), /Signed out/);
  assert.strictEqual(temps(), before + 1);
  await b.stop();
  assert.strictEqual(temps(), before, "throwaway profile deleted");
  console.log("profile in use -> throwaway ok");

  // 4. Live view: frames and the URL arrive, a click and typing in the view reach the page.
  showBrowser(state);
  const frame = await until("first frame", () => panel.sent.find((m) => m.frame));
  assert(frame.w > 0 && frame.h > 0 && Buffer.from(frame.frame, "base64")[0] === 0xff, "jpeg frame with page size");
  await until("url", () => panel.sent.some((m) => m.url === base + "/"));
  const click = (type) => panel.fromView({ mouse: { type, x: 200, y: 130, button: "left", clickCount: 1, modifiers: 0 } });
  click("mousePressed"); click("mouseReleased");
  await until("click reached the page", async () => /"clicked"/.test(await a.call("browser_snapshot")));
  click("mousePressed"); click("mouseReleased"); // focus nothing in particular; now the field:
  for (const type of ["mousePressed", "mouseReleased"]) panel.fromView({ mouse: { type, x: 150, y: 210, button: "left", clickCount: 1, modifiers: 0 } });
  for (const ch of "hi") { panel.fromView({ key: { type: "keyDown", key: ch, code: "Key" + ch.toUpperCase(), text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), modifiers: 0 } }); panel.fromView({ key: { type: "keyUp", key: ch, code: "Key" + ch.toUpperCase(), text: "", windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), modifiers: 0 } }); }
  await until("typing reached the page", async () => /value="hi"/.test(await a.call("browser_snapshot")));
  panel.fromView({ nav: "reload" });
  await until("reload", async () => /"Press me"/.test(await a.call("browser_snapshot")));
  console.log("live view ok");

  // 5. Claude's browser goes away: the view says so.
  await a.stop();
  await until("closed notice", () => panel.sent.some((m) => m.closed));
  panel.dispose();
  console.log("closed ok");

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(temps(), before);
  console.log("BROWSER EXTRAS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
