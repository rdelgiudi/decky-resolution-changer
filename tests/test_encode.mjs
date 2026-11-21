// Run with: node tests/test_encode.mjs — checks the raw protobuf fallback
// against payloads captured from Steam's own Settings → Display on-device.
import { readFileSync } from "node:fs";
import assert from "node:assert";
const src = readFileSync(new URL("../src/steamSetting.ts", import.meta.url), "utf8");
const body = src.slice(src.indexOf("function varint"), src.indexOf("function findWriters"));
const js = body.replace(/: number\[\]/g, "").replace(/\((\w+): number\)/g, "($1)")
  .replace(/\(field: number, value: string\): string/, "(field, value)").replace("export ", "");
const encodeStringField = new Function(`${js}; return encodeStringField;`)();
assert.equal(encodeStringField(21012, "1920x1080"), "oqEKCTE5MjB4MTA4MA==");
assert.equal(encodeStringField(21012, "Native"), "oqEKBk5hdGl2ZQ==");
console.log("encode OK: matches captured Steam payloads");
