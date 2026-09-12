/* data-error-drill — engine/mutate.js
 * Zero-dependency fault injector for tabular data (array of rows, each row an array of strings).
 * Deterministic: same table + plan + seed => same faults, same manifest.
 * Every fault is recorded in a manifest precise enough to restore the original byte-for-byte.
 * Row 0 is treated as the header and is never mutated.
 *
 * Design notes (grounded in mutation-testing research):
 * - First-order only: one fault per location. The coupling effect (DeMillo et al.) says tests
 *   that catch simple faults tend to catch the complex ones they compose into.
 * - Few, well-chosen operators beat many (selective mutation, Offutt et al. 1996). Each operator
 *   here maps to a documented real-world data failure, not to a syntactic possibility.
 * - The subtle operators (value-swap, key-space, unit-scale) target the errors spreadsheet
 *   research (Panko, EuSpRIG) finds hardest to catch: plausible-looking values and silent
 *   mismatches that surface only in final computed indicators.
 */

const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

/* Cell-level operators. pred filters candidate cell values; make returns the mutated value
 * (given the cell value, the rng, and column values for context) or null if impossible. */
const CELL_OPS = {
  "digit-flip": {
    pred: (v) => /\d/.test(v) && !DATE_RE.test(v),
    make(before, rand) {
      const positions = [...before].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter((i) => i >= 0);
      const pos = pick(positions, rand);
      let d;
      do { d = String(Math.floor(rand() * 10)); } while (d === before[pos]);
      return before.slice(0, pos) + d + before.slice(pos + 1);
    },
  },
  "digit-transpose": {
    // two adjacent, differing digits somewhere in the value
    pred: (v) => !DATE_RE.test(v) && /(\d)(?!\1)\d/.test(v),
    make(before, rand) {
      const spots = [];
      for (let i = 0; i < before.length - 1; i++)
        if (/\d/.test(before[i]) && /\d/.test(before[i + 1]) && before[i] !== before[i + 1]) spots.push(i);
      const i = pick(spots, rand);
      return before.slice(0, i) + before[i + 1] + before[i] + before.slice(i + 2);
    },
  },
  "unit-scale": {
    pred: (v) => NUM_RE.test(v) && parseFloat(v) !== 0,
    make(before, rand) {
      const neg = before.startsWith("-");
      const body = neg ? before.slice(1) : before;
      let [int, frac = ""] = body.split(".");
      let out;
      if (rand() < 0.5) { // x10: move point right
        out = frac.length ? int + frac[0] + (frac.length > 1 ? "." + frac.slice(1) : "") : int + "0";
      } else {           // /10: move point left
        out = int.length > 1 ? int.slice(0, -1) + "." + int.slice(-1) + frac : "0." + int + frac;
      }
      out = out.replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m)); // trim trailing ".000"
      return (neg ? "-" : "") + out;
    },
  },
  "date-shift": {
    pred: (v) => DATE_RE.test(v),
    make(before) {
      const m = before.match(DATE_RE);
      const month = ((parseInt(m[2], 10) % 12) + 1).toString().padStart(2, "0");
      const day = Math.min(parseInt(m[3], 10), 28).toString().padStart(2, "0");
      return before.replace(DATE_RE, m[1] + "-" + month + "-" + day);
    },
  },
  "cell-blank": {
    pred: (v) => String(v).trim() !== "",
    make: () => "",
  },
  "value-swap": {
    // replaceable by a different value that already exists in the same column
    pred: (v, colValues) => colValues.some((x) => x !== v),
    make(before, rand, colValues) {
      const others = [...new Set(colValues.filter((x) => x !== before))];
      return pick(others, rand);
    },
  },
  "key-space": {
    // an id-ish value: no spaces, has a letter or digit
    pred: (v) => v.length > 0 && !/\s/.test(v) && /[A-Za-z0-9]/.test(v),
    make: (before) => before + " ",
  },
};

export const FAULT_TYPES = [...Object.keys(CELL_OPS), "row-dup", "row-drop"];

