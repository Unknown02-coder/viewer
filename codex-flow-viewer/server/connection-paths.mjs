import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalProject } from "./model.mjs";
import { isRecordFile } from "./records.mjs";

export function connectionError(message, code = "CONNECTION_FAILED", field) {
  return Object.assign(new Error(message), { code, field });
}
export function normalizeInputPath(value, field = "path") {
  if (typeof value !== "string" || !value.trim())
    throw connectionError(
      "프로젝트와 기록 경로를 입력해 주세요.",
      "PATH_REQUIRED",
      field,
    );
  let input = value.trim();
  for (let i = 0; i < 2; i++)
    if (
      (input.startsWith('"') && input.endsWith('"')) ||
      (input.startsWith("'") && input.endsWith("'"))
    )
      input = input.slice(1, -1).trim();
  if (!input || /[\u0000-\u001f]/.test(input) || /^["']|["']$/.test(input))
    throw connectionError(
      "폴더 경로의 따옴표나 줄바꿈을 확인해 주세요.",
      "INVALID_PATH",
      field,
    );
  input = input.replace(/^~(?=$|[\\/])/, os.homedir());
  input = input.replace(/%([A-Za-z_][A-Za-z_0-9]*)%/g, (_, name) => {
    const allowed = [
      "USERPROFILE",
      "HOME",
      "CODEX_HOME",
      "ONEDRIVE",
      "ONEDRIVECOMMERCIAL",
      "ONEDRIVECONSUMER",
    ];
    const actual = Object.keys(process.env).find(
      (key) => key.toUpperCase() === name.toUpperCase(),
    );
    if (!allowed.includes(name.toUpperCase()) || !actual)
      throw connectionError(
        `경로의 환경변수를 확인해 주세요: %${name}%`,
        "UNKNOWN_PATH_VARIABLE",
        field,
      );
    return process.env[actual];
  });
  if (/^file:/i.test(input)) {
    try {
      input = fileURLToPath(input);
    } catch {
      throw connectionError(
        "파일 주소를 폴더 경로로 확인해 주세요.",
        "INVALID_PATH",
        field,
      );
    }
  }
  return path.resolve(input);
}
export async function pathIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return { path: "", key: "" };
  const raw = path.resolve(value);
  let resolved = raw;
  try {
    resolved = await fs.realpath(raw);
  } catch {
    /* Historical recorded paths may no longer exist. */
  }
  return { path: resolved, key: canonicalProject(resolved) };
}
export async function projectDirectory(value) {
  const project = normalizeInputPath(value, "project");
  let stat;
  try {
    stat = await fs.stat(project);
  } catch (error) {
    throw connectionError(
      `프로젝트 폴더를 확인할 수 없습니다 (${error.code}): ${project}`,
      "PROJECT_UNAVAILABLE",
      "project",
    );
  }
  if (!stat.isDirectory())
    throw connectionError(
      "프로젝트에는 파일이 아닌 폴더 경로를 입력해 주세요.",
      "PROJECT_NOT_DIRECTORY",
      "project",
    );
  return project;
}
export async function recordLocations(value) {
  let root = normalizeInputPath(value, "sessionsRoot");
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    throw connectionError(
      `기록 경로를 확인할 수 없습니다 (${error.code}): ${root}`,
      "SOURCE_UNAVAILABLE",
      "sessionsRoot",
    );
  }
  root = await fs.realpath(root);
  if (stat.isFile()) {
    if (!isRecordFile(root))
      throw connectionError(
        "기록 폴더 또는 .jsonl / .jsonl.zst 파일을 선택해 주세요.",
        "UNSUPPORTED_SOURCE",
        "sessionsRoot",
      );
    return { root, roots: [root] };
  }
  if (!stat.isDirectory())
    throw connectionError(
      "읽을 수 있는 기록 폴더를 선택해 주세요.",
      "UNSUPPORTED_SOURCE",
      "sessionsRoot",
    );
  try {
    if ((await fs.stat(path.join(root, "sessions"))).isDirectory())
      root = path.join(root, "sessions");
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  const roots = [root];
  if (path.basename(root).toLowerCase() === "sessions") {
    const archived = path.join(path.dirname(root), "archived_sessions");
    try {
      if ((await fs.stat(archived)).isDirectory()) roots.push(archived);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) roots.push(archived);
    }
  }
  return { root, roots };
}

export const containsPath = (directory, file) => {
  const base = canonicalProject(directory),
    target = canonicalProject(file);
  return target === base || target.startsWith(base + "/");
};

export async function* recordFiles(root, onError, visited = new Set()) {
  let entries;
  try {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      if (isRecordFile(root)) yield root;
      return;
    }
    const key = (await pathIdentity(root)).key;
    if (visited.has(key)) return;
    visited.add(key);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    onError(root, error);
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* recordFiles(file, onError, visited);
    else if (entry.isFile() && isRecordFile(file)) yield file;
    else if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) yield* recordFiles(file, onError, visited);
        else if (stat.isFile() && isRecordFile(file)) yield file;
      } catch (error) {
        onError(file, error);
      }
    }
  }
}
