// The matcher. Tier 1 only at this build step: a cheap regex prefilter over raw
// bytes, whose only job is deciding what deserves attention.
//
// Tier 2 (src/repo/solidity.js, build step 3) strips comments and string
// literals and tracks which function each match sits in. Until it exists every
// finding is confidence 'medium' and matches inside comments are NOT discarded.
// That is a known, temporary false-positive source, and it is why
// test/fixtures/Clean.sol cannot assert zero findings until step 3.

import { RULES } from './catalog.js';

const lineOf = (source, index) => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
};

function applies(rule, file) {
  if (rule.mode === 'chain') return false;
  if (rule.filenames?.length) return rule.filenames.some((re) => re.test(file.rel));
  if (rule.languages && !rule.languages.includes(file.ext)) return false;
  // pathHints narrow a rule that would otherwise match everywhere (PQG-011's
  // bare address regex would flag every .sol in the repo without this).
  if (rule.pathHints?.length && !rule.pathHints.some((re) => re.test(file.rel))) return false;
  return true;
}

/** Tier-1 scan of one discovered file. Returns findings, never throws. */
export function matchFile(file) {
  const findings = [];

  for (const rule of RULES) {
    if (!applies(rule, file)) continue;

    // Artifact rules (PQG-009) match on filename alone and have no source.
    if (!rule.patterns.length && rule.filenames?.length) {
      findings.push(finding(rule, file, 1, file.rel));
      continue;
    }
    if (!file.source) continue;

    for (const pattern of rule.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of file.source.matchAll(re)) {
        findings.push(finding(rule, file, lineOf(file.source, match.index), match[0].trim().slice(0, 80)));
      }
    }
  }

  return dedupe(findings);
}

function finding(rule, file, line, evidence) {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    fixability: rule.fixability,
    file: file.rel,
    line,
    evidence,
    why: rule.why,
    remediation: rule.remediation,
    confidence: 'medium', // upgraded to 'high' by tier 2 at build step 3
    ...(rule.feedsExposureOracle ? { feedsExposureOracle: true } : {}),
  };
}

// One rule firing five times on one line is one finding, not five.
function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.id}:${f.file}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
