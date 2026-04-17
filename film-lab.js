// ── CONSTANTS ──────────────────────────────────────────────────────────────

// SHA-256 of "darkroom" — change by running: echo -n "yourpassword" | shasum -a 256
const PASSWORD_HASH = 'c6a31148a73f1db678218c65c55b395d76aa11d6b6c6407634f0399963b1af5e';

const TEST_ROLL_MANIFEST = './test-roll/manifest.json';

const SESSION_KEY         = 'filmlab_auth';
const MODEL               = 'claude-sonnet-4-6';
const CLASSIFIER_URL      = 'https://analog-image-classifier.onrender.com';
const ANTHROPIC_PROXY     = `${CLASSIFIER_URL}/anthropic/messages`;
const RUNWAY_PROXY        = `${CLASSIFIER_URL}/runway`;
const MIN_GOOD_CONFIDENCE = 0.65; // "good" below this confidence is treated as uncertain → removed

const SERENE_PROMPT = 'Barely perceptible, dreamlike movement — soft breeze through foliage, gentle light shift, slow cloud or water surface motion. The first and last frames must be visually identical so the clip loops without any visible jump. Preserve film grain, color palette, and composition exactly. 5 seconds, 24fps. Serene, meditative, cinematic.';

// ── STATE ───────────────────────────────────────────────────────────────────

let photos        = [];
let removedPhotos = [];
let isAnalyzing   = false;
let portfolioHTML = null;

