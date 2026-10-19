import { describe, expect, it } from 'vitest'

import {
  buildRepoPersistenceContext,
  evaluateEcosystemTriggers,
} from '../triggers'
import type {
  PersistenceAssessment,
  RepoPersistenceContext,
  RepositoryEcology,
} from '../types'

// --- Helpers ---

function makeRepo(
  fullName: string,
  opts: {
    horizon?: string
    role?: string
    phase?: string
  } = {},
): RepositoryEcology {
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    classified: !!(opts.horizon && opts.role),
    declaration: {
      intent: 'test',
      ...(opts.horizon
        ? {
            horizon:
              opts.horizon as RepositoryEcology['declaration'] extends {
                horizon?: infer H
              }
                ? H
                : never,
          }
        : {}),
      ...(opts.role
        ? {
            role:
              opts.role as RepositoryEcology['declaration'] extends {
                role?: infer R
              }
                ? R
                : never,
          }
        : {}),
      ...(opts.phase
        ? {
            phase:
              opts.phase as RepositoryEcology['declaration'] extends {
                phase?: infer P
              }
                ? P
                : never,
          }
        : {}),
    },
    ...(opts.phase
      ? {
          season:
            opts.phase === 'emerging' || opts.phase === 'expanding'
              ? ({
                  season: 'expansion' as const,
                  sourcePhase: opts.phase as 'emerging' | 'expanding',
                } as const)
              : opts.phase === 'consolidating'
                ? ({
                    season: 'consolidation' as const,
                    sourcePhase: 'consolidating' as const,
                  } as const)
                : opts.phase === 'pruning'
                  ? ({
                      season: 'pruning' as const,
                      sourcePhase: 'pruning' as const,
                    } as const)
                  : opts.phase === 'resting'
                    ? ({
                        season: 'dormancy' as const,
                        sourcePhase: 'resting' as const,
                        dormancyMode: 'hibernation' as const,
                      } as const)
                    : opts.phase === 'archival'
                      ? ({
                          season: 'dormancy' as const,
                          sourcePhase: 'archival' as const,
                          dormancyMode: 'survival' as const,
                        } as const)
                      : undefined,
        }
      : {}),
  }
}

function makePersistence(
  overrides: Partial<PersistenceAssessment> = {},
): PersistenceAssessment {
  return {
    alignedCount: 0,
    divergentCount: 0,
    orthogonalCount: 0,
    undeterminedCount: 0,
    totalSnapshots: 14,
    windowDays: 14,
    missingDays: 0,
    evidence: 'complete',
    persistentlyAligned: false,
    persistentlyDivergent: false,
    ...overrides,
  }
}

function makeContext(
  fullName: string,
  stratum: RepoPersistenceContext['stratum'],
  persistence: Partial<PersistenceAssessment> = {},
  divergentSeason?: RepoPersistenceContext['divergentSeason'],
): RepoPersistenceContext {
  return {
    fullName,
    stratum,
    persistence: makePersistence(persistence),
    divergentSeason,
  }
}

// --- buildRepoPersistenceContext ---

describe('buildRepoPersistenceContext', () => {
  it('returns context with correct stratum for classified repo', () => {
    const repo = makeRepo('org/core', {
      horizon: 'perennial',
      role: 'infrastructure',
      phase: 'consolidating',
    })
    const persistence = makePersistence({ persistentlyAligned: true, alignedCount: 12 })
    const result = buildRepoPersistenceContext(repo, persistence, 'consolidation')

    expect(result).toBeDefined()
    expect(result!.fullName).toBe('org/core')
    expect(result!.stratum).toBe('structural_core')
    expect(result!.persistence).toBe(persistence)
  })

  it('returns undefined for unclassified repo (no horizon)', () => {
    const repo = makeRepo('org/unknown', { role: 'application' })
    const result = buildRepoPersistenceContext(repo, makePersistence(), 'expansion')
    expect(result).toBeUndefined()
  })

  it('returns undefined for unclassified repo (no role)', () => {
    const repo = makeRepo('org/unknown', { horizon: 'perennial' })
    const result = buildRepoPersistenceContext(repo, makePersistence(), 'expansion')
    expect(result).toBeUndefined()
  })

  it('returns context with stratum = undefined for seasonal repo', () => {
    const repo = makeRepo('org/seasonal', {
      horizon: 'seasonal',
      role: 'library',
      phase: 'expanding',
    })
    const result = buildRepoPersistenceContext(repo, makePersistence(), 'expansion')

    expect(result).toBeDefined()
    expect(result!.stratum).toBeUndefined()
  })

  it('sets divergentSeason when persistently divergent and season diverges from climate', () => {
    const repo = makeRepo('org/drift', {
      horizon: 'perennial',
      role: 'application',
      phase: 'expanding',
    })
    const persistence = makePersistence({
      persistentlyDivergent: true,
      divergentCount: 12,
    })
    // expansion season vs dormancy climate → divergent relation
    const result = buildRepoPersistenceContext(repo, persistence, 'dormancy')

    expect(result).toBeDefined()
    expect(result!.divergentSeason).toBe('expansion')
  })

  it('does not set divergentSeason when not persistently divergent', () => {
    const repo = makeRepo('org/ok', {
      horizon: 'perennial',
      role: 'application',
      phase: 'expanding',
    })
    const persistence = makePersistence({ persistentlyAligned: false })
    const result = buildRepoPersistenceContext(repo, persistence, 'expansion')

    expect(result).toBeDefined()
    expect(result!.divergentSeason).toBeUndefined()
  })

  it('does not set divergentSeason when persistently divergent but season is aligned with climate', () => {
    // Stale/inconsistent persistence flag — season is expansion, climate is expansion (aligned),
    // but persistence claims divergent. divergentSeason should not be set.
    const repo = makeRepo('org/stale', {
      horizon: 'perennial',
      role: 'application',
      phase: 'expanding',
    })
    const persistence = makePersistence({
      persistentlyDivergent: true,
      divergentCount: 10,
    })
    const result = buildRepoPersistenceContext(repo, persistence, 'expansion')

    expect(result).toBeDefined()
    expect(result!.divergentSeason).toBeUndefined()
  })

  it('does not set divergentSeason when persistently divergent but season is orthogonal to climate', () => {
    // expansion season vs consolidation climate → orthogonal, not divergent
    const repo = makeRepo('org/ortho', {
      horizon: 'perennial',
      role: 'application',
      phase: 'expanding',
    })
    const persistence = makePersistence({
      persistentlyDivergent: true,
      divergentCount: 10,
    })
    const result = buildRepoPersistenceContext(repo, persistence, 'consolidation')

    expect(result).toBeDefined()
    expect(result!.divergentSeason).toBeUndefined()
  })
})

