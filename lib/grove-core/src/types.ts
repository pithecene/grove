// Ecology enumerations — const arrays for runtime validation + types

export const HORIZONS = [
  'ephemeral',
  'seasonal',
  'perennial',
  'generational',
] as const
export type Horizon = (typeof HORIZONS)[number]

export const PHASES = [
  'emerging',
  'expanding',
  'consolidating',
  'pruning',
  'resting',
  'archival',
] as const
export type Phase = (typeof PHASES)[number]

export const ROLES = [
  'infrastructure',
  'application',
  'library',
  'experiment',
  'documentation',
  'stewardship',
  'civilizational',
] as const
export type Role = (typeof ROLES)[number]

export const SEASONS = [
  'expansion',
  'consolidation',
  'pruning',
  'dormancy',
] as const
export type Season = (typeof SEASONS)[number]

export const CLIMATES = SEASONS
export type Climate = Season

export const DORMANCY_MODES = ['hibernation', 'survival'] as const
export type DormancyMode = (typeof DORMANCY_MODES)[number]

export const RITUALS = [
  'consolidation',
  'stewardship_reaffirmation',
  'intent_redeclaration',
  'ecosystem_balance',
] as const
export type Ritual = (typeof RITUALS)[number]

// §1.1 — derived from declared Role
export const ROLE_CLASSES = ['foundational', 'system', 'domain'] as const
export type RoleClass = (typeof ROLE_CLASSES)[number]

// §1.2 — categorical relation between season and climate
export const CLIMATE_RELATIONS = ['aligned', 'divergent', 'orthogonal'] as const
export type ClimateRelation = (typeof CLIMATE_RELATIONS)[number]

// §3 — structural strata
export const STRATA = ['structural_core', 'long_arc_domain', 'ephemeral_field'] as const
export type Stratum = (typeof STRATA)[number]

// §2.2 — categorical reason for climate proposal
export const PROPOSAL_BASES = [
  'sustained_core_divergence',
  'long_arc_alignment',
  'density_drift_upward',
  'density_drift_downward',
  'mixed_transition',
] as const
export type ProposalBasis = (typeof PROPOSAL_BASES)[number]

// §2.1 — climate state union
export type ClimateState =
  | { kind: 'undefined' }
  | { kind: 'declared'; climate: Climate }
  | { kind: 'proposed'; climate: Climate; basis: ProposalBasis }

// Parsed .grove.yaml — missing optionals are undefined ("unknown")
export interface GroveDeclaration {
  intent: string
  horizon?: Horizon
  role?: Role
  phase?: Phase
  steward?: string
  consolidation_interval_days?: number
}

// Transparent season derivation
export interface SeasonDerivation {
  season: Season
  sourcePhase: Phase
  dormancyMode?: DormancyMode
}

// Consolidation interval observation
export interface ConsolidationObservation {
  intervalDays: number
  daysSinceActivity: number
  elapsed: boolean
}

// Ritual invitation — observation string uses observational language
export interface RitualInvitation {
  ritual: Ritual
  observation: string
}

// Phase duration observation
export interface PhaseDurationObservation {
  phase: Phase
  declaredAt: string // ISO 8601
  daysSinceDeclared: number
  horizon?: Horizon // context for threshold interpretation
}

// Climate/season tension
export interface ClimateTension {
  fullName: string
  climate: Climate
  season: Season
}

// Density tiers — observational, not evaluative
export const DENSITY_TIERS = [
  'sparse',
  'rooting',
  'thickening',
  'dense_canopy',
  'tangled_thicket',
] as const
export type DensityTier = (typeof DENSITY_TIERS)[number]

/** Observed structural signals — all optional, absence is valid */
export interface StructuralSignals {
  fileCount?: number
  commitsLast30d?: number
  commitsLast90d?: number
  dependencyManifestsObserved?: string[]
  ecosystemDependencyCount?: number
  /** Documentation and onboarding artifacts observed in the tree */
  readmePresent?: boolean
  contributingPresent?: boolean
  licensePresent?: boolean
  docsDirectoryPresent?: boolean
  /** CI/CD and testing infrastructure observed in the tree */
  ciConfigPresent?: boolean
  testDirectoryPresent?: boolean
  /** Co-located test file patterns observed (e.g. *_test.go, *.test.ts) */
  testFilePatternsObserved?: boolean
  observedAt: string // ISO 8601
}

/** Derived density observation — descriptive tier, not a score */
export interface DensityObservation {
  tier: DensityTier
  description: string
  signals: StructuralSignals
}

/** Structural signals captured at reference time (subset of StructuralSignals) */
export interface ReferenceSnapshot {
  fileCount?: number
  ecosystemDependencyCount?: number
  densityTier?: DensityTier
  observedAt: string // ISO 8601
}

