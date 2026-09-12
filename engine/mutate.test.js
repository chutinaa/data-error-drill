import { test, expect } from "bun:test";
import { mutate, restore, sameTable, FAULT_TYPES } from "./mutate.js";

function sample() {
  return [
    ["order_id", "amount", "ship_date", "status"],
    ["SO-10041", "1250.00", "2026-03-04", "shipped"],
    ["SO-10042", "88.50",   "2026-03-05", "shipped"],
    ["SO-10043", "402.75",  "2026-03-09", "pending"],
    ["SO-10044", "17.20",   "2026-03-11", "shipped"],
    ["SO-10045", "930.00",  "2026-03-12", "cancelled"],
    ["SO-10046", "56.10",   "2026-03-15", "shipped"],
    ["SO-10047", "310.40",  "2026-03-16", "pending"],
    ["SO-10048", "74.95",   "2026-03-18", "shipped"],
    ["SO-10049", "1288.00", "2026-03-21", "cancelled"],
    ["SO-10050", "45.60",   "2026-03-24", "shipped"],
    ["SO-10051", "207.30",  "2026-03-26", "pending"],
    ["SO-10052", "99.99",   "2026-03-29", "shipped"],
  ];
}
const FULL_PLAN = FAULT_TYPES.map((t) => ({ type: t, count: 1 }));

test("empty plan changes nothing (negative control)", () => {
  const { table, manifest } = mutate(sample(), []);
  expect(manifest.length).toBe(0);
  expect(sameTable(table, sample())).toBe(true);
});

test("plan counts are honored exactly", () => {
  const { manifest } = mutate(sample(), FULL_PLAN, 7);
  expect(manifest.length).toBe(FAULT_TYPES.length);
  for (const t of FAULT_TYPES) expect(manifest.filter((f) => f.type === t).length).toBe(1);
});

test("deterministic: same seed same result, different seed different result", () => {
  const a = mutate(sample(), FULL_PLAN, 11);
  const b = mutate(sample(), FULL_PLAN, 11);
  const c = mutate(sample(), FULL_PLAN, 12);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
});

test("mutated table actually differs from the original (positive control)", () => {
  const { table } = mutate(sample(), FULL_PLAN, 3);
  expect(sameTable(table, sample())).toBe(false);
});

test("header row is never touched", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { table, manifest } = mutate(sample(), FULL_PLAN, seed);
    expect(table[0]).toEqual(sample()[0]);
    for (const f of manifest) expect(f.row).toBeGreaterThan(0);
  }
});

test("digit-flip changes exactly one character, and it is a digit", () => {
  const { manifest } = mutate(sample(), [{ type: "digit-flip", count: 2 }], 5);
  for (const f of manifest) {
    const diffs = [...f.before].map((ch, i) => (ch !== f.after[i] ? i : -1)).filter((i) => i >= 0);
    expect(f.before.length).toBe(f.after.length);
    expect(diffs.length).toBe(1);
    expect(/\d/.test(f.before[diffs[0]])).toBe(true);
    expect(/\d/.test(f.after[diffs[0]])).toBe(true);
  }
});

test("date-shift keeps ISO shape and changes the month", () => {
  const { manifest } = mutate(sample(), [{ type: "date-shift", count: 2 }], 9);
  for (const f of manifest) {
    expect(f.after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.before.slice(5, 7)).not.toBe(f.after.slice(5, 7));
  }
});

test("cell-blank empties a previously non-empty cell", () => {
  const { manifest } = mutate(sample(), [{ type: "cell-blank", count: 2 }], 4);
  for (const f of manifest) { expect(f.before.trim()).not.toBe(""); expect(f.after).toBe(""); }
});

test("row-dup inserts an identical row right below", () => {
  const { table, manifest } = mutate(sample(), [{ type: "row-dup", count: 1 }], 6);
  const f = manifest[0];
  expect(table.length).toBe(sample().length + 1);
  expect(table[f.insertedAt]).toEqual(table[f.row]);
});

test("row-drop removes the recorded row", () => {
  const { table, manifest } = mutate(sample(), [{ type: "row-drop", count: 1 }], 8);
  expect(table.length).toBe(sample().length - 1);
  expect(manifest[0].content).toEqual(sample()[manifest[0].row]);
});

test("digit-transpose swaps two adjacent digits: same multiset of characters, value changed", () => {
  const { manifest } = mutate(sample(), [{ type: "digit-transpose", count: 3 }], 13);
  for (const f of manifest) {
    expect(f.after).not.toBe(f.before);
    expect(f.after.length).toBe(f.before.length);
    expect([...f.after].sort().join("")).toBe([...f.before].sort().join(""));
  }
});

test("unit-scale multiplies or divides the number by exactly 10", () => {
  const { manifest } = mutate(sample(), [{ type: "unit-scale", count: 3 }], 21);
  for (const f of manifest) {
    const b = parseFloat(f.before), a = parseFloat(f.after);
    const ratio = a / b;
    const ok = Math.abs(ratio - 10) < 1e-9 || Math.abs(ratio - 0.1) < 1e-9;
    expect(ok).toBe(true);
  }
});

test("value-swap plants a value that already exists elsewhere in the same column", () => {
  const { manifest } = mutate(sample(), [{ type: "value-swap", count: 3 }], 17);
  const orig = sample();
  for (const f of manifest) {
    expect(f.after).not.toBe(f.before);
    const column = orig.slice(1).map((r) => r[f.col]);
    expect(column.includes(f.after)).toBe(true);
  }
});

test("key-space appends exactly one trailing space to an id-like value", () => {
  const { manifest } = mutate(sample(), [{ type: "key-space", count: 3 }], 19);
  for (const f of manifest) {
    expect(f.after).toBe(f.before + " ");
    expect(/\s/.test(f.before)).toBe(false);
  }
});

test("restore(manifest) returns the original byte-for-byte — 50 seeds", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { table, manifest } = mutate(sample(), FULL_PLAN, seed);
    expect(sameTable(restore(table, manifest), sample())).toBe(true);
  }
});

test("impossible request fails loudly, not silently", () => {
  expect(() => mutate(sample(), [{ type: "row-drop", count: 99 }], 1)).toThrow();
  expect(() => mutate(sample(), [{ type: "nonsense", count: 1 }], 1)).toThrow();
  expect(() => mutate([["only-header"]], [], 1)).toThrow();
});
