# Repository identity — the invariant

Status: binding design note for `app/src/server/db/bindings.ts` and everything that reads
or writes observation rows. Code is derived from this; a change here precedes a change there.

## 1. Two keys

- A repository's **identity** is its immutable GitHub id. It survives renames and transfers.
- A repository's **name** (`owner/name`) is mutable, reusable, and is what every observation
  row is stored under. Rows are never rewritten: the name a row carries is the name Grove saw.

Identity is attached to names through **bindings** — time-bound segments
`(github_id, full_name, first_observed_at, last_observed_at, method, evidence)`.

## 2. The invariant

> A row stored under name *N* at instant *t* belongs to identity *I* if and only if a binding
> segment of *I* for *N* contains *t* (bounds inclusive, exact timestamps).

Everything else follows from it:

1. **One name at a time.** An identity is never bound to two names over overlapping instants.
   Therefore the latest observation of *I* under any other name is a hard floor for a segment
   of *I* under *N*: rows under *N* at or before that instant cannot be *I*'s.
2. **One identity per name at a time.** Two identities are never bound to the same name over
   overlapping instants (`findOverlappingBinding`). A conflict is reported, never resolved by
   choosing.
3. **Segments, not spans.** An identity that leaves a name and returns to it gets a new segment,
   whether or not another identity held the name in between. Nothing stretches across the
   interval it spent elsewhere.
4. **Bounds are exact and extend only by observation.** A segment's `last_observed_at` advances
   when a row is recorded under its name inside it; `first_observed_at` moves earlier only by
   adoption (§3). Rows later than the latest observation are never pulled in: they belong to
   whatever the name denotes at their own time.
5. **Rows recorded from now on carry their identity.** New snapshot and declaration rows record
   `github_id` at write time where it is known; they are matched by id directly and never depend
   on a binding. Historical rows (`github_id IS NULL`) resolve only through bindings. (Planned:
   migration `0005_row_identity`.)

## 3. Attributing rows that predate identity tracking (adoption)

A name first observed on a database recorded before identity tracking has rows no binding
covers. They are adopted into the new segment only back to the **latest instant that excludes
them**, and the basis is recorded in the binding's evidence (`floor_basis`):

| basis | floor | strength |
|---|---|---|
| `previous_name_observation` | the identity's last observation under another name | strong: one name at a time |
| `created_at` | the repository's creation time | weak: the repository may have existed under another name before taking this one |
| `earliest_row` | the earliest row stored under the name | no exclusion at all |

The strongest available basis wins. A `created_at`-only adoption is a visibly weaker claim, not
a silently equal one. Rows before the floor stay unbound.

## 4. What a backfill may claim

A backfill asks GitHub what a historical name denotes **now**; a redirect proves the name once
belonged to the resolved repository, not since when. Therefore:

- Names are resolved first and bound in order of observation end, so a name the repository held
  earlier floors a name it took later (§2.1).
- Rows before the floor are reported as unbound (`name_reused`, `unboundSpan`, `floorBasis`,
  `previousName`) and left alone.
- `not_found` is recorded as "not found *or not accessible*", never as deletion.
- Re-running is idempotent: existing bindings are never rewritten or tightened. Tightening is a
  deliberate, separate act.

## 5. What reads must honour

Every read that aggregates rows for an identity goes through the identity predicate
(`getSnapshotHistoryForIdentity`, `getDeclarationHistoryForIdentity`, `getPortfolioCalendarWindow`)
or matches `github_id` directly (§2.5). Per-name guards that compare "the previous row" — the
snapshot throttle, declaration dedupe, observed span — compare only the identity's own rows
under that name: by id and name where the row recorded its identity, otherwise within the
name's current segment (`currentSegmentStart`). A name taken over by another repository starts
afresh, and a repository observed under a new name records its first row there.

A name with no binding at all keeps name-keyed behaviour: nothing is known, nothing is inferred.

## 6. What is not claimed

- A rename date. A name change is "observed under a new name"; the rename happened somewhere
  between the last observation under the old name and the first under the new one.
- Continuity across a gap. A span without observation is reported as exactly that.
- Anything about a name GitHub does not answer about: `unavailable`/`unreachable` answers record
  nothing.
