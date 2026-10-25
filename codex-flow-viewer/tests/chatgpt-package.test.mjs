import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageSnapshot } from "../scripts/package-chatgpt-import.mjs";
import { snapshot, sourceId } from "./helpers/chatgpt.mjs";
test("producer preserves captured envelope content, derives real capture time and refuses existing output", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-package-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envelope = snapshot({ truncated: true }).pages[0],
    input = path.join(dir, "page-0001.json"),
    output = path.join(dir, "out.cflow.json");
  const original = JSON.stringify(envelope, null, 2);
  await fs.writeFile(input, original);
  const result = await packageSnapshot({
    pagesDir: dir,
    output,
    sourceInstanceId: sourceId,
  });
  assert.equal(result.coverage.text, "partial");
  const bundle = JSON.parse(await fs.readFile(output, "utf8"));
  assert.deepEqual(bundle.pages, [envelope]);
  assert.equal(bundle.capturedAt, envelope.receivedAt);
  await assert.rejects(
    packageSnapshot({ pagesDir: dir, output, sourceInstanceId: sourceId }),
    /EEXIST/,
  );
  assert.equal(await fs.readFile(input, "utf8"), original);
});
