/* data-error-drill — engine/score.js
 * Score a tool's report against the fault manifest.
 * Honest semantics, v0.1:
 *   caught  = the report text mentions the planted wrong value, or the affected row's key.
 *   missed  = neither appears.
 * This is substring evidence, not proof — the verdict card says so. False-alarm counting is
 * out of scope for v0.1 (a report's own noise cannot be judged without knowing its format).
 */

export function evidenceFor(f) {
  const ev = [];
  if (f.after) ev.push({ text: f.after, kind: "planted value" });
  if (f.rowKey) ev.push({ text: f.rowKey, kind: "affected row key" });
  return ev.filter((e) => String(e.text).trim().length >= 2);
}

export function score(manifest, reportText) {
  const rep = String(reportText || "");
  const rows = manifest.map((f) => {
    const hit = evidenceFor(f).find((e) => rep.includes(e.text));
    return {
      id: f.id, type: f.type, rowKey: f.rowKey ?? "",
      caught: !!hit,
      evidence: hit ? hit.kind + " \u00ab" + hit.text + "\u00bb found in report" : "no trace of this fault in the report",
    };
  });
  const caught = rows.filter((r) => r.caught).length;
  return {
    rows,
    total: rows.length,
    caught,
    missed: rows.length - caught,
    catchRate: rows.length ? Math.round((100 * caught) / rows.length) : 0,
  };
}
