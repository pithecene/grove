/**
 * Steward identity resolved from a GitHub Personal Access Token.
 *
 * Replaces the OAuth session stack with a single GROVE_GITHUB_TOKEN env var.
 * Identity is fetched once from the GitHub API and cached in-memory
 * for the process lifetime.
 */

import { fetchViewer } from '@grove/github'

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
  /** GitHub refused the token (`unauthorized` or `forbidden` answer) */
  | 'rejected'
  /**
   * GitHub gave no usable answer (throttled, unavailable or unreachable),
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

  // Concurrent checks on a cold cache (a route loading its session and its
  // data at once) share one request, so they cannot disagree about the token.
  if (inflight && inflight.token === token) return await inflight.promise
  const promise = verify(token)
  inflight = { token, promise }
  try {
    return await promise
  } finally {
    if (inflight?.promise === promise) inflight = undefined
  }
}

let inflight: { token: string; promise: Promise<IdentityResolution> } | undefined

async function verify(token: string): Promise<IdentityResolution> {
  const answer = await fetchViewer(token)
  if (answer.kind !== 'ok') {
    // Only a decision about the token says anything about it; throttling,
    // server errors and network failures leave it unverified.
    const rejected = answer.kind === 'unauthorized' || answer.kind === 'forbidden'
    console.warn(
      rejected
        ? `[grove] GitHub did not accept GROVE_GITHUB_TOKEN (${answer.kind}).`
        : `[grove] GitHub gave no usable answer to the identity check (${answer.kind}); token unverified.`,
    )
    return {
      kind: 'unavailable',
      reason: rejected ? 'rejected' : 'unreachable',
      status: answer.kind === 'unreachable' ? undefined : answer.status,
    }
  }

  cached = { token, login: answer.value.login, id: answer.value.id }
  return { kind: 'resolved', identity: cached }
}

/**
 * Forget the cached identity. Called when GitHub answers 401 to a later
 * request: the token has been revoked or has expired since it was verified,
 * and the next session check must ask GitHub again.
 */
export function invalidateStewardIdentity(): void {
  cached = undefined
  inflight = undefined
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
