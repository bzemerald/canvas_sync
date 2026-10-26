// node cdp.mjs "<js>" [seconds]: evaluates <js> in the app's main window (over WebView2's
// remote debugging, port 9222), prints its value and the console errors and exceptions after it.
const [js, secs = "3"] = process.argv.slice(2);
const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
// The main window: the one whose <html> has neither "ghost" nor "launcher".
const classOf = (url) => new Promise((done) => {
  const w = new WebSocket(url);
  w.onopen = () => w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.documentElement.className", returnByValue: true } }));
  w.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id === 1) { w.close(); done(m.result?.result?.value ?? ""); } };
});
let page;
for (const p of pages.filter((p) => p.type === "page")) {
  const c = await classOf(p.webSocketDebuggerUrl);
  if (!/ghost|launcher/.test(c)) page = p;
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
    console.log(`[console.${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 1500));
  else if (m.method === "Runtime.exceptionThrown")
    console.log("[exception]", (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 2000));
  else if (m.id === 3) console.log("[result]", JSON.stringify(m.result?.result?.value ?? m.result?.exceptionDetails?.text ?? m.result).slice(0, 2000));
};
ws.onopen = () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
  setTimeout(() => process.exit(0), Number(secs) * 1000);
};
