import { spawn } from "node:child_process";

const port = Number(process.env.VIEWER_PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("VIEWER_PORT must be a valid port.");
const address = `http://127.0.0.1:${port}`;
async function ready() {
  try {
    const result = await fetch(`${address}/api/config`, {
      signal: AbortSignal.timeout(500),
    });
    const config = await result.json();
    return (
      result.ok &&
      typeof config.project === "string" &&
      typeof config.sessionsRoot === "string"
    );
  } catch {
    return false;
  }
}
function openBrowser() {
  if (process.argv.includes("--no-open")) return;
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", "start", "", address], {
          windowsHide: true,
          stdio: "ignore",
        })
      : spawn("xdg-open", [address], { stdio: "ignore" });
  child.on("error", () => console.log(`Open ${address} in your browser.`));
  child.unref();
}
if (await ready()) {
  openBrowser();
  console.log(`Viewer is already running: ${address}`);
} else {
  await import("../server/start.mjs");
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await ready()) {
      openBrowser();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
