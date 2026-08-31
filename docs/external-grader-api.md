# External draft grader contract

The browser can send a completed or in-progress PPR draft to an independent HTTPS endpoint. The endpoint should grade from a separately maintained projection/ranking source rather than echoing War Room's scores.

## Recommended architecture

Use a small server-side proxy that keeps provider credentials secret, fetches external evidence such as FantasyPros consensus rankings/projections or SportsDataIO projections, maps players by stable IDs or normalized name/team/position, and returns deterministic team scores. Never place a provider key in this GitHub Pages repository.

The browser sends `POST application/json` with this shape:

```json
{
  "schemaVersion": 1,
  "requestId": "draft UUID",
  "gradingRequirements": {
    "scoring": "PPR",
    "scoreRange": [0, 100],
    "independentEvidenceRequired": true
  },
  "draft": "league settings, picks, keepers and player identities only"
}
```

Return HTTP 200 JSON:

```json
{
  "provider": "My independent grader",
  "modelVersion": "2026.08.31",
  "gradedAt": "2026-08-31T18:00:00Z",
  "methodology": "Starter points, replacement depth and risk using independent PPR projections.",
  "sourceUrls": ["https://example.com/methodology"],
  "teams": [
    {
      "team": 0,
      "score": 84.2,
      "grade": "A-",
      "confidence": 0.78,
      "explanation": ["Strong WR advantage", "Thin backup RB depth"]
    }
  ]
}
```

`teams` must contain exactly one entry for every zero-based team ID. Scores must be from 0 through 100, confidence from 0 through 1, and the endpoint must allow CORS from `https://vbui31.github.io`.

The request deliberately omits War Room's local grades, projections, recommendations, and explanations. This prevents the outside grader from simply echoing or anchoring on the result it is supposed to audit.

## Two implementation choices

1. A deterministic projection proxy is the recommended production option. It is reproducible, inspectable, inexpensive to run and reduces language-model hallucination. It requires a licensed data API and player-ID mapping.
2. A language-model grading endpoint can produce richer prose and handle unusual formats, but grades are less stable and may reproduce prompt or training bias. If used, require structured JSON, temperature zero, independent projections in the prompt, provenance, and a deterministic score recomputation outside the model.

War Room preserves the external response alongside its own grade and reports disagreement. External scores never silently overwrite the local recommendation model.
