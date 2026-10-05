// Drives browser-mcp.js over MCP stdio against a local page, headless. Run with Node 22+:
//   ELECTRON_RUN_AS_NODE=1 /snap/code/current/usr/share/code/code test/browser.js
const { spawn } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-browser-"));
fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Login</title>
<h1>Welcome</h1>
<label for="email">Email</label><input id="email" placeholder="you@example.com">
<input type="password" id="pw" aria-label="Password">
<select id="lang"><option>English</option><option>Français</option></select>
<button id="go">Log in</button>
<a href="next.html">Next page</a>
<p id="out"></p>
<script>
  console.log("page ready");
  document.getElementById("go").addEventListener("click", () => {
    document.getElementById("out").textContent = "Hello " + document.getElementById("email").value + " (" + document.getElementById("lang").value + ")";
    setTimeout(() => { throw new Error("late boom"); }, 50);
  });
  document.getElementById("email").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("out").textContent = "submitted " + e.target.value; });
</script>`);
fs.writeFileSync(path.join(dir, "next.html"), `<!doctype html><title>Next</title><p>Second page</p><img src="missing.png">`);

const srv = spawn(process.execPath, [path.join(__dirname, "..", "browser-mcp.js")], { env: { ...process.env, BITSMITH_BROWSER: process.env.BITSMITH_BROWSER || "headless" } });
srv.stderr.pipe(process.stderr);
const waiting = new Map();
let seq = 0;
readline.createInterface({ input: srv.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args = {}) => {
  const m = await rpc("tools/call", { name, arguments: args });
  return { error: m.result.isError, text: m.result.content.map((c) => c.text || "").join(""), content: m.result.content };
};
const ref = (snap, label) => +snap.match(new RegExp(`\\[(\\d+)\\][^\\n]*${label}`))[1];

(async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.strictEqual(init.result.serverInfo.name, "bitsmith-browser");
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  assert.deepStrictEqual(list.result.tools.map((t) => t.name), ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_console"]);

  let s = (await call("browser_open", { url: "file://" + path.join(dir, "index.html") })).text;
  assert.match(s, /Title: Login/);
  assert.match(s, /\[\d+\] input text "Email" placeholder|\[\d+\] input text "Email"/);
  assert.match(s, /select .*options=\["English","Français"\]/);
  assert.match(s, /Text:\n[\s\S]*Welcome/);
  console.log("open + snapshot ok");

  s = (await call("browser_type", { ref: ref(s, '"Email"'), text: "a@b.co" })).text;
  assert.match(s, /"Email" value="a@b.co"/);
  s = (await call("browser_type", { ref: ref(s, '"Password"'), text: "secret" })).text;
  assert.match(s, /"Password" \(filled\)/);
  assert(!s.includes("secret"), "password value is never shown");
  s = (await call("browser_type", { ref: ref(s, "select"), text: "français" })).text;
  assert.match(s, /value="Français"/);
  s = (await call("browser_click", { ref: ref(s, '"Log in"') })).text;
  assert.match(s, /Hello a@b.co \(Français\)/);
  console.log("type + select + click ok");

  s = (await call("browser_type", { ref: ref(s, '"Email"'), text: "x@y.z", submit: true })).text;
  assert.match(s, /submitted x@y.z/);
  console.log("submit with Enter ok");

  const con = (await call("browser_console")).text;
  assert.match(con, /log: page ready/);
  assert.match(con, /uncaught: Error: late boom/);
  assert.strictEqual((await call("browser_console")).text, "(no messages)");
  console.log("console ok");

  const shot = await call("browser_screenshot");
  assert.strictEqual(shot.content[0].type, "image");
  assert(Buffer.from(shot.content[0].data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG");
  console.log("screenshot ok");

  s = (await call("browser_click", { ref: ref(s, "Next page") })).text;
  assert.match(s, /Title: Next/);
  assert.match((await call("browser_console")).text, /missing.png/);
  console.log("navigation by link ok");

  const stale = await call("browser_click", { ref: 99 });
  assert(stale.error && /new browser_snapshot/.test(stale.text));
  const bad = await call("browser_click", { ref: "1'); alert(1); ('" });
  assert(bad.error && /ref must be/.test(bad.text));
  const down = await call("browser_open", { url: "http://127.0.0.1:59999" });
  assert(down.error && /ERR_CONNECTION_REFUSED/.test(down.text));
  console.log("errors ok");

  srv.stdin.end();
  await new Promise((r) => srv.on("exit", r));
  fs.rmSync(dir, { recursive: true });
  console.log("BROWSER TOOLS PASSED");
})().catch((e) => { console.error("FAIL:", e); srv.kill(); process.exit(1); });
