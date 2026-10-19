import type { Climate, ClimateProposal } from '@grove/core'
import { surfaceTriggeredEcosystemInvitations } from '@grove/core'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { ClimateBand } from '../components/ClimateBand'
import { ClimateDeclaration } from '../components/ClimateDeclaration'
import { EmptyState } from '../components/EmptyState'
import { Header } from '../components/Header'
import { PaginationControls } from '../components/PaginationControls'
import { RepoCard } from '../components/RepoCard'
import { RitualInvitation } from '../components/RitualInvitation'
import { usePagination } from '../hooks/usePagination'
import { getSession } from '../server/auth'
import {
  acceptClimateProposal,
  dismissClimateProposal,
} from '../server/climate'
import { loadPortfolio } from '../server/portfolio'

export const Route = createFileRoute('/')({
  component: PortfolioPage,
  loader: async () => {
    const [session, portfolio] = await Promise.all([
      getSession(),
      loadPortfolio(),
    ])
    return { session, portfolio }
  },
})

function PortfolioPage() {
  const { session, portfolio } = Route.useLoaderData()
  const router = useRouter()
  const [showClimatePanel, setShowClimatePanel] = useState(false)
  const [climate, setClimate] = useState<Climate | undefined>(
    portfolio.climate,
  )
  const [proposal, setProposal] = useState<ClimateProposal | undefined>(
    portfolio.climateProposal,
  )
  const { page, totalPages, paginated, setPage } = usePagination(
    portfolio.repositories,
  )

  // Ecosystem balance invitations are derived exclusively from the
  // persistence-based trigger pipeline (§4/§5). No heuristic fallback —
  // §7 prohibits quantitative framing in ecosystem balance outputs.
  // When triggers are undefined (no climate, no classified repos, or
  // insufficient snapshot history), no ecosystem balance invitations
  // are surfaced. When the steward changes climate client-side, trigger
  // data is stale — no invitations until next page load.
  const ecosystemInvitations = useMemo(() => {
    const triggers = portfolio.ecosystemTriggers
    if (triggers && climate === portfolio.climate && climate) {
      return surfaceTriggeredEcosystemInvitations(triggers, climate)
    }
    return []
  }, [climate, portfolio.climate, portfolio.ecosystemTriggers])

  if (!session.authenticated) {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason={session.reason} />
      </div>
    )
  }

  // Determine atmosphere from portfolio climate
  const seasonAttr = climate ?? undefined

  return (
    <div
      data-season={seasonAttr}
      style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}
    >
      <Header login={session.login} />
      <ClimateBand
        climate={climate}
        proposal={proposal}
        onOpenDeclaration={() => setShowClimatePanel(true)}
        onAcceptProposal={
          proposal
            ? async () => {
                const result = await acceptClimateProposal()
                setClimate(result.climate)
                setProposal(undefined)
                router.invalidate()
              }
            : undefined
        }
        onDismissProposal={
          proposal
            ? async () => {
                await dismissClimateProposal()
                setProposal(undefined)
              }
            : undefined
        }
      />

      {showClimatePanel && (
        <ClimateDeclaration
          currentClimate={climate}
          onClose={() => setShowClimatePanel(false)}
          onDeclared={(declared) => {
            setClimate(declared)
            setShowClimatePanel(false)
          }}
        />
      )}

      <main className="px-8 py-6">
        {portfolio.repositories.length === 0 ? (
          <p
            className="text-center text-sm py-12"
            style={{ color: 'var(--grove-text-muted)' }}
          >
            No repositories with <code>.grove.yaml</code> observed.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {paginated.map((repo) => (
                <RepoCard
                  key={repo.fullName}
                  repo={repo}
                  climate={climate}
                />
              ))}
            </div>
            <PaginationControls
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </>
        )}

        {ecosystemInvitations.length > 0 && (
          <div className="mt-8">
            <h3
              className="text-sm mb-4 tracking-wide uppercase opacity-60"
              style={{ color: 'var(--grove-text-muted)' }}
            >
              Ritual Invitations
            </h3>
            <div className="space-y-3">
              {ecosystemInvitations.map((invitation, index) => (
                <RitualInvitation
                  key={`${invitation.ritual}-${index}`}
                  invitation={invitation}
                />
              ))}
            </div>
          </div>
        )}

        {portfolio.unclassified.length > 0 && (
          <div className="mt-12">
            <Link
              to="/unclassified"
              className="text-sm"
              style={{ color: 'var(--grove-text-muted)' }}
            >
              {portfolio.unclassified.length} unclassified{' '}
              {portfolio.unclassified.length === 1
                ? 'repository'
                : 'repositories'}{' '}
              observed &rarr;
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}