// ── UTILS ───────────────────────────────────────────────────────────────────

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resizeDataUrl(dataUrl, maxPx = 1920) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else        { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.src = dataUrl;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── CLASSIFIER ───────────────────────────────────────────────────────────────

const CLASS_LABELS = {
  good:           'Good',
  blurry:         'Blurry',
  over_exposed:   'Overexposed',
  under_exposed:  'Underexposed',
  light_exposure: 'Light leak',
};

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bytes = atob(data);
  const arr   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function checkClassifierHealth() {
  try {
    const res = await fetch(`${CLASSIFIER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function classifyPhoto(dataUrl) {
  const form = new FormData();
  form.append('image', dataUrlToBlob(dataUrl), 'photo.jpg');
  const res = await fetch(`${CLASSIFIER_URL}/predict`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Classifier ${res.status}`);
  return await res.json(); // { class, confidence }
}

function setClassifierStatus(online) {
  const dot  = document.getElementById('classifier-dot');
  const text = document.getElementById('classifier-text');
  if (!dot || !text) return;
  dot.className    = `classifier-dot ${online ? 'online' : 'offline'}`;
  text.textContent = online ? 'Classifier online' : 'Classifier offline';
}

// ── AUTH ────────────────────────────────────────────────────────────────────

const isLoggedIn  = () => sessionStorage.getItem(SESSION_KEY) === '1';
const setLoggedIn = () => sessionStorage.setItem(SESSION_KEY, '1');
const logout      = () => { sessionStorage.clear(); location.reload(); };

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a film photography instructor. Terse, direct, no flattery.

For each photo give brief technical notes only — one phrase per category, plainly stated. No praise, no hedging, no rating.

title is poetic and specific to this image — a fragment, a feeling, an unexpected word or phrase lightly suggested by the composition, light quality, subject, or mood. Avoid generic titles. Each should feel like it could only belong to this particular frame.

animatable: true if the photo contains NO people and the subject (nature, landscape, sky, water, foliage, architecture) would benefit from subtle looping motion. false for portraits, group shots, or subjects where motion would look unnatural.

Respond with valid JSON only — no markdown, no extra text:

{
  "title": "<abstract title>",
  "teacherFeedback": "<1–2 sentences of direct technical observation>",
  "animatable": true,
  "technical": {
    "exposure": "<one phrase>",
    "lighting": "<one phrase>",
    "composition": "<one phrase>",
    "film": "<stock or format if identifiable, otherwise omit>"
  }
}`;

// ── EVALUATION CRITERIA (loaded from evaluation-criteria.json at runtime) ────

let _criteriaCache = null;

async function fetchEvaluationCriteria() {
  if (_criteriaCache) return _criteriaCache;
  try {
    const res = await fetch('./evaluation-criteria.json', { cache: 'no-store' });
    if (res.ok) _criteriaCache = await res.json();
  } catch (e) {
    console.warn('Could not load evaluation-criteria.json, using fallback:', e.message);
  }
  return _criteriaCache;
}

function buildJudgePrompt(criteria) {
  if (!criteria) {
    // Fallback if file unavailable
    return `You are a senior photo editor evaluating a film photography instructor's analysis. Score the analysis — not the photo.
Criteria (1–5 each): title (specific to this frame), feedback (precise and causal), consistency (notes support assessment).
Respond with valid JSON only: { "scores": { "title": <int>, "feedback": <int>, "consistency": <int> }, "overall": <float>, "note": "<weakest element>", "flags": [] }`;
  }

  const criteriaBlock = criteria.criteria.map(c => {
    const levels = Object.entries(c.levels)
      .map(([score, desc]) => `    ${score}: ${desc}`)
      .join('\n');
    return `  ${c.name} (id: "${c.id}")\n  ${c.description}\n${levels}`;
  }).join('\n\n');

  const scoreFields = criteria.criteria.map(c => `"${c.id}": <int 1-5>`).join(', ');
  const criteriaIds = criteria.criteria.map(c => `"${c.id}"`).join(', ');

  return `You are a senior photo editor evaluating the quality of a film photography instructor's written analysis. Score the analysis — not the photo.

Criteria loaded from evaluation-criteria.json (score each 1–5):

${criteriaBlock}

Passing threshold: ${criteria.passing_threshold}/5. Flag threshold: ${criteria.flag_threshold}/5.
${criteria.improvement_rule}

Respond with valid JSON only — no markdown:
{
  "scores": { ${scoreFields} },
  "overall": <float one decimal — unweighted average of all criteria>,
  "note": "<one sentence identifying the single weakest element>",
  "flags": [<criterion ids where score is at or below ${criteria.flag_threshold}, chosen from: ${criteriaIds}>]
}`;
}

// ── CLAUDE API ───────────────────────────────────────────────────────────────

async function analyzePhotoWithClaude(dataUrl, classification = null) {
  const base64    = dataUrl.split(',')[1];
  const mediaType = dataUrl.split(';')[0].split(':')[1];

  const res = await fetch(ANTHROPIC_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: classification
              ? `Evaluate this film photograph. Classifier pre-screened as "${classification.class}" (${Math.round(classification.confidence * 100)}% confidence) — use as context only.`
              : 'Evaluate this film photograph.'
          }
        ]
      }]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data  = await res.json();
  const raw   = data.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse response from instructor.');
  return JSON.parse(match[0]);
}

async function judgeAnalysis(photo) {
  if (!photo.analysis) return;
  const base64    = photo.dataUrl.split(',')[1];
  const mediaType = photo.dataUrl.split(';')[0].split(':')[1];

  const criteria = await fetchEvaluationCriteria();
  const prompt   = buildJudgePrompt(criteria);

  const context = `Instructor's analysis:
Title: "${photo.analysis.title}"
Feedback: "${photo.analysis.teacherFeedback}"
Exposure: ${photo.analysis.technical?.exposure || '—'}
Lighting: ${photo.analysis.technical?.lighting || '—'}
Composition: ${photo.analysis.technical?.composition || '—'}`;

  try {
    const res = await fetch(ANTHROPIC_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 250,
        system: prompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: context }
        ]}]
      })
    });
    if (!res.ok) return;
    const data  = await res.json();
    const match = data.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return;
    photo.judgeScore = JSON.parse(match[0]);
    updateCardJudge(photo);
    showEvalReportBtn();
  } catch (e) {
    console.warn('Judge skipped:', e.message);
  }
}

function updateCardJudge(photo) {
  const el = document.getElementById(`judge-${photo.id}`);
  if (!el || !photo.judgeScore) return;
  const { overall, note, scores, flags = [] } = photo.judgeScore;
  const color = overall >= 4 ? '#4caf7d' : overall >= 3 ? '#c8a830' : '#e06060';
  const tooltip = Object.entries(scores || {})
    .map(([k, v]) => `${k}: ${v}/5`).join(' · ');
  const flagBadge = flags.length
    ? `<span class="judge-flag" title="Flagged: ${flags.join(', ')}">⚑</span>` : '';
  el.innerHTML = `
    <span class="judge-score" style="color:${color}" title="${tooltip}">${overall}/5</span>
    ${flagBadge}
    <span class="judge-note">${escapeHtml(note)}</span>`;
}

function showEvalReportBtn() {
  const btn = document.getElementById('eval-report-btn');
  if (btn && photos.some(p => p.judgeScore)) btn.classList.remove('hidden');
}

// ── EVALUATION REPORT ────────────────────────────────────────────────────────

function generateEvaluationReport() {
  const criteria = _criteriaCache;
  const judged   = photos.filter(p => p.judgeScore);
  if (!judged.length) return;

  const criteriaList  = criteria?.criteria || [
    { id: 'title', name: 'Title Specificity' },
    { id: 'feedback', name: 'Feedback Precision' },
    { id: 'consistency', name: 'Internal Consistency' },
  ];
  const nameMap       = Object.fromEntries(criteriaList.map(c => [c.id, c.name]));
  const passingThresh = criteria?.passing_threshold ?? 3.5;
  const flagThresh    = criteria?.flag_threshold    ?? 3.0;

  // Per-criterion averages
  const avgScores = {};
  criteriaList.forEach(({ id }) => {
    const vals = judged.map(p => p.judgeScore.scores?.[id]).filter(v => v != null);
    avgScores[id] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

  const overallVals = judged.map(p => p.judgeScore.overall).filter(v => v != null);
  const overallAvg  = overallVals.length
    ? overallVals.reduce((a, b) => a + b, 0) / overallVals.length : null;

  // Areas for improvement: criteria below passing threshold
  const improvements = criteriaList
    .filter(({ id }) => avgScores[id] != null && avgScores[id] < passingThresh)
    .map(({ id, name, description }) => {
      const flagged = judged.filter(p => (p.judgeScore.scores?.[id] ?? 5) <= flagThresh);
      return {
        criterion: name,
        description,
        average_score: avgScores[id]?.toFixed(1),
        passing_threshold: passingThresh,
        gap: (passingThresh - avgScores[id]).toFixed(1),
        photos_flagged: flagged.map(p => ({
          filename: p.file.name,
          score: p.judgeScore.scores?.[id],
          note: p.judgeScore.note,
        })),
      };
    });

  const report = {
    title: 'Film Lab — Evaluation Report',
    criteria_source: 'evaluation-criteria.json',
    generated: new Date().toISOString(),

    summary: {
      photos_analyzed:      photos.length,
      photos_with_scores:   judged.length,
      overall_average:      overallAvg != null ? `${overallAvg.toFixed(1)}/5` : '—',
      criterion_averages:   Object.fromEntries(
        criteriaList.map(({ id, name }) => [name, avgScores[id] != null ? `${avgScores[id].toFixed(1)}/5` : '—'])
      ),
      passing_threshold:    `${passingThresh}/5`,
      flag_threshold:       `${flagThresh}/5`,
      photos_below_flag:    judged.filter(p => p.judgeScore.overall <= flagThresh).length,
    },

    areas_for_improvement: improvements.length > 0
      ? improvements
      : [{ message: 'All criteria meet or exceed the passing threshold.' }],

    per_photo_evaluations: judged.map(p => ({
      filename:         p.file.name,
      instructor_title: p.analysis?.title || '',
      overall:          p.judgeScore.overall,
      scores:           Object.fromEntries(
        Object.entries(p.judgeScore.scores || {}).map(([id, v]) => [nameMap[id] || id, v])
      ),
      flags:            (p.judgeScore.flags || []).map(id => nameMap[id] || id),
      note:             p.judgeScore.note,
    })),
  };

  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url,
    download: `film-lab-evaluation-${new Date().toISOString().slice(0, 10)}.json`,
  }).click();
  URL.revokeObjectURL(url);
}

// ── PORTFOLIO HTML GENERATOR ─────────────────────────────────────────────────

function buildPortfolioHTML(picks) {
  const items = picks.map(p => /* html */`
    <div class="pf-item">
      <div class="pf-img-wrap">
        <img src="${p.dataUrl}" alt="${escapeHtml(p.analysis?.title || p.file.name)}" loading="lazy">
      </div>
      <div class="pf-meta">
        <span class="pf-title">${escapeHtml(p.analysis?.title || p.file.name)}</span>
      </div>
    </div>
  `).join('\n');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>35mm Film Portfolio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inria+Sans:ital,wght@0,300;0,400;0,700;1,300;1,400;1,700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: rgb(245,245,244); font-family: "Inria Sans", sans-serif; }
    .pf-header { padding: 4rem 5% 2.5rem; }
    .pf-header h1 { font-size: 36pt; font-weight: 300; letter-spacing: 0.04em; }
    .pf-header p { font-size: 13pt; color: #888; margin-top: 0.5rem; font-style: italic; }
    .pf-grid { columns: 3; column-gap: 1.5rem; padding: 0 5% 5rem; max-width: 1400px; margin: 0 auto; }
    @media (max-width: 900px) { .pf-grid { columns: 2; } }
    @media (max-width: 560px) { .pf-grid { columns: 1; } }
    .pf-item { break-inside: avoid; margin-bottom: 1.75rem; }
    .pf-img-wrap { border-radius: 6px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.12); background: #000; }
    .pf-img-wrap img { width: 100%; height: auto; display: block; }
    .pf-meta { padding: 0.5rem 0.25rem 0; }
    .pf-title { font-size: 11pt; color: #555; font-style: italic; }
  </style>
</head>
<body>
  <header class="pf-header">
    <h1>35mm Film</h1>
    <p>Selected frames</p>
  </header>
  <div class="pf-grid">
${items}
  </div>
</body>
</html>`;
}

// ── PHOTO MANAGEMENT ─────────────────────────────────────────────────────────

async function loadTestRoll() {
  const btn = document.getElementById('test-roll-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const filenames = await fetch(TEST_ROLL_MANIFEST, { cache: 'no-store' }).then(r => r.json());

    if (!filenames.length) {
      btn.textContent = 'No test photos yet';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'load test roll'; }, 2000);
      return;
    }

    for (const name of filenames) {
      try {
        const resp    = await fetch(`./test-roll/${encodeURIComponent(name)}`);
        if (!resp.ok) continue;
        const blob    = await resp.blob();
        const file    = new File([blob], name, { type: blob.type || 'image/jpeg' });
        const dataUrl = await readFileAsDataUrl(file);
        const photo   = { id: uid(), file, dataUrl, status: 'pending', analysis: null };
        photos.push(photo);
        document.getElementById('photos-grid').appendChild(buildCard(photo));
      } catch (e) {
        console.warn('Could not load test photo:', name);
      }
    }

    updateCount();
    if (photos.length) {
      document.getElementById('photos-section').classList.remove('hidden');
      developRoll();
    }
  } catch (e) {
    console.error('Failed to load test roll:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'load test roll';
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (!files.length) return;

  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const photo   = { id: uid(), file, dataUrl, status: 'pending', analysis: null };
    photos.push(photo);
    document.getElementById('photos-grid').appendChild(buildCard(photo));
  }

  updateCount();
  document.getElementById('photos-section').classList.remove('hidden');
  developRoll();
}

