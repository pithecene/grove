import { desc, eq } from 'drizzle-orm'

import type { GroveDb } from './client'
import { getDb } from './client'
import { comparisonReferences } from './schema'

export type ReferenceRow = typeof comparisonReferences.$inferSelect

/** Keep a prior instant as a reference. Append-only: nothing is replaced. */
export function saveReference(
  input: { stewardId: number; referenceAt: string; label?: string; savedAt?: string },
  db: GroveDb = getDb(),
): ReferenceRow {
  return db
    .insert(comparisonReferences)
    .values({
      stewardId: input.stewardId,
      referenceAt: input.referenceAt,
      savedAt: input.savedAt ?? new Date().toISOString(),
      label: input.label ?? null,
    })
    .returning()
    .get()
}

/** The steward's saved references, most recently saved first. */
export function listReferences(stewardId: number, db: GroveDb = getDb()): ReferenceRow[] {
  return db
    .select()
    .from(comparisonReferences)
    .where(eq(comparisonReferences.stewardId, stewardId))
    .orderBy(desc(comparisonReferences.savedAt), desc(comparisonReferences.id))
    .all()
}

/** The reference saved most recently, if any. */
export function latestReference(
  stewardId: number,
  db: GroveDb = getDb(),
): ReferenceRow | undefined {
  return listReferences(stewardId, db)[0]
}
