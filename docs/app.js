const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  encrypted: null,
  report: null,
  selectedCompanyId: null,
  password: null
};

function scoreBadge(score10) {
  if (score10 >= 7.5) return { cls: 'good', label: `${score10.toFixed(2)} / 10` };
  if (score10 >= 5.5) return { cls: 'mid', label: `${score10.toFixed(2)} / 10` };
  return { cls: 'bad', label: `${score10.toFixed(2)} / 10` };
}

function scoreBarColor(score10) {
  if (score10 >= 7.5) return 'rgba(46, 158, 107, 0.9)';
  if (score10 >= 5.5) return 'rgba(245, 158, 11, 0.9)';
  return 'rgba(194, 65, 102, 0.9)';
}

function scoreBand(score10) {
  if (score10 >= 7.5) return 'good';
  if (score10 >= 5.5) return 'mid';
  return 'bad';
}

function criticalityLabel(weight) {
  if (weight >= 3) return 'Critical';
  if (weight === 2) return 'High';
  return 'Standard';
}

function renderLlmsExperiments(item, criterionId) {
  const exp = item?.experiments?.llmsArtifacts;
  if (!exp) return '';

  const key = criterionId === 'llms_full_txt' ? 'llms_full_txt' : 'llms_txt';
  const control = exp.control?.[key];
  const ai = exp.ai?.[key];
  const aiErr = exp.aiError;

  const parts = [];
  parts.push(`<div class="muted small" style="margin-top:10px;">Experiments</div>`);
  parts.push(`<div class="muted small">Control (link-based discovery from Website/Docs landing pages)</div>`);

  if (control) {
    if (Array.isArray(control.candidates) && control.candidates.length) {
      parts.push(`<div class="muted small" style="margin-top:6px;">Discovered candidate links</div>`);
      parts.push(`<ul>${control.candidates.map((u) => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a></li>`).join('')}</ul>`);
    } else {
      parts.push(`<div class="muted small" style="margin-top:6px;">No candidate links discovered from landing pages.</div>`);
    }

    if (Array.isArray(control.fetched) && control.fetched.length) {
      parts.push(`<div class="muted small" style="margin-top:6px;">Fetch results</div>`);
      parts.push('<ul>');
      for (const f of control.fetched) {
        const label = f.ok ? 'OK' : 'Failed';
        const meta = [
          typeof f.status === 'number' ? `HTTP ${f.status}` : null,
          typeof f.bytes === 'number' ? `${f.bytes} bytes` : null,
          typeof f.lineCount === 'number' ? `${f.lineCount} lines` : null,
          f.contentType ? f.contentType : null,
          f.truncated ? 'truncated' : null,
          f.error ? `error: ${f.error}` : null
        ].filter(Boolean).join(' · ');

        const u = f.url || '';
        const uHtml = u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a>` : '(no url)';
        parts.push(`<li><span class="pill">${escapeHtml(label)}</span> ${uHtml}${meta ? ` <span class="muted small">(${escapeHtml(meta)})</span>` : ''}</li>`);
      }
      parts.push('</ul>');
    }
  } else {
    parts.push(`<div class="muted small" style="margin-top:6px;">No control experiment data present in report.</div>`);
  }

  parts.push(`<div class="muted small" style="margin-top:8px;">AI (web search discovery)</div>`);
  if (ai) {
    parts.push('<ul>');
    parts.push(`<li><span class="pill">exists: ${escapeHtml(String(ai.exists))}</span></li>`);
    if (ai.url) parts.push(`<li>url: <a href="${escapeHtml(ai.url)}" target="_blank" rel="noreferrer">${escapeHtml(ai.url)}</a></li>`);
    if (ai.how_found) parts.push(`<li><span class="muted small">how_found:</span> ${escapeHtml(ai.how_found)}</li>`);
    parts.push(`<li><span class="pill">spec_compliant: ${escapeHtml(String(ai.spec_compliant))}</span> <span class="pill">score: ${escapeHtml(String(ai.score))}</span></li>`);
    if (Array.isArray(ai.issues) && ai.issues.length) {
      parts.push(`<li><span class="muted small">issues:</span><ul>${ai.issues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></li>`);
    }
    parts.push('</ul>');
  } else {
    parts.push(`<div class="muted small" style="margin-top:6px;">AI experiment not available.${aiErr ? ` Error: ${escapeHtml(aiErr)}` : ''}</div>`);
  }

  return parts.join('');
}

