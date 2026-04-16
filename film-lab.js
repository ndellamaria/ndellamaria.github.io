// ── CONSTANTS ──────────────────────────────────────────────────────────────

// SHA-256 of "darkroom" — change by running: echo -n "yourpassword" | shasum -a 256
const PASSWORD_HASH = 'c6a31148a73f1db678218c65c55b395d76aa11d6b6c6407634f0399963b1af5e';

const SESSION_KEY    = 'filmlab_auth';
const API_KEY_STORE  = 'filmlab_api_key';
const MODEL          = 'claude-sonnet-4-6';
const CLASSIFIER_URL = 'https://analog-image-classifier.onrender.com';

// ── STATE ───────────────────────────────────────────────────────────────────

let photos        = [];   // { id, file, dataUrl, status, analysis, classification, inPortfolio, flagged }
let removedPhotos = [];   // same shape; populated by classifier rejects + cleanup
let apiKey        = '';
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

// ── API KEY ─────────────────────────────────────────────────────────────────

const storedKey = () => localStorage.getItem(API_KEY_STORE) || '';
const saveKey   = k => { localStorage.setItem(API_KEY_STORE, k); apiKey = k; };

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Margot, a film photography instructor. Terse, direct, no flattery. Evaluate only on: framing, light, exposure, composition, film.

teacherFeedback is 1–2 sentences. State what works and what doesn't. If it's bad, say so plainly.

title is not a description of the photo. It is abstract and opaque — a fragment, a feeling, a word. Never literal. Examples of the register: "After the fact", "Held light", "Nowhere particular", "Salt", "The long wait". Avoid anything that names what is in the frame.

Scoring: 1–4 = poor technical execution or no point of view. 5–6 = competent but unremarkable. 7 = solid. 8–9 = portfolio-ready. 10 = exceptional.

portfolioWorthy is false if: unintentional blur, blown or crushed exposure without artistic intent, no clear subject, score ≤ 6. Apply a high bar.

Respond with valid JSON only — no markdown, no extra text:

{
  "score": <integer 1–10>,
  "title": "<abstract, opaque title>",
  "teacherFeedback": "<1–2 sentences, no flattery>",
  "technical": {
    "framing": "<one phrase>",
    "light": "<one phrase>",
    "exposure": "<one phrase>",
    "film": "<stock or format if identifiable, otherwise omit>"
  },
  "portfolioWorthy": <true | false>,
  "portfolioReasoning": "<one sentence>"
}`;

// ── CLAUDE API ───────────────────────────────────────────────────────────────

async function analyzePhotoWithClaude(dataUrl, classification = null) {
  const base64    = dataUrl.split(',')[1];
  const mediaType = dataUrl.split(';')[0].split(':')[1];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: classification
              ? `Please evaluate this film photograph. My classifier pre-screened it as "${classification.class}" (${Math.round(classification.confidence * 100)}% confidence). Use that as context but reach your own conclusion.`
              : 'Please evaluate this film photograph.'
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
  if (!match) throw new Error('Could not parse response from Margot.');
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
        ${p.analysis ? `<span class="pf-score">${p.analysis.score}/10</span>` : ''}
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
    .pf-meta { display: flex; justify-content: space-between; align-items: baseline; padding: 0.5rem 0.25rem 0; }
    .pf-title { font-size: 11pt; color: #555; font-style: italic; }
    .pf-score { font-size: 10pt; color: #aaa; flex-shrink: 0; margin-left: 0.5rem; }
  </style>
</head>
<body>
  <header class="pf-header">
    <h1>35mm Film</h1>
    <p>Selected frames — curated by Margot</p>
  </header>
  <div class="pf-grid">
${items}
  </div>
</body>
</html>`;
}

// ── PHOTO MANAGEMENT ─────────────────────────────────────────────────────────

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (!files.length) return;

  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const photo = { id: uid(), file, dataUrl, status: 'pending', analysis: null };
    photos.push(photo);
    document.getElementById('photos-grid').appendChild(buildCard(photo));
  }

  updateCount();
  document.getElementById('photos-section').classList.remove('hidden');
}

function removePhoto(id) {
  photos = photos.filter(p => p.id !== id);
  document.getElementById(`card-${id}`)?.remove();
  updateCount();
  if (photos.length === 0) {
    document.getElementById('photos-section').classList.add('hidden');
    if (removedPhotos.length === 0) document.getElementById('portfolio-section').classList.add('hidden');
  }
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
  document.getElementById('removed-section').classList.add('hidden');
  document.getElementById('filter-notice').classList.add('hidden');
  updateCount();
}

