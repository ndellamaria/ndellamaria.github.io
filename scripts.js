const MONTHS = ['January','February','March','April','May','June','July',
                 'August','September','October','November','December'];

// ── PORTFOLIO RENDER ─────────────────────────────────────────────────────────

async function renderPortfolio() {
  const grid = document.getElementById('portfolio-grid');
  if (!grid) return;

  const photos = await fetch('./portfolio-photos.json', { cache: 'no-store' }).then(r => r.json());

  grid.innerHTML = photos.map(p => {
    const hasVideo = !!p.video;
    const orientation = `onload="this.setAttribute('data-orientation',this.naturalHeight>this.naturalWidth?'portrait':'landscape')"`;

    const videoHtml = hasVideo ? `
      <video muted playsinline loop preload="none" poster="pics/${p.filename}">
        <source src="videos/${p.video}" type="video/mp4">
      </video>` : '';

    const month  = p.month  ? MONTHS[parseInt(p.month, 10) - 1] : '';
    const date   = [month, p.year].filter(Boolean).join(' ');
    const overlayHtml = (p.location || date) ? `
      <div class="overlay">
        ${p.location ? `<div class="overlay-location">${p.location}</div>` : ''}
        ${date ? `<div class="overlay-date">${date}</div>` : ''}
      </div>` : '';

    return `<div class="portfolio-item${hasVideo ? ' has-video' : ''}">
  <img src="pics/${p.filename}" alt="${p.alt || ''}" ${orientation}>
  ${videoHtml}${overlayHtml}
</div>`;
  }).join('\n');

  initVideoObservers();
}

// ── VIDEO OBSERVERS ──────────────────────────────────────────────────────────

function initVideoObservers() {
  document.querySelectorAll('.portfolio-item.has-video').forEach(item => {
    const video = item.querySelector('video');
    if (!video) return;

    new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          video.preload = 'auto';
          video.play().then(() => item.classList.add('video-ready'))
               .catch(e => console.log('Autoplay prevented:', e));
          entry.target._playObserver.unobserve(item);
        }
      });
    }, { threshold: 0.5, rootMargin: '50px' }).observe(item);

    const pauseObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting && video.played.length > 0) {
          video.pause();
        } else if (entry.isIntersecting && item.classList.contains('video-ready')) {
          video.play().catch(e => console.log('Replay prevented:', e));
        }
      });
    }, { threshold: 0.1 });

    pauseObserver.observe(item);
  });
}

// ── TYPING EFFECT ────────────────────────────────────────────────────────────

const phrases = [
  ' a software developer.',
  ' an outdoor enthusiast.',
  ' an amateur film photographer.'
];

let currentPhraseIndex = 0;
let currentText = '';
let isDeleting = false;
let isWaiting  = false;

function type() {
  const currentPhrase = phrases[currentPhraseIndex];

  if (isWaiting) {
    setTimeout(() => {
      isWaiting = false;
      if (isDeleting) {
        currentText = currentText.slice(0, -1);
      } else {
        currentPhraseIndex = (currentPhraseIndex + 1) % phrases.length;
      }
      type();
    }, 700);
    return;
  }

  currentText = isDeleting
    ? currentPhrase.substring(0, currentText.length - 1)
    : currentPhrase.substring(0, currentText.length + 1);

  document.getElementById('typing-text').innerHTML = currentText + '<span class="cursor"></span>';

  const delta = isDeleting ? 50 : 75;

  if (!isDeleting && currentText === currentPhrase) {
    isDeleting = true; isWaiting = true; type(); return;
  }
  if (isDeleting && currentText === '') {
    isDeleting = false; isWaiting = true; type(); return;
  }

  setTimeout(type, delta);
}

window.onload = () => type();

document.addEventListener('DOMContentLoaded', () => renderPortfolio());