function removePhoto(id) {
  const photo = photos.find(p => p.id === id);
  if (!photo) return;
  photos = photos.filter(p => p.id !== id);
  document.getElementById(`card-${id}`)?.remove();
  photo.status = 'removed-manual';
  removedPhotos.push(photo);
  updateCount();
  updateRemovedNav();
  if (photos.length === 0) document.getElementById('photos-section').classList.add('hidden');
}

function clearAll() {
  photos        = [];
  removedPhotos = [];
  portfolioHTML = null;
  document.getElementById('photos-grid').innerHTML    = '';
  document.getElementById('portfolio-grid').innerHTML = '';
  document.getElementById('removed-grid').innerHTML   = '';
  document.getElementById('photos-section').classList.add('hidden');
  document.getElementById('portfolio-section').classList.add('hidden');
  document.getElementById('portfolio-download-section').classList.add('hidden');
  document.getElementById('filter-notice').classList.add('hidden');
  updateCount();
  updateRemovedNav();
  updateRollButtons();
}

function updateCount() {
  const n = photos.length;
  document.getElementById('photo-count').textContent =
    n ? `(${n} frame${n !== 1 ? 's' : ''})` : '';
}

// ── CARD BUILDERS ─────────────────────────────────────────────────────────────

function buildCard(photo) {
  const div = document.createElement('div');
  div.className = 'photo-card';
  div.id = `card-${photo.id}`;
  div.innerHTML = /* html */`
    <div class="photo-card-img-wrap">
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.file.name)}">
      <button class="photo-card-remove" title="Remove">✕</button>
      <span class="status-badge status-pending" id="status-${photo.id}">Pending</span>
    </div>
    <div class="photo-card-body" id="body-${photo.id}">
      <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
    </div>
  `;
  div.querySelector('.photo-card-remove').addEventListener('click', () => removePhoto(photo.id));
  return div;
}

function setCardAnalyzing(photo) {
  const badge = document.getElementById(`status-${photo.id}`);
  if (badge) { badge.className = 'status-badge status-analyzing'; badge.textContent = 'Developing…'; }
  const body = document.getElementById(`body-${photo.id}`);
  if (body) {
    body.innerHTML = /* html */`
      <div class="card-loading">
        <div class="spinner"></div>
      </div>`;
  }
}

