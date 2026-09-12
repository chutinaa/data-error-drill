# SKILL.md — let an AI design your drill

This file is written **for AI assistants**. If you are a human: paste this file
into any AI chat together with the header row (and a few sample rows) of your
data, plus one sentence about what your checking tool does — and the AI will
map your tool's blind spots, predict which planted errors it will miss, and
hand you a drill plan that tests exactly that prediction. No code needed.

## 1. What a drill plan is

data-error-drill plants known errors into a copy of a table so the user can
test whether the report / checking tool they built actually catches them.
A good drill plan is not random: it says **which** error types to plant,
**how many**, **where**, and — most importantly — **which ones the tool is
predicted to miss**. The drill then confirms or refutes that prediction.

The nine built-in fault types (see `faults/*.json`):

| type | what it does | real-world failure it simulates | typically caught by |
|---|---|---|---|
| `digit-flip` | changes one digit | manual copy typo, OCR misread | totals / reconciliation |
| `digit-transpose` | swaps two adjacent digits | the classic keying transposition | totals; range checks usually pass |
| `unit-scale` | moves the decimal point (×10 or ÷10) | unit/scale mixup | magnitude & range checks |
| `cell-blank` | empties one cell | unmapped field, formula returning blank | completeness checks |
| `row-drop` | deletes one row | export filter left on, lost paste | row-count / sum reconciliation |
| `row-dup` | duplicates one row | double submission, join fan-out | duplicate checks, count reconciliation |
| `date-shift` | moves a date one month (`YYYY-MM-DD`) | stale formula, format mixup | period/window checks |
| `value-swap` | replaces a value with a *different valid* value from the same column | wrong status picked, copy from wrong row | **only** cross-checks against a source of truth |
| `key-space` | appends invisible whitespace to an ID | copy-paste residue | trimmed-match / join reconciliation |

## 2. The AI's workflow: triage → blind-spot map → predict → plan

**Step 1 — Triage the data.** Ask for (or use) the real header row plus 3–5
sample rows (sensitive values redacted; you only need column names and value
*shapes*). Classify each column: identifier, amount, count, date,
category/status, free text. Then mark the **critical columns**: anything that
feeds a final computed indicator (amounts, quantities, rates, anything
aggregated downstream). Empirical spreadsheet research (Panko, EuSpRIG) and
practitioner experience agree: errors do the most damage — and hide the
longest — in the cells that final metrics are computed from, and at
definition boundaries ("which rows count as this month?"). Target those
columns first.

**Step 2 — Map the tool's blind spots.** Ask the user one question: *"what
does your tool actually check?"* Map the answer against the right-hand column
of the table above. Every fault type whose usual detector is absent is a
predicted miss. Typical patterns:

- "It validates formats and required fields" → predicted to miss
  `value-swap`, `digit-transpose`, `row-drop`, `date-shift`.
- "It compares totals against the source system" → predicted to catch the
  numeric faults, miss `value-swap` on category columns and `key-space`.
- "It joins against a master list" → `key-space` is the killer test.

**Step 3 — Predict, then plan.** Output the drill plan with a one-line
justification per fault **and an explicit prediction** per fault: expected
caught or expected missed. The prediction is the product — a drill that
confirms "your tool misses plausible wrong values" teaches more than a
generic catch rate.

**Step 4 — Size it.** 3–7 faults per drill. At least one predicted-caught
(so a broken tool can't pass by silence being misread) and at least one
predicted-missed (so the drill has something to teach). Prefer one fault per
failure mode over repeats — research on mutation testing (selective mutation,
Offutt et al.) shows a few well-chosen operators expose as much as exhaustive
ones; and the coupling effect says tests that catch these simple single
faults tend to catch the messier compound ones too.

## 3. Drill plan output format

```
Drill plan for <table name>
  target columns: amount (feeds monthly total), status (drives inclusion rule)
  digit-transpose × 1 on amount   — hand-keyed; transposition is the top keying error   [predict: MISSED — no total check]
  unit-scale      × 1 on amount   — thousands/units mixup                               [predict: CAUGHT — range check]
  value-swap      × 1 on status   — wrong-but-valid status flips the inclusion rule     [predict: MISSED — nothing cross-checks status]
  row-drop        × 1             — export filter risk                                  [predict: MISSED — no count reconciliation]
Total: 4 faults, 3 predicted misses. In index.html: tick those four types,
set counts, generate, run your tool on the .drill.csv, paste its report, score.
Then compare the verdicts against these predictions.
```

If the environment can run JavaScript (bun/node), you may call the engine
directly:

```js
import { mutate } from "./engine/mutate.js";
const res = mutate(table, plan, seed);   // res.table = drilled copy
// res.manifest = answer sheet (type, row, col, rowKey, before, after)
```

## 4. After the drill: turn misses into checks

For every confirmed miss, recommend the *cheapest* check that would have
caught it, in the user's own toolchain (a SUM comparison, a row-count
reconciliation, a TRIM before joins, a category whitelist cross-check).
Then suggest re-running the drill with a new seed to confirm the fix. One
green round is a data point, not a certificate.

## 5. Prompt template for humans

> Here is SKILL.md from data-error-drill, plus the header row and a few
> sample rows of my table (sensitive values redacted). This data is produced
> by: <how — hand-typed / exported from a system / OCR'd / merged from
> several files>. My tool checks: <what it does>. Map my tool's blind spots,
> predict which planted errors it would miss, and give me a drill plan I can
> reproduce in index.html.
