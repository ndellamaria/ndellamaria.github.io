// ── CONSTANTS ──────────────────────────────────────────────────────────────

// SHA-256 of "darkroom" — change by running: echo -n "yourpassword" | shasum -a 256
const PASSWORD_HASH = 'c6a31148a73f1db678218c65c55b395d76aa11d6b6c6407634f0399963b1af5e';

const TEST_ROLL_MANIFEST = './test-roll/manifest.json';

const SESSION_KEY         = 'filmlab_auth';
const MODEL               = 'claude-sonnet-4-6';
const CLASSIFIER_URL      = 'https://analog-image-classifier.onrender.com';
const ANTHROPIC_PROXY     = `${CLASSIFIER_URL}/anthropic/messages`;
const MIN_GOOD_CONFIDENCE = 0.65; // "good" below this confidence is treated as uncertain → removed

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

title is abstract and opaque — a fragment, a feeling, a word. Never literal or descriptive of the subject.

Respond with valid JSON only — no markdown, no extra text:

{
  "title": "<abstract title>",
  "teacherFeedback": "<1–2 sentences of direct technical observation>",
  "technical": {
    "exposure": "<one phrase>",
    "lighting": "<one phrase>",
    "composition": "<one phrase>",
    "film": "<stock or format if identifiable, otherwise omit>"
  }
}`;

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
    if (photos.length) document.getElementById('photos-section').classList.remove('hidden');
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
        <span>Reviewing…</span>
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
    } catch (err) {
      photo.status = 'error';
      setCardError(photo, err.message || 'Analysis failed.');
      console.error(err);
    }
  }));

  isAnalyzing = false; btn.disabled = false; btn.textContent = 'Develop Roll →';
  updateRollButtons();
  renderPortfolioSection();
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
  div.innerHTML = /* html */`
    <div class="photo-card-img-wrap">
      <img src="${photo.dataUrl}" alt="${escapeHtml(analysis?.title || photo.file.name)}">
    </div>
    <div class="photo-card-body">
      <p class="photo-card-title">${escapeHtml(analysis?.title || photo.file.name)}</p>
      <button class="portfolio-toggle in-portfolio" data-id="${photo.id}">★ Remove from Portfolio</button>
    </div>`;
  div.querySelector('.portfolio-toggle').addEventListener('click', () => {
    photo.inPortfolio = false;
    const mainBtn = document.getElementById(`toggle-${photo.id}`);
    if (mainBtn) { mainBtn.textContent = '+ Add to Portfolio'; mainBtn.classList.remove('in-portfolio'); }
    document.getElementById(`card-${photo.id}`)?.classList.remove('portfolio-pick');
    renderPortfolioSection();
    updateRollButtons();
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
  document.getElementById('logout-btn')            .addEventListener('click', logout);
  document.getElementById('export-portfolio-btn')  .addEventListener('click', exportPortfolio);
  document.getElementById('download-portfolio-btn').addEventListener('click', downloadPortfolio);

  // Navigation
  document.getElementById('removed-nav-btn')    .addEventListener('click', showRemovedView);
  document.getElementById('back-to-roll-btn')   .addEventListener('click', showRollView);
  document.getElementById('clear-all-removed-btn').addEventListener('click', clearAllRemoved);

});
