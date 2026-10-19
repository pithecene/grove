import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import type { PortfolioScope } from '../scope'
import type { GroveDb } from './client'
import { getDb } from './client'
import { collectionRunRepositories, collectionRuns } from './schema'

/** How a collection came about. */
export type RunMethod = 'visit' | 'cli' | 'backfill'

/**
 * What a run did about one repository: a new snapshot; nothing new because
 * the last one is within the throttle; no observation because GitHub gave
 * no usable answer; or GitHub answered but the run ended before anything
 * was recorded (`not_recorded` — a portfolio is recorded whole or not at all).
 */
export type RunOutcome = 'observed' | 'unchanged' | 'unavailable' | 'not_recorded'

export type RunRow = typeof collectionRuns.$inferSelect
export type RunRepositoryRow = typeof collectionRunRepositories.$inferSelect

function serializeScope(scope: PortfolioScope | undefined): string | null {
  if (!scope) return null
  return JSON.stringify({ owners: [...scope.owners], exclude: [...scope.exclude] })
}

/** Open a run. Returns its id; `finishRun` closes it. */
export function startRun(
  input: {
    method: RunMethod
    stewardId?: number
    fullPortfolio: boolean
    scope?: PortfolioScope
    startedAt?: string
  },
  db: GroveDb = getDb(),
): number {
  const row = db
    .insert(collectionRuns)
    .values({
      startedAt: input.startedAt ?? new Date().toISOString(),
      method: input.method,
      stewardId: input.stewardId ?? null,
      fullPortfolio: input.fullPortfolio,
      complete: false,
      scope: serializeScope(input.scope),
    })
    .returning({ id: collectionRuns.id })
    .get()
  return row.id
}

/**
 * Close a run. `complete` says every targeted repository received an
 * outcome row; `answer` records the GitHub answer kind when the run could
 * not proceed as a whole.
 */
export function finishRun(
  id: number,
  input: { complete: boolean; answer?: string; finishedAt?: string },
  db: GroveDb = getDb(),
): void {
  db.update(collectionRuns)
    .set({
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      complete: input.complete,
      answer: input.answer ?? null,
    })
    .where(eq(collectionRuns.id, id))
    .run()
}

/** Record what a run did about one repository. */
export function recordRunRepository(
  runId: number,
  input: { githubId?: number; fullName: string; outcome: RunOutcome; answer?: string },
  db: GroveDb = getDb(),
): void {
  db.insert(collectionRunRepositories)
    .values({
      runId,
      githubId: input.githubId ?? null,
      fullName: input.fullName,
      outcome: input.outcome,
      answer: input.answer ?? null,
    })
    .run()
}

export function getRun(id: number, db: GroveDb = getDb()): RunRow | undefined {
  return db.select().from(collectionRuns).where(eq(collectionRuns.id, id)).get()
}

export function getRunRepositories(runId: number, db: GroveDb = getDb()): RunRepositoryRow[] {
  return db
    .select()
    .from(collectionRunRepositories)
    .where(eq(collectionRunRepositories.runId, runId))
    .orderBy(asc(collectionRunRepositories.fullName))
    .all()
}

/**
 * The most recent *live* run (`visit` or `cli`) by this steward that
 * targeted the whole configured scope and gave every repository an
 * outcome — the only kind of run from which "not present any more" may
 * be inferred. A backfill reads history and says nothing about presence;
 * another steward's run describes another portfolio.
 */
export function getLatestCompleteFullRun(
  stewardId: number,
  db: GroveDb = getDb(),
): RunRow | undefined {
  return db
    .select()
    .from(collectionRuns)
    .where(
      and(
        eq(collectionRuns.stewardId, stewardId),
        eq(collectionRuns.fullPortfolio, true),
        eq(collectionRuns.complete, true),
        inArray(collectionRuns.method, ['visit', 'cli']),
      ),
    )
    .orderBy(desc(collectionRuns.startedAt), desc(collectionRuns.id))
    .limit(1)
    .get()
}
