import type { Climate, ClimateProposal } from '@grove/core'

interface ClimateBandProps {
  climate?: Climate
  proposal?: ClimateProposal
  onOpenDeclaration: () => void
  onAcceptProposal?: () => void
  onDismissProposal?: () => void
}

const proposalDateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function formatProposalDate(iso: string): string {
  return proposalDateFormat.format(new Date(iso))
}

const PROPOSAL_BASIS_DESCRIPTIONS: Record<string, string> = {
  sustained_core_divergence:
    'Structural core projects have persistently diverged from the declared climate.',
  long_arc_alignment:
    'Long-horizon domain projects share a sustained seasonal direction that differs from the declared climate.',
  density_drift_upward:
    'Sustained structural density increase observed across the portfolio.',
  density_drift_downward:
    'Sustained structural density decrease observed across the portfolio.',
  mixed_transition:
    'The portfolio has moved away from the declared climate without a single dominant direction.',
}

export function ClimateBand({
  climate,
  proposal,
  onOpenDeclaration,
  onAcceptProposal,
  onDismissProposal,
}: ClimateBandProps) {
  return (
    <div
      style={{
        backgroundColor: 'var(--grove-surface)',
        borderBottom: '1px solid var(--grove-border)',
      }}
    >
      <div className="flex items-center justify-between px-8 py-3 text-sm">
        <span style={{ color: 'var(--grove-text-muted)' }}>
          {climate ? (
            <>
              Climate: <span style={{ color: 'var(--grove-text)' }}>{climate}</span>
            </>
          ) : (
            'No climate declared'
          )}
        </span>
        <button
          onClick={onOpenDeclaration}
          className="text-xs px-3 py-1 rounded cursor-pointer transition-colors"
          style={{
            color: 'var(--grove-text-muted)',
            border: '1px solid var(--grove-border)',
          }}
        >
          {climate ? 'Update climate' : 'Declare climate'}
        </button>
      </div>

      {proposal && (
        <div
          className="px-8 py-3 text-sm"
          style={{
            borderTop: '1px solid var(--grove-border)',
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p
                className="text-xs mb-1 tracking-wide uppercase opacity-60"
                style={{ color: 'var(--grove-text-muted)' }}
              >
                Observed pattern
              </p>
              <p style={{ color: 'var(--grove-text-muted)' }}>
                {PROPOSAL_BASIS_DESCRIPTIONS[proposal.basis] ??
                  'A persistent seasonal pattern has been observed.'}
              </p>
              {proposal.observedSeason && (
                <p className="mt-1 text-xs" style={{ color: 'var(--grove-text-muted)' }}>
                  Observed direction:{' '}
                  <span style={{ color: 'var(--grove-text)' }}>
                    {proposal.observedSeason}
                  </span>
                </p>
              )}
              {proposal.evidence === 'not_observed' && (
                <p
                  className="mt-1 text-xs"
                  style={{ color: 'var(--grove-text-muted)', opacity: 0.8 }}
                >
                  {proposal.lastSupportedAt
                    ? `Last supported by observation on ${formatProposalDate(proposal.lastSupportedAt)}. `
                    : ''}
                  The recent window does not carry enough determinate observation to
                  re-examine this pattern.
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0 pt-1">
              {onAcceptProposal && (
                <button
                  onClick={onAcceptProposal}
                  className="text-xs px-3 py-1 rounded cursor-pointer transition-colors"
                  style={{
                    color: 'var(--grove-surface)',
                    backgroundColor: 'var(--grove-accent)',
                  }}
                >
                  Adopt as climate
                </button>
              )}
              {onDismissProposal && (
                <button
                  onClick={onDismissProposal}
                  className="text-xs px-3 py-1 rounded cursor-pointer transition-colors"
                  style={{
                    color: 'var(--grove-text-muted)',
                    border: '1px solid var(--grove-border)',
                  }}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
