import { describe, expect, it } from 'vitest'

import {
  assessPersistence,
  buildCalendarWindow,
  hasDeterminateEvidence,
  relateCalendarWindow,
  shiftDay,
} from '../persistence'

function window(phases: Array<string | null | 'missing'>, endDay = '2025-01-14') {
  const rows = phases.flatMap((phase, i) =>
    phase === 'missing'
      ? []
      : [{ observedAt: `${shiftDay(endDay, -i)}T12:00:00.000Z`, phase }],
  )
  return assessPersistence(
    relateCalendarWindow(buildCalendarWindow(rows, endDay), 'dormancy'),
  )
}

describe('hasDeterminateEvidence', () => {
  it('a complete window of derivable relations is determinate', () => {
    expect(hasDeterminateEvidence(window(Array(14).fill('expanding')))).toBe(true)
  })

  it('observed days without a derivable relation are ambiguity, not evidence', () => {
    // 9 observed days, all with no phase: "partial" by count, nothing determinable.
    const p = window([...Array(9).fill(null), ...Array(5).fill('missing')])
    expect(p.evidence).toBe('partial')
    expect(hasDeterminateEvidence(p)).toBe(false)
  })

  it('mixed windows need the threshold in determinate days', () => {
    expect(
      hasDeterminateEvidence(
        window([...Array(9).fill('expanding'), ...Array(5).fill(null)]),
      ),
    ).toBe(true)
    expect(
      hasDeterminateEvidence(
        window([...Array(8).fill('expanding'), ...Array(6).fill(null)]),
      ),
    ).toBe(false)
  })

  it('insufficient windows are never determinate', () => {
    expect(
      hasDeterminateEvidence(window(['expanding', ...Array(13).fill('missing')])),
    ).toBe(false)
  })
})