/* mulberry32 — tiny seeded PRNG, good enough for picking cells */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clone(table) { return table.map((r) => r.slice()); }
function pick(list, rand) { return list[Math.floor(rand() * list.length)]; }

/* Column values (data rows only) for value-swap context. */
function colValues(table, c) {
  const out = [];
  for (let r = 1; r < table.length; r++) out.push(table[r][c]);
  return out;
}

/* Collect candidate cells, excluding header and already-used cells/rows. */
function candidates(table, usedCells, usedRows, pred) {
  const out = [];
  const cols = table[0].length;
  const colVals = [];
  for (let c = 0; c < cols; c++) colVals.push(colValues(table, c));
  for (let r = 1; r < table.length; r++) {
    if (usedRows.has(r)) continue;
    for (let c = 0; c < table[r].length; c++) {
      if (usedCells.has(r + ":" + c)) continue;
      if (pred(table[r][c], colVals[c])) out.push({ r, c });
    }
  }
  return out;
}

/**
 * mutate(table, plan, seed) -> { table, manifest }
 * plan: [{ type: "digit-flip", count: 2 }, ...]
 * manifest entries (in application order):
 *   cell fault: { id, type, row, col, rowKey, before, after }
 *   { id, type: "row-drop", row, content, rowKey }   // row index at time of removal
 *   { id, type: "row-dup",  row, insertedAt, rowKey }
 * Throws if a requested fault has no eligible target left (caller shows the message).
 */
export function mutate(table, plan, seed = 42) {
  if (!Array.isArray(table) || table.length < 2) throw new Error("need a header row plus at least one data row");
  const rand = rng(seed);
  const t = clone(table);
  const manifest = [];
  const usedCells = new Set();
  const usedRows = new Set(); // rows touched by cell faults: excluded from row faults, and vice versa
  let id = 0;

  // Cell-level faults first, row-level faults last, so recorded indices stay valid.
  const order = (type) => (type === "row-dup" ? 1 : type === "row-drop" ? 2 : 0);
  const steps = [];
  for (const p of plan) {
    if (!FAULT_TYPES.includes(p.type)) throw new Error("unknown fault type: " + p.type);
    for (let i = 0; i < (p.count || 0); i++) steps.push(p.type);
  }
  steps.sort((a, b) => order(a) - order(b));

  for (const type of steps) {
    id++;
    if (CELL_OPS[type]) {
      const op = CELL_OPS[type];
      const cs = candidates(t, usedCells, usedRows, op.pred);
      if (!cs.length) throw new Error("no eligible cell left for " + type);
      const { r, c } = pick(cs, rand);
      const before = t[r][c];
      const after = op.make(before, rand, colValues(t, c));
      t[r][c] = after;
      usedCells.add(r + ":" + c); usedRows.add(r);
      manifest.push({ id, type, row: r, col: c, rowKey: c === 0 ? before : t[r][0], before, after });
    } else {
      const rows = [];
      for (let r = 1; r < t.length; r++) if (!usedRows.has(r)) rows.push(r);
      if (!rows.length) throw new Error("no untouched row left for " + type);
      const r = pick(rows, rand);
      if (type === "row-dup") {
        t.splice(r + 1, 0, t[r].slice());
        usedRows.add(r); usedRows.add(r + 1);
        manifest.push({ id, type, row: r, insertedAt: r + 1, rowKey: t[r][0] });
      } else { // row-drop
        const content = t[r].slice();
        t.splice(r, 1);
        usedRows.add(r);
        manifest.push({ id, type, row: r, content, rowKey: content[0] });
      }
    }
  }
  return { table: t, manifest };
}

/** restore(mutatedTable, manifest) -> original table (undo in reverse order) */
export function restore(table, manifest) {
  const t = clone(table);
  for (let i = manifest.length - 1; i >= 0; i--) {
    const f = manifest[i];
    if (f.type === "row-drop") t.splice(f.row, 0, f.content.slice());
    else if (f.type === "row-dup") t.splice(f.insertedAt, 1);
    else t[f.row][f.col] = f.before;
  }
  return t;
}

/** deep equality for tables (byte-for-byte restore check) */
export function sameTable(a, b) {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}
