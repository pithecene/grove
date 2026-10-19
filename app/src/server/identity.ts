/**
 * Steward identity resolved from a GitHub Personal Access Token.
 *
 * Replaces the OAuth session stack with a single GROVE_GITHUB_TOKEN env var.
 * Identity is fetched once from the GitHub API and cached in-memory
 * for the process lifetime.
 */

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
  /** GitHub answered but did not accept the token (401/403, or any non-2xx) */
  | 'rejected'
  /** GitHub could not be reached; the token is unverified, not refused */
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
      console.warn(
        `[grove] GitHub identity check failed (${response.status}). Check that GROVE_GITHUB_TOKEN is valid.`,
      )
      return { kind: 'unavailable', reason: 'rejected', status: response.status }
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
