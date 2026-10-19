# Re-entry v1 — official collection and backfill, and "since this reference"

Status: design proposal. Nothing here is implemented. Examples use synthetic names.

## 1. The observation this design answers

Grove v1 observes only when a page is opened. A steward whose attention concentrates on a few
projects stops opening Grove; Grove therefore stops observing — including the concentration
itself. The record of that period still exists in each repository's git history. Reconciling it
by hand afterwards (which repositories are new, which were renamed, which spans were not observed
rather than inactive, which declarations moved) is the report the product should produce.

Three consequences, in order:

1. Collection and backfill are official, explicit, repeatable commands — not visits, not one-off
   scripts.
2. Git is the source for the repository-side daily series; live observation adds GitHub-side
   state.
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

| | `observed` | `git_history` |
|---|---|---|
| When written | at a visit or a `collect` run | by `backfill`, for UTC days lacking an observed snapshot |
| Inputs | GitHub REST at that moment: tree of the default branch, commit-activity stats, root `package.json`, `pushed_at`, repository metadata | the repository's git history: tree at the last default-branch commit ≤ end of day, commit dates, `.grove.yaml` and root `package.json` at that commit |
| `observed_at` | wall clock | end of the UTC day (`T23:59:59.999Z`), with the commit SHA in evidence |
| Lens | the algorithm in force at that time | the algorithm in force when the backfill runs (version recorded in evidence) |

What git holds exactly: the tree (file count, manifests, documentation/CI/test artifacts, root
`package.json` and its dependency names), every commit's date, and `.grove.yaml` at every commit.
What git does not hold: `pushed_at` (any-branch push time), the GitHub-side name on a given day
(covered by bindings), repositories since deleted, and GitHub's Sunday-anchored weekly buckets.

Divergences are stated in evidence and here, never hidden:

- **Commit windows.** Reconstructed `commits_last_30d` / `commits_last_90d` count default-branch
  commits by committer date in the trailing 30 / 90 calendar days; live rows use GitHub's last
  4 / 13 weekly buckets. Live rows stay as recorded; each row carries its own lens.
- **Consolidation input.** Reconstructed rows use the last default-branch commit date where live
  rows use `pushed_at` (which can be later, from other branches).
- **Ecosystem dependency count.** Resolved against the portfolio repositories that existed on that
  day (`created_at` ≤ day), under the names they held that day (bindings).
- **Density tier.** Computed with the current `observeStructuralDensity`; evidence records the
  Grove version and commit that computed it.

**Window rule.** One slot per UTC day per identity. An observed snapshot fills the slot when one
exists, else a reconstructed one; `insufficient` only when neither. Persistence and escalation
therefore become determinate across backfilled spans.

**Proposal rule.** Proposals are evaluated only when a run happens, from the windows ending that
day. Nothing is backdated: `last_supported_at` never moves into the past, no proposal is created
"as of" a reconstructed day, and the "Not observed" timeline entry stays — it describes method,
not the repository.

**Contract reading.** `CONTRACT_ECOSYSTEM_BALANCE` §4 asks for a daily baseline. This design reads
that as a statement about *resolution* (one observation per repository per day), which git
satisfies, rather than about *collection cadence*. The one amendment it asks for is a sentence in
`CONTRACT_OBSERVATIONAL`: an observation may be recorded from the repository's own history when
its method and source commit are recorded with it; such rows are never presented as
contemporaneous observation. If the cadence reading is preferred instead, §4 needs amending to
admit a derived baseline; the slices below are unchanged either way.

## 4. Slices

### A. `collect` — official on-demand collection

`pnpm --filter @grove/app collect` → `app/scripts/collect.ts`.

- Runs the existing portfolio pipeline (`loadPortfolio`) without a browser session: steward from
  `GROVE_GITHUB_TOKEN`, scope from `GROVE_SCOPE_*`, database from `GROVE_DB_PATH`; same hourly
  throttle, same persistence code. No second pipeline.
- `collection_runs`: `started_at`, `finished_at`, `method` (`cli` | `visit` | `backfill`),
  `steward_id`, `attempted`, `observed`, `failures` (JSON: name, status, message),
  `rate_limit_remaining`, `partial`. Page-load observation records `visit` through the same
  function, so cadences stay distinguishable in the record.
- A repository that fails to fetch gets no snapshot and appears in `failures`: "current access
  unavailable", never deletion; last-known rows stay attributable.
- No scheduler, no daemon, no notifications. The command exists so that a collection is an
  official act with a record, whenever it is run.

### B. `backfill` — the daily series from git

