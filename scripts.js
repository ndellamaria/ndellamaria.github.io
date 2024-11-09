const phrases = [
  " a software developer.",
  " an outdoor enthusiast.",
  " an amateur film photographer."
];

let currentPhraseIndex = 0;
let currentText = '';
let isDeleting = false;
let isWaiting = false;

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

  if (isDeleting) {
    currentText = currentPhrase.substring(0, currentText.length - 1);
  } else {
    currentText = currentPhrase.substring(0, currentText.length + 1);
  }

  document.getElementById('typing-text').innerHTML =
    currentText + '<span class="cursor"></span>';

  let delta = isDeleting ? 50 : 75;

  if (!isDeleting && currentText === currentPhrase) {
    isDeleting = true;
    isWaiting = true;
    type();
    return;
  }

  if (isDeleting && currentText === '') {
    isDeleting = false;
    isWaiting = true;
    type();
    return;
  }

  setTimeout(type, delta);
}

// Start the typing effect
window.onload = function () {
  type();
}

document.addEventListener('DOMContentLoaded', function () {
  const videoItems = document.querySelectorAll('.portfolio-item.has-video');

  videoItems.forEach(item => {
    const video = item.querySelector('video');

    // Create an intersection observer
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // When item comes into view:
          // 1. Start loading the video
          video.preload = "auto";

          // 2. Play the video when it's ready
          video.play().then(() => {
            item.classList.add('video-ready');
          }).catch(e => console.log("Autoplay prevented:", e));

          // 3. Stop observing this item
          observer.unobserve(item);
        }
      });
    }, {
      // Adjust these values to control when videos start playing
      threshold: 0.5, // Video starts when 50% visible
      rootMargin: '50px' // Adds a 50px margin to trigger slightly earlier
    });

    // Start observing the item
    observer.observe(item);

    // Optional: Pause video when it's not in view to save resources
    const visibilityObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting && video.played.length > 0) {
          video.pause();
        } else if (entry.isIntersecting && item.classList.contains('video-ready')) {
          video.play().catch(e => console.log("Replay prevented:", e));
        }
      });
    }, {
      threshold: 0.1 // Pause/play when just 10% visible
    });

    visibilityObserver.observe(item);
  });
});