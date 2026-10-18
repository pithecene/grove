import { describe, expect, it } from 'vitest'

import {
  formatRepoList,
  surfaceTriggeredEcosystemInvitations,
} from '../rituals'
import type {
  EcosystemTriggerResult,
  PersistenceAssessment,
  RepoPersistenceContext,
} from '../types'

// --- Helpers ---

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

function makeNotTriggered(): EcosystemTriggerResult {
  return {
    coreDivergence: [],
    coreSplit: false,
    longArcDrift: { repos: [] },
    triggered: false,
  }
}

// --- formatRepoList ---

describe('formatRepoList', () => {
  it('returns just the name for a single entry', () => {
    expect(formatRepoList(['org/repo'])).toBe('org/repo')
  })

  it('joins two names with "and"', () => {
    expect(formatRepoList(['org/a', 'org/b'])).toBe('org/a and org/b')
  })

  it('joins three names with Oxford comma', () => {
    expect(formatRepoList(['org/a', 'org/b', 'org/c'])).toBe(
      'org/a, org/b, and org/c',
    )
  })

  it('joins four names with Oxford comma', () => {
    expect(formatRepoList(['a', 'b', 'c', 'd'])).toBe('a, b, c, and d')
  })

  it('returns empty string for empty array', () => {
    expect(formatRepoList([])).toBe('')
  })
})

// --- surfaceTriggeredEcosystemInvitations ---

