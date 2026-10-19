/**
 * Steward identity resolved from a GitHub Personal Access Token.
 *
 * Replaces the OAuth session stack with a single GROVE_GITHUB_TOKEN env var.
 * Identity is fetched once from the GitHub API and cached in-memory
 * for the process lifetime.
 */

import { isRateLimitResponse } from '@grove/github'

export interface StewardIdentity {
  token: string
  login: string
  id: number
}

let cached: StewardIdentity | undefined

/** Read the GROVE_GITHUB_TOKEN env var. */
export function getToken(): string | undefined {
  return process.env.GROVE_GITHUB_TOKEN
}

/** True when GROVE_GITHUB_TOKEN is set in the environment. */
export function isConfigured(): boolean {
  return !!process.env.GROVE_GITHUB_TOKEN
}

/** Why no identity is available; the UI states the actual condition. */
export type IdentityUnavailableReason =
  /** GROVE_GITHUB_TOKEN is not set */
  | 'missing'
  /** GitHub refused the token: 401, or 403 that is not a rate limit */
  | 'rejected'
  /**
   * GitHub gave no usable answer — network failure, 5xx, or a rate limit —
   * so the token is unverified this time, not refused
   */
  | 'unreachable'

export type IdentityResolution =
  | { kind: 'resolved'; identity: StewardIdentity }
  | { kind: 'unavailable'; reason: IdentityUnavailableReason; status?: number }

/**
 * Resolve the steward's GitHub identity from the configured token, saying
 * why when it cannot. Fetches `https://api.github.com/user` once, then
 * caches the result in a module-level singleton for the process lifetime.
 */
export async function resolveStewardIdentity(): Promise<IdentityResolution> {
  const token = getToken()
  if (!token) return { kind: 'unavailable', reason: 'missing' }

  if (cached && cached.token === token) return { kind: 'resolved', identity: cached }

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    })

    if (!response.ok) {
      // Only an authentication failure says anything about the token. A
      // rate limit (primary or secondary) and server errors leave it unverified.
      const rateLimited = isRateLimitResponse(response.status, response.headers)
      const rejected =
        response.status === 401 || (response.status === 403 && !rateLimited)
      console.warn(
        rejected
          ? `[grove] GitHub did not accept GROVE_GITHUB_TOKEN (${response.status}).`
          : `[grove] GitHub identity check gave no usable answer (${response.status}); token unverified.`,
      )
      return {
        kind: 'unavailable',
        reason: rejected ? 'rejected' : 'unreachable',
        status: response.status,
      }
    }

    const user = await response.json()

    cached = { token, login: user.login, id: user.id }
    return { kind: 'resolved', identity: cached }
  } catch (err) {
    console.warn('[grove] Failed to reach GitHub API:', err)
    return { kind: 'unavailable', reason: 'unreachable' }
  }
}

/**
 * Forget the cached identity. Called when GitHub answers 401 to a later
 * request: the token has been revoked or has expired since it was verified,
 * and the next session check must ask GitHub again.
 */
export function invalidateStewardIdentity(): void {
  cached = undefined
}

/**
 * The steward's identity, or undefined when none is available (no token,
 * a token GitHub refused, or GitHub unreachable) — callers degrade to the
 * unauthenticated state rather than crashing route loaders.
 */
export async function getStewardIdentity(): Promise<
  StewardIdentity | undefined
> {
  const resolution = await resolveStewardIdentity()
  return resolution.kind === 'resolved' ? resolution.identity : undefined
}
