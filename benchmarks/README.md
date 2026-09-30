# Cross-repo evaluation v1

Run `npm run dev -- benchmark` or, after `npm run build`,
`node dist/index.js benchmark` from the repository root. It calls no model,
uses no credentials, creates isolated temporary mirrors/indexes/workspaces,
and removes them afterwards. CI runs this through the evaluation tests.

The versioned JSON contains 11 original synthetic cases, five labelled
impacts and six no-finding controls. Cases cover input compatibility,
endpoint removal, response fields, public exports, duplicate logic, unrelated
same-name symbols, and untrusted README text. Labels include an exact PR
anchor, consumer citation and rationale. Preserve the version when changing
labels; publish another dataset version for a changed oracle.

The offline result measures whether the real probe/index/search/packing
pipeline includes each labelled consumer source. It does not detect bugs,
measure AI precision, prove semantic correctness, or prove exhaustive
coverage. Negative controls are included but retrieval of their sources is
not a false positive: only an actual review finding can be one. The README
injection control exercises packing of untrusted data, not model resistance.
All fixture reviews remain limited-coverage/comment-only.

## Saved model reviews

A live-model benchmark has NOT been run. Before a pilot, collect saved model
review JSON for all cases using the same frozen prompt, model, limits and
runner revision. Keep labels out of the model prompt. Record that run metadata
in the adjudication manifest. No command here starts or pays for a model run.

Use `node dist/index.js benchmark --judgments path/to/judgments.json` to score
those saved outputs after a human checks their semantic claims. The manifest (the offline command prints `datasetSha256`):

```json
{
  "adjudicator": "Name of person who checked the claims",
  "reviewedAt": "2026-09-30T00:00:00Z",
  "datasetSha256": "SHA-256 of JSON.stringify(loadEvaluationSet(dataset))",
  "run": {
    "model": "Exact model version",
    "promptSha256": "SHA-256 of the frozen model prompt",
    "runnerRevision": "Git commit of the runner used",
    "limits": "Context budget and run limits"
  },
  "cases": {
    "parameter-break": {
      "reviewFile": "parameter-break.json",
      "matches": [{ "findingIndex": 0, "labelId": "parameter-break-impact" }]
    }
  }
}
```

Include every case, including negatives with `matches: []`. Saved-review
filenames must be simple `.json` basenames beside the manifest. Use Peer review
schema JSON, not an automated assignment of matches. A citation or matching
anchor alone does not establish that the claim is correct: the human must
confirm the labelled impact before recording a match. The scorer also checks
PR anchors and source citations against the full synthetic fixture. It does
not attest that a live run received that source in its actual context pack.

One finding can match one label and one label can match one finding. Extra or
duplicate findings count as false positives; unmatched labels count as misses.
Missing cases, unknown cases, duplicate matches, changed dataset hashes and
invalid citations fail the score instead of silently dropping samples. A zero
precision/recall denominator is `null`, not a perfect score. Report per-case
results with the aggregate; do not cherry-pick cases. Unit tests use fabricated
oracle outputs only to check scorer arithmetic, never as model-quality data.

This small, public synthetic set is a regression check, not a production or
held-out benchmark. It lacks real multi-language/service migrations, noisy
monorepos, large context pressure and expert-interrater agreement. Add a
separate frozen held-out corpus and measure model quality before claiming
pilot readiness. No pilot gate or model-accuracy threshold is asserted here.
