import type { GroveDb } from './db'
import {
  getBindingsForIdentity,
  getDb,
  getDeclarationHistoryForIdentity,
  getSnapshotHistoryForIdentity,
} from './db'
import { buildTimeline, type TimelineEntry } from './timeline'

/** Effectively unbounded: declaration changes are rare, one row per change. */
const ALL_DECLARATIONS = Number.MAX_SAFE_INTEGER

/**
 * The structural timeline of one identity, followed across every name it
 * was observed under. It reads the whole daily series — at most one row per
 * day, observed or recorded from the repository's history alike, compressed
 * into spans — so the timeline never stops partway through it.
 */
export function timelineForIdentity(
  githubId: number,
  snapshotWasRecorded: boolean,
  db: GroveDb = getDb(),
): {
  timeline: TimelineEntry[]
  snapshots: ReturnType<typeof getSnapshotHistoryForIdentity>
  declarations: ReturnType<typeof getDeclarationHistoryForIdentity>
} {
  const snapshots = getSnapshotHistoryForIdentity(githubId, {}, db)
  const declarations = getDeclarationHistoryForIdentity(githubId, ALL_DECLARATIONS, db)
  const timeline = buildTimeline(
    snapshots,
    declarations,
    snapshotWasRecorded,
    true,
    { bindings: getBindingsForIdentity(githubId, db) },
    true,
  )
  return { timeline, snapshots, declarations }
}
