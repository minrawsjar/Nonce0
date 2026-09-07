// Text reporter. Colour only when stdout is a TTY, so piping to a file or CI
// log stays clean. --json is JSON.stringify in bin/ and never came here.

import { rank, counts, isPermanent } from './score.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const SEV = { critical: (s) => c('1;31', s), high: (s) => c('31', s), medium: (s) => c('33', s), low: (s) => c('90', s) };
const dim = (s) => c('90', s);
const bold = (s) => c('1', s);

export function renderText(findings, { target, mode }) {
  if (!findings.length) {
    return `${c('32', 'clean')} — no findings in ${target}\n${dim('Repo mode has no value at risk and cannot tell a live admin path from a test fixture.')}\n`;
  }

  const ranked = rank(findings);
  const out = [''];

  let lastGroup = null;
  for (const f of ranked) {
    const group = isPermanent(f) ? 'permanent' : 'fixable';
    if (group !== lastGroup) {
      out.push(
        bold(group === 'permanent' ? 'PERMANENT — needs a plan starting now' : 'FIXABLE — an afternoon'),
        ''
      );
      lastGroup = group;
    }
    out.push(
      `  ${SEV[f.severity](f.severity.padEnd(8))} ${bold(f.id)}  ${f.title}`,
      `    ${dim(`${f.file}:${f.line}`)}  ${dim(f.evidence)}`,
      `    ${f.remediation}`,
      ''
    );
  }

  const n = counts(ranked);
  const summary = Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ');
  out.push(dim('—'.repeat(60)));
  out.push(`${ranked.length} findings in ${target}  (${summary})`);

  const permanent = ranked.filter(isPermanent).length;
  if (permanent) out.push(dim(`${permanent} of them cannot be fixed, only contained. Those are the ones with a deadline.`));
  if (mode === 'repo') out.push(dim('Repo mode: no value at risk, no exposure data. Run against a deployed address for both.'));

  return out.join('\n') + '\n';
}
