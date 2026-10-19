import { Link } from '@tanstack/react-router'

import type { AccessFailure } from '../server/github-state'
import { Header } from './Header'

type Subject = 'repository' | 'portfolio'

interface LookupNoticeProps {
  login?: string
  subject: Subject
  state: Exclude<AccessFailure, { kind: 'token_rejected' }> | { kind: 'out_of_scope' }
}

const sentence = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1)

/** States the condition for the stage that produced it (`state.subject`). */
function message(state: LookupNoticeProps['state']): string {
  switch (state.kind) {
    case 'out_of_scope':
      return 'This repository is outside the selected portfolio scope.'
    case 'not_accessible':
      return `${sentence(state.subject)} was not found or is not accessible with the configured token.`
    case 'unavailable':
      return `GitHub gave no usable answer about ${state.subject} this time (unreachable, unavailable or rate-limited). Nothing was observed.`
  }
}

/**
 * Shown when a lookup produced no observation. States the condition,
 * nothing more: no retry prompt, no urgency, no guess.
 */
export function LookupNotice({ login, subject, state }: LookupNoticeProps) {
  return (
    <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
      <Header login={login} />
      <main className="px-8 py-8">
        {subject === 'repository' && (
          <Link
            to="/"
            className="text-sm mb-6 inline-block"
            style={{ color: 'var(--grove-text-muted)' }}
          >
            &larr; Portfolio
          </Link>
        )}
        <p className="text-sm" style={{ color: 'var(--grove-text-muted)' }}>
          {message(state)}
        </p>
      </main>
    </div>
  )
}
