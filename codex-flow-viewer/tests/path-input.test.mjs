import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeInputPath } from "../server/connection-paths.mjs";
import { SessionRepository } from "../server/repository.mjs";

test("home paths, profile variables and local file URLs normalize safely while malformed input is rejected", () => {
  assert.equal(normalizeInputPath(' "~" '), path.resolve(os.homedir()));
  const variable = process.env.USERPROFILE ? "USERPROFILE" : "HOME";
  assert.equal(
    normalizeInputPath("%" + variable + "%"),
    path.resolve(process.env[variable]),
  );
  assert.equal(
    normalizeInputPath(pathToFileURL(os.tmpdir()).href),
    path.resolve(os.tmpdir()),
  );
  assert.throws(
    () => normalizeInputPath("%MISSING_FLOW_PROFILE%"),
    (error) => error.code === "UNKNOWN_PATH_VARIABLE",
  );
  assert.throws(
    () => normalizeInputPath('"unfinished'),
    (error) => error.code === "INVALID_PATH",
  );
});

test("empty, unrecognized and different-project sources produce different actionable diagnostics", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-status-"));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = new SessionRepository({ project: dir, sessionsRoot: dir });
  await repo.refresh();
  assert.equal(repo.diagnostics.status, "no_records");
  const file = path.join(dir, "source.jsonl");
  await fs.writeFile(file, '{"other":"format"}\n');
  await repo.refresh();
  assert.equal(repo.diagnostics.status, "unrecognized_records");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "foreign", cwd: dir + "-other" },
    }) + "\n",
  );
  await repo.refresh();
  assert.equal(repo.diagnostics.status, "no_matching_project");
  assert.equal(repo.diagnostics.availableProjects.length, 1);
});

test("a file selected as project is rejected without replacing a working connection", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-folder-"));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.jsonl");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "local", cwd: dir },
    }) + "\n",
  );
  const repo = new SessionRepository({ project: dir, sessionsRoot: dir });
  await repo.refresh();
  await assert.rejects(
    repo.configure({ project: file, sessionsRoot: dir }),
    (error) => error.code === "PROJECT_NOT_DIRECTORY",
  );
  assert.equal(repo.project, dir);
  assert.equal(repo.list()[0].id, "local");
});