function computeWeightedTotal(criteria, criteriaDefs) {
  const byId = new Map(criteriaDefs.map((c) => [c.id, c]));
  const sumW = criteriaDefs.reduce((a, c) => a + c.weight, 0);
  const weighted = criteria.reduce((acc, item) => {
    const w = byId.get(item.id)?.weight ?? 0;
    return acc + item.score * w;
  }, 0);
  const total10 = sumW === 0 ? 0 : weighted / sumW;
  return {
    totalScore10: Math.round(total10 * 100) / 100,
    totalScore100: Math.round(total10 * 10 * 100) / 100
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptReport(password, encrypted) {
  if (!encrypted || typeof encrypted !== 'object') {
    throw new Error('Encrypted report is missing.');
  }
  if (!encrypted.data || !encrypted.salt || !encrypted.iv || !encrypted.tag) {
    throw new Error('Encrypted report is not generated yet.');
  }

  const salt = b64ToBytes(encrypted.salt);
  const iv = b64ToBytes(encrypted.iv);
  const tag = b64ToBytes(encrypted.tag);
  const data = b64ToBytes(encrypted.data);

  if (data.length < 16) {
    throw new Error('Encrypted report payload is too small (likely placeholder).');
  }

  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);

  const key = await deriveKey(password, salt, encrypted.iter ?? 310000);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    combined
  );

  const dec = new TextDecoder();
  return JSON.parse(dec.decode(new Uint8Array(plaintext)));
}

function setError(msg) {
  $('errorLine').textContent = msg || '';
}

function setMetaLine(msg) {
  $('metaLine').textContent = msg || '';
}

function renderScores() {
  const tbody = $('scoresTable').querySelector('tbody');
  tbody.innerHTML = '';

  const companies = state.report?.companies ?? [];
  const n = companies.length;
  for (let i = 0; i < companies.length; i++) {
    const item = companies[i];
    const tr = document.createElement('tr');
    tr.dataset.companyId = item.company.id;
    tr.classList.add('rank-row');

    const t = n <= 1 ? 0 : i / (n - 1);
    const hue = Math.round(130 - t * 110);
    tr.style.setProperty('--rank-hue', String(hue));

    const nameTd = document.createElement('td');
    nameTd.textContent = item.company.name;

    const total10Td = document.createElement('td');
    const score10 = item.totalScore10;
    const pct = Math.max(0, Math.min(100, (score10 / 10) * 100));
    const barColor = scoreBarColor(score10);
    total10Td.innerHTML = [
      `<div class="score-cell">`,
      `<div class="score-num">${score10.toFixed(2)} / 10</div>`,
      `<div class="score-bar"><span style="width:${pct.toFixed(1)}%;background:${barColor}"></span></div>`,
      `</div>`
    ].join('');

    tr.appendChild(nameTd);
    tr.appendChild(total10Td);

    tr.addEventListener('click', () => {
      state.selectedCompanyId = item.company.id;
      renderDrilldown();
    });

    tbody.appendChild(tr);
  }

  $('generatedAt').textContent = state.report ? `Generated: ${new Date(state.report.generatedAt).toLocaleString()}` : '';
}