function updateCount() {
  const n = photos.length;
  document.getElementById('photo-count').textContent =
    n ? `(${n} frame${n !== 1 ? 's' : ''})` : '';

  const r = removedPhotos.length;
  const el = document.getElementById('removed-count');
  if (el) el.textContent = r ? `(${r})` : '';
}

// ── CARD BUILDERS ─────────────────────────────────────────────────────────────

function buildCard(photo) {
  const div = document.createElement('div');
  div.className = 'photo-card';
  div.id = `card-${photo.id}`;
  div.innerHTML = /* html */`
    <div class="photo-card-img-wrap">
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.file.name)}">
      <button class="photo-card-remove" data-id="${photo.id}" title="Remove">✕</button>
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
        <span>Margot is reviewing…</span>
      </div>`;
  }
}

function setCardDone(photo) {
  const { analysis } = photo;
  const card = document.getElementById(`card-${photo.id}`);
  if (!card) return;

  if (photo.inPortfolio) card.classList.add('portfolio-pick');
  if (photo.flagged)     card.classList.add('flagged');

  const badge = document.getElementById(`status-${photo.id}`);
  if (badge) badge.className = 'status-badge status-done';

  const body = document.getElementById(`body-${photo.id}`);
  if (!body) return;

  const t = analysis.technical || {};
  const filmLine = t.film ? `
      <div class="tech-item">
        <span class="tech-label">Film</span>
        <span class="tech-value">${escapeHtml(t.film)}</span>
      </div>` : '';

  const clsBadge = photo.classification
    ? `<span class="cls-badge cls-${photo.classification.class.replace(/_/g, '-')}">${CLASS_LABELS[photo.classification.class] || photo.classification.class} · ${Math.round(photo.classification.confidence * 100)}%</span>`
    : '';

  body.innerHTML = /* html */`
    <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
    ${clsBadge}
    <div class="photo-card-header">
      <p class="photo-card-title">${escapeHtml(analysis.title || '')}</p>
      <span class="photo-card-score">${analysis.score}/10</span>
    </div>
    <p class="photo-card-feedback">${escapeHtml(analysis.teacherFeedback || '')}</p>
    <div class="technical-grid">
      <div class="tech-item">
        <span class="tech-label">Framing</span>
        <span class="tech-value">${escapeHtml(t.framing || '—')}</span>
      </div>
      <div class="tech-item">
        <span class="tech-label">Light</span>
        <span class="tech-value">${escapeHtml(t.light || '—')}</span>
      </div>
      <div class="tech-item">
        <span class="tech-label">Exposure</span>
        <span class="tech-value">${escapeHtml(t.exposure || '—')}</span>
      </div>${filmLine}
    </div>
    <div class="card-actions">
      <button class="portfolio-toggle${photo.inPortfolio ? ' in-portfolio' : ''}" id="toggle-${photo.id}" data-id="${photo.id}">
        ${photo.inPortfolio ? '★ In Portfolio' : '+ Add to Portfolio'}
      </button>
      <button class="flag-toggle${photo.flagged ? ' flagged' : ''}" id="flag-${photo.id}" data-id="${photo.id}" title="Flag for removal">
        ${photo.flagged ? '🚩 Flagged' : 'Flag'}
      </button>
    </div>`;

  body.querySelector('.portfolio-toggle').addEventListener('click', () => togglePortfolio(photo.id));
  body.querySelector('.flag-toggle').addEventListener('click', () => toggleFlag(photo.id));
}

function setCardError(photo, message) {
  const badge = document.getElementById(`status-${photo.id}`);
  if (badge) { badge.className = 'status-badge status-error'; badge.textContent = 'Error'; }
  const body = document.getElementById(`body-${photo.id}`);
  if (body) {
    body.innerHTML = /* html */`
      <p class="photo-card-filename">${escapeHtml(photo.file.name)}</p>
      <p class="error-msg" style="padding:0.75rem 0;">${escapeHtml(message)}</p>`;
  }
}

// ── FLAG TOGGLE ───────────────────────────────────────────────────────────────