function setCardDone(photo) {
  const card = document.getElementById(`card-${photo.id}`);
  if (!card) return;

  if (photo.inPortfolio) card.classList.add('portfolio-pick');

  const badge = document.getElementById(`status-${photo.id}`);
  if (badge) badge.className = 'status-badge status-done';

  const body = document.getElementById(`body-${photo.id}`);
  if (!body) return;

  const { analysis } = photo;
  const t = analysis.technical || {};

  const filmLine = t.film ? `
      <div class="tech-item">
        <span class="tech-label">Film</span>
        <span class="tech-value">${escapeHtml(t.film)}</span>
      </div>` : '';

  const clsBadge = photo.classification
    ? `<span class="cls-badge cls-${photo.classification.class.replace(/_/g, '-')}">${CLASS_LABELS[photo.classification.class] || photo.classification.class} · ${(photo.classification.confidence * 100).toFixed(2)}%</span>`
    : '';

  body.innerHTML = /* html */`
    <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
    ${clsBadge}
    <p class="photo-card-title">${escapeHtml(analysis.title || '')}</p>
    <p class="photo-card-feedback">${escapeHtml(analysis.teacherFeedback || '')}</p>
    <div class="technical-grid">
      <div class="tech-item">
        <span class="tech-label">Exposure</span>
        <span class="tech-value">${escapeHtml(t.exposure || '—')}</span>
      </div>
      <div class="tech-item">
        <span class="tech-label">Lighting</span>
        <span class="tech-value">${escapeHtml(t.lighting || '—')}</span>
      </div>
      <div class="tech-item">
        <span class="tech-label">Composition</span>
        <span class="tech-value">${escapeHtml(t.composition || '—')}</span>
      </div>${filmLine}
    </div>
    <div class="card-actions">
      <button class="portfolio-toggle${photo.inPortfolio ? ' in-portfolio' : ''}" id="toggle-${photo.id}">
        ${photo.inPortfolio ? '★ In Portfolio' : '+ Add to Portfolio'}
      </button>
    </div>
    <div class="judge-row" id="judge-${photo.id}">
      <span class="judge-loading">Peer reviewing…</span>
    </div>`;

  body.querySelector('.portfolio-toggle').addEventListener('click', () => togglePortfolio(photo.id));
}

function setCardError(photo, message) {
  const badge = document.getElementById(`status-${photo.id}`);
  if (badge) { badge.className = 'status-badge status-error'; badge.textContent = 'Error'; }
  const body = document.getElementById(`body-${photo.id}`);
  if (body) body.innerHTML = /* html */`
    <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
    <p class="error-msg" style="padding:0.75rem 0;">${escapeHtml(message)}</p>`;
}

// ── PORTFOLIO TOGGLE ──────────────────────────────────────────────────────────

function togglePortfolio(id) {
  const photo = photos.find(p => p.id === id);
  if (!photo || photo.status !== 'done') return;

  photo.inPortfolio = !photo.inPortfolio;
  document.getElementById(`card-${id}`)?.classList.toggle('portfolio-pick', photo.inPortfolio);

  const btn = document.getElementById(`toggle-${id}`);
  if (btn) {
    btn.textContent = photo.inPortfolio ? '★ In Portfolio' : '+ Add to Portfolio';
    btn.classList.toggle('in-portfolio', photo.inPortfolio);
  }

  renderPortfolioSection();
  updateRollButtons();
}

// ── DEVELOP ROLL ──────────────────────────────────────────────────────────────

async function developRoll() {
  if (isAnalyzing) return;

  const pending = photos.filter(p => p.status !== 'done');
  if (!pending.length) return;

  isAnalyzing = true;
  const btn = document.getElementById('analyze-btn');
  btn.disabled = true; btn.textContent = 'Classifying…';

  pending.forEach(p => { p.status = 'analyzing'; setCardAnalyzing(p); });

  // ── Phase 1: classify all in parallel ──
  const classifierUp = await checkClassifierHealth();
  setClassifierStatus(classifierUp);

  if (classifierUp) {
    await Promise.all(pending.map(async photo => {
      try { photo.classification = await classifyPhoto(photo.dataUrl); }
      catch (err) { photo.classification = null; console.warn('Classification skipped:', photo.file.name, err.message); }
    }));

    // Remove: not "good" OR "good" with low confidence
    const bad = pending.filter(p =>
      p.classification && (
        p.classification.class !== 'good' ||
        p.classification.confidence < MIN_GOOD_CONFIDENCE
      )
    );

    if (bad.length) {
      bad.forEach(p => {
        photos = photos.filter(x => x.id !== p.id);
        document.getElementById(`card-${p.id}`)?.remove();
        p.status = 'removed-classifier';
        removedPhotos.push(p);
      });
      showFilterNotice(bad);
      updateCount();
      updateRemovedNav();
    }
  }

  // ── Phase 2: Review remaining photos ──
  const toAnalyze = photos.filter(p => p.status === 'analyzing');

  if (!toAnalyze.length) {
    isAnalyzing = false; btn.disabled = false; btn.textContent = 'Develop Roll →';
    if (!photos.length) document.getElementById('photos-section').classList.add('hidden');
    return;
  }

  btn.textContent = 'Developing…';

  await Promise.all(toAnalyze.map(async photo => {
    try {
      const resized  = await resizeDataUrl(photo.dataUrl);
      photo.analysis = await analyzePhotoWithClaude(resized, photo.classification ?? null);
      photo.status   = 'done';
      setCardDone(photo);
      judgeAnalysis(photo); // fire-and-forget: updates card when ready
    } catch (err) {
      photo.status = 'error';
      setCardError(photo, err.message || 'Analysis failed.');
      console.error(err);
    }
  }));

  isAnalyzing = false; btn.disabled = false; btn.textContent = 'Develop Roll →';
  updateRollButtons();
  renderPortfolioSection();

  // Auto-animate portfolio picks Claude flagged as suitable (no people, nature/landscape content)
  photos.filter(p => p.inPortfolio && p.analysis?.animatable === true).forEach(p => animatePhoto(p));
}

