import type { GitHubAnswer, GitHubRepo } from '@grove/github'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getBindingsForIdentity, listResolutions } from '../db/bindings'
import { createDb, type GroveDb } from '../db/client'
import { repositories, repositoryBindings } from '../db/schema'
import { backfillIdentities, type NameResolver } from '../identity-backfill'
import { parseScope } from '../scope'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
  for (const name of [
    'former-owner/thing',
    'orchard/kept',
    'neighbour/other',
    'former-owner/gone',
  ]) {
    db.insert(repositories)
      .values({
        fullName: name,
        htmlUrl: `https://github.com/${name}`,
        defaultBranch: 'main',
        lastObservedAt: '2025-01-01T00:00:00.000Z',
      })
      .run()
  }
})

function resolved(id: number, fullName: string): GitHubAnswer<GitHubRepo> {
  return {
    kind: 'ok',
    status: 200,
    value: {
      id,
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      default_branch: 'main',
      pushed_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
    },
  }
}

const resolver: NameResolver = async (name) =>
  (
    ({
      'former-owner/thing': resolved(100, 'orchard/thing'), // renamed into scope
      'orchard/kept': resolved(200, 'orchard/kept'),
      'neighbour/other': resolved(300, 'neighbour/other'), // outside scope
      'former-owner/gone': { kind: 'not_found', status: 404 },
    }) as Record<string, GitHubAnswer<GitHubRepo>>
  )[name] ?? { kind: 'unavailable', status: 500 }

describe('backfill with a configured scope', () => {
  it('records only repositories that resolve into the scope; former names still resolve', async () => {
    const scope = parseScope({ GROVE_SCOPE_OWNERS: 'orchard' })
    const report = await backfillIdentities(db, resolver, {
      apply: true,
      scope,
      now: () => '2025-02-01T00:00:00.000Z',
    })

    const byName = Object.fromEntries(report.entries.map((e) => [e.fullName, e.outcome]))
    expect(byName).toEqual({
      'former-owner/thing': 'bound',
      'orchard/kept': 'bound',
      'neighbour/other': 'out_of_scope',
      'former-owner/gone': 'out_of_scope',
    })
    expect(getBindingsForIdentity(100, db)).toHaveLength(1)
    expect(getBindingsForIdentity(300, db)).toHaveLength(0)
    expect(db.select().from(repositoryBindings).all()).toHaveLength(2)
    // no resolution row for anything outside the scope, resolved or not
    expect(
      listResolutions(db)
        .map((r) => r.fullName)
        .sort(),
    ).toEqual(['former-owner/thing', 'orchard/kept'])
  })

  it('an unresolved name within the scope is still recorded as unresolved', async () => {
    const scope = parseScope({ GROVE_SCOPE_OWNERS: 'former-owner' })
    await backfillIdentities(db, resolver, {
      apply: true,
      scope,
      names: ['former-owner/gone'],
      now: () => '2025-02-01T00:00:00.000Z',
    })
    expect(listResolutions(db)[0]).toMatchObject({
      fullName: 'former-owner/gone',
      outcome: 'not_found',
    })
  })

  it('without a scope everything resolvable is recorded', async () => {
    const report = await backfillIdentities(db, resolver, { apply: false })
    expect(report.entries.some((e) => e.outcome === 'out_of_scope')).toBe(false)
  })
})
