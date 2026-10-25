export const isRecordFile = (name) => /\.jsonl(?:\.zst)?$/i.test(name);

/** Incremental JSONL decoding. Pending bytes remain bytes until a newline arrives. */
export class JsonlDecoder {
  #tail = Buffer.alloc(0);
  #line = 0;
  invalidLines = [];
  get pendingBytes() {
    return this.#tail.length;
  }

  push(chunk) {
    const bytes = Buffer.concat([this.#tail, chunk]);
    const rows = [];
    let start = 0;
    for (
      let end = bytes.indexOf(10);
      end !== -1;
      end = bytes.indexOf(10, start)
    ) {
      this.#line++;
      const text = bytes
        .subarray(start, end)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      if (text) {
        try {
          const row = JSON.parse(text);
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw new Error("record must be an object");
          rows.push({ line: this.#line, row });
        } catch {
          this.invalidLines.push(this.#line);
        }
      }
      start = end + 1;
    }
    this.#tail = Buffer.from(bytes.subarray(start));
    return rows;
  }
}
