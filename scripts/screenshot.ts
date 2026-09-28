// Screenshot a running Work HQ (normally `bin/work-hq demo`) with headless Chrome over CDP.
//   bun scripts/screenshot.ts <url> <out.png> [width] [height] [js-to-run-first]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://localhost:7718/", out = "docs/img/dashboard.png", w = "1600", h = "1000", pre] = process.argv.slice(2);
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "whq-shot-"))}`, "--hide-scrollbars", `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: any;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t: any) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); pending.get(d.id)?.(d.result); };
const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(3000);
if (pre) { await send("Runtime.evaluate", { expression: pre, awaitPromise: true }); await sleep(1200); }
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`wrote ${out}`);
ws.close(); proc.kill();
process.exit(0);