function toggleFlag(id) {
  const photo = photos.find(p => p.id === id);
  if (!photo || photo.status !== 'done') return;

  photo.flagged = !photo.flagged;

  document.getElementById(`card-${id}`)?.classList.toggle('flagged', photo.flagged);

  const btn = document.getElementById(`flag-${id}`);
  if (btn) {
    btn.textContent = photo.flagged ? '🚩 Flagged' : 'Flag';
    btn.classList.toggle('flagged', photo.flagged);
  }

  updateCleanupButtons();
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
}

// ── DEVELOP ROLL (classify → filter → analyze in parallel) ───────────────────

async function developRoll() {
  if (isAnalyzing) return;

  const key = storedKey();
  if (!key) { showApiKeyModal(true); return; }
  apiKey = key;

  const pending = photos.filter(p => p.status !== 'done');
  if (!pending.length) return;

  isAnalyzing = true;
  const btn = document.getElementById('analyze-btn');
  btn.disabled    = true;
  btn.textContent = 'Classifying…';

  pending.forEach(p => { p.status = 'analyzing'; setCardAnalyzing(p); });

  // ── Phase 1: classify all in parallel ──
  const classifierUp = await checkClassifierHealth();
  setClassifierStatus(classifierUp);

  if (classifierUp) {
    await Promise.all(pending.map(async photo => {
      try {
        photo.classification = await classifyPhoto(photo.dataUrl);
      } catch (err) {
        photo.classification = null;
        console.warn('Classification skipped:', photo.file.name, err.message);
      }
    }));

    // Move non-good photos to the Removed section
    const bad = pending.filter(p => p.classification && p.classification.class !== 'good');
    if (bad.length) {
      bad.forEach(p => {
        photos = photos.filter(x => x.id !== p.id);
        document.getElementById(`card-${p.id}`)?.remove();
        p.status = 'removed-classifier';
        removedPhotos.push(p);
      });
      showFilterNotice(bad);
      updateCount();
      renderRemovedSection();
    }
  }

  // ── Phase 2: Margot reviews all passing photos in parallel ──
  const toAnalyze = photos.filter(p => p.status === 'analyzing');

  if (!toAnalyze.length) {
    isAnalyzing     = false;
    btn.disabled    = false;
    btn.textContent = 'Develop Roll →';
    if (!photos.length) document.getElementById('photos-section').classList.add('hidden');
    return;
  }

  btn.textContent = 'Developing…';

  await Promise.all(toAnalyze.map(async photo => {
    try {
      const resized     = await resizeDataUrl(photo.dataUrl);
      photo.analysis    = await analyzePhotoWithClaude(resized, photo.classification ?? null);
      photo.status      = 'done';
      photo.inPortfolio = photo.analysis.portfolioWorthy && photo.analysis.score >= 7;
      setCardDone(photo);
    } catch (err) {
      photo.status = 'error';
      setCardError(photo, err.message || 'Analysis failed.');
      console.error(err);
    }
  }));

  isAnalyzing     = false;
  btn.disabled    = false;
  btn.textContent = 'Develop Roll →';

  updateCleanupButtons();
  renderPortfolioSection();
}

