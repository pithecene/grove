import type { GitHubFailure } from '@grove/github'

import { invalidateStewardIdentity } from './identity'

/**
 * What the application can state when a GitHub request did not produce
 * an observation. Mapped once, here, from what GitHub answered.
 */
export type AccessFailure =
  /** The token was accepted at the session check but refused on this request (401) */
  | { kind: 'token_rejected' }
  /** GitHub reported `subject` missing or not accessible with this token (404 / non-throttled 403) */
  | { kind: 'not_accessible'; status: number; subject: string }
  /** GitHub gave no usable answer about `subject`: throttling, server error or network failure */
  | { kind: 'unavailable'; status?: number; subject: string }

/**
 * Map a failed answer to the state the page states. `subject` names what
 * the request was about, as a noun phrase ("this repository", "the
 * portfolio listing", "the declaration of org/name"), so the page attributes
 * the failure to the right stage. A 401 also forgets the cached identity:
 * the token has been revoked or has expired since it was verified, and the
 * next session check must ask GitHub again.
 */
export function accessFailure(failure: GitHubFailure, subject: string): AccessFailure {
  switch (failure.kind) {
    case 'unauthorized':
      invalidateStewardIdentity()
      return { kind: 'token_rejected' }
    case 'not_found':
    case 'forbidden':
      return { kind: 'not_accessible', status: failure.status, subject }
    case 'throttled':
    case 'unavailable':
      console.warn(`[grove] GitHub gave no usable answer about ${subject} (${failure.kind} ${failure.status}).`)
      return { kind: 'unavailable', status: failure.status, subject }
    case 'unreachable':
      console.warn(`[grove] Failed to reach GitHub about ${subject}: ${failure.message}`)
      return { kind: 'unavailable', subject }
  }
}
