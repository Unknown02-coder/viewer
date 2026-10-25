import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizePreferences } from "./store.mjs";
import { isRecordFile } from "./records.mjs";
import { MAX_SNAPSHOT_BYTES } from "./chatgpt/snapshot.mjs";

const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("저장할 내용이 너무 큽니다.");
  }
  return JSON.parse(text || "{}");
}

export function createViewerServer({
  repository,
  store,
  config,
  staticDir,
  middleware,
  imports,
  direct,
}) {
  const streams = new Set();
  const change = (value) => {
    for (const res of streams)
      res.write(`event: change\ndata: ${JSON.stringify(value)}\n\n`);
  };
  repository.on("change", change);
  const configSnapshot = (snapshot = repository.snapshot()) => ({
    ...config,
    project: snapshot.project,
    sessionsRoot: snapshot.sessionsRoot,
    connectionId: snapshot.connectionId,
    error: snapshot.error,
    diagnostics: snapshot.diagnostics,
    sourceKind: snapshot.sourceKind || "codex",
    selectedImportId: snapshot.selectedImportId || null,
    mcpProjectId: snapshot.mcpProjectId || null,
    mcpProjectName: snapshot.mcpProjectName || null,
    notice: snapshot.notice || null,
    mode:
      snapshot.sourceKind === "chatgpt" || isRecordFile(snapshot.sessionsRoot)
        ? "import"
        : "live",
  });
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host;
    const allowedHosts = new Set([
      `127.0.0.1:${req.socket.localPort}`,
      `localhost:${req.socket.localPort}`,
    ]);
    if (!allowedHosts.has(host))
      return json(res, 403, { error: "로컬 주소로 접속해 주세요." });
    if (
      req.headers.origin &&
      ![
        `http://127.0.0.1:${req.socket.localPort}`,
        `http://localhost:${req.socket.localPort}`,
      ].includes(req.headers.origin)
    )
      return json(res, 403, { error: "외부 출처의 요청은 허용하지 않습니다." });
    try {
      const url = new URL(req.url, `http://${host}`);
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return "";
          }
        });
      if (
        direct &&
        url.pathname === "/api/direct/status" &&
        req.method === "GET"
      )
        return json(res, 200, direct.status());
      if (direct && url.pathname === "/api/direct/projects") {
        if (req.method === "GET")
          return json(res, 200, { projects: direct.projects() });
        if (req.method === "POST") {
          const value = direct.createProject(await body(req));
          await direct.refresh();
          return json(res, 200, value);
        }
        return json(res, 405, { error: "지원하지 않는 요청입니다." });
      }
      if (
        segments[0] === "api" &&
        segments[1] === "chatgpt" &&
        segments[2] === "imports" &&
        imports
      ) {
        if (segments.length === 3) {
          if (req.method === "GET") {
            await imports.refresh();
            return json(res, 200, { conversations: imports.catalog() });
          }
          if (req.method === "POST") {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > MAX_SNAPSHOT_BYTES)
                throw new Error("가져올 사본은 50 MiB 이하여야 합니다.");
              chunks.push(chunk);
            }
            return json(res, 200, await imports.import(Buffer.concat(chunks)));
          }
          return json(res, 405, { error: "지원하지 않는 요청입니다." });
        }
        if (
          segments.length === 6 &&
          segments[4] === "source" &&
          req.method === "GET"
        ) {
          const data = await imports.source(segments[3], segments[5]);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="chatgpt-${segments[5]}.json"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(data);
          return;
        }
      }
      if (["/api/config", "/api/connection"].includes(url.pathname)) {
        let snapshot = repository.snapshot();
        if (req.method === "PUT") {
          const next = await body(req);
          snapshot = await repository.configure(next, (settings) =>
            store.set("settings", settings),
          );
          config.project = snapshot.project;
          config.sessionsRoot = snapshot.sessionsRoot;
        } else if (req.method !== "GET")
          return json(res, 405, { error: "지원하지 않는 요청입니다." });
        return json(
          res,
          200,
          url.pathname === "/api/connection"
            ? { config: configSnapshot(snapshot), sessions: snapshot.sessions }
            : configSnapshot(snapshot),
        );
      }
      if (
        (segments[1] === "sessions" || segments[1] === "state") &&
        req.headers["x-viewer-connection"] &&
        req.headers["x-viewer-connection"] !== repository.connectionId
      )
        return json(res, 409, {
          error: "프로젝트 연결이 변경되었습니다. 최신 연결을 다시 불러옵니다.",
          code: "CONNECTION_CHANGED",
        });
      if (url.pathname === "/api/sessions" && req.method === "GET")
        return json(res, 200, repository.list());
      if (
        segments[0] === "api" &&
        segments[1] === "sessions" &&
        segments[2] &&
        req.method === "GET"
      ) {
        const session = repository.get(segments[2]);
        if (!session)
          return json(res, 404, {
            error: "선택한 프로젝트의 대화를 찾을 수 없습니다.",
          });
        return json(res, 200, session);
      }
      if (segments[0] === "api" && segments[1] === "state" && segments[2]) {
        if (!repository.get(segments[2]))
          return json(res, 404, { error: "대화를 찾을 수 없습니다." });
        const key = `session:${segments[2]}`;
        if (req.method === "PUT") {
          const value = await body(req);
          if (
            req.headers["x-viewer-connection"] &&
            req.headers["x-viewer-connection"] !== repository.connectionId
          )
            return json(res, 409, {
              error:
                "프로젝트 연결이 변경되었습니다. 최신 연결을 다시 불러옵니다.",
              code: "CONNECTION_CHANGED",
            });
          if (!repository.get(segments[2]))
            return json(res, 404, {
              error: "현재 연결에서 대화를 찾을 수 없습니다.",
            });
          if (!value || typeof value !== "object" || Array.isArray(value))
            return json(res, 400, {
              error: "화면 상태 형식이 올바르지 않습니다.",
            });
          store.set(key, sanitizePreferences(value, true));
        } else if (req.method !== "GET")
          return json(res, 405, { error: "지원하지 않는 요청입니다." });
        const saved = store.get(key);
        return json(
          res,
          200,
          Object.keys(saved).length ? sanitizePreferences(saved) : {},
        );
      }
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("event: ready\ndata: {}\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/"))
        return json(res, 404, { error: "요청을 찾을 수 없습니다." });
      if (middleware)
        return middleware(req, res, () =>
          json(res, 404, { error: "페이지를 찾을 수 없습니다." }),
        );
      if (!staticDir)
        return json(res, 404, { error: "화면 빌드가 필요합니다." });
      const target = path.resolve(
        staticDir,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
      if (!target.startsWith(path.resolve(staticDir) + path.sep))
        return json(res, 403, { error: "허용하지 않는 경로입니다." });
      const data = await fs.readFile(target);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type":
          mime[path.extname(target)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
    } catch (error) {
      json(res, error.code === "ENOENT" ? 404 : 400, {
        error: error.message,
        code: error.code || "REQUEST_FAILED",
        field: error.field,
      });
    }
  });
  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(": keepalive\n\n");
  }, 20000);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    repository.off("change", change);
    for (const res of streams) res.end();
  });
  return server;
}