function showFilterNotice(removed) {
  const counts = {};
  removed.forEach(p => {
    const cls = p.classification?.class || 'unknown';
    counts[cls] = (counts[cls] || 0) + 1;
  });
  const parts = Object.entries(counts)
    .map(([cls, n]) => `${n} ${(CLASS_LABELS[cls] || cls).toLowerCase()}`);
  const notice = document.getElementById('filter-notice');
  const text   = document.getElementById('filter-notice-text');
  if (!notice || !text) return;
  text.textContent = `Moved ${removed.length} photo${removed.length !== 1 ? 's' : ''} to Removed: ${parts.join(', ')}.`;
  notice.classList.remove('hidden');
}

// ── ROLL BUTTONS ──────────────────────────────────────────────────────────────

function updateRollButtons() {
  const hasPortfolio = photos.some(p => p.inPortfolio);
  const hasNonPortfolioAnalyzed = photos.some(p => !p.inPortfolio && p.status === 'done');
  const keepBtn = document.getElementById('keep-portfolio-btn');
  keepBtn.classList.toggle('hidden', !hasPortfolio || !hasNonPortfolioAnalyzed);
  updateRemovedNav();
  renderRemovedView();
  renderPortfolioSection();
  if (photos.length === 0) document.getElementById('photos-section').classList.add('hidden');
}

function keepPortfolioOnly() {
  const toRemove = photos.filter(p => !p.inPortfolio);
  toRemove.forEach(p => {
    photos = photos.filter(x => x.id !== p.id);
    document.getElementById(`card-${p.id}`)?.remove();
    p.status = p.status === 'done' ? 'removed-cleanup' : 'removed-classifier';
    removedPhotos.push(p);
  });
  updateCount();
  updateRollButtons();
  updateRemovedNav();
  renderRemovedView();
  if (photos.length === 0) document.getElementById('photos-section').classList.add('hidden');
}

// ── REMOVED VIEW ──────────────────────────────────────────────────────────────

function showRemovedView() {
  document.getElementById('view-roll').classList.add('hidden');
  document.getElementById('view-removed').classList.remove('hidden');
  document.getElementById('back-to-site').style.display = 'none';
  document.getElementById('back-to-roll-btn').style.display = '';
  renderRemovedView();
}

function showRollView() {
  document.getElementById('view-removed').classList.add('hidden');
  document.getElementById('view-roll').classList.remove('hidden');
  document.getElementById('back-to-roll-btn').style.display = 'none';
  document.getElementById('back-to-site').style.display = '';
}

function updateRemovedNav() {
  const btn   = document.getElementById('removed-nav-btn');
  const count = document.getElementById('removed-count');
  const n     = removedPhotos.length;
  if (count) count.textContent = n;
  btn?.classList.toggle('hidden', n === 0);
}

function renderRemovedView() {
  const grid  = document.getElementById('removed-grid');
  const empty = document.getElementById('removed-empty');
  grid.innerHTML = '';

  if (removedPhotos.length === 0) {
    empty?.classList.remove('hidden');
    return;
  }

  empty?.classList.add('hidden');
  removedPhotos.forEach(p => grid.appendChild(buildRemovedCard(p)));
}

function buildRemovedCard(photo) {
  const div = document.createElement('div');
  div.className = 'photo-card';
  div.id = `removed-card-${photo.id}`;

  const clsBadge = photo.classification
    ? `<span class="cls-badge cls-${photo.classification.class.replace(/_/g, '-')}">${CLASS_LABELS[photo.classification.class] || photo.classification.class} · ${(photo.classification.confidence * 100).toFixed(2)}%</span>`
    : '';

  let reason = 'Removed';
  if (photo.status === 'removed-classifier' && photo.classification) {
    const label = CLASS_LABELS[photo.classification.class] || photo.classification.class;
    reason = photo.classification.class === 'good'
      ? `Uncertain classifier result (${(photo.classification.confidence * 100).toFixed(2)}% confidence)`
      : `Removed by classifier — ${label}`;
  } else if (photo.status === 'removed-cleanup') {
    reason = 'Flagged and removed';
  } else if (photo.status === 'removed-manual') {
    reason = 'Manually removed';
  }

  const feedbackLine = photo.analysis?.teacherFeedback
    ? `<p class="photo-card-feedback">${escapeHtml(photo.analysis.teacherFeedback)}</p>` : '';

  div.innerHTML = /* html */`
    <div class="photo-card-img-wrap">
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.file.name)}">
      <button class="photo-card-remove" title="Delete permanently">✕</button>
    </div>
    <div class="photo-card-body">
      <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
      ${clsBadge}
      <p class="removed-reason">${escapeHtml(reason)}</p>
      ${feedbackLine}
      <button class="primary-btn recover-btn" id="recover-${photo.id}">Recover to Portfolio</button>
    </div>
  `;

  div.querySelector('.photo-card-remove').addEventListener('click', () => deleteFromRemoved(photo.id));
  div.querySelector('.recover-btn').addEventListener('click', () => addToPortfolioFromRemoved(photo.id));
  return div;
}

function deleteFromRemoved(id) {
  removedPhotos = removedPhotos.filter(p => p.id !== id);
  document.getElementById(`removed-card-${id}`)?.remove();
  updateRemovedNav();
  const empty = document.getElementById('removed-empty');
  if (removedPhotos.length === 0) empty?.classList.remove('hidden');
}

