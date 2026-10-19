import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { EmptyState } from '../components/EmptyState'
import { Header } from '../components/Header'
import { getSession } from '../server/auth'
import type { SinceReport, SinceSource, StructureAt } from '../server/since'
import { keepReference, loadSince } from '../server/since-fns'

type SinceSearch = { ref?: string }

export const Route = createFileRoute('/since')({
  component: SincePage,
  validateSearch: (search: Record<string, unknown>): SinceSearch => ({
    ref: typeof search.ref === 'string' && search.ref.length > 0 ? search.ref : undefined,
  }),
  loaderDeps: ({ search }) => ({ ref: search.ref }),
  loader: async ({ deps }) => {
    const session = await getSession()
    if (!session.authenticated) return { session, lookup: undefined }
    const lookup = await loadSince({ data: { referenceAt: deps.ref } })
    return { session, lookup }
  },
})

/** Calendar days are UTC days throughout, as the rows and the reference are. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

const muted = { color: 'var(--grove-text-muted)' } as const
const text = { color: 'var(--grove-text)' } as const

/** How Grove knows a line: stated beside it, never implied. */
function Source({ source }: { source: SinceSource }) {
  return (
    <span className="text-xs ml-2 opacity-60" style={muted}>
      {source}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h3 className="text-sm mb-4 tracking-wide uppercase opacity-60" style={muted}>
        {title}
      </h3>
      <div className="space-y-3 text-sm" style={text}>
        {children}
      </div>
    </section>
  )
}

function Line({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}

function Nothing({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm" style={muted}>
      {children}
    </div>
  )
}

function describeStructure(s: StructureAt | null): string {
  if (!s) return 'no row'
  const parts = [
    s.densityTier ? s.densityTier.replace(/_/g, ' ') : 'structure not derived',
    s.manifests.length > 0 ? `manifests ${s.manifests.join(', ')}` : 'no manifests',
    s.ecosystemDependencyCount === null
      ? 'ecosystem dependencies unknown'
      : `${s.ecosystemDependencyCount} ecosystem ${s.ecosystemDependencyCount === 1 ? 'dependency' : 'dependencies'}`,
  ]
  return `${parts.join(' · ')} (${formatDate(s.observedAt)}, ${s.source})`
}

function ReferenceHeader({ report }: { report: SinceReport }) {
  const router = useRouter()
  const navigate = Route.useNavigate()
  const [day, setDay] = useState('')
  const [kept, setKept] = useState(false)
  // The end of a day is the reference; the latest day that has ended.
  const maxDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const basis =
    report.reference.basis === 'saved'
      ? report.reference.label
        ? `a kept reference — ${report.reference.label}`
        : 'a kept reference'
      : report.reference.basis === 'chosen'
        ? 'a point chosen for this reading (not kept)'
        : report.reference.basis === 'absence'
          ? 'the last observation before the most recent absence (shown as a default)'
          : 'the earliest observation (shown as a default)'

  return (
    <div>
      <h2
        className="text-xl"
        style={{ fontFamily: 'var(--grove-font-display)', ...text }}
      >
        Since {formatInstant(report.reference.at)}
      </h2>
      <p className="text-sm mt-1" style={muted}>
        {basis}; compared with what is recorded up to {formatInstant(report.now)}.
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-4 text-sm">
        <button
          type="button"
          disabled={kept}
          onClick={async () => {
            await keepReference({ data: { referenceAt: report.reference.at } })
            setKept(true)
            router.invalidate()
          }}
          style={muted}
        >
          {kept ? 'Kept as a reference' : 'Keep this point as a reference'}
        </button>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
              navigate({ search: { ref: `${day}T23:59:59.999Z` } })
            }
          }}
        >
          <label style={muted} htmlFor="since-day">
            or compare since the end of
          </label>
          <input
            id="since-day"
            type="date"
            max={maxDay}
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="text-sm px-2 py-1 rounded"
            style={{
              backgroundColor: 'var(--grove-surface)',
              border: '1px solid var(--grove-border)',
              ...text,
            }}
          />
          <button type="submit" style={muted}>
            compare
          </button>
        </form>
      </div>
    </div>
  )
}

