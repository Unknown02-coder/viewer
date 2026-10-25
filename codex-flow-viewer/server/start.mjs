import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { SessionRepository } from "./repository.mjs";
import { ViewerStore } from "./store.mjs";
import { createViewerServer } from "./http.mjs";
import { DirectRecords } from "./mcp/records.mjs";
import { RecordSourceRouter } from "./record-source-router.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new ViewerStore(
  process.env.VIEWER_DB || path.join(root, ".local/viewer.sqlite"),
);
const saved = store.get("settings");
const config = {
  project:
    process.env.VIEWER_PROJECT || saved.project || path.resolve(root, ".."),
  sessionsRoot:
    process.env.VIEWER_SESSIONS ||
    saved.sessionsRoot ||
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "sessions",
    ),
  pollInterval: 2000,
};
const direct = new DirectRecords(store);
const repository = new RecordSourceRouter({
  codex: new SessionRepository(config),
  direct,
  store,
});
await repository.refresh();
let vite;
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: { middlewareMode: true, host: "127.0.0.1", hmr: false },
    appType: "spa",
  });
}
const server = createViewerServer({
  repository,
  store,
  config,
  direct,
  staticDir: path.join(root, "dist"),
  middleware: vite?.middlewares,
});
const port = Number(process.env.VIEWER_PORT || 4318);
server.on("error", (error) => {
  console.error(`뷰어 실행 실패: ${error.message}`);
  process.exitCode = 1;
  clearInterval(timer);
  vite?.close();
  store.close();
});
const timer = setInterval(
  () => repository.refresh().catch((error) => console.error(error.message)),
  config.pollInterval,
);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Codex Flow Viewer: http://127.0.0.1:${port}\n프로젝트: ${config.project}\n읽기 전용 기록: ${config.sessionsRoot}`,
  ),
);
async function stop() {
  clearInterval(timer);
  server.closeAllConnections();
  server.close();
  await vite?.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
