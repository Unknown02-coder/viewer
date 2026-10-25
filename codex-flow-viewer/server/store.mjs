import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** Strict on API writes; repair old/corrupt preferences when reading. */
export function sanitizePreferences(input, strict = false) {
  const result = {
    selected: null,
    expanded: [],
    pinned: [],
    notes: {},
    titles: {},
    positions: {},
    relations: [],
  };
  const invalid = (key) => {
    if (strict) throw new Error(`화면 상태 형식이 올바르지 않습니다: ${key}`);
  };
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const id = (value) => typeof value === "string" && value.length <= 1000;
  const finite = (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) < 1e8;
  if (!object(input)) {
    invalid("state");
    return result;
  }
  if ("selected" in input) {
    if (input.selected === null || id(input.selected))
      result.selected = input.selected;
    else invalid("selected");
  }
  for (const key of ["expanded", "pinned"])
    if (key in input) {
      if (
        Array.isArray(input[key]) &&
        input[key].length <= 20000 &&
        input[key].every(id)
      )
        result[key] = [...new Set(input[key])];
      else invalid(key);
    }
  for (const key of ["notes", "titles"])
    if (key in input) {
      if (!object(input[key])) {
        invalid(key);
        continue;
      }
      const entries = Object.entries(input[key]).filter(([name, value]) => {
        const valid =
          id(name) &&
          typeof value === "string" &&
          value.length <= (key === "titles" ? 1000 : 100000);
        if (!valid) invalid(key);
        return valid;
      });
      result[key] = Object.fromEntries(entries);
    }
  if ("positions" in input) {
    if (!object(input.positions)) invalid("positions");
    else
      result.positions = Object.fromEntries(
        Object.entries(input.positions)
          .filter(([name, point]) => {
            const valid =
              id(name) && object(point) && finite(point.x) && finite(point.y);
            if (!valid) invalid("positions");
            return valid;
          })
          .map(([name, point]) => [name, { x: point.x, y: point.y }]),
      );
  }
  if ("viewport" in input) {
    const v = input.viewport;
    if (
      object(v) &&
      finite(v.x) &&
      finite(v.y) &&
      finite(v.zoom) &&
      v.zoom > 0 &&
      v.zoom <= 10
    )
      result.viewport = { x: v.x, y: v.y, zoom: v.zoom };
    else invalid("viewport");
  }
  if ("relations" in input) {
    if (!Array.isArray(input.relations)) invalid("relations");
    else
      result.relations = input.relations
        .filter((r) => {
          const valid =
            object(r) && id(r.source) && id(r.target) && r.source !== r.target;
          if (!valid) invalid("relations");
          return valid;
        })
        .map((r) => ({ source: r.source, target: r.target }));
  }
  return result;
}

export class ViewerStore {
  constructor(filename) {
    this.filename = filename;
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS viewer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get(key) {
    const row = this.db
      .prepare("SELECT value FROM viewer_state WHERE key = ?")
      .get(key);
    return row ? JSON.parse(row.value) : {};
  }
  set(key, value) {
    this.db
      .prepare(
        "INSERT INTO viewer_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
