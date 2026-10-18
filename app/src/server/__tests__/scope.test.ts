import { describe, expect, it } from 'vitest'

import { applyScope, isWithinScope, parseScope } from '../scope'

const repos = [
  { full_name: 'orchard/alpha' },
  { full_name: 'orchard/beta' },
  { full_name: 'Orchard/gamma' },
  { full_name: 'neighbour/delta' },
  { full_name: 'other/epsilon' },
]

describe('parseScope', () => {
  it('returns undefined when nothing is configured', () => {
    expect(parseScope({})).toBeUndefined()
    expect(
      parseScope({ GROVE_SCOPE_OWNERS: '', GROVE_SCOPE_EXCLUDE: ' ' }),
    ).toBeUndefined()
  })

  it('parses comma-separated owners and exclusions, trimmed and lower-cased', () => {
    const scope = parseScope({
      GROVE_SCOPE_OWNERS: ' Orchard, neighbour ',
      GROVE_SCOPE_EXCLUDE: 'orchard/Beta',
    })
    expect(scope?.owners).toEqual(new Set(['orchard', 'neighbour']))
    expect(scope?.exclude).toEqual(new Set(['orchard/beta']))
  })
})

describe('applyScope / isWithinScope', () => {
  it('without a scope, every reachable repository is kept', () => {
    expect(applyScope(repos, undefined)).toHaveLength(5)
    expect(isWithinScope('anything/at-all', undefined)).toBe(true)
  })

  it('keeps only the selected owners, case-insensitively, preserving order', () => {
    const scope = parseScope({ GROVE_SCOPE_OWNERS: 'orchard' })
    expect(applyScope(repos, scope).map((r) => r.full_name)).toEqual([
      'orchard/alpha',
      'orchard/beta',
      'Orchard/gamma',
    ])
  })

  it('exclusions apply within the selected owners', () => {
    const scope = parseScope({
      GROVE_SCOPE_OWNERS: 'orchard',
      GROVE_SCOPE_EXCLUDE: 'orchard/beta',
    })
    expect(applyScope(repos, scope).map((r) => r.full_name)).toEqual([
      'orchard/alpha',
      'Orchard/gamma',
    ])
  })

  it('exclusions alone keep every other owner', () => {
    const scope = parseScope({ GROVE_SCOPE_EXCLUDE: 'other/epsilon' })
    expect(applyScope(repos, scope).map((r) => r.full_name)).toEqual([
      'orchard/alpha',
      'orchard/beta',
      'Orchard/gamma',
      'neighbour/delta',
    ])
  })
})