function showFilterNotice(removed) {
  const counts = {};
  removed.forEach(p => {
    const cls = p.classification.class;
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

// ── CLEAN UP ─────────────────────────────────────────────────────────────────

const CLEANUP_THRESHOLD = 4;

function cleanUp() {
  const bad = photos.filter(p => p.status === 'done' && p.analysis?.score <= CLEANUP_THRESHOLD && !p.flagged);
  bad.forEach(p => {
    p.flagged = true;
    document.getElementById(`card-${p.id}`)?.classList.add('flagged');
    const btn = document.getElementById(`flag-${p.id}`);
    if (btn) { btn.textContent = '🚩 Flagged'; btn.classList.add('flagged'); }
  });
  updateCleanupButtons();
}

function removeFlagged() {
  const flagged = photos.filter(p => p.flagged);
  flagged.forEach(p => {
    photos = photos.filter(x => x.id !== p.id);
    document.getElementById(`card-${p.id}`)?.remove();
    p.status = 'removed-cleanup';
    removedPhotos.push(p);
  });
  updateCount();
  updateCleanupButtons();
  renderRemovedSection();
  renderPortfolioSection();
  if (photos.length === 0) document.getElementById('photos-section').classList.add('hidden');
}

function updateCleanupButtons() {
  const analyzed     = photos.filter(p => p.status === 'done');
  const flagged      = photos.filter(p => p.flagged);
  const unflaggedBad = analyzed.filter(p => p.analysis?.score <= CLEANUP_THRESHOLD && !p.flagged);

  const cleanBtn  = document.getElementById('cleanup-btn');
  const removeBtn = document.getElementById('remove-flagged-btn');

  cleanBtn.classList.toggle('hidden', unflaggedBad.length === 0);
  removeBtn.classList.toggle('hidden', flagged.length === 0);
  if (flagged.length > 0) removeBtn.textContent = `Remove flagged (${flagged.length})`;
}

// ── REMOVED SECTION ───────────────────────────────────────────────────────────

function buildRemovedCard(photo) {
  const div = document.createElement('div');
  div.className = 'photo-card removed-card';
  div.id = `removed-card-${photo.id}`;

  const clsBadge = photo.classification
    ? `<span class="cls-badge cls-${photo.classification.class.replace(/_/g, '-')}">${CLASS_LABELS[photo.classification.class] || photo.classification.class} · ${Math.round(photo.classification.confidence * 100)}%</span>`
    : '';

  const reason = photo.status === 'removed-classifier' && photo.classification
    ? `Removed by classifier — ${CLASS_LABELS[photo.classification.class] || photo.classification.class}`
    : photo.analysis
    ? `Cleaned up — scored ${photo.analysis.score}/10`
    : 'Removed';

  const feedbackLine = photo.analysis?.teacherFeedback
    ? `<p class="photo-card-feedback">${escapeHtml(photo.analysis.teacherFeedback)}</p>`
    : '';

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

function renderRemovedSection() {
  const section = document.getElementById('removed-section');
  const grid    = document.getElementById('removed-grid');
  grid.innerHTML = '';

  if (removedPhotos.length === 0) {
    section.classList.add('hidden');
    return;
  }

  removedPhotos.forEach(p => grid.appendChild(buildRemovedCard(p)));
  section.classList.remove('hidden');
  updateCount();
}

function deleteFromRemoved(id) {
  removedPhotos = removedPhotos.filter(p => p.id !== id);
  document.getElementById(`removed-card-${id}`)?.remove();
  updateCount();
  if (removedPhotos.length === 0) document.getElementById('removed-section').classList.add('hidden');
}

async function addToPortfolioFromRemoved(id) {
  const photo = removedPhotos.find(p => p.id === id);
  if (!photo) return;

  const btn = document.getElementById(`recover-${id}`);

  // If no analysis yet, try to run Margot on it before adding
  if (!photo.analysis) {
    const key = storedKey();
    if (key) {
      apiKey = key;
      if (btn) { btn.disabled = true; btn.textContent = 'Analyzing…'; }
      try {
        const resized  = await resizeDataUrl(photo.dataUrl);
        photo.analysis = await analyzePhotoWithClaude(resized, photo.classification ?? null);
      } catch (e) {
        console.warn('Could not analyze recovered photo:', e.message);
      }
    }
  }

  removedPhotos = removedPhotos.filter(p => p.id !== id);
  document.getElementById(`removed-card-${id}`)?.remove();

  photo.status      = 'done';
  photo.inPortfolio = true;
  photo.flagged     = false;
  photos.push(photo);

  updateCount();
  if (removedPhotos.length === 0) document.getElementById('removed-section').classList.add('hidden');
  renderPortfolioSection();
}

// ── PORTFOLIO SECTION ─────────────────────────────────────────────────────────

function renderPortfolioSection() {
  const picks = photos
    .filter(p => p.inPortfolio)
    .sort((a, b) => (b.analysis?.score ?? 0) - (a.analysis?.score ?? 0));

  const section = document.getElementById('portfolio-section');
  const grid    = document.getElementById('portfolio-grid');
  grid.innerHTML = '';

  if (picks.length === 0) {
    section.classList.add('hidden');
    return;
  }

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
      <div class="photo-card-header">
        <p class="photo-card-title">${escapeHtml(analysis?.title || photo.file.name)}</p>
        ${analysis ? `<span class="photo-card-score">${analysis.score}/10</span>` : ''}
      </div>
      <button class="portfolio-toggle in-portfolio" data-id="${photo.id}">★ Remove from Portfolio</button>
    </div>`;
  div.querySelector('.portfolio-toggle').addEventListener('click', () => {
    photo.inPortfolio = false;
    // Sync the main roll card toggle if it exists
    const mainBtn = document.getElementById(`toggle-${photo.id}`);
    if (mainBtn) {
      mainBtn.textContent = '+ Add to Portfolio';
      mainBtn.classList.remove('in-portfolio');
      document.getElementById(`card-${photo.id}`)?.classList.remove('portfolio-pick');
    }
    renderPortfolioSection();
  });
  return div;
}

async function exportPortfolio() {
  const picks = photos
    .filter(p => p.inPortfolio)
    .sort((a, b) => (b.analysis?.score ?? 0) - (a.analysis?.score ?? 0));

  if (!picks.length) return;

  const btn = document.getElementById('export-portfolio-btn');
  btn.disabled    = true;
  btn.textContent = 'Generating…';

  try {
    const sized = await Promise.all(
      picks.map(async p => ({ ...p, dataUrl: await resizeDataUrl(p.dataUrl, 1200) }))
    );

    portfolioHTML = buildPortfolioHTML(sized);

    const blob  = new Blob([portfolioHTML], { type: 'text/html' });
    const url   = URL.createObjectURL(blob);
    const frame = document.getElementById('portfolio-frame');
    frame.src   = url;

    const dl = document.getElementById('portfolio-download-section');
    dl.classList.remove('hidden');
    dl.scrollIntoView({ behavior: 'smooth' });
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Export Portfolio →';
  }
}

function downloadPortfolio() {
  if (!portfolioHTML) return;
  const blob = new Blob([portfolioHTML], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'film-portfolio.html' });
  a.click();
  URL.revokeObjectURL(url);
}

// ── API KEY MODAL ─────────────────────────────────────────────────────────────

let pendingDevelopAfterKey = false;

function showApiKeyModal(andDevelop = false) {
  pendingDevelopAfterKey = andDevelop;
  const modal = document.getElementById('api-key-modal');
  modal.classList.remove('hidden');
  const input = document.getElementById('api-key-input');
  input.value = storedKey();
  setTimeout(() => input.focus(), 60);
}

function hideApiKeyModal() {
  document.getElementById('api-key-modal').classList.add('hidden');
  document.getElementById('api-key-error').classList.add('hidden');
}

function handleSaveApiKey() {
  const val = document.getElementById('api-key-input').value.trim();
  if (!val) { document.getElementById('api-key-error').classList.remove('hidden'); return; }
  saveKey(val);
  hideApiKeyModal();
  if (pendingDevelopAfterKey) { pendingDevelopAfterKey = false; developRoll(); }
}

// ── SHOW APP ──────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  apiKey = storedKey();
  if (!apiKey) setTimeout(() => showApiKeyModal(false), 400);
  checkClassifierHealth().then(setClassifierStatus);
}

// ── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  if (isLoggedIn()) { showApp(); }

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pw   = document.getElementById('password-input').value;
    const hash = await sha256(pw);
    if (hash === PASSWORD_HASH) { setLoggedIn(); showApp(); }
    else document.getElementById('login-error').classList.remove('hidden');
  });

  // ── Drop zone ──
  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');

  dropZone.addEventListener('click', e => {
    if (e.target.closest('label') || e.target === fileInput || e.target === folderInput) return;
    fileInput.click();
  });

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change',   e => { addFiles(e.target.files); e.target.value = ''; });
  folderInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

  // ── App buttons ──
  document.getElementById('analyze-btn')           .addEventListener('click', developRoll);
  document.getElementById('filter-notice-dismiss') .addEventListener('click', () => document.getElementById('filter-notice').classList.add('hidden'));
  document.getElementById('add-more-btn')          .addEventListener('click', () => fileInput.click());
  document.getElementById('clear-btn')             .addEventListener('click', clearAll);
  document.getElementById('cleanup-btn')           .addEventListener('click', cleanUp);
  document.getElementById('remove-flagged-btn')    .addEventListener('click', removeFlagged);
  document.getElementById('logout-btn')            .addEventListener('click', logout);
  document.getElementById('change-api-key-btn')    .addEventListener('click', () => showApiKeyModal(false));
  document.getElementById('export-portfolio-btn')  .addEventListener('click', exportPortfolio);
  document.getElementById('download-portfolio-btn').addEventListener('click', downloadPortfolio);

  // ── API key modal ──
  document.getElementById('save-api-key-btn')  .addEventListener('click', handleSaveApiKey);
  document.getElementById('cancel-api-key-btn').addEventListener('click', hideApiKeyModal);
  document.getElementById('modal-overlay')     .addEventListener('click', hideApiKeyModal);
  document.getElementById('api-key-input')     .addEventListener('keydown', e => { if (e.key === 'Enter') handleSaveApiKey(); });
});
