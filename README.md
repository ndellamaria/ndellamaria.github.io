# Film Lab

A private film photography darkroom — a web app that evaluates rolls of scanned negatives using a custom ML classifier and Claude, selects portfolio picks, animates nature shots with Runway ML, and publishes to a live personal site via automated GitHub PR.

Built as the final project for *Navigating Your Worth* (NYU, Spring 2026).

---

## What It Does

Upload a roll of scanned film photographs. Film Lab runs each frame through a five-stage pipeline:

```
Raw scans
    │
    ▼
[1] ONNX Classifier (ResNet50)
    Custom-trained 5-class model: good · blurry · over-exposed · under-exposed · light leak
    Removes frames below 0.65 confidence threshold
    │
    ▼
[2] Claude Instructor (claude-sonnet-4-6)
    Per-frame: poetic title · technical feedback · exposure / lighting /
    composition notes · animatable flag (no people, nature subject)
    │
    ▼
[3] Judge LLM (claude-sonnet-4-6, separate system prompt)
    Scores each analysis against evaluation-criteria.json on 3 criteria
    Runs silently in background — results available via ↓ Evaluation Report
    │
    ▼
[4] Portfolio Curation
    User selects portfolio picks
    Eligible frames animated with Runway ML (gen3a_turbo) — seamless loop
    Export as self-contained HTML (images + videos embedded as base64)
    │
    ▼
[5] Publish to Site
    Select one or more portfolio picks · preview full site with photos and
    videos · backend fetches videos from Runway and uploads all assets ·
    opens a single GitHub PR updating portfolio-photos.json
```

---

## Architecture

| Layer          | Technology                                                                      |
| -------------- | ------------------------------------------------------------------------------- |
| Frontend       | Vanilla JS, HTML, CSS — static, no build step                                   |
| Classifier     | ONNX Runtime (ResNet50, [custom-trained 5-class model](https://github.com/ndellamaria/analog-image-classifier)) |
| Instructor LLM | Anthropic Claude claude-sonnet-4-6 via server-side proxy                        |
| Judge LLM      | Anthropic Claude claude-sonnet-4-6, separate system prompt                      |
| Animation      | Runway ML gen3a_turbo image-to-video                                            |
| Backend        | Flask (Python), hosted on Render                                                |
| Portfolio site | GitHub Pages, `ndellamaria.github.io`                                           |
| Portfolio data | `portfolio-photos.json` — single source of truth                                |

---

## Key Files

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `film-lab.html`            | App shell — login screen, roll view, portfolio section, site preview modal |
| `film-lab.js`              | All app logic — classification, analysis, animation, publishing            |
| `film-lab.css`             | Dark-theme UI styles                                                       |
| `evaluation-criteria.json` | Judge LLM rubric — edit to change how quality is measured                  |
| `portfolio-photos.json`    | Live portfolio manifest — all photos rendered from this                    |
| `scripts.js`               | Renders portfolio on the main site from `portfolio-photos.json`            |
| `index.html`               | Main personal site                                                         |
| `test-roll/manifest.json`  | List of test photos for demo runs                                          |

Backend lives in a separate repo: [ndellamaria/analog-image-classifier](https://github.com/ndellamaria/analog-image-classifier)

---

## Access

Film Lab is password-gated. The password hash is stored in `film-lab.js` as a SHA-256 digest. To change the password:

```bash
echo -n "yournewpassword" | shasum -a 256
```

Replace `PASSWORD_HASH` at the top of `film-lab.js` with the result.

### Publish gate

Publishing to GitHub can be disabled without changing the password — set `PUBLISH_ENABLED = false` at the top of `film-lab.js`. This hides all `+ Site` controls, preventing anyone from opening a PR. Set it back to `true` to re-enable.

---

## Environment Variables (Render backend)

| Variable            | Required for                                                  |
| ------------------- | ------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Instructor LLM + Judge LLM                                    |
| `RUNWAY_API_KEY`    | Photo animation                                               |
| `GITHUB_TOKEN`      | Automated PR — needs `contents:write` + `pull_requests:write` |

---

## Evaluation

Film Lab includes a self-evaluation system. After each roll is developed, a Judge LLM scores every analysis output against a rubric defined in `evaluation-criteria.json`. The judge runs silently in the background — click **↓ Evaluation Report** in the roll section to download a full markdown report with:

- Per-criterion averages across the roll
- Areas for improvement with actionable agent suggestions
- Per-photo score breakdown

See [EVALUATION.md](./EVALUATION.md) for full documentation.

---

## Publish to Site

From any portfolio card, toggle **+ Site** to select photos for publishing. An **Add N to Site →** button appears in the portfolio section header. Clicking it:

1. Fetches the live `portfolio-photos.json`
2. Renders a full site preview in a modal — all existing photos and videos playing
3. On **Open PR**: backend fetches Runway video URLs directly, uploads images to `pics/` and videos to `videos/`, updates the JSON manifest, and opens a single GitHub PR

---

## Transferability

Film Lab's technical triage, evaluation framework, animation selection logic, and publication pipeline work for any film photographer. What it cannot replicate is the final curatorial decision — knowing which technically flawed frames still carry something worth keeping. That judgment is structurally non-transferable.
