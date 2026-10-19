import { createServerFn } from '@tanstack/react-start'

import { saveReference } from './db'
import type { IdentityUnavailableReason } from './identity'
import { resolveStewardIdentity } from './identity'
import { parseScope } from './scope'
import { computeSince, type SinceReport, usableReference } from './since'

export type SinceLookup =
  | { kind: 'observed'; report: SinceReport }
  /** Nothing in scope has ever been observed: there is no reference to compare against */
  | { kind: 'nothing' }
  /** The chosen reference is not an instant that has been (malformed, or after now) */
  | { kind: 'unusable_reference'; referenceAt: string }
  | { kind: 'unauthenticated'; reason: IdentityUnavailableReason }

/**
 * What changed since a reference. Reading it records nothing: no
 * reference is kept, no run is opened, no row is written.
 */
export const loadSince = createServerFn({ method: 'GET' })
  .validator((data: { referenceAt?: string }) => data)
  .handler(async ({ data }): Promise<SinceLookup> => {
    const resolution = await resolveStewardIdentity()
    if (resolution.kind === 'unavailable') {
      return { kind: 'unauthenticated', reason: resolution.reason }
    }
    if (
      data.referenceAt !== undefined &&
      !usableReference(data.referenceAt, new Date().toISOString())
    ) {
      return { kind: 'unusable_reference', referenceAt: data.referenceAt }
    }
    const report = computeSince(undefined, {
      stewardId: resolution.identity.id,
      scope: parseScope(),
      referenceAt: data.referenceAt,
    })
    return report ? { kind: 'observed', report } : { kind: 'nothing' }
  })

/** Keep an instant as a reference — the one explicit act on this page. */
export const keepReference = createServerFn({ method: 'POST' })
  .validator((data: { referenceAt: string; label?: string }) => data)
  .handler(async ({ data }) => {
    const resolution = await resolveStewardIdentity()
    if (resolution.kind === 'unavailable') {
      throw new Error('Not authenticated')
    }
    if (!usableReference(data.referenceAt, new Date().toISOString())) {
      throw new Error('A reference must be an instant not after now')
    }
    const row = saveReference({
      stewardId: resolution.identity.id,
      referenceAt: data.referenceAt,
      label: data.label,
    })
    return { referenceAt: row.referenceAt, savedAt: row.savedAt, label: row.label }
  })
