# Re-entry v1 — official collection and backfill, and "since this reference"

Status: design proposal, revision 2 (after review). Nothing here is implemented. Examples use
synthetic names.

## 1. The observation this design answers

Grove v1 observes only when a page is opened. A steward whose attention concentrates on a few
projects stops opening Grove; Grove therefore stops observing — including the concentration
itself. The record of that period still exists in each repository's commit history. Reconciling it
by hand afterwards (which repositories are new, which were renamed, which spans were not observed
rather than inactive, which declarations moved) is the report the product should produce.

Three consequences, in order:

1. Collection and backfill are official, explicit, repeatable commands — not visits, not one-off
   scripts.
2. The repository's own history is the source for the repository-side daily series; live
   observation adds GitHub-side state.
3. A return answers "what changed since this reference", with every line marked by how Grove
   knows it.

Child units, attention declarations, relationships and cosmology wait behind these.

## 2. Gate (`CLAUDE.md`)

| Question | Answer |
|---|---|
| Stewardship questions | Q1 (declared intent and when it changed), Q5 (change over time), Q21 (long inactivity — distinguishable from absence of observation), Q24 (what is explicitly unknown due to missing observation data). Q29 only in the negative: nothing about ritual engagement is recorded. |
| Contracts | `CONTRACT_OBSERVATIONAL` (time-bound, method traceable), `CONTRACT_READ_ONLY` (collector and backfill read only), `CONTRACT_NON_PRESCRIPTIVE` (no notifications, no participation tracking; a saved reference is navigation state), `CONTRACT_ECOSYSTEM_BALANCE` §4 (daily baseline — see §3). |
| Frequent attention needed? | No. Backfill makes the daily baseline recoverable at any time; the view is built for rare returns. |
| Collapses observation into judgment? | No. Differences are listed with their source; no adjectives; counts are plain numbers inside sections, never a backlog. |
| Removable? | Yes. Each slice is a column or table, a script and a route; removing any leaves the current app intact. |

## 3. The method model

Two methods, one series.

| | `observed` | `history` |
|---|---|---|
| When written | at a visit or a `collect` run | by `backfill`, for past UTC days lacking an observed snapshot |
| Inputs | GitHub REST at that moment: tree of the default branch, commit-activity stats, root `package.json`, `pushed_at`, repository metadata | the repository's commit history **as the default branch now records it**: the tree at the selected commit, commit dates, `.grove.yaml` and root `package.json` at that commit |
| `observed_at` | wall clock | end of the UTC day (`T23:59:59.999Z`); `recorded_at` and the run id say when it was actually written |
| Lens | the algorithm in force at that time | the algorithm in force when the backfill runs (version recorded in evidence) |

Every row of either method records `github_id` (the identity it was observed for) and, for
`history`, `collection_run_id`; identity-keyed reads match the id directly (see
`designs/identity.md`), so a reconstructed row never depends on a binding segment to be found.

### 3.1 What history can and cannot say

A clone holds the commits now reachable from the default branch and their dates. It does **not**
hold when a commit joined the branch (a commit dated February may have been fast-forwarded in
April) nor commits that were later force-pushed away. The reconstructed series is therefore the
**retrospective** branch state — "what the default branch's first-parent history says the tree was
on that day" — never the contemporaneous one. This is a stated method, recorded as
`branch_state: retrospective` in evidence and visible in the timeline wording; it is not presented
as what Grove would have seen that day.

Per day, the selected commit is the last commit on the default branch's **first-parent** history
whose committer date is at or before the end of the day. A day before the repository's
`created_at` is left empty (the repository did not exist). A day at or after `created_at` with no
commit yet is recorded as the repository **existing but empty** (`state: empty`, no tree, no
signals): absence of a commit does not show absence of the repository, and membership matters for
ecosystem counts and for "newly observed" versus "created".

Declarations are **not** sampled daily. Every first-parent commit that changes `.grove.yaml` yields
its own `declaration_changes` row (`observed_at` = committer date), so several transitions in one
day survive. Snapshots remain one per day.

Divergences from live observation, stated in evidence (`divergences`) and here:

- **Commit windows.** Reconstructed `commits_last_30d/90d` count first-parent commits by committer
  date in the trailing 30 / 90 calendar days; live rows use GitHub's last 4 / 13 weekly buckets.
- **Consolidation input and clock.** Reconstructed rows use the last first-parent commit date in
  place of `pushed_at`, and evaluate `observeConsolidationInterval` with that day's end as `now` —
  never the backfill's wall clock.
- **Ecosystem dependency count.** Resolved against portfolio repositories that existed on that
  day (`created_at` ≤ day), under the names they held that day (bindings).
