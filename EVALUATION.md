# Film Lab — Evaluation System

The Judge LLM is a second Claude instance (separate system prompt) that evaluates the quality of Film Lab's primary instructor analysis after each photo is developed. It scores the *analysis output* — not the photograph itself.

Criteria are defined in `evaluation-criteria.json` and loaded at runtime. Edit that file to change how quality is measured without touching any code.

---

## How It Works

```
Instructor analysis (title, feedback, technical notes)
    │
    ▼
Judge LLM fetches evaluation-criteria.json
    │
    ▼
Scores each criterion 1–5
Flags criteria at or below flag_threshold
Generates actionable improvement suggestions for weak criteria
    │
    ▼
Score + flag badge + suggestions rendered on each card
    │
    ▼ (on "↓ Evaluation Report")
Markdown report downloaded with full breakdown
```

---

## Evaluation Criteria

Defined in `evaluation-criteria.json`. Current version (1.0):

### 1. Title Specificity (`title`)

> Is the title specific and evocative to this exact frame, or generic and interchangeable?

| Score | Meaning |
|-------|---------|
| 1 | Generic — could apply to any photograph (e.g. "Golden Light", "Morning Mist") |
| 2 | Slightly specific but still interchangeable with similar photos |
| 3 | References a recognizable element of the photo but lacks originality |
| 4 | Evocative and clearly tied to something unique in this frame |
| 5 | Poetic and unexpected — could only belong to this particular image |

---

### 2. Feedback Precision (`feedback`)

> Is the technical feedback precise, causal, and actionable — or vague and obvious?

| Score | Meaning |
|-------|---------|
| 1 | Vague or obvious — adds no value beyond looking at the photo |
| 2 | Names a technical issue but without identifying cause or offering direction |
| 3 | Specific observation, partially identifies cause |
| 4 | Precise — identifies cause, effect, and implies a corrective direction |
| 5 | Surgical — names exact technical cause, its effect on the image, and a clear improvement path |

---

### 3. Internal Consistency (`consistency`)

> Do the technical notes (exposure, lighting, composition) align with and support the overall teacherFeedback?

| Score | Meaning |
|-------|---------|
| 1 | Technical notes directly contradict the feedback |
| 2 | Partially aligned — at least one note contradicts or undermines the feedback |
| 3 | Mostly consistent with minor gaps or redundancy |
| 4 | Well-aligned — each note contributes to a coherent assessment |
| 5 | Perfectly consistent — title, feedback, and technical notes form a single unified critique |

---

## Thresholds

| Setting | Value | Effect |
|---------|-------|--------|
| `passing_threshold` | 3.5/5 | Criteria below this appear in *Areas for Improvement* in the report |
| `flag_threshold` | 3.0/5 | Individual photos below this get a ⚑ flag badge on their card |

---

## Card Display

After the instructor analysis completes, the judge score appears at the bottom of each photo card:

```
[3.3/5] [⚑]  The title is generic and could apply to many landscape photographs.
         Suggestions (2)
           › Require the title to reference a specific visual element unique to this frame
           › Add an instruction prohibiting titles that could describe more than one photo
```

- **Score badge** — color-coded: green ≥ 4.0, amber ≥ 3.0, red < 3.0. Hover to see per-criterion breakdown.
- **⚑ flag** — appears when one or more criteria scored at or below the flag threshold (3.0).
- **Suggestions** — collapsed by default, expand to see actionable improvements to the Film Lab agent's system prompt or logic.

---

## Suggestions

The Judge does not suggest how to improve the *photograph* — it suggests how to improve the **Film Lab agent itself**. Each suggestion is a concrete instruction change, e.g.:

> "Require the system prompt to instruct the instructor to identify a specific cause-and-effect relationship in the technical feedback, not just name the issue."

Suggestions appear:
- On each card (collapsed under "Suggestions (N)")
- In the downloaded evaluation report under *Areas for Improvement*

---

## Evaluation Report

Click **↓ Evaluation Report** in the roll section (appears after the first judge score is received). Downloads a `.md` file named `film-lab-evaluation-YYYY-MM-DD.md`.

### Report structure

```
# Film Lab — Evaluation Report
Generated / Criteria source / Thresholds

## Summary
Table: overall average, per-criterion averages, photo counts

## Areas for Improvement
One section per criterion below passing_threshold, including:
  - Average score and gap from threshold
  - Agent improvement suggestions (aggregated from flagged photos)
  - Individual photos flagged with their score and judge note

## Per-Photo Evaluations
For each photo: title, overall score, per-criterion scores, judge note, suggestions
```

---

## Customizing the Criteria

Edit `evaluation-criteria.json` — the Judge reads it fresh on every analysis run.

```json
{
  "criteria": [
    {
      "id": "your_criterion_id",
      "name": "Display Name",
      "description": "What is being evaluated",
      "weight": 1,
      "levels": {
        "1": "Weakest performance description",
        "5": "Strongest performance description"
      }
    }
  ],
  "passing_threshold": 3.5,
  "flag_threshold": 3.0,
  "improvement_rule": "Plain-English rule injected verbatim into the Judge's system prompt."
}
```

Changes take effect immediately — no code changes or redeploy needed.