function SincePage() {
  const { session, lookup } = Route.useLoaderData()

  if (!session.authenticated || !lookup || lookup.kind === 'unauthenticated') {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header />
        <EmptyState
          reason={
            !session.authenticated
              ? session.reason
              : lookup?.kind === 'unauthenticated'
                ? lookup.reason
                : undefined
          }
        />
      </div>
    )
  }

  if (lookup.kind === 'nothing' || lookup.kind === 'unusable_reference') {
    return (
      <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
        <Header login={session.login} />
        <main className="px-8 py-8">
          <Link to="/" className="text-sm mb-6 inline-block" style={muted}>
            &larr; Portfolio
          </Link>
          <p className="text-sm" style={muted}>
            {lookup.kind === 'nothing'
              ? 'Nothing in the selected scope has been observed yet, so there is no point to compare against.'
              : 'That reference is not an instant that has been — nothing is recorded past now.'}
          </p>
          {lookup.kind === 'unusable_reference' && (
            <Link
              to="/since"
              search={{}}
              className="text-sm mt-4 inline-block"
              style={muted}
            >
              Compare since the default reference &rarr;
            </Link>
          )}
        </main>
      </div>
    )
  }

  const { report } = lookup
  const r = report.repositories
  const e = report.evidence

  return (
    <div style={{ backgroundColor: 'var(--grove-bg)', minHeight: '100vh' }}>
      <Header login={session.login} />
      <main className="px-8 py-8 max-w-4xl">
        <Link to="/" className="text-sm mb-6 inline-block" style={muted}>
          &larr; Portfolio
        </Link>

        <ReferenceHeader key={report.reference.at} report={report} />

        <Section title="Repositories">
          {r.newlyObserved.length === 0 &&
            r.notPresent.length === 0 &&
            r.nameChanges.length === 0 && (
              <Nothing>No repository appeared, left, or changed name.</Nothing>
            )}
          {r.newlyObserved.map((n) => (
            <Line key={`new-${n.githubId}`}>
              <Link
                to="/repo/$owner/$name"
                params={{
                  owner: n.fullName.split('/')[0],
                  name: n.fullName.split('/')[1],
                }}
              >
                {n.fullName}
              </Link>{' '}
              — newly observed {formatDate(n.firstAt)}
              {n.createdAfterReference && n.createdAt
                ? `, created ${formatDate(n.createdAt)}`
                : ''}
              <Source source={n.source} />
            </Line>
          ))}
          {r.notPresent.map((n) => (
            <Line key={`gone-${n.githubId}`}>
              {n.fullName} — present at the reference (last {formatDate(n.lastAt)}), not
              present in the latest full collection
              {n.outcome === 'unavailable'
                ? ` (access unavailable${n.answer ? `: ${n.answer}` : ''})`
                : ''}
              <Source source="observed" />
            </Line>
          ))}
          {r.nameChanges.map((c) => (
            <Line key={`name-${c.githubId}-${c.observedAt}`}>
              {c.toName} —{' '}
              {c.source === 'observed'
                ? 'observed under a new name'
                : 'under a new name from'}{' '}
              {formatDate(c.observedAt)}, previously {c.fromName}
              <Source source={c.source} />
            </Line>
          ))}
        </Section>

        <Section title="Declarations">
          {r.declarationChanges.length === 0 && (
            <Nothing>No declaration changed.</Nothing>
          )}
          {r.declarationChanges.map((d) => (
            <Line key={`decl-${d.githubId}-${d.observedAt}`}>
              {d.fullName} — {formatDate(d.observedAt)}:{' '}
              {d.changes
                .map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`)
                .join('; ')}
              <Source source={d.source} />
            </Line>
          ))}
        </Section>

        <Section title="Structure, at the reference and now">
          {r.structure.length === 0 && (
            <Nothing>No structural observation on either side.</Nothing>
          )}
          {r.structure.map((s) => (
            <Line key={`struct-${s.githubId}`}>
              <div>{s.fullName}</div>
              <div className="text-xs" style={muted}>
                at the reference: {describeStructure(s.atReference)}
              </div>
              <div className="text-xs" style={muted}>
                now: {describeStructure(s.now)}
              </div>
            </Line>
          ))}
        </Section>

        <Section title="Evidence">
          {e.gaps.map((g) => (
            <Line key={`gap-${g.githubId}-${g.observedAt}`}>
              {g.fullName} — not observed {formatDate(g.from)} through{' '}
              {formatDate(g.observedAt)} ({g.days} days)
              {g.from !== g.lastObservedAt
                ? `; last observed ${formatDate(g.lastObservedAt)}, before the reference`
                : ''}
              <Source source="observed" />
            </Line>
          ))}
          {e.historyDays.map((h) => (
            <Line key={`hist-${h.githubId}`}>
              {h.fullName} — {h.days} {h.days === 1 ? 'day' : 'days'} recorded from
              history
              <Source source="reconstructed" />
            </Line>
          ))}
          {e.unobserved.map((u) => (
            <Line key={`un-${u.githubId}`}>
              {u.fullName} — no row of any kind since the reference
            </Line>
          ))}
          {e.partialRuns.map((p) => (
            <Line key={`run-${p.id}`}>
              Collection {formatInstant(p.startedAt)} ({p.method}) —{' '}
              {!p.fullPortfolio ? 'a single repository or a named subset' : 'incomplete'}
              {p.answer ? ` (${p.answer})` : ''}
            </Line>
          ))}
          <Line>
            {e.latestFullRun
              ? `Absence is read from the full collection of ${formatInstant(e.latestFullRun.startedAt)}.`
              : 'No full collection since the reference: nothing is said about absence.'}
          </Line>
        </Section>

        <Section title="Climate">
          {report.climate.declarations.length === 0 &&
            report.climate.proposals.length === 0 && (
              <Nothing>No climate declaration or proposal in the interval.</Nothing>
            )}
          {report.climate.declarations.map((d) => (
            <Line key={`clim-${d.declaredAt}`}>
              Climate declared {d.climate} on {formatDate(d.declaredAt)}
              <Source source="declared" />
            </Line>
          ))}
          {report.climate.proposals.map((p) => (
            <Line key={`prop-${p.id}`}>
              Proposal of {p.climate} — proposed {formatDate(p.proposedAt)}
              {p.lastSupportedAt
                ? `, last supported ${formatDate(p.lastSupportedAt)}`
                : ''}
              {p.respondedAt
                ? `, ${p.status} ${formatDate(p.respondedAt)}`
                : `, ${p.status}`}
              <Source source="proposed" />
            </Line>
          ))}
        </Section>
      </main>
    </div>
  )
}
