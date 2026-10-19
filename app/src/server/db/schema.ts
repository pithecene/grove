import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Reference table — upserted on sync.
 * Tracks the last-observed state of each GitHub repository *name*.
 * Names are mutable; `github_id` is the immutable identity observed under
 * this name most recently (null for rows recorded before identity tracking).
 */
export const repositories = sqliteTable('repositories', {
  fullName: text('full_name').primaryKey(),
  htmlUrl: text('html_url').notNull(),
  defaultBranch: text('default_branch').notNull(),
  pushedAt: text('pushed_at'),
  sizeKb: integer('size_kb'),
  lastObservedAt: text('last_observed_at').notNull(),
  githubId: integer('github_id'),
  /** GitHub creation time: the repository existed from here, with or without commits */
  createdAt: text('created_at'),
})

/**
 * Time-bound binding of a repository name to an immutable GitHub id.
 *
 * History rows stay keyed by the name they were observed under; a binding
 * says which identity that name denoted between `first_observed_at` and
 * `last_observed_at`. A rename yields a second binding for the same id;
 * a reused name yields a second binding for the same name; an identity
 * that returns to a former name yields a further time segment. Original
 * observations are never rewritten.
 *
 * method: 'observed' (id captured live at observation time) or
 * 'github_redirect' (historical name resolved later through the API;
 * `evidence` records what GitHub answered and when).
 */
export const repositoryBindings = sqliteTable(
  'repository_bindings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubId: integer('github_id').notNull(),
    fullName: text('full_name')
      .notNull()
      .references(() => repositories.fullName),
    firstObservedAt: text('first_observed_at').notNull(),
    lastObservedAt: text('last_observed_at').notNull(),
    method: text('method').notNull(),
    resolvedAt: text('resolved_at').notNull(),
    evidence: text('evidence'),
  },
  (table) => [
    // Not unique: an identity that returns to a name it held before gets a
    // new time segment rather than one binding spanning another identity's.
    index('idx_bindings_identity').on(table.githubId, table.fullName),
    index('idx_bindings_name').on(table.fullName),
  ],
)

/**
 * Outcome of the most recent attempt to resolve a historical name.
 * Keeps unresolved names visible as unresolved — a 404 is recorded as
 * "not found or not accessible", never as deletion.
 */
export const identityResolutions = sqliteTable('identity_resolutions', {
  fullName: text('full_name')
    .primaryKey()
    .references(() => repositories.fullName),
  attemptedAt: text('attempted_at').notNull(),
  outcome: text('outcome').notNull(),
  httpStatus: integer('http_status'),
  githubId: integer('github_id'),
  resolvedFullName: text('resolved_full_name'),
  evidence: text('evidence'),
})

/**
 * Immutable, append-only observation history.
 * Season is never stored — it is derived from phase at read time.
 * Density tier + description are stored to preserve the observation
 * even if the algorithm changes in a future version.
 */
export const ecologySnapshots = sqliteTable(
  'ecology_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fullName: text('full_name')
      .notNull()
      .references(() => repositories.fullName),
    /**
     * Identity the row was recorded for, when known at write time. Rows
     * with an id are matched by it directly; rows recorded before row
     * identity (null) resolve through `repository_bindings` only.
     */
    githubId: integer('github_id'),
    observedAt: text('observed_at').notNull(),
    /**
     * How the row came to be: `observed` (GitHub at that moment) or
     * `history` (reconstructed from the repository's commit history —
     * the retrospective branch state, never presented as contemporaneous).
     */
    method: text('method').notNull().default('observed'),
    /** When the row was actually written — for `history` rows, the backfill time */
    recordedAt: text('recorded_at'),
    collectionRunId: integer('collection_run_id'),
    /** JSON provenance for `history` rows: sha, committed_at, branch_state, state, algorithm, divergences */
    evidence: text('evidence'),
    classified: integer('classified', { mode: 'boolean' }).notNull(),
    // Declaration fields — all nullable (unknown is first-class)
    intent: text('intent'),
    horizon: text('horizon'),
    role: text('role'),
    phase: text('phase'),
    steward: text('steward'),
    consolidationIntervalDays: integer('consolidation_interval_days'),
    // Structural signals
    fileCount: integer('file_count'),
    commitsLast30d: integer('commits_last_30d'),
    commitsLast90d: integer('commits_last_90d'),
    dependencyManifestsObserved: text('dependency_manifests_observed'),
    ecosystemDependencyCount: integer('ecosystem_dependency_count'),
    // Density observation
    densityTier: text('density_tier'),
    densityDescription: text('density_description'),
  },
  (table) => [
    index('idx_snapshots_repo_time').on(table.fullName, table.observedAt),
    index('idx_snapshots_identity_time').on(table.githubId, table.observedAt),
  ],
)

