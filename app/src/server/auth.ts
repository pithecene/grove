import { createServerFn } from '@tanstack/react-start'

import { getCurrentClimate } from './db'
import { resolveStewardIdentity } from './identity'

export const getSession = createServerFn({ method: 'GET' }).handler(
  async () => {
    const resolution = await resolveStewardIdentity()
    if (resolution.kind === 'unavailable') {
      // `reason` lets the UI say what is actually the case: no token, a
      // token GitHub refused, or GitHub unreachable.
      return {
        authenticated: false as const,
        reason: resolution.reason,
        login: undefined,
        climate: undefined,
      }
    }

    const { identity } = resolution
    return {
      authenticated: true as const,
      reason: undefined,
      login: identity.login,
      climate: getCurrentClimate(identity.id),
    }
  },
)
