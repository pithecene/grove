import { createFileRoute, Link } from '@tanstack/react-router'

import { EmptyState } from '../components/EmptyState'
import { Header } from '../components/Header'
import { LookupNotice } from '../components/LookupNotice'
import { PaginationControls } from '../components/PaginationControls'
import { RepoCard } from '../components/RepoCard'
import { usePagination } from '../hooks/usePagination'
import { getSession } from '../server/auth'
import { loadPortfolio, type PortfolioView } from '../server/portfolio'

export const Route = createFileRoute('/unclassified')({
  component: UnclassifiedPage,
  loader: async () => {
    const [session, lookup] = await Promise.all([
      getSession(),
      loadPortfolio(),
    ])
    return { session, lookup }
  },
})

const NOTHING_OBSERVED: PortfolioView = { repositories: [], unclassified: [] }

function UnclassifiedPage() {
  const { session, lookup } = Route.useLoaderData()
  const portfolio = lookup.kind === 'observed' ? lookup.portfolio : NOTHING_OBSERVED

  const { page, totalPages, paginated, setPage } = usePagination(
    portfolio.unclassified,
    12,
  )

  if (!session.authenticated) {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason={session.reason} />
      </div>
    )
  }

  if (lookup.kind === 'unauthenticated') {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason={lookup.reason} />
      </div>
    )
  }

  if (lookup.kind === 'token_rejected') {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason="rejected" />
      </div>
    )
  }

  if (lookup.kind !== 'observed') {
    return <LookupNotice login={session.login} subject="portfolio" state={lookup} />
  }

  const seasonAttr = portfolio.climate ?? undefined

  return (
    <div
      data-season={seasonAttr}
      style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}
    >
      <Header login={session.login} />

      <main className="px-8 py-6">
        <Link
          to="/"
          className="text-sm mb-6 inline-block"
          style={{ color: 'var(--grove-text-muted)' }}
        >
          &larr; Portfolio
        </Link>

        <h2
          className="text-xl mb-2"
          style={{
            fontFamily: 'var(--grove-font-display)',
            color: 'var(--grove-text)',
          }}
        >
          Unclassified repositories
        </h2>
        <p
          className="text-sm mb-6"
          style={{ color: 'var(--grove-text-muted)' }}
        >
          These repositories have no <code>.grove.yaml</code>. They are observed
          but not yet part of the declared ecosystem.
        </p>

        {portfolio.unclassified.length === 0 ? (
          <p
            className="text-center text-sm py-12"
            style={{ color: 'var(--grove-text-muted)' }}
          >
            No unclassified repositories observed.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {paginated.map((repo) => (
              <RepoCard
                key={repo.fullName}
                repo={repo}
                climate={portfolio.climate}
              />
            ))}
          </div>
        )}

        <PaginationControls
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      </main>
    </div>
  )
}
