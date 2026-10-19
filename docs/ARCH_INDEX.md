# Grove — Architectural Index

This document provides a fast navigation map of the repository.
It is not a design document. It is a structural lookup table.

---

## Root

- `README.md`
  High-level overview and purpose.

- `CLAUDE.md`
  Constitutional constraints and invariants.

- `AGENTS.md`
  Role definitions and development discipline.

- `.grove.yaml`
  Grove's own stewardship declaration. Grove observes itself.

---

## /docs

Documentation and design artifacts.

- `INTENT.md`
  Canonical intent declaration for Grove.

- `MODEL.md`
  Conceptual model: Intent, Shape, Motion, Accessibility, Capability, Fit, (In)Action.

- `QUESTIONS.md`
  Enumerated stewardship questions Grove is allowed to surface.

- `MEASURES.md`
  Measurement vocabulary and contextual signal definitions.

- `ANTI_PATTERNS.md`
  Drift patterns that indicate deviation from intent and contracts.

- `IMPLEMENTATION_PLAN.md`
  Phased implementation plan inherited from Phase 0 doctrine.

- `philosophy.md`
  Long-horizon stewardship framing.

- `ecology.md`
  v1 primitives (horizon, phase, role, steward, cadence, dependency load, ritual, season, climate).

- `design_principles.md`
  UI design guardrails.

- `roadmap.md`
  Planned evolution of Grove.

- `contracts/`
  Formalized invariants and interface boundaries.

- `designs/`
  Specifications and interaction notes.

  - `designs/rituals.md`
    Design specification for rituals, seasons, and climate.

  - `designs/ui-v0.md`
    Phase 1 UI implementation handoff.

  - `designs/identity.md`
    The repository-identity invariant: bindings, segments, adoption floors, what reads and backfills may claim.

  - `designs/re-entry-v1.md`
    Design proposal: official collection and backfill, and the "since this reference" view.

---

## Core Concepts

Grove operates on a fixed conceptual spine:

**Intent → Shape → Motion → Accessibility → Capability → Fit → (In)Action**

- **Intent** — human-declared purpose and audience
- **Shape** — static structure of the codebase
- **Motion** — how the code changes over time
- **Accessibility** — cognitive legibility relative to intent
- **Capability** — observed, time-bound behavior
- **Fit** — alignment or tension between the above
- **(In)Action** — prune, preserve, freeze, split, archive — or do nothing

Inaction is a first-class outcome.

---

## Data Flow (v1)

```
.grove.yaml → grove-core → grove-web
GitHub API  ↗
```

- **grove-core** — Pure TypeScript logic. Parses `.grove.yaml`, computes ecology signals, evaluates fit. No framework dependencies.
- **grove-web** — TanStack Start application layer. OAuth, GitHub fetching, rendering.

---

## Architecture (planned)

### /lib/grove-core

Framework-agnostic logic:
- `.grove.yaml` parsing
- Horizon handling
- Phase evaluation
- Consolidation checks
- Dependency load calculation
- Ritual eligibility and invitation surfacing
- Season derivation from phase
- Calendar-anchored persistence windows (`persistence.ts`) — missing days are explicit
- Proposal evidence (`proposals.ts`) — supported / reversed / not observed

### /lib/github

GitHub API client and repo sync logic.
- `client.ts` — enumeration, `.grove.yaml` fetch, name → identity resolution (follows renames)

### /app

TanStack Start application layer:
- `routes/` — Web routes (overview, repo detail, auth callbacks)
- `components/` — Reusable UI components
- `styles/` — Global styling and design primitives

### /server

Server-side utilities (`app/src/server/`):
- `identity.ts`, `auth.ts` — steward identity from `GROVE_GITHUB_TOKEN`
- `portfolio.ts`, `repository.ts` — loading, classification, persistence
- `scope.ts` — explicit portfolio selection from `GROVE_SCOPE_*` (private to the deployment)
- `ecosystem-triggers.ts` — calendar-anchored trigger and proposal evaluation
- `timeline.ts` — structural timeline incl. observation gaps and name changes
- `db/bindings.ts` — time-bound name ↔ identity bindings; history across renames
- `identity-backfill.ts` + `app/scripts/identity-backfill.ts` — evidence-backed binding of historical names (dry run by default)

---

## Sync Engine (v1)

GitHub API. Live fetch per session. No persistence.

---

## Storage Model

- **v1:** None. Session-based.
- **v2:** SQLite or Postgres. Snapshot history.

---

## Configuration

- `.grove.yaml` (per-repo file)
  Declares: intent, horizon, role, phase, steward, consolidation cadence.
  See `docs/designs/grove-yaml-spec.md`.

---

## Contracts

Contracts are the normative authority for implementation behavior.

They constrain interpretation, language, and behavior — not runtime APIs.

All contracts live in `docs/contracts/`.

---

## Phase Discipline

- Phase 0: Doctrine and contracts (current)
- Phase 1: Ecology engine + web UI (TanStack Start, GitHub OAuth, `.grove.yaml`)
- Phase 2: Persistence layer (SQLite/Postgres, snapshot history)
- Phase 3: Drift detection and consolidation tracking
- Phase 4: Cosmology projection layer
- Phase 5: Optional generalization

Later phases may not be reached. This is acceptable.

---

## Future (Not Yet Implemented)

- Persistence layer
- Historical drift tracking
- Cosmology projection engine
- Background sync jobs

---

## Invariant

Grove must remain useful even if visited only a few times per year.
