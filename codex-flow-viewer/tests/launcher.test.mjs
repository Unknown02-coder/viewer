import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

test("Windows launcher keeps the already-running result visible until a key is pressed", {
  skip: process.platform !== "win32",
  timeout: 15000,
}, async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ project: "fixture", sessionsRoot: "fixture" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn("cmd.exe", ["/d", "/c", "start-viewer.cmd --no-open"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, VIEWER_PORT: String(server.address().port) },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  for (let i = 0; i < 100 && !output.includes("Viewer is already running:") && child.exitCode === null; i++) await delay(30);
  assert.match(output, /Viewer is already running:/);
  await delay(150);
  assert.equal(child.exitCode, null, "Successful reuse must not immediately close the window");
  assert.match(output, /Open the viewer using the browser address above/);
  child.stdin.end("\r\n");
  assert.equal(await exited, 0);
});