- **Density tier.** Computed with the current `observeStructuralDensity`; evidence records the
  Grove version and commit.

### 3.2 Window, gap and proposal rules

- **Window rule.** One slot per UTC day per identity; an observed snapshot fills the slot when one
  exists, else a `history` one; `insufficient` only when neither.
- **Strata across a reconstructed window.** The evaluator derives a repository's stratum from
  role and horizon. A window whose rows do not agree on role or horizon is undeterminable
  (`insufficient`): persistence is not attributed to a stratum the repository did not hold
  throughout. Phase differences are the relation itself and need no such rule.
- **Gap rule.** Spans without observation are computed from `observed` rows only. A reconstructed
  span is presented separately ("recorded from history: n days") and never removes a "Not
  observed" entry.
- **Proposal rule.** Proposals are evaluated only when a run happens, from the windows ending that
  day. Nothing is backdated: `last_supported_at` never moves into the past and no proposal is
  created "as of" a reconstructed day.
- **Today is never backfilled.** The backfill range ends at the previous UTC day, so a live
  observation of the current day is always the only row for it and the hourly guard is unaffected.

### 3.3 Contract reading

`CONTRACT_ECOSYSTEM_BALANCE` §4 asks for a daily baseline. This design reads that as a statement
about *resolution* (one observation per repository per day), which history satisfies, rather than
about *collection cadence*. The one amendment it asks for is a sentence in `CONTRACT_OBSERVATIONAL`:
an observation may be recorded from the repository's own history when its method, source commit
and recording time are recorded with it; such rows are never presented as contemporaneous
observation. If the cadence reading is preferred instead, §4 needs amending to admit a derived
baseline; the slices below are unchanged either way.

## 4. Slices

### A. `collect` — official on-demand collection

`pnpm --filter @grove/app collect` → `app/scripts/collect.ts`.

- Runs the existing portfolio pipeline (`loadPortfolio`) without a browser session: steward from
  `GROVE_GITHUB_TOKEN`, scope from `GROVE_SCOPE_*`, database from `GROVE_DB_PATH`; same hourly
  throttle, same persistence code. No second pipeline.
- `collection_runs`: `id`, `started_at`, `finished_at`, `method` (`cli` | `visit` | `backfill`),
  `steward_id`, `full_portfolio` (whether the run attempted every repository in the configured
  scope), `answer` (the GitHub answer kind when the run could not list at all).
- `collection_run_repositories`: one row per repository the run was about — `run_id`,
  `github_id`, `full_name`, `outcome` (`observed` | `unchanged` for a throttled-but-present
  repository | `access unavailable` with the GitHub answer kind). Membership is explicit, so a
  targeted run (one page visit, `backfill --names …`) never implies absence of the rest, and
  "not present in the latest run" is inferred only from a full live run.
- A repository GitHub did not answer about gets no snapshot: "current access unavailable", never
  deletion; last-known rows stay attributable. Nothing in the record or the view calls this a
  failure.
- No scheduler, no daemon, no notifications. The command exists so a collection is an official
  act with a record, whenever it is run.

### B. `backfill` — the daily series from history

`pnpm --filter @grove/app backfill -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--names a/b,…] [--apply]`
→ `app/scripts/backfill.ts`. Dry run by default: prints, per identity, the days it would fill,
the commits it would read and the divergences in play; writes nothing. `--to` defaults to and may
not exceed the previous UTC day.

- **Source.** A blobless clone per identity in `GROVE_GIT_CACHE` (default
  `data/git-cache/<github_id>`), fetched read-only with the token; `ls-tree -r`,
  `log --first-parent --format`, `show <sha>:<path>`. Nothing is written to any repository.
- **Shared definitions.** The live tree classification is split into a pure
  `classifyTree(entries)` in `lib/github`, used by both the live fetch and the backfill, so
  manifests, documentation / CI / test detection and the truncation guard are one function.
  Commit counting and ecosystem dependency counting get the same treatment.
- **Per day, atomically.** For each in-scope identity and each UTC day in range without an
  observed snapshot: the day's snapshot, its `state`, and the declaration rows for the commits of
  that day commit in **one transaction**, so an interrupted run leaves either a complete day or
  nothing, and a retry repairs rather than skips. Rows carry `method = 'history'`, `github_id`,
  `collection_run_id`, `observed_at` = end of day, `recorded_at` = wall clock, and
  `evidence = {sha, committed_at, branch_state: 'retrospective', state, algorithm, divergences}`.
- **Migration** `0006_observation_method`: `method`, `recorded_at`, `collection_run_id` and
  `evidence` on `ecology_snapshots` and `declaration_changes` (default `observed`; existing rows
  untouched).
