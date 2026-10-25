import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decodeSnapshot,
  MAX_SNAPSHOT_BYTES,
} from "../server/chatgpt/snapshot.mjs";

// Packages already captured pages. Does not contact ChatGPT or run source text.
export async function packageSnapshot({ pagesDir, output, sourceInstanceId }) {
  const files = (await fs.readdir(pagesDir))
    .filter((name) => /^page-\d+\.json$/.test(name))
    .sort();
  if (!files.length || files.length > 500)
    throw new Error("1~500개의 page-NNNN.json 사본이 필요합니다.");
  let size = 0;
  const pages = [];
  for (const name of files) {
    const filename = path.join(pagesDir, name);
    size += (await fs.stat(filename)).size;
    if (size > MAX_SNAPSHOT_BYTES)
      throw new Error("페이지 사본이 50 MiB를 넘습니다.");
    pages.push(JSON.parse(await fs.readFile(filename, "utf8")));
  }
  const times = pages
    .map((p) => Date.parse(p.receivedAt))
    .filter(Number.isFinite);
  if (times.length !== pages.length)
    throw new Error("페이지의 실제 수집 시각이 필요합니다.");
  const bundle = {
    format: "codex-flow.chatgpt-snapshot",
    schemaVersion: 1,
    sourceInstanceId,
    capturedAt: new Date(Math.max(...times)).toISOString(),
    pages,
  };
  const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + "\n");
  const decoded = decodeSnapshot(bytes);
  // Exclusive output also prevents overwriting any captured input file.
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, bytes, { flag: "wx" });
  return {
    file: path.resolve(output),
    id: decoded.id,
    questions: decoded.turns.length,
    coverage: decoded.coverage,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--pages") || !args.includes("--out"))
    throw new Error(
      "사용법: node scripts/package-chatgpt-import.mjs --pages <페이지 폴더> --out <새 cflow.json 파일> [--source-id <UUID>]",
    );
  let sourceInstanceId = args.includes("--source-id")
    ? value("--source-id")
    : null;
  if (!sourceInstanceId) {
    const identity = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../.local/chatgpt-source-id.json",
    );
    await fs.mkdir(path.dirname(identity), { recursive: true });
    try {
      sourceInstanceId = JSON.parse(
        await fs.readFile(identity, "utf8"),
      ).sourceInstanceId;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      sourceInstanceId = randomUUID();
      try {
        await fs.writeFile(identity, JSON.stringify({ sourceInstanceId }), {
          flag: "wx",
        });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        sourceInstanceId = JSON.parse(
          await fs.readFile(identity, "utf8"),
        ).sourceInstanceId;
      }
    }
  }
  console.log(
    JSON.stringify(
      await packageSnapshot({
        pagesDir: value("--pages"),
        output: value("--out"),
        sourceInstanceId,
      }),
      null,
      2,
    ),
  );
}
