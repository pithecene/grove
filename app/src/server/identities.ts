import { asc } from 'drizzle-orm'

import type { GroveDb } from './db'
import { getDb } from './db'
import { repositories, repositoryBindings } from './db/schema'
import { isWithinScope, type PortfolioScope } from './scope'

/** A repository identity under the name observed most recently. */
export interface Identity {
  githubId: number
  fullName: string
  defaultBranch: string
  createdAt: string | null
  lastObservedAt: string
}

/**
 * One entry per identity in scope, under the name observed most recently
 * (a renamed repository keeps its former name rows). Identity comes from
 * the repository row's id or from a binding of its name — bindings are
 * the identity mechanism for rows recorded before ids were written
 * (`docs/designs/identity.md`). Creation is known if any row carries it.
 */
export function listIdentities(
  db: GroveDb = getDb(),
  scope?: PortfolioScope,
  names?: string[],
): Identity[] {
  const wanted = names ? new Set(names.map((n) => n.toLowerCase())) : undefined
  const rows = db.select().from(repositories).orderBy(asc(repositories.fullName)).all()
  // The identity a name denotes most recently, for rows without an id.
  const boundIdentity = new Map<string, number>()
  for (const b of db
    .select()
    .from(repositoryBindings)
    .orderBy(asc(repositoryBindings.lastObservedAt))
    .all()) {
    boundIdentity.set(b.fullName, b.githubId)
  }
  const latest = new Map<number, Identity>()
  for (const r of rows) {
    const githubId = r.githubId ?? boundIdentity.get(r.fullName)
    if (githubId === undefined) continue
    const current = latest.get(githubId)
    const createdAt = r.createdAt ?? current?.createdAt ?? null
    if (!current || r.lastObservedAt > current.lastObservedAt) {
      latest.set(githubId, {
        githubId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        createdAt,
        lastObservedAt: r.lastObservedAt,
      })
    } else {
      current.createdAt = createdAt
    }
  }
  return [...latest.values()]
    .filter((t) => isWithinScope(t.fullName, scope))
    .filter((t) => !wanted || wanted.has(t.fullName.toLowerCase()))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
}