async function addToPortfolioFromRemoved(id) {
  const photo = removedPhotos.find(p => p.id === id);
  if (!photo) return;

  const btn = document.getElementById(`recover-${id}`);

  if (!photo.analysis) {
    if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
    try {
      const resized  = await resizeDataUrl(photo.dataUrl);
      photo.analysis = await analyzePhotoWithClaude(resized, photo.classification ?? null);
      judgeAnalysis(photo);
    } catch (e) {
      console.warn('Could not analyze recovered photo:', e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Recover to Portfolio'; }
    }
  }

  removedPhotos = removedPhotos.filter(p => p.id !== id);
  document.getElementById(`removed-card-${id}`)?.remove();

  photo.status      = 'done';
  photo.inPortfolio = true;
  photos.push(photo);

  updateRemovedNav();
  updateRollButtons();
  renderPortfolioSection();

  const empty = document.getElementById('removed-empty');
  if (removedPhotos.length === 0) empty?.classList.remove('hidden');
}

function clearAllRemoved() {
  removedPhotos = [];
  document.getElementById('removed-grid').innerHTML = '';
  document.getElementById('removed-empty')?.classList.remove('hidden');
  updateRemovedNav();
}

// ── SEAMLESS VIDEO LOOP ───────────────────────────────────────────────────────

function createSeamlessVideo(src) {
  const XFADE = 0.9;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:100%;overflow:hidden;';

  function makeVideo() {
    const v = document.createElement('video');
    v.src         = src;
    v.muted       = true;
    v.playsInline = true;
    v.autoplay    = true;
    v.loop        = false;
    v.style.cssText = 'width:100%;display:block;';
    return v;
  }

  function attachLoop(current) {
    current.addEventListener('timeupdate', function onUpdate() {
      if (!current.duration) return;
      if (current.duration - current.currentTime > XFADE) return;

      current.removeEventListener('timeupdate', onUpdate);

      const next = makeVideo();
      next.style.cssText += 'position:absolute;inset:0;opacity:0;';
      wrap.appendChild(next);
      next.play();

      requestAnimationFrame(() => {
        next.style.transition    = `opacity ${XFADE}s ease`;
        current.style.transition = `opacity ${XFADE}s ease`;
        next.style.opacity    = '1';
        current.style.opacity = '0';
      });

      setTimeout(() => {
        current.remove();
        next.style.cssText = 'width:100%;display:block;';
        attachLoop(next);
      }, XFADE * 1000 + 50);
    });
  }

  const first = makeVideo();
  wrap.appendChild(first);
  first.play();
  attachLoop(first);
  return wrap;
}

// ── ANIMATION ────────────────────────────────────────────────────────────────

async function animatePhoto(photo) {
  photo.animating = true;
  photo.animationError = null;
  refreshPortfolioCard(photo);

  try {
    const genRes = await fetch(`${RUNWAY_PROXY}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_image: photo.dataUrl, prompt_text: SERENE_PROMPT })
    });
    if (!genRes.ok) throw new Error(`Runway error ${genRes.status}`);
    const { task_id, error } = await genRes.json();
    if (error) throw new Error(error);

    for (let i = 0; i < 72; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const poll   = await fetch(`${RUNWAY_PROXY}/task/${task_id}`);
      const status = await poll.json();
      if (status.status === 'SUCCEEDED') {
        photo.videoUrl  = status.video_url;
        photo.animating = false;
        refreshPortfolioCard(photo);
        return;
      }
      if (status.status === 'FAILED') throw new Error(status.error || 'Animation failed');
    }
    throw new Error('Animation timed out');
  } catch (err) {
    photo.animating      = false;
    photo.animationError = err.message;
    refreshPortfolioCard(photo);
  }
}

function unAnimatePhoto(photo) {
  photo.videoUrl       = null;
  photo.animationError = null;
  refreshPortfolioCard(photo);
}

function refreshPortfolioCard(photo) {
  const card = document.getElementById(`pf-card-${photo.id}`);
  if (!card) return;

  const imgWrap = card.querySelector('.photo-card-img-wrap');
  const animBtn = card.querySelector('.animate-btn');

  if (photo.videoUrl) {
    imgWrap.innerHTML = '';
    imgWrap.appendChild(createSeamlessVideo(photo.videoUrl));
    if (animBtn) { animBtn.textContent = 'Un-animate'; animBtn.classList.add('animated'); animBtn.disabled = false; }
  } else if (photo.animating) {
    imgWrap.innerHTML = `<img src="${photo.dataUrl}" alt=""><div class="anim-overlay">Animating…</div>`;
    if (animBtn) { animBtn.textContent = 'Animating…'; animBtn.disabled = true; animBtn.classList.remove('animated'); }
  } else {
    imgWrap.innerHTML = `<img src="${photo.dataUrl}" alt="${escapeHtml(photo.analysis?.title || photo.file.name)}">`;
    if (animBtn) {
      animBtn.textContent = photo.animationError ? 'Retry' : 'Animate';
      animBtn.disabled = false;
      animBtn.classList.remove('animated');
    }
  }
}

// ── LOCATION / DATE METADATA ─────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

function formatDate(photo) {
  const m = photo.dateMonth;
  const y = photo.dateYear;
  if (!y && !m) return '';
  if (m && y) return `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
  return y || MONTHS[parseInt(m, 10) - 1];
}

function updateMetaOverlay(card, photo) {
  const locEl  = card.querySelector('.meta-loc');
  const dateEl = card.querySelector('.meta-date-display');
  if (locEl)  locEl.textContent  = photo.location || '';
  if (dateEl) dateEl.textContent = formatDate(photo);
}

// ── ADD TO SITE ───────────────────────────────────────────────────────────────

function buildSitePreviewHTML(photos, newFilename, newDataUrl) {
  const SITE = 'https://ndellamaria.github.io';
  const MO   = ['January','February','March','April','May','June','July',
                 'August','September','October','November','December'];

  const items = photos.map(p => {
    const isNew  = p.filename === newFilename;
    const imgSrc = isNew ? newDataUrl : `${SITE}/pics/${encodeURIComponent(p.filename)}`;
    const month  = p.month ? MO[parseInt(p.month, 10) - 1] : '';
    const date   = [month, p.year].filter(Boolean).join(' ');

    const overlayContent = p.location || date
      ? `${p.location ? `<div class="overlay-location">${p.location}</div>` : ''}${date ? `<div class="overlay-date">${date}</div>` : ''}`
      : (isNew ? '<div class="overlay-location">NEW</div>' : '');

    const overlay = overlayContent ? `<div class="overlay${isNew ? ' overlay-new' : ''}">${overlayContent}</div>` : '';

    return `<div class="portfolio-item${isNew ? ' is-new' : ''}">
  <img src="${imgSrc}" alt="${p.alt || ''}">
  ${overlay}
</div>`;
  }).join('\n');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inria+Sans:ital,wght@0,300;0,400&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:rgb(245,245,244);font-family:"Inria Sans",sans-serif;padding-bottom:4rem}
.preview-banner{background:#1a1a19;color:#e8e8e6;font-size:10pt;font-weight:300;padding:0.6rem 1.25rem;letter-spacing:0.03em}
.portfolio-title{padding:2rem 5% 1rem}
.portfolio-title h1{font-size:30pt;font-weight:300}
.portfolio{columns:4;column-gap:1.5rem;padding:0 1rem;max-width:1400px;margin:0 auto}
@media(max-width:1200px){.portfolio{columns:3}}
@media(max-width:900px){.portfolio{columns:2}}
.portfolio-item{break-inside:avoid;margin-bottom:1.5rem;position:relative;overflow:hidden;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);display:inline-block;width:100%;background:#000}
.portfolio-item.is-new{box-shadow:0 0 0 3px #5b8ff0,0 4px 20px rgba(91,143,240,.35)}
.portfolio-item img{width:100%;height:auto;display:block}
.overlay{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.72));color:#fff;padding:2rem 1rem .85rem;pointer-events:none}
.overlay-new{background:rgba(70,110,220,.82)}
.overlay-location{font-size:11pt;font-weight:300}
.overlay-date{font-size:9.5pt;font-weight:300;opacity:.7;margin-top:.1rem}
</style></head><body>
<div class="preview-banner">Preview — new photo highlighted in blue · videos not shown</div>
<div class="portfolio-title"><h1 class="film">35mm Film</h1></div>
<div class="portfolio">
${items}
</div></body></html>`;
}

async function addToSite(photo) {
  const modal  = document.getElementById('site-modal');
  const frame  = document.getElementById('site-preview-frame');
  const prBtn  = document.getElementById('open-pr-btn');
  const status = document.getElementById('pr-status');

  modal.classList.remove('hidden');
  frame.src = '';
  prBtn.disabled = true;
  prBtn.textContent = 'Building preview…';
  status.innerHTML = '';

  let currentPhotos = [];
  try {
    currentPhotos = await fetch('https://ndellamaria.github.io/portfolio-photos.json', { cache: 'no-store' }).then(r => r.json());
  } catch (e) { console.warn('Could not fetch live portfolio JSON:', e.message); }

  const safeName = photo.file.name.replace(/\s+/g, '-');
  const newEntry = {
    filename: safeName,
    alt: photo.analysis?.title || safeName,
    video: null,
    location: photo.location || '',
    month: photo.dateMonth || '',
    year: photo.dateYear || '',
  };

  const blob = new Blob([buildSitePreviewHTML([...currentPhotos, newEntry], safeName, photo.dataUrl)], { type: 'text/html' });
  frame.src = URL.createObjectURL(blob);

  prBtn.disabled = false;
  prBtn.textContent = 'Open PR on GitHub →';

  prBtn.onclick = async () => {
    prBtn.disabled = true;
    prBtn.textContent = 'Opening PR…';
    status.innerHTML = '';
    try {
      const res = await fetch(`${CLASSIFIER_URL}/github/add-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: photo.dataUrl.split(',')[1],
          filename: safeName,
          meta: {
            title:    photo.analysis?.title || '',
            location: photo.location || '',
            month:    photo.dateMonth || '',
            year:     photo.dateYear || '',
          }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      prBtn.textContent = 'PR opened ✓';
      status.innerHTML = `<a href="${data.pr_url}" target="_blank" rel="noopener">View PR #${data.pr_number} →</a>`;
    } catch (err) {
      prBtn.disabled = false;
      prBtn.textContent = 'Open PR on GitHub →';
      status.textContent = `Error: ${err.message}`;
    }
  };
}

// ── PORTFOLIO SECTION ─────────────────────────────────────────────────────────

function renderPortfolioSection() {
  const picks   = photos.filter(p => p.inPortfolio);
  const section = document.getElementById('portfolio-section');
  const grid    = document.getElementById('portfolio-grid');
  grid.innerHTML = '';

  if (picks.length === 0) { section.classList.add('hidden'); return; }

  picks.forEach(p => grid.appendChild(buildPortfolioCard(p)));

  const n = picks.length;
  document.getElementById('portfolio-desc').textContent =
    `${n} frame${n !== 1 ? 's' : ''} selected for portfolio.`;
  section.classList.remove('hidden');
}

function buildPortfolioCard(photo) {
  const { analysis } = photo;
  const div = document.createElement('div');
  div.className = 'photo-card portfolio-pick';
  div.id = `pf-card-${photo.id}`;

  const animBtnText = photo.animating ? 'Animating…' : photo.videoUrl ? 'Un-animate' : 'Animate';

  div.innerHTML = /* html */`
    <div class="photo-card-img-wrap">
      ${photo.animating ? '<div class="anim-overlay">Animating…</div>' : ''}
      <div class="photo-meta-overlay">
        <span class="meta-loc">${escapeHtml(photo.location || '')}</span>
        <span class="meta-date-display">${formatDate(photo)}</span>
      </div>
    </div>
    <div class="photo-card-body">
      <p class="photo-card-title">${escapeHtml(analysis?.title || photo.file.name)}</p>
      <div class="meta-inputs">
        <input type="text" class="meta-input meta-location-input" placeholder="Location" value="${escapeHtml(photo.location || '')}">
        <select class="meta-input meta-month-input">
          <option value="">Month</option>
          ${MONTHS.map((m, i) => `<option value="${i + 1}"${photo.dateMonth == i + 1 ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
        <input type="number" class="meta-input meta-year-input" placeholder="Year" min="1900" max="${new Date().getFullYear()}" value="${photo.dateYear || ''}" style="width:5.5rem;flex:none;">
      </div>
      <div class="card-actions">
        <button class="portfolio-toggle in-portfolio" data-id="${photo.id}">★ Remove</button>
        <button class="animate-btn${photo.videoUrl ? ' animated' : ''}" ${photo.animating ? 'disabled' : ''} data-id="${photo.id}">${animBtnText}</button>
        <button class="add-to-site-btn" data-id="${photo.id}">+ Site</button>
      </div>
    </div>`;

  const imgWrap = div.querySelector('.photo-card-img-wrap');
  if (photo.videoUrl) {
    imgWrap.prepend(createSeamlessVideo(photo.videoUrl));
  } else {
    const img = document.createElement('img');
    img.src = photo.dataUrl;
    img.alt = escapeHtml(analysis?.title || photo.file.name);
    imgWrap.prepend(img);
  }

  div.querySelector('.portfolio-toggle').addEventListener('click', () => {
    photo.inPortfolio = false;
    const mainBtn = document.getElementById(`toggle-${photo.id}`);
    if (mainBtn) { mainBtn.textContent = '+ Add to Portfolio'; mainBtn.classList.remove('in-portfolio'); }
    document.getElementById(`card-${photo.id}`)?.classList.remove('portfolio-pick');
    renderPortfolioSection();
    updateRollButtons();
  });
  div.querySelector('.animate-btn').addEventListener('click', () => {
    photo.videoUrl ? unAnimatePhoto(photo) : animatePhoto(photo);
  });
  div.querySelector('.add-to-site-btn').addEventListener('click', () => addToSite(photo));

  div.querySelector('.meta-location-input').addEventListener('input', e => {
    photo.location = e.target.value;
    updateMetaOverlay(div, photo);
  });
  div.querySelector('.meta-month-input').addEventListener('change', e => {
    photo.dateMonth = e.target.value;
    updateMetaOverlay(div, photo);
  });
  div.querySelector('.meta-year-input').addEventListener('input', e => {
    photo.dateYear = e.target.value;
    updateMetaOverlay(div, photo);
  });

  return div;
}

async function exportPortfolio() {
  const picks = photos.filter(p => p.inPortfolio);
  if (!picks.length) return;

  const btn = document.getElementById('export-portfolio-btn');
  btn.disabled = true; btn.textContent = 'Generating…';

  try {
    const sized = await Promise.all(
      picks.map(async p => ({ ...p, dataUrl: await resizeDataUrl(p.dataUrl, 1200) }))
    );
    portfolioHTML = buildPortfolioHTML(sized);

    const blob  = new Blob([portfolioHTML], { type: 'text/html' });
    const url   = URL.createObjectURL(blob);
    document.getElementById('portfolio-frame').src = url;

    const dl = document.getElementById('portfolio-download-section');
    dl.classList.remove('hidden');
    dl.scrollIntoView({ behavior: 'smooth' });
  } finally {
    btn.disabled = false; btn.textContent = 'Export Portfolio →';
  }
}

function downloadPortfolio() {
  if (!portfolioHTML) return;
  const blob = new Blob([portfolioHTML], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'film-portfolio.html' }).click();
  URL.revokeObjectURL(url);
}

// ── SHOW APP ──────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  checkClassifierHealth().then(setClassifierStatus);
}

// ── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  if (isLoggedIn()) showApp();

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const hash = await sha256(document.getElementById('password-input').value);
    if (hash === PASSWORD_HASH) { setLoggedIn(); showApp(); }
    else document.getElementById('login-error').classList.remove('hidden');
  });

  // Drop zone
  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');

  document.getElementById('test-roll-btn').addEventListener('click', loadTestRoll);

  dropZone.addEventListener('click', e => {
    if (e.target.closest('label') || e.target === fileInput || e.target === folderInput) return;
    fileInput.click();
  });
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over'); addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change',   e => { addFiles(e.target.files); e.target.value = ''; });
  folderInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

  // Roll buttons
  document.getElementById('analyze-btn')           .addEventListener('click', developRoll);
  document.getElementById('filter-notice-dismiss') .addEventListener('click', () => document.getElementById('filter-notice').classList.add('hidden'));
  document.getElementById('add-more-btn')          .addEventListener('click', () => fileInput.click());
  document.getElementById('clear-btn')             .addEventListener('click', clearAll);
  document.getElementById('keep-portfolio-btn')    .addEventListener('click', keepPortfolioOnly);
  document.getElementById('eval-report-btn')       .addEventListener('click', generateEvaluationReport);
  document.getElementById('logout-btn')            .addEventListener('click', logout);
  document.getElementById('export-portfolio-btn')  .addEventListener('click', exportPortfolio);
  document.getElementById('download-portfolio-btn').addEventListener('click', downloadPortfolio);

  // Navigation
  document.getElementById('removed-nav-btn')    .addEventListener('click', showRemovedView);
  document.getElementById('back-to-roll-btn')   .addEventListener('click', showRollView);
  document.getElementById('clear-all-removed-btn').addEventListener('click', clearAllRemoved);

  // Site preview modal
  document.getElementById('close-site-modal-btn').addEventListener('click', () => {
    const modal = document.getElementById('site-modal');
    const frame = document.getElementById('site-preview-frame');
    if (frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
    frame.src = '';
    modal.classList.add('hidden');
  });

});
