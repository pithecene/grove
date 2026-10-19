import { createFileRoute, Link } from '@tanstack/react-router'

import { AccessibilityDisplay } from '../components/AccessibilityDisplay'
import { CapabilityDisplay } from '../components/CapabilityDisplay'
import { ConsolidationDisplay } from '../components/ConsolidationDisplay'
import { DensityDisplay } from '../components/DensityDisplay'
import { DriftDisplay } from '../components/DriftDisplay'
import { EmptyState } from '../components/EmptyState'
import { Header } from '../components/Header'
import { LookupNotice } from '../components/LookupNotice'
import { StructuralTimeline } from '../components/StructuralTimeline'
import { PhaseIndicator } from '../components/PhaseIndicator'
import { RitualInvitation } from '../components/RitualInvitation'
import { getSession } from '../server/auth'
import { loadRepository } from '../server/repository'

export const Route = createFileRoute('/repo/$owner/$name')({
  component: RepositoryDetailPage,
  loader: async ({ params }) => {
    // Resolve the session first: with no token, or an invalid/expired one,
    // the repository loader cannot observe anything. Degrade to the same
    // unauthenticated state the portfolio page shows instead of throwing.
    const session = await getSession()
    if (!session.authenticated) {
      return { session, lookup: undefined }
    }
    const lookup = await loadRepository({
      data: { owner: params.owner, name: params.name },
    })
    return { session, lookup }
  },
})

function RepositoryDetailPage() {
  const { session, lookup } = Route.useLoaderData()

  if (!session.authenticated || !lookup) {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason={session.reason} />
      </div>
    )
  }

  // The token was accepted when the session was checked but refused on this
  // request: it has been revoked or has expired since.
  if (lookup.kind === 'token_rejected') {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState reason="rejected" />
      </div>
    )
  }

  if (lookup.kind !== 'observed') {
    return <LookupNotice login={session.login} subject="repository" state={lookup} />
  }

  const { ecology, consolidation, phaseDuration, shapeDrift, motionDrift, accessibility, capability, ritualInvitations, timeline } = lookup.detail

  const seasonAttr = ecology.season?.season

  return (
    <div
      data-season={seasonAttr}
      className="flex flex-col h-screen"
      style={{ backgroundColor: 'var(--grove-bg)' }}
    >
      <Header login={session.login} />

      <main className="flex-1 min-h-0 flex flex-col px-8 py-8">
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
          {ecology.fullName}
        </h2>

        {!ecology.classified && (
          <p
            className="text-sm mb-6"
            style={{ color: 'var(--grove-text-muted)' }}
          >
            Unclassified — no .grove.yaml observed.
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,20rem)] gap-x-12 gap-y-8 mt-6 flex-1 min-h-0">
          {/* Left column — ecology details + ritual invitations */}
          <div className="max-w-xl overflow-y-auto">
            {ecology.declaration && (
              <div className="space-y-6">
                {/* Intent */}
                <div>
                  <div
                    className="text-sm"
                    style={{ color: 'var(--grove-text)' }}
                  >
                    <span
                      className="opacity-60"
                      style={{ color: 'var(--grove-text-muted)' }}
                    >
                      Intent:
                    </span>{' '}
                    {ecology.declaration.intent}
                  </div>
                </div>

                {/* Phase + Season */}
                <PhaseIndicator
                  phase={ecology.declaration.phase}
                  season={ecology.season}
                  phaseDuration={phaseDuration}
                />

                {/* Horizon */}
                <div className="text-sm" style={{ color: 'var(--grove-text)' }}>
                  <span
                    className="opacity-60"
                    style={{ color: 'var(--grove-text-muted)' }}
                  >
                    Horizon:
                  </span>{' '}
                  {ecology.declaration.horizon ?? 'undeclared'}
                </div>

                {/* Role */}
                <div className="text-sm" style={{ color: 'var(--grove-text)' }}>
                  <span
                    className="opacity-60"
                    style={{ color: 'var(--grove-text-muted)' }}
                  >
                    Role:
                  </span>{' '}
                  {ecology.declaration.role ?? 'undeclared'}
                </div>

                {/* Steward */}
                <div className="text-sm" style={{ color: 'var(--grove-text)' }}>
                  <span
                    className="opacity-60"
                    style={{ color: 'var(--grove-text-muted)' }}
                  >
                    Steward:
                  </span>{' '}
                  {ecology.declaration.steward ?? 'undeclared'}
                </div>

                {/* Consolidation */}
                <ConsolidationDisplay consolidation={consolidation} />

                {/* Structural density */}
                <DensityDisplay density={ecology.density} />

                {/* Accessibility */}
                <AccessibilityDisplay accessibility={accessibility} />

                {/* Capability infrastructure */}
                <CapabilityDisplay capability={capability} />
              </div>
            )}

            {/* Drift observations */}
            <DriftDisplay shapeDrift={shapeDrift} motionDrift={motionDrift} />

            {/* Ritual invitations */}
            {ritualInvitations.length > 0 && (
              <div className="mt-8">
                <h3
                  className="text-sm mb-4 tracking-wide uppercase opacity-60"
                  style={{ color: 'var(--grove-text-muted)' }}
                >
                  Ritual Invitations
                </h3>
                <div className="space-y-3">
                  {ritualInvitations.map((invitation) => (
                    <RitualInvitation
                      key={invitation.ritual}
                      invitation={invitation}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right column — structural timeline */}
          <div className="overflow-y-auto">
            <StructuralTimeline timeline={timeline} />
          </div>
        </div>
      </main>
    </div>
  )
}