/** Shape drift observation — factual structural comparison */
export interface ShapeDriftObservation {
  referenceSnapshot: ReferenceSnapshot
  currentFileCount?: number
  currentEcosystemDependencyCount?: number
  currentDensityTier?: DensityTier
  descriptions: string[] // 0–N observational sentences
}

/** Motion drift observation — tension between phase and cadence */
export interface MotionDriftObservation {
  phase: Phase
  commitsLast30d?: number
  commitsLast90d?: number
  description: string // single observational sentence
}

// §4 — how much of a calendar-anchored window was actually observed
export const WINDOW_EVIDENCE = ['complete', 'partial', 'insufficient'] as const
export type WindowEvidence = (typeof WINDOW_EVIDENCE)[number]

export interface PersistenceAssessment {
  alignedCount: number
  divergentCount: number
  orthogonalCount: number
  /** Observed snapshots whose relation could not be derived (e.g. no phase) */
  undeterminedCount: number
  /** Snapshots actually observed inside the window */
  totalSnapshots: number
  /** Calendar days the window spans */
  windowDays: number
  /** Calendar days inside the window with no observation at all */
  missingDays: number
  /**
   * complete — every day observed; partial — enough observed days that the
   * threshold is reachable; insufficient — the threshold cannot be reached,
   * so persistence is undeterminable (not "absent").
   */
  evidence: WindowEvidence
  persistentlyAligned: boolean
  persistentlyDivergent: boolean
}

// §2.3 — relation between a standing proposal and the current window
export const PROPOSAL_EVIDENCE_STATES = ['supported', 'reversed', 'not_observed'] as const
export type ProposalEvidenceState = (typeof PROPOSAL_EVIDENCE_STATES)[number]

/** Individual repo persistence context for trigger evaluation */
export interface RepoPersistenceContext {
  fullName: string
  stratum: Stratum | undefined
  persistence: PersistenceAssessment
  /** The divergent season, if persistently divergent. Needed for §5.3 coherence check. */
  divergentSeason?: Season
}

/** §5 trigger evaluation result */
export interface EcosystemTriggerResult {
  /** §5.1 — Set A repos that are persistently divergent */
  coreDivergence: RepoPersistenceContext[]
  /** §5.2 — true if Set A has both persistently aligned and persistently divergent repos */
  coreSplit: boolean
  /** §5.3 — Set B repos that are persistently divergent in the same direction */
  longArcDrift: {
    repos: RepoPersistenceContext[]
    /** The shared divergent season, if coherent */
    coherentSeason?: Season
  }
  /** Whether any trigger fired */
  triggered: boolean
}

/**
 * Accessibility observation — cognitive legibility relative to declared intent.
 * Describes observed documentation and onboarding artifacts without judging quality.
 * CONTRACT_ACCESSIBILITY.md constrains: no grading, no prescriptive guidance.
 */
export interface AccessibilityObservation {
  /** Prerequisites implied by observed dependency manifests */
  impliedPrerequisites: string[]
  /** Documentation artifacts observed as present */
  presentArtifacts: string[]
  /** Documentation artifacts observed as absent */
  absentArtifacts: string[]
  /** Observational sentences — 0-N, silence is valid */
  descriptions: string[]
}

/**
 * Capability observation — observable infrastructure for exercising the project.
 * Describes CI, testing, and build infrastructure presence without claiming anything works.
 * CONTRACT_CAPABILITY_OBSERVATION.md constrains: no pass/fail, no "working"/"broken".
 */
export interface CapabilityObservation {
  /** Build/run infrastructure artifacts observed */
  observedInfrastructure: string[]
  /** Observational sentences — 0-N, silence is valid */
  descriptions: string[]
}

/** §2.1 — Climate proposal generated by Grove's observation pipeline */
export interface ClimateProposal {
  /** The climate Grove is suggesting */
  climate: Climate
  /** Categorical reason for the proposal */
  basis: ProposalBasis
  /** Which trigger type drove the escalation */
  triggerType: 'core_divergence' | 'core_split' | 'long_arc_drift'
  /** The coherent divergent season observed, if applicable */
  observedSeason?: Season
  /** When observation last reproduced the pattern behind this proposal (ISO 8601) */
  lastSupportedAt?: string
  /**
   * supported — the current window reproduces the pattern;
   * not_observed — the current window lacks enough observed days to re-examine it.
   * A proposal whose pattern reversed is withdrawn and never surfaced.
   */
  evidence?: Exclude<ProposalEvidenceState, 'reversed'>
}

// Classified repository
export interface RepositoryEcology {
  fullName: string
  htmlUrl: string
  declaration?: GroveDeclaration
  season?: SeasonDerivation
  density?: DensityObservation
  classified: boolean
}

// Portfolio
export interface Portfolio {
  repositories: RepositoryEcology[]
  unclassified: RepositoryEcology[]
  climate?: Climate
}