// --- evaluateEcosystemTriggers — §5.1 Core Divergence ---

describe('evaluateEcosystemTriggers — §5.1 Core Divergence', () => {
  it('one Set A repo persistently divergent → triggered, coreDivergence contains repo', () => {
    const ctx = makeContext('org/core', 'structural_core', {
      persistentlyDivergent: true,
      divergentCount: 12,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.coreDivergence).toHaveLength(1)
    expect(result.coreDivergence[0].fullName).toBe('org/core')
    expect(result.triggered).toBe(true)
  })

  it('multiple Set A repos persistently divergent → all listed', () => {
    const ctx1 = makeContext('org/core1', 'structural_core', {
      persistentlyDivergent: true,
    }, 'expansion')
    const ctx2 = makeContext('org/core2', 'structural_core', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ctx1, ctx2])

    expect(result.coreDivergence).toHaveLength(2)
  })

  it('no Set A repos persistently divergent → coreDivergence empty', () => {
    const ctx = makeContext('org/core', 'structural_core', {
      persistentlyAligned: true,
      alignedCount: 14,
    })
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.coreDivergence).toHaveLength(0)
  })

  it('Set B repo persistently divergent → does NOT trigger coreDivergence', () => {
    const ctx = makeContext('org/app', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.coreDivergence).toHaveLength(0)
  })
})

// --- evaluateEcosystemTriggers — §5.2 Core Split ---