describe('surfaceTriggeredEcosystemInvitations', () => {
  it('returns empty array when triggered === false', () => {
    const result = surfaceTriggeredEcosystemInvitations(
      makeNotTriggered(),
      'consolidation',
    )
    expect(result).toEqual([])
  })

  // §5.1 — single repo
  it('§5.1 single repo: names the repo, season, and climate', () => {
    const ctx = makeContext(
      'org/core',
      'structural_core',
      { persistentlyDivergent: true, divergentCount: 12 },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [ctx],
        coreSplit: false,
        longArcDrift: { repos: [] },
        triggered: true,
      },
      'dormancy',
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.ritual).toBe('ecosystem_balance')
    expect(result[0]!.observation).toContain('org/core')
    expect(result[0]!.observation).toContain('expansion')
    expect(result[0]!.observation).toContain('dormancy')
    expect(result[0]!.observation).toContain('structural core')
    expect(result[0]!.observation).toContain('observation window')
  })

  // §5.1 — single repo, undefined divergentSeason
  it('§5.1 single repo without divergentSeason: uses season-agnostic phrasing', () => {
    const ctx = makeContext(
      'org/core',
      'structural_core',
      { persistentlyDivergent: true, divergentCount: 12 },
      // no divergentSeason — can happen when current season is orthogonal
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [ctx],
        coreSplit: false,
        longArcDrift: { repos: [] },
        triggered: true,
      },
      'dormancy',
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.observation).toContain('org/core')
    expect(result[0]!.observation).toContain('dormancy')
    expect(result[0]!.observation).toContain('persistently diverged')
    // Must not interpolate "undefined" as text
    expect(result[0]!.observation).not.toContain('undefined')
  })

  // §5.1 — multiple repos
  it('§5.1 multiple repos: lists all repo names', () => {
    const ctx1 = makeContext(
      'org/core1',
      'structural_core',
      { persistentlyDivergent: true },
      'expansion',
    )
    const ctx2 = makeContext(
      'org/core2',
      'structural_core',
      { persistentlyDivergent: true },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [ctx1, ctx2],
        coreSplit: false,
        longArcDrift: { repos: [] },
        triggered: true,
      },
      'dormancy',
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.observation).toContain('org/core1')
    expect(result[0]!.observation).toContain('org/core2')
    expect(result[0]!.observation).toContain('Structural core projects')
  })

  // §5.2 — core split (subsumes §5.1)
  it('§5.2 core split: emits split observation, no separate §5.1', () => {
    const divergent = makeContext(
      'org/core-b',
      'structural_core',
      { persistentlyDivergent: true, divergentCount: 12 },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [divergent],
        coreSplit: true,
        longArcDrift: { repos: [] },
        triggered: true,
      },
      'dormancy',
    )

    // Only the §5.2 observation, not §5.1
    expect(result).toHaveLength(1)
    expect(result[0]!.ritual).toBe('ecosystem_balance')
    expect(result[0]!.observation).toContain('split')
    expect(result[0]!.observation).toContain('dormancy')
    // Should NOT contain the §5.1 "in the structural core has maintained" phrasing
    expect(result[0]!.observation).not.toContain('has maintained')
  })

  // §5.3 — long-arc drift with coherent season
  it('§5.3 long-arc drift: names repos, coherent season, and climate', () => {
    const b1 = makeContext(
      'org/app1',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b2 = makeContext(
      'org/app2',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [],
        coreSplit: false,
        longArcDrift: { repos: [b1, b2], coherentSeason: 'expansion' },
        triggered: true,
      },
      'dormancy',
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.ritual).toBe('ecosystem_balance')
    expect(result[0]!.observation).toContain('org/app1')
    expect(result[0]!.observation).toContain('org/app2')
    expect(result[0]!.observation).toContain('expansion')
    expect(result[0]!.observation).toContain('dormancy')
    expect(result[0]!.observation).toContain('Long-horizon domain projects')
  })

  // §5.3 — without coherent season
  it('§5.3 without coherent season: omits direction clause', () => {
    const b1 = makeContext(
      'org/app1',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b2 = makeContext(
      'org/app2',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'pruning',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [],
        coreSplit: false,
        longArcDrift: { repos: [b1, b2], coherentSeason: undefined },
        triggered: true,
      },
      'dormancy',
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.observation).toContain('persistently diverged')
    expect(result[0]!.observation).not.toContain('share a')
  })

  // Multiple triggers fire
  it('multiple triggers produce multiple invitations', () => {
    const coreCtx = makeContext(
      'org/core',
      'structural_core',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b1 = makeContext(
      'org/app1',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b2 = makeContext(
      'org/app2',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [coreCtx],
        coreSplit: false,
        longArcDrift: { repos: [b1, b2], coherentSeason: 'expansion' },
        triggered: true,
      },
      'dormancy',
    )

    // §5.1 + §5.3 = 2 invitations
    expect(result).toHaveLength(2)
    expect(result.every((inv) => inv.ritual === 'ecosystem_balance')).toBe(true)
  })

  // Language compliance
  it('uses observational language — no forbidden vocabulary', () => {
    const ctx = makeContext(
      'org/core',
      'structural_core',
      { persistentlyDivergent: true },
      'expansion',
    )
    const result = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [ctx],
        coreSplit: false,
        longArcDrift: { repos: [] },
        triggered: true,
      },
      'dormancy',
    )

    const observation = result[0]!.observation
    const forbidden = [
      'success',
      'failure',
      'good',
      'bad',
      'healthy',
      'unhealthy',
      'underperforming',
      'productivity',
      'efficiency',
      'velocity',
      'optimize',
    ]
    for (const word of forbidden) {
      expect(observation.toLowerCase()).not.toContain(word)
    }
  })

  // No quantitative language
  it('does not use quantitative framing (N of M, percentages, ratios)', () => {
    const divergent = makeContext(
      'org/core-b',
      'structural_core',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b1 = makeContext(
      'org/app1',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )
    const b2 = makeContext(
      'org/app2',
      'long_arc_domain',
      { persistentlyDivergent: true },
      'expansion',
    )

    // Test §5.2
    const splitResult = surfaceTriggeredEcosystemInvitations(
      {
        coreDivergence: [divergent],
        coreSplit: true,
        longArcDrift: { repos: [b1, b2], coherentSeason: 'expansion' },
        triggered: true,
      },
      'dormancy',
    )

    for (const inv of splitResult) {
      // No "N of M" pattern
      expect(inv.observation).not.toMatch(/\d+ of \d+/)
      // No percentage
      expect(inv.observation).not.toMatch(/\d+%/)
      // No "majority" / "minority"
      expect(inv.observation.toLowerCase()).not.toContain('majority')
      expect(inv.observation.toLowerCase()).not.toContain('minority')
    }
  })
})
