import { createServerFn } from '@tanstack/react-start'

import { resolveStewardIdentity } from './identity'
import { observePortfolio, type PortfolioLookup } from './observe'

export type { PortfolioLookup, PortfolioView } from './observe'

/**
 * Load and classify all repositories for the authenticated user — a page
 * visit's collection, recorded as a run with method `visit`. The pipeline
 * itself lives in `observe.ts` and is shared with the `collect` command.
 */
export const loadPortfolio = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PortfolioLookup> => {
    // Identity first — no token, or no usable answer about it, means nothing
    // to observe; the reason travels with the result.
    const resolution = await resolveStewardIdentity()
    if (resolution.kind === 'unavailable') {
      return { kind: 'unauthenticated', reason: resolution.reason }
    }
    const { lookup } = await observePortfolio(resolution.identity, { method: 'visit' })
    return lookup
  },
)
