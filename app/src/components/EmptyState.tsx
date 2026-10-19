import type { IdentityUnavailableReason } from '../server/identity'

interface EmptyStateProps {
  /** Why no steward identity is available. Defaults to a missing token. */
  reason?: IdentityUnavailableReason
}

const Token = () => (
  <code style={{ color: 'var(--grove-text)' }}>GROVE_GITHUB_TOKEN</code>
)

/**
 * Shown when nothing can be observed because no steward identity is
 * available. The copy states the actual condition: a token that is
 * absent, one GitHub refused, or GitHub out of reach.
 */
export function EmptyState({ reason = 'missing' }: EmptyStateProps) {
  const copy = {
    missing: {
      title: 'No token configured.',
      body: (
        <>
          Set <Token /> in your environment to begin observing repositories.
        </>
      ),
    },
    rejected: {
      title: 'The configured token was not accepted.',
      body: (
        <>
          GitHub did not accept the current <Token />. Observation resumes once a
          token GitHub accepts is set.
        </>
      ),
    },
    unreachable: {
      title: 'GitHub could not be reached.',
      body: (
        <>
          The configured <Token /> could not be verified this time. Nothing was
          observed; observation resumes when GitHub can be reached.
        </>
      ),
    },
  }[reason]

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center max-w-md">
        <h2
          className="text-xl mb-4"
          style={{
            fontFamily: 'var(--grove-font-display)',
            color: 'var(--grove-text)',
          }}
        >
          {copy.title}
        </h2>
        <p
          className="text-sm"
          style={{ color: 'var(--grove-text-muted)' }}
        >
          {copy.body}
        </p>
      </div>
    </div>
  )
}