describe('evaluateEcosystemTriggers — §5.2 Core Split', () => {
  it('Set A has aligned + divergent → coreSplit = true', () => {
    const aligned = makeContext('org/core-a', 'structural_core', {
      persistentlyAligned: true,
      alignedCount: 14,
    })
    const divergent = makeContext('org/core-b', 'structural_core', {
      persistentlyDivergent: true,
      divergentCount: 12,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([aligned, divergent])

    expect(result.coreSplit).toBe(true)
    expect(result.triggered).toBe(true)
  })

  it('Set A has aligned only → coreSplit = false', () => {
    const a1 = makeContext('org/core-a', 'structural_core', {
      persistentlyAligned: true,
    })
    const a2 = makeContext('org/core-b', 'structural_core', {
      persistentlyAligned: true,
    })
    const result = evaluateEcosystemTriggers([a1, a2])

    expect(result.coreSplit).toBe(false)
  })

  it('Set A has divergent only → coreSplit = false', () => {
    const d1 = makeContext('org/core-a', 'structural_core', {
      persistentlyDivergent: true,
    }, 'expansion')
    const d2 = makeContext('org/core-b', 'structural_core', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([d1, d2])

    expect(result.coreSplit).toBe(false)
  })

  it('empty Set A → coreSplit = false', () => {
    const result = evaluateEcosystemTriggers([])
    expect(result.coreSplit).toBe(false)
  })
})

// --- evaluateEcosystemTriggers — §5.3 Long-Arc Drift ---

describe('evaluateEcosystemTriggers — §5.3 Long-Arc Drift', () => {
  it('2 Set B repos persistently divergent, same season → triggered, coherentSeason set', () => {
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b2 = makeContext('org/app2', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([b1, b2])

    expect(result.longArcDrift.repos).toHaveLength(2)
    expect(result.longArcDrift.coherentSeason).toBe('expansion')
    expect(result.triggered).toBe(true)
  })

  it('2 Set B repos persistently divergent, different seasons → not triggered', () => {
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b2 = makeContext('org/app2', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'dormancy')
    const result = evaluateEcosystemTriggers([b1, b2])

    expect(result.longArcDrift.repos).toHaveLength(0)
    expect(result.longArcDrift.coherentSeason).toBeUndefined()
  })

  it('1 Set B repo persistently divergent → not triggered (need ≥2)', () => {
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([b1])

    expect(result.longArcDrift.repos).toHaveLength(0)
  })

  it('equal-size tied groups → deterministic tie-break by alphabetical season', () => {
    // 2 repos diverging toward "dormancy", 2 toward "expansion"
    // Alphabetically: "dormancy" < "expansion", so dormancy group wins
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b2 = makeContext('org/app2', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b3 = makeContext('org/app3', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'dormancy')
    const b4 = makeContext('org/app4', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'dormancy')
    const result = evaluateEcosystemTriggers([b1, b2, b3, b4])

    expect(result.longArcDrift.repos).toHaveLength(2)
    expect(result.longArcDrift.coherentSeason).toBe('dormancy')
    expect(result.longArcDrift.repos.map((r) => r.fullName)).toEqual([
      'org/app3',
      'org/app4',
    ])
  })

  it('3 Set B repos: 2 share season, 1 differs → triggered with the 2 coherent repos', () => {
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b2 = makeContext('org/app2', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'expansion')
    const b3 = makeContext('org/app3', 'long_arc_domain', {
      persistentlyDivergent: true,
    }, 'pruning')
    const result = evaluateEcosystemTriggers([b1, b2, b3])

    expect(result.longArcDrift.repos).toHaveLength(2)
    expect(result.longArcDrift.coherentSeason).toBe('expansion')
    expect(result.longArcDrift.repos.map((r) => r.fullName)).toEqual([
      'org/app1',
      'org/app2',
    ])
  })
})

// --- evaluateEcosystemTriggers — triggered flag ---

describe('evaluateEcosystemTriggers — triggered flag', () => {
  it('no triggers → triggered = false', () => {
    const ctx = makeContext('org/core', 'structural_core', {
      persistentlyAligned: true,
    })
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.triggered).toBe(false)
  })

  it('any trigger fires → triggered = true', () => {
    const ctx = makeContext('org/core', 'structural_core', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.triggered).toBe(true)
  })
})

// --- evaluateEcosystemTriggers — strata exclusion ---

describe('evaluateEcosystemTriggers — strata exclusion', () => {
  it('seasonal repos (stratum = undefined) do not contribute to any trigger', () => {
    const seasonal = makeContext('org/seasonal', undefined, {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([seasonal])

    expect(result.coreDivergence).toHaveLength(0)
    expect(result.coreSplit).toBe(false)
    expect(result.longArcDrift.repos).toHaveLength(0)
    expect(result.triggered).toBe(false)
  })

  it('ephemeral repos (Set C) do not trigger independently', () => {
    const ephemeral = makeContext('org/scratch', 'ephemeral_field', {
      persistentlyDivergent: true,
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ephemeral])

    expect(result.coreDivergence).toHaveLength(0)
    expect(result.coreSplit).toBe(false)
    expect(result.longArcDrift.repos).toHaveLength(0)
    expect(result.triggered).toBe(false)
  })

  it('empty contexts → no triggers, triggered = false', () => {
    const result = evaluateEcosystemTriggers([])

    expect(result.coreDivergence).toHaveLength(0)
    expect(result.coreSplit).toBe(false)
    expect(result.longArcDrift.repos).toHaveLength(0)
    expect(result.triggered).toBe(false)
  })

  it('insufficient window does not trigger even with divergent flag', () => {
    const ctx = makeContext('org/core', 'structural_core', {
      persistentlyDivergent: true,
      divergentCount: 5,
      totalSnapshots: 5,
      missingDays: 9,
      evidence: 'insufficient',
    }, 'expansion')
    const result = evaluateEcosystemTriggers([ctx])

    expect(result.coreDivergence).toHaveLength(0)
    expect(result.triggered).toBe(false)
  })

  it('incomplete window does not contribute to §5.2 split', () => {
    const aligned = makeContext('org/core-a', 'structural_core', {
      persistentlyAligned: true,
      alignedCount: 14,
    })
    const incomplete = makeContext('org/core-b', 'structural_core', {
      persistentlyDivergent: true,
      totalSnapshots: 7,
      missingDays: 7,
      evidence: 'insufficient',
    }, 'expansion')
    const result = evaluateEcosystemTriggers([aligned, incomplete])

    expect(result.coreSplit).toBe(false)
  })

  it('incomplete window does not contribute to §5.3 drift', () => {
    const b1 = makeContext('org/app1', 'long_arc_domain', {
      persistentlyDivergent: true,
      totalSnapshots: 8,
      missingDays: 6,
      evidence: 'insufficient',
    }, 'expansion')
    const b2 = makeContext('org/app2', 'long_arc_domain', {
      persistentlyDivergent: true,
      totalSnapshots: 8,
      missingDays: 6,
      evidence: 'insufficient',
    }, 'expansion')
    const result = evaluateEcosystemTriggers([b1, b2])

    expect(result.longArcDrift.repos).toHaveLength(0)
    expect(result.triggered).toBe(false)
  })
})