function renderDrilldown() {
  const companyId = state.selectedCompanyId;
  const detailTitle = $('detailTitle');
  const detailPill = $('detailPill');
  const detailBody = $('detailBody');

  if (!state.report) {
    detailTitle.textContent = 'Drilldown';
    detailPill.textContent = '';
    detailBody.classList.add('muted');
    detailBody.textContent = 'Unlock the report to view details.';
    return;
  }

  const item = state.report.companies.find((c) => c.company.id === companyId) || state.report.companies[0];
  if (!item) return;

  const totals = computeWeightedTotal(item.criteria, state.report.criteria);

  detailTitle.textContent = `${item.company.name} score breakdown`;
  detailPill.textContent = `${totals.totalScore10.toFixed(2)} / 10`;

  const parts = [];
  parts.push(`<div class="kv"><div class="muted">Website</div><div><a href="${item.company.website}" target="_blank" rel="noreferrer">${item.company.website}</a></div></div>`);
  parts.push(`<div class="kv"><div class="muted">Docs</div><div><a href="${item.company.docs}" target="_blank" rel="noreferrer">${item.company.docs}</a></div></div>`);
  parts.push(`<div class="section"><h3>Overall</h3><div class="muted">${escapeHtml(item.overallSummary || '')}</div></div>`);

  const criteriaById = new Map(state.report.criteria.map((c) => [c.id, c]));

  parts.push(`<div class="section"><h3>Criteria</h3></div>`);
  parts.push(`<div class="criteria-grid">`);

  // Ensure consistent ordering by report criteria definition
  const byId = new Map((item.criteria || []).map((x) => [x.id, x]));
  for (const def of state.report.criteria) {
    const c = byId.get(def.id);
    const score = typeof c?.score === 'number' ? c.score : 0;
    const badge = scoreBadge(score);
    const band = scoreBand(score);
    const crit = criticalityLabel(def.weight);
    parts.push(`<div class="criteria-card ${band}">`);
    parts.push(`<div class="criteria-card-head">`);
    parts.push(`<div class="criteria-title">${escapeHtml(def.name)}</div>`);
    parts.push(`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
      <span class="pill crit ${band}">${escapeHtml(crit)} ×${def.weight}</span>
      <span class="badge ${badge.cls}">${badge.label}</span>
    </div>`);
    parts.push(`</div>`);

    parts.push(`<div class="criteria-body">`);
    parts.push(`<div>${escapeHtml(c?.analysis || '')}</div>`);
    if (Array.isArray(c?.evidence) && c.evidence.length) {
      parts.push(`<div class="muted small" style="margin-top:6px;">Evidence to verify</div>`);
      parts.push(`<ul>${c.evidence.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
    }
    if (Array.isArray(c?.advice) && c.advice.length) {
      parts.push(`<div class="muted small" style="margin-top:6px;">Advice</div>`);
      parts.push(`<ul>${c.advice.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
    }

    if (def.id === 'llms_txt' || def.id === 'llms_full_txt') {
      parts.push(renderLlmsExperiments(item, def.id));
    }
    parts.push(`</div>`);
    parts.push(`</div>`);
  }

  parts.push(`</div>`);

  detailBody.classList.remove('muted');
  detailBody.innerHTML = parts.join('');
}

function renderCouchbase() {
  const body = $('couchbaseBody');
  if (!state.report) {
    body.classList.add('muted');
    body.textContent = 'Unlock the report to view Couchbase recommendations.';
    return;
  }

  const advice = state.report.couchbaseAdvice;
  if (!advice) {
    body.classList.add('muted');
    body.textContent = 'No Couchbase recommendations present in report.';
    return;
  }

  const couchbase = state.report.companies.find((c) => c.company.id === 'couchbase');
  const totals = couchbase ? computeWeightedTotal(couchbase.criteria, state.report.criteria) : null;

  const parts = [];
  if (totals) {
    parts.push(`<div class="kv"><div class="muted">Couchbase total</div><div><span class="badge mid">${totals.totalScore10.toFixed(2)} / 10</span></div></div>`);
  }

  if (Array.isArray(advice.topFindings) && advice.topFindings.length) {
    parts.push('<div class="section"><h3>Top findings</h3>');
    parts.push(`<ul>${advice.topFindings.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
    parts.push('</div>');
  }

  if (Array.isArray(advice.nextBestActions) && advice.nextBestActions.length) {
    parts.push('<div class="section"><h3>Next best actions (prioritized)</h3>');
    parts.push('<div>');
    for (const a of advice.nextBestActions) {
      parts.push(`<div class="section">`);
      parts.push(`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`);
      parts.push(`<div style="font-weight:700;">${escapeHtml(a.title || '')}</div>`);
      parts.push(`<span class="pill">Impact: ${escapeHtml(a.impact || '')}</span>`);
      parts.push(`<span class="pill">Effort: ${escapeHtml(a.effort || '')}</span>`);
      parts.push(`</div>`);
      if (a.why) parts.push(`<div class="muted" style="margin-top:6px;">${escapeHtml(a.why)}</div>`);
      if (Array.isArray(a.how) && a.how.length) {
        parts.push(`<ul>${a.how.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
      }
      parts.push(`</div>`);
    }
    parts.push('</div>');
    parts.push('</div>');
  }

  if (Array.isArray(advice.criteriaSpecificPlan) && advice.criteriaSpecificPlan.length) {
    parts.push('<div class="section"><h3>Criteria-specific plan</h3>');
    for (const p of advice.criteriaSpecificPlan) {
      parts.push(`<div class="section">`);
      parts.push(`<div style="font-weight:700;">${escapeHtml(p.criteriaId || '')}</div>`);
      if (Array.isArray(p.whatToDo) && p.whatToDo.length) {
        parts.push(`<div class="muted small" style="margin-top:6px;">What to do</div>`);
        parts.push(`<ul>${p.whatToDo.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
      }
      if (Array.isArray(p.howToValidate) && p.howToValidate.length) {
        parts.push(`<div class="muted small" style="margin-top:6px;">How to validate</div>`);
        parts.push(`<ul>${p.howToValidate.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
      }
      parts.push(`</div>`);
    }
    parts.push('</div>');
  }

  if (Array.isArray(advice.measurements) && advice.measurements.length) {
    parts.push('<div class="section"><h3>How to measure progress</h3>');
    parts.push(`<ul>${advice.measurements.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
    parts.push('</div>');
  }

  body.classList.remove('muted');
  body.innerHTML = parts.join('');
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadMeta() {
  try {
    const res = await fetch('./data/meta.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadEncrypted() {
  const res = await fetch('./data/report.encrypted.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load report: ${res.status}`);
  return await res.json();
}

async function reloadAll() {
  setError('');
  state.meta = await loadMeta();
  if (state.meta) {
    setMetaLine(`Latest build: ${new Date(state.meta.generatedAt).toLocaleString()} | Model: ${state.meta.model}`);
  } else {
    setMetaLine('No meta available yet. Run the workflow to generate the first report.');
  }
  state.encrypted = await loadEncrypted();
}

function updateWorkflowLink() {
  const link = $('runWorkflowLink');
  // Best-effort: user can replace in README with exact URL for their repo.
  link.href = 'https://github.com/TimLFletcher/AyeEye/actions/workflows/refresh-report.yml';
}

function getPasswordFromSession() {
  try {
    return sessionStorage.getItem('aidiscovery_password');
  } catch {
    return null;
  }
}

function setPasswordToSession(pw) {
  try {
    sessionStorage.setItem('aidiscovery_password', pw);
  } catch {
    // ignore
  }
}

function clearPasswordSession() {
  try {
    sessionStorage.removeItem('aidiscovery_password');
  } catch {
    // ignore
  }
}

async function promptForPassword({ force = false } = {}) {
  if (!force) {
    const existing = state.password || getPasswordFromSession();
    if (existing) {
      state.password = existing;
      return existing;
    }
  }

  const pw = window.prompt('Enter dashboard password');
  if (!pw) return null;
  state.password = pw;
  setPasswordToSession(pw);
  return pw;
}

async function unlock({ forcePrompt = false } = {}) {
  setError('');
  const password = await promptForPassword({ force: forcePrompt });
  if (!password) {
    setError('Password is required to view the report.');
    return;
  }

  try {
    const report = await decryptReport(password, state.encrypted);
    state.report = report;
    if (!state.selectedCompanyId) {
      const hasCouchbase = report.companies?.some((c) => c?.company?.id === 'couchbase');
      state.selectedCompanyId = hasCouchbase ? 'couchbase' : report.companies?.[0]?.company?.id || null;
    }
    renderScores();
    renderDrilldown();
    renderCouchbase();
  } catch (e) {
    state.report = null;
    setError(`Unable to unlock report.\n${e?.message || e}`);
  }
}

$('reloadBtn').addEventListener('click', async () => {
  setError('');
  try {
    await reloadAll();
    if (state.password || getPasswordFromSession()) {
      await unlock();
    }
  } catch (e) {
    setError(e?.message || String(e));
  }
});

window.addEventListener('keydown', async (e) => {
  if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    clearPasswordSession();
    state.password = null;
    await unlock({ forcePrompt: true });
  }
});

updateWorkflowLink();

(async () => {
  try {
    await reloadAll();
    await unlock();
  } catch (e) {
    setError(e?.message || String(e));
  }
})();
