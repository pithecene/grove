import type { GitHubAnswer, GitHubRepo } from '@grove/github'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const github = vi.hoisted(() => ({
  fetchUserRepos: vi.fn(),
  classifyRepository: vi.fn(),
  fetchStructuralSignals: vi.fn(),
}))

vi.mock('@grove/github', () => github)

import { getRun, getRunRepositories } from '../db'
import { createDb, type GroveDb } from '../db/client'
import { ecologySnapshots } from '../db/schema'
import { observePortfolio } from '../observe'

let db: GroveDb

const identity = { token: 'synthetic', login: 'orchard', id: 7 }

const repo = (id: number, fullName: string): GitHubRepo => ({
  id,
  full_name: fullName,
  html_url: `https://github.com/${fullName}`,
  default_branch: 'main',
  pushed_at: null,
  created_at: '2024-01-01T00:00:00.000Z',
})

const ok = <T,>(value: T): GitHubAnswer<T> => ({ kind: 'ok', status: 200, value })

beforeEach(() => {
  db = createDb(new Database(':memory:'))
  github.fetchUserRepos.mockReset()
  github.classifyRepository.mockReset()
  github.fetchStructuralSignals.mockReset()
  github.fetchStructuralSignals.mockResolvedValue({ observedAt: new Date().toISOString() })
  github.classifyRepository.mockImplementation(async (_token: string, r: GitHubRepo) =>
    ok({
      fullName: r.full_name,
      htmlUrl: r.html_url,
      classified: true,
      declaration: { intent: 'synthetic', phase: 'consolidating' },
    }),
  )
})

afterEach(() => {
  delete process.env.GROVE_SCOPE_OWNERS
  delete process.env.GROVE_SCOPE_EXCLUDE
})

describe('observePortfolio records a run', () => {
  it('a full observation: every repository in scope gets an outcome and the run is complete', async () => {
    github.fetchUserRepos.mockResolvedValue(ok([repo(100, 'orchard/alpha'), repo(200, 'orchard/beta')]))
    const { lookup, runId } = await observePortfolio(identity, { method: 'cli', db })
    expect(lookup.kind).toBe('observed')
    expect(getRun(runId, db)).toMatchObject({
      method: 'cli',
      stewardId: 7,
      fullPortfolio: true,
      complete: true,
      answer: null,
    })
    expect(getRunRepositories(runId, db).map((r) => [r.fullName, r.outcome])).toEqual([
      ['orchard/alpha', 'observed'],
      ['orchard/beta', 'observed'],
    ])
    expect(db.select().from(ecologySnapshots).all().map((r) => r.githubId)).toEqual([100, 200])

    // Within the throttle: present, unchanged — still a complete full run.
    const again = await observePortfolio(identity, { method: 'visit', db })
    expect(getRun(again.runId, db)?.complete).toBe(true)
    expect(getRunRepositories(again.runId, db).map((r) => r.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ])
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(2)
  })

  it('a listing GitHub did not answer ends the run with that answer and records nothing', async () => {
    github.fetchUserRepos.mockResolvedValue({ kind: 'throttled', status: 403 })
    const { lookup, runId } = await observePortfolio(identity, { method: 'cli', db })
    expect(lookup).toMatchObject({ kind: 'unavailable', subject: 'the portfolio listing' })
    expect(getRun(runId, db)).toMatchObject({ complete: false, answer: 'throttled' })
    expect(getRunRepositories(runId, db)).toHaveLength(0)
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(0)
  })

  it('a declaration GitHub refused ends the run incomplete, naming that repository', async () => {
    github.fetchUserRepos.mockResolvedValue(ok([repo(100, 'orchard/alpha'), repo(200, 'orchard/beta')]))
    github.classifyRepository.mockImplementation(async (_token: string, r: GitHubRepo) =>
      r.id === 200
        ? { kind: 'forbidden', status: 403 }
        : ok({ fullName: r.full_name, htmlUrl: r.html_url, classified: false }),
    )
    const { lookup, runId } = await observePortfolio(identity, { method: 'cli', db })
    expect(lookup).toMatchObject({
      kind: 'not_accessible',
      subject: 'the declaration of orchard/beta',
    })
    expect(getRun(runId, db)).toMatchObject({ complete: false, answer: 'forbidden' })
    // What GitHub answered about is kept on the run; nothing is recorded as
    // an observation for either repository this time.
    expect(getRunRepositories(runId, db).map((r) => [r.fullName, r.outcome, r.answer])).toEqual([
      ['orchard/alpha', 'not_recorded', null],
      ['orchard/beta', 'unavailable', 'forbidden'],
    ])
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(0)
  })

  it('every repository GitHub did not answer about in a batch is kept with its own kind', async () => {
    github.fetchUserRepos.mockResolvedValue(
      ok([repo(100, 'orchard/alpha'), repo(200, 'orchard/beta'), repo(300, 'orchard/gamma')]),
    )
    github.classifyRepository.mockImplementation(async (_token: string, r: GitHubRepo) =>
      r.id === 100
        ? ok({ fullName: r.full_name, htmlUrl: r.html_url, classified: false })
        : r.id === 200
          ? { kind: 'throttled', status: 429 }
          : { kind: 'unavailable', status: 502 },
    )
    const { runId } = await observePortfolio(identity, { method: 'cli', db })
    expect(getRun(runId, db)).toMatchObject({ complete: false, answer: 'throttled' })
    expect(getRunRepositories(runId, db).map((r) => [r.fullName, r.outcome, r.answer])).toEqual([
      ['orchard/alpha', 'not_recorded', null],
      ['orchard/beta', 'unavailable', 'throttled'],
      ['orchard/gamma', 'unavailable', 'unavailable'],
    ])
  })

  it('the configured scope is recorded on the run and bounds its membership', async () => {
    process.env.GROVE_SCOPE_OWNERS = 'orchard'
    process.env.GROVE_SCOPE_EXCLUDE = 'orchard/hidden'
    github.fetchUserRepos.mockResolvedValue(
      ok([repo(100, 'orchard/alpha'), repo(300, 'orchard/hidden'), repo(400, 'elsewhere/x')]),
    )
    const { runId } = await observePortfolio(identity, { method: 'cli', db })
    expect(JSON.parse(getRun(runId, db)?.scope ?? '{}')).toEqual({
      owners: ['orchard'],
      exclude: ['orchard/hidden'],
    })
    expect(getRunRepositories(runId, db).map((r) => r.fullName)).toEqual(['orchard/alpha'])
  })
})
