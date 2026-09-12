import { test, expect } from "bun:test";
import { mutate } from "./mutate.js";
import { score, evidenceFor } from "./score.js";

const MANIFEST = [
  { id: 1, type: "digit-flip", row: 3, col: 1, rowKey: "SO-10043", before: "402.75", after: "402.95" },
  { id: 2, type: "cell-blank", row: 4, col: 3, rowKey: "SO-10044", before: "shipped", after: "" },
  { id: 3, type: "row-drop",  row: 5, content: ["SO-10045", "930.00", "2026-03-12", "cancelled"], rowKey: "SO-10045" },
];

test("perfect report catches all", () => {
  const s = score(MANIFEST, "amount mismatch 402.95 on SO-10043; SO-10044 status empty; SO-10045 missing from file");
  expect(s.caught).toBe(3); expect(s.missed).toBe(0); expect(s.catchRate).toBe(100);
});

test("silent report catches none (negative control)", () => {
  const s = score(MANIFEST, "All checks passed. 6 rows processed.");
  expect(s.caught).toBe(0); expect(s.missed).toBe(3); expect(s.catchRate).toBe(0);
  for (const r of s.rows) expect(r.caught).toBe(false);
});

test("partial report scores partially, with per-fault evidence", () => {
  const s = score(MANIFEST, "row SO-10045 not found");
  expect(s.caught).toBe(1);
  expect(s.rows.find((r) => r.id === 3).caught).toBe(true);
  expect(s.rows.find((r) => r.id === 3).evidence).toContain("SO-10045");
  expect(s.rows.find((r) => r.id === 1).caught).toBe(false);
});

test("cell-blank has no after value: row key is the evidence", () => {
  const ev = evidenceFor(MANIFEST[1]);
  expect(ev.length).toBe(1);
  expect(ev[0].text).toBe("SO-10044");
});

test("empty report and empty manifest degrade gracefully", () => {
  expect(score([], "whatever").total).toBe(0);
  expect(score(MANIFEST, "").caught).toBe(0);
});

test("end-to-end: mutate a table, a report citing every rowKey+after scores 100%", () => {
  const table = [
    ["order_id", "amount", "ship_date", "status"],
    ["SO-1", "10.00", "2026-01-02", "ok"], ["SO-2", "20.00", "2026-01-03", "ok"],
    ["SO-3", "30.00", "2026-01-04", "ok"], ["SO-4", "40.00", "2026-01-05", "ok"],
    ["SO-5", "50.00", "2026-01-06", "ok"], ["SO-6", "60.00", "2026-01-07", "ok"],
  ];
  const plan = [{ type: "digit-flip", count: 1 }, { type: "row-drop", count: 1 }, { type: "cell-blank", count: 1 }];
  const { manifest } = mutate(table, plan, 21);
  const fakeReport = manifest.map((f) => "flag " + (f.after || "") + " " + (f.rowKey || "")).join("\n");
  expect(score(manifest, fakeReport).catchRate).toBe(100);
});