- **Chronology, not insertion order.** `getLatestDeclaration`, `getDeclarationHistory` and the
  declaration dedupe order by `observed_at` then `id`, so an older reconstructed declaration
  inserted after a newer live one never becomes the apparent latest.
- **Idempotent.** An existing complete row for (identity, day) — of either method — is never
  replaced. A later live observation on a backfilled day is recorded beside it; the window rule
  prefers it.
- **Names.** Rows are stored under the name bound to the identity on that day; a day inside a
  rename gap with no binding is stored under the nearest later binding's name with evidence
  saying so. Because rows carry `github_id`, no binding is widened and no overlap arises.
- **Timeline wording.** "Recorded from history as the default branch now records it: {n} days,
  {first}–{last} (recorded {recorded_at})." and, for declarations, "Declared in repository on
  {commit date} — recorded from history on {recorded_at}." The "Not observed — … ({n} days
  without observation)" entry remains, computed from observed rows only.

### C. `/since` — the re-entry view

Route `/since`, linked from the overview; the overview itself is unchanged.

- **Reference.** A steward-chosen prior instant. `comparison_references` (`steward_id`,
  `reference_at`, `saved_at`, `label` nullable), append-only, explicit save ("Keep this point as a
  reference"), never created by opening a page.
- **Default** when none is saved: the last observation before the most recent span of 14 days or
  more without observation — what Grove last saw before the absence, so the comparison spans the
  absence and everything since — else the earliest observation; shown as a default.
- **As-of rule.** "At the reference" means, per identity, the latest row with `observed_at` at
  or before `reference_at`; on the same day an `observed` row takes precedence over a `history`
  one; a later row is never selected. An identity with no row at or before the reference is
  stated as "not observed at the reference", not compared.
- **Content**, deterministic, each line tagged **observed** / **declared** / **reconstructed** /
  **proposed**:
  - repositories first observed after the reference ("newly observed"; "created {date}" only
    when `created_at` is after the reference);
  - repositories present at the reference but not present in the latest **full live** run, with
    the run's outcome for them ("current access unavailable", with the answer kind);
  - name changes (bindings);
  - declaration changes, field by field;
  - structural observations at the reference and now, as plain pairs: density tier, manifests,
    ecosystem dependency count — no deltas with adjectives, no file-count noise;
  - evidence: observation-gap spans within the interval (observed rows only), days recorded from
    history, repositories without any row in the interval, runs that did not cover the full
    portfolio;
  - climate: declarations and proposals created / supported / withdrawn in the interval.
- Nothing counts as acknowledgement: no unread state, no badge, no "n items" heading.

## 5. Acceptance examples (synthetic names in tests)

| Scenario | Expected |
|---|---|
| Backfill over a 170-day gap ending yesterday, then `collect` | Each past day has a `history` slot; today has only the live row; windows ending today are determinate; the "Not observed" entry remains; no proposal is dated inside the gap. |
| Backfill re-run over the same range | No new rows; the dry run lists zero days to fill. |
| A run is interrupted after a day's snapshot but before its declarations | Nothing of that day is committed; the next run fills it completely. |
| A live snapshot exists for a day in the range | That day is skipped by backfill; the window slot uses the observed row. |
| Repository created on day 3, first commit on day 10 | Days 1–2 empty; days 3–9 `state: empty`; day 10 onward from the tree. |
| `.grove.yaml` changed in three commits on one day | Three declaration rows with SHAs and commit dates, one snapshot for the day. |
| A commit dated before the range was fast-forwarded into the branch inside it | Reconstructed as the retrospective branch state, labelled so; no claim about when it joined. |
| Role changed mid-window in reconstructed rows | The window is `insufficient` for stratum-based triggers. |
| Name reused during the range | Rows land under the binding in force that day and carry the identity; nothing is widened. |
| One repository returns `forbidden` during `collect` | The run row and its repository row say "access unavailable (forbidden)"; no snapshot for it; last-known rows remain. |
| A targeted run (`--names` or one page visit) | `full_portfolio` is false; `/since` infers no absences from it. |
| A page is opened repeatedly | No reference is saved; only the hourly-throttled visit observation. |
| Reference saved between two rows | Comparison uses the latest row at or before it; an identity with none is "not observed at the reference". |
| Repository discovered that was created long before the reference | "Newly observed", not "created". |

## 6. Out of scope

Child units / components; attention declarations; relationships beyond bindings; any scheduler
inside or outside Grove; generated digests; contemporaneous branch-state evidence (not available
from a clone); changes to the climate evaluator beyond the stratum-agreement rule above.

## 7. Sequence

Three stacked changes — `collect`, `backfill`, `since` — each reviewed on its own, on top of the
row-identity slice they rely on.
