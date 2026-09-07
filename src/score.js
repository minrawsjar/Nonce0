// Ranking. The term that makes it honest is (1 - fixability).
//
//   risk = exposure x value_at_risk x (1 - fixability)
//
// Repo mode has neither exposure nor value at risk, so it degrades to severity
// ordering and SAYS SO rather than inventing a number. What it can still do is
// the inversion: a permanent finding outranks a fixable one of the same or
// higher severity, because the permanent one needs a plan starting now and the
// fixable one is an afternoon.

import { SEVERITY_ORDER } from './rules/catalog.js';

export const isPermanent = (f) => f.fixability === 0;

export function rank(findings) {
  return [...findings].sort((a, b) => {
    if (isPermanent(a) !== isPermanent(b)) return isPermanent(a) ? -1 : 1;
    const sev = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (sev !== 0) return sev;
    return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
  });
}

export function counts(findings) {
  const out = {};
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

/** Exit code 1 when anything at or above `failOn` is present. */
export function worstAtOrAbove(findings, failOn) {
  const limit = SEVERITY_ORDER.indexOf(failOn);
  return findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= limit);
}