/**
 * Recorded only when a declaration differs from the previous observation.
 * Enables tracking when intent, phase, or other declarations change.
 */
export const declarationChanges = sqliteTable(
  'declaration_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fullName: text('full_name')
      .notNull()
      .references(() => repositories.fullName),
    /** Identity the row was recorded for, when known at write time (see ecology_snapshots) */
    githubId: integer('github_id'),
    observedAt: text('observed_at').notNull(),
    /** `observed` | `history` (see ecology_snapshots.method) */
    method: text('method').notNull().default('observed'),
    recordedAt: text('recorded_at'),
    collectionRunId: integer('collection_run_id'),
    /** JSON provenance for `history` rows: sha, committed_at, path */
    evidence: text('evidence'),
    classified: integer('classified', { mode: 'boolean' }).notNull(),
    // Declaration fields — all nullable
    intent: text('intent'),
    horizon: text('horizon'),
    role: text('role'),
    phase: text('phase'),
    steward: text('steward'),
    consolidationIntervalDays: integer('consolidation_interval_days'),
  },
  (table) => [
    index('idx_declarations_repo_time').on(table.fullName, table.observedAt),
    index('idx_declarations_identity_time').on(table.githubId, table.observedAt),
  ],
)

/**
 * Steward-set, append-only climate declarations.
 * Climate persists across sessions (survives logout).
 * Keyed by declared_by_id (immutable GitHub user ID) for continuity
 * across username changes. declared_by stores the login for display.
 */
export const climateDeclarations = sqliteTable('climate_declarations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  climate: text('climate').notNull(),
  declaredAt: text('declared_at').notNull(),
  declaredBy: text('declared_by'),
  declaredById: integer('declared_by_id'),
})

/**
 * §2.1–2.3 — Climate proposals generated by Grove's observation pipeline.
 * Only one active proposal may exist at a time.
 *
 * Status lifecycle:
 * - active: proposed, awaiting steward response
 * - accepted: steward confirmed (climate declaration was made)
 * - dismissed: steward declined the proposal
 * - withdrawn: Grove withdrew because the underlying pattern reversed
 */
export const climateProposals = sqliteTable('climate_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  climate: text('climate').notNull(),
  basis: text('basis').notNull(),
  triggerType: text('trigger_type').notNull(),
  observedSeason: text('observed_season'),
  observation: text('observation').notNull(),
  status: text('status').notNull().default('active'),
  proposedAt: text('proposed_at').notNull(),
  respondedAt: text('responded_at'),
  stewardId: integer('steward_id'),
  /** Last evaluation whose window carried enough evidence and reproduced the pattern */
  lastSupportedAt: text('last_supported_at'),
  /**
   * JSON array of `{ fullName, githubId? }` — the repositories whose
   * persistence the proposal drew on. A later evaluation can only call the
   * pattern reversed when every one of them is present and observed enough.
   */
  sourceRepositories: text('source_repositories'),
})

/**
 * One row per collection — a page visit, an explicit `collect`, or a
 * backfill: the record of what Grove attempted and when. Never a metric.
 */
export const collectionRuns = sqliteTable('collection_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  /** 'visit' | 'cli' | 'backfill' */
  method: text('method').notNull(),
  stewardId: integer('steward_id'),
  /** The run targeted the whole configured scope, not one repository or a named subset */
  fullPortfolio: integer('full_portfolio', { mode: 'boolean' }).notNull(),
  /** Every targeted repository received an outcome row */
  complete: integer('complete', { mode: 'boolean' }).notNull().default(false),
  /** GitHub answer kind when the run could not proceed as a whole (e.g. the listing) */
  answer: text('answer'),
  /** JSON `{ owners, exclude }` of the configured scope at the time, when any */
  scope: text('scope'),
})

/**
 * One row per repository a run was about: present and observed, present
 * but within the snapshot throttle (`unchanged`), not answered by GitHub
 * (`unavailable`, with the answer kind), or answered but not recorded
 * because the run ended incomplete (`not_recorded`). Membership is explicit
 * so a targeted run never implies absence of the rest.
 */
export const collectionRunRepositories = sqliteTable(
  'collection_run_repositories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => collectionRuns.id),
    githubId: integer('github_id'),
    fullName: text('full_name').notNull(),
    /** 'observed' | 'unchanged' | 'unavailable' | 'not_recorded' */
    outcome: text('outcome').notNull(),
    /** GitHub answer kind when `unavailable` */
    answer: text('answer'),
  },
  (table) => [index('idx_run_repositories_run').on(table.runId)],
)