`pnpm --filter @grove/app backfill -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--names a/b,…] [--apply]`
→ `app/scripts/backfill.ts`. Dry run by default: prints, per identity, the days it would fill,
the commits it would read and the divergences in play; writes nothing.

- **Source.** A blobless clone per identity in `GROVE_GIT_CACHE` (default
  `data/git-cache/<github_id>`), fetched read-only with the token; `git ls-tree -r`,
  `git log --format`, `git show <sha>:<path>`. Nothing is written to any repository.
- **Shared definitions.** The live tree classification is split into a pure `classifyTree(entries)`
  in `lib/github`, used by both the live fetch and the backfill, so manifests, documentation / CI /
  test detection and the truncation guard are one function. Commit counting and ecosystem
  dependency counting get the same treatment.
- **Per day.** For each in-scope identity and each UTC day in range without an observed snapshot:
  tip = last default-branch commit with committer date ≤ end of day; if none, the day is left
  empty (the repository did not exist yet). One snapshot row with `method = 'git_history'`,
  `observed_at` = end of day, `evidence` = `{sha, committed_at, algorithm, divergences}`; the
  declaration parsed from `.grove.yaml` at tip; a `declaration_changes` row (also
  method-labelled) only where it differs from the previous row for the identity.
- **Migration** `0005_observation_method`: `method` + `evidence` on `ecology_snapshots` and
  `declaration_changes` (default `observed`; existing rows untouched).
- **Idempotent.** An existing row for (identity, day) — of either method — is never replaced. A
  later live observation on a backfilled day is recorded beside it; the window rule prefers it.
- **Bindings.** Rows are stored under the name bound to the identity on that day; a day inside a
  rename gap with no binding is stored under the nearest later binding, and the evidence says so.
- **Timeline wording.** "Recorded from git history: {n} days, {first}–{last}." and, for
  declarations, "Declared in repository on {commit date} — recorded from git history on
  {run date}." The "Not observed — … ({n} days without observation)" entry remains.

### C. `/since` — the re-entry view

Route `/since`, linked from the overview; the overview itself is unchanged.

- **Reference.** A steward-chosen prior instant. `comparison_references` (`steward_id`,
  `reference_at`, `saved_at`, `label` nullable), append-only, explicit save ("Keep this point as a
  reference"), never created by opening a page.
- **Default** when none is saved: the start of the most recent observed stretch after an
  observation gap of 14 days or more (the point of return), else the earliest observation; shown
  as a default.
- **Content**, deterministic, each line tagged **observed** / **declared** / **reconstructed** /
  **proposed**:
  - repositories first observed after the reference ("newly observed"; "created {date}" only
    when `created_at` is after the reference);
  - repositories present at the reference but absent from the latest run (with the run's failure
    reason when there is one);
  - name changes (bindings);
  - declaration changes, field by field;
  - structural observations at the reference and now, as plain pairs: density tier, manifests,
    ecosystem dependency count — no deltas with adjectives, no file-count noise;
  - evidence: observation-gap spans within the interval, days filled from git history,
    repositories without any row in the interval, partial runs;
  - climate: declarations and proposals created / supported / withdrawn in the interval.
- Nothing counts as acknowledgement: no unread state, no badge, no "n items" heading.

## 5. Acceptance examples (synthetic names in tests)

| Scenario | Expected |
|---|---|
| Backfill over a 170-day gap, then `collect` | Each day has a `git_history` slot; windows ending today are determinate; the "Not observed" entry remains; no proposal is dated inside the gap. |
| Backfill re-run over the same range | No new rows; the dry run lists zero days to fill. |
| A live snapshot exists for a day in the range | That day is skipped by backfill; the window slot uses the observed row. |
| Repository created mid-range | Days before its first commit are left empty, not zero. |
| `.grove.yaml` changed in three commits during the gap | Three `git_history` declaration rows with SHAs and commit dates; the timeline labels them. |
| Name reused during the range | Rows land under the binding in force that day; a day with no binding is stored under the nearest later one, with evidence. |
| One repository returns 403 during `collect` | The run is `partial`; no snapshot for it; "access unavailable"; last-known rows remain. |
| A page is opened repeatedly | No reference is saved; only the hourly-throttled visit observation. |
| Reference saved, then a rename | `/since` shows the name change; history continues across it. |
| Repository discovered that was created long before the reference | "Newly observed", not "created". |

## 6. Out of scope

Child units / components; attention declarations; relationships beyond bindings; any scheduler
inside or outside Grove; generated digests; changes to the climate evaluator beyond reading the
determinate windows the backfill provides.

## 7. Sequence

Three stacked changes — `collect`, `backfill`, `since` — each reviewed on its own. None touches the
identity / calendar-window slice they build on.
