// nonce0 dashboard. No framework, no build step, no dependencies.
// It is a form and two tables; a bundler would be more machinery than content.
// Served same-origin by ../backend/server.js, so fetch paths are relative and
// there is no CORS to debug.

const $ = (id) => document.getElementById(id);
const form = $('scan-form');
const statusLine = $('status');

const setStatus = (msg, isError = false) => {
  statusLine.textContent = msg;
  statusLine.classList.toggle('error', isError);
};

// A failed lookup must never render as "safe". Three states, and unknown is loud.
const EXPOSURE_LABEL = {
  exposed: ['exposed', 'exposed'],
  'not-exposed': ['not-exposed', 'nonce 0 — key still hidden'],
  unknown: ['unknown', 'RPC FAILED — not a clean result'],
};

function renderExposure(chains = []) {
  const body = $('exposure-rows');
  body.replaceChildren();
  for (const c of chains) {
    const [cls, label] = EXPOSURE_LABEL[c.status] ?? ['unknown', c.status];
    const tr = document.createElement('tr');
    const tx = c.firstExposingTx
      ? `<a class="mono" href="${c.explorer ?? '#'}" rel="noreferrer noopener">${c.firstExposingTx.slice(0, 18)}…</a>`
      : '<span class="hint">—</span>';
    tr.innerHTML =
      `<td>${c.name}</td>` +
      `<td class="mono">${c.nonce ?? '—'}</td>` +
      `<td class="${cls}">${label}</td>` +
      `<td>${tx}</td>`;
    body.append(tr);
  }
  $('exposure').hidden = chains.length === 0;
}

function renderFindings(findings = []) {
  const body = $('finding-rows');
  body.replaceChildren();
  for (const f of findings) {
    const tr = document.createElement('tr');
    // fixability 0 means permanent: say so, because that is the ranking's point.
    const fix = f.fixability === 0 ? '<span class="sev-critical">permanent</span>'
      : f.fixability === 1 ? '<span class="not-exposed">fixable</span>'
      : '<span class="sev-medium">containable</span>';
    tr.innerHTML =
      `<td class="mono">${f.id ?? ''}</td>` +
      `<td class="sev sev-${f.severity}">${f.severity ?? ''}</td>` +
      `<td>${fix}</td>` +
      `<td class="mono">${f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : (f.address ?? '')}</td>` +
      `<td>${f.remediation ?? ''}</td>`;
    body.append(tr);
  }
  $('findings').hidden = findings.length === 0;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = $('target').value.trim();
  const tier = $('tier').value;
  const button = form.querySelector('button');

  button.disabled = true;
  setStatus(`scanning ${target} at tier ${tier}…`);
  $('findings').hidden = true;
  $('exposure').hidden = true;

  try {
    const res = await fetch(`/api/scan?target=${encodeURIComponent(target)}&tier=${tier}`);
    const data = await res.json();

    if (res.status === 402) {
      setStatus(`402 payment required — ${data.tier} costs ${data.price}. ${data.note ?? ''}`, true);
    } else if (res.status === 503) {
      setStatus(`${data.error}: ${data.detail}`, true);
    } else if (!res.ok) {
      setStatus(`${data.error ?? res.status}${data.detail ? ' — ' + data.detail : ''}`, true);
    } else if (data.counts) {
      const summary = Object.entries(data.counts).map(([k, v]) => `${v} ${k}`).join(', ');
      setStatus(`${data.total} findings — ${summary || 'none'}. Upgrade the tier for locations.`);
    } else {
      renderFindings(data.findings);
      renderExposure(data.exposure);
      setStatus(`${data.findings?.length ?? 0} findings for ${data.target}`);
    }
  } catch (err) {
    setStatus(`request failed: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
});

// Health pill: tells you whether the engine is wired, separately from the API
// being up. Those failing for different reasons is the normal state mid-build.
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    const pill = $('health');
    pill.textContent = h.scanner ? 'api up · scanner wired' : 'api up · scanner not built (step 2)';
    pill.className = `pill ${h.scanner ? 'up' : 'down'}`;
  })
  .catch(() => {
    const pill = $('health');
    pill.textContent = 'api unreachable';
    pill.className = 'pill down';
  });
