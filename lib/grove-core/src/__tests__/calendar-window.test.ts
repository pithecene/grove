import { describe, expect, it } from 'vitest'

import {
  assessPersistence,
  buildCalendarWindow,
  PERSISTENCE_WINDOW_SIZE,
  relateCalendarWindow,
  shiftDay,
  toUtcDay,
} from '../persistence'

function snap(day: string, phase: string | null = 'expanding', hour = 12) {
  return { observedAt: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`, phase }
}

describe('toUtcDay / shiftDay', () => {
  it('derives the UTC calendar day', () => {
    expect(toUtcDay('2025-03-01T23:59:59.000Z')).toBe('2025-03-01')
    expect(toUtcDay('2025-03-01T00:00:00.000Z')).toBe('2025-03-01')
  })

  it('shifts across month and year boundaries', () => {
    expect(shiftDay('2025-03-01', -1)).toBe('2025-02-28')
    expect(shiftDay('2024-12-31', 1)).toBe('2025-01-01')
    expect(shiftDay('2025-01-14', -13)).toBe('2025-01-01')
  })
})

describe('buildCalendarWindow', () => {
  it('produces one slot per calendar day, most recent first', () => {
    const slots = buildCalendarWindow([], '2025-01-14', 3)
    expect(slots.map((s) => s.day)).toEqual(['2025-01-14', '2025-01-13', '2025-01-12'])
    expect(slots.every((s) => s.snapshot === undefined)).toBe(true)
  })

  it('represents days without observation explicitly', () => {
    const rows = [snap('2025-01-14'), snap('2025-01-12')]
    const slots = buildCalendarWindow(rows, '2025-01-14', 3)
    expect(slots[0].snapshot).toBeDefined()
    expect(slots[1].snapshot).toBeUndefined() // 2025-01-13 not observed
    expect(slots[2].snapshot).toBeDefined()
  })

  it('keeps the most recent snapshot of a day regardless of input order', () => {
    const rows = [snap('2025-01-14', 'expanding', 3), snap('2025-01-14', 'resting', 20)]
    const slots = buildCalendarWindow(rows, '2025-01-14', 1)
    expect(slots[0].snapshot?.phase).toBe('resting')
  })

  it('ignores observations outside the window', () => {
    const rows = [snap('2025-01-15'), snap('2025-01-01')]
    const slots = buildCalendarWindow(rows, '2025-01-14', 3)
    expect(slots.every((s) => s.snapshot === undefined)).toBe(true)
  })

  it('a months-long absence yields a window of empty slots, not a stitched window', () => {
    const rows = [snap('2025-01-14'), snap('2024-08-01'), snap('2024-07-31')]
    const slots = buildCalendarWindow(rows, '2025-01-14')
    expect(slots).toHaveLength(PERSISTENCE_WINDOW_SIZE)
    expect(slots.filter((s) => s.snapshot !== undefined)).toHaveLength(1)
  })
})

describe('assessPersistence with calendar slots', () => {
  function window(days: Array<string | null | 'missing'>, endDay = '2025-01-14') {
    // days[i] is the phase on day endDay-i; 'missing' = no observation
    const rows = days.flatMap((phase, i) =>
      phase === 'missing' ? [] : [snap(shiftDay(endDay, -i), phase)],
    )
    return relateCalendarWindow(buildCalendarWindow(rows, endDay), 'dormancy')
  }

  it('complete window: 14 observed divergent days → persistently divergent', () => {
    const relations = window(Array(14).fill('expanding'))
    const result = assessPersistence(relations)
    expect(result.evidence).toBe('complete')
    expect(result.windowDays).toBe(14)
    expect(result.missingDays).toBe(0)
    expect(result.totalSnapshots).toBe(14)
    expect(result.persistentlyDivergent).toBe(true)
  })

  it('partial window: 9 observed divergent days with 5 missing → still persistent, evidence partial', () => {
    const days = [...Array(9).fill('expanding'), ...Array(5).fill('missing')]
    const result = assessPersistence(window(days))
    expect(result.evidence).toBe('partial')
    expect(result.missingDays).toBe(5)
    expect(result.divergentCount).toBe(9)
    expect(result.persistentlyDivergent).toBe(true)
  })

  it('missing days never count toward alignment or divergence', () => {
    const days = [...Array(8).fill('expanding'), ...Array(6).fill('missing')]
    const result = assessPersistence(window(days))
    expect(result.evidence).toBe('insufficient')
    expect(result.persistentlyDivergent).toBe(false)
    expect(result.persistentlyAligned).toBe(false)
    expect(result.undeterminedCount).toBe(0)
  })

  it('a single observed day after a long absence is insufficient', () => {
    const days = ['expanding', ...Array(13).fill('missing')]
    const result = assessPersistence(window(days))
    expect(result.evidence).toBe('insufficient')
    expect(result.totalSnapshots).toBe(1)
    expect(result.missingDays).toBe(13)
  })

  it('observed days without a derivable relation are undetermined, not missing', () => {
    const days = [...Array(9).fill('expanding'), ...Array(5).fill(null)]
    const result = assessPersistence(window(days))
    expect(result.missingDays).toBe(0)
    expect(result.undeterminedCount).toBe(5)
    expect(result.evidence).toBe('complete')
  })

  it('legacy relation lists are treated as observed snapshots', () => {
    const result = assessPersistence(Array(14).fill('aligned'))
    expect(result.evidence).toBe('complete')
    expect(result.persistentlyAligned).toBe(true)
  })

  it('legacy short lists are insufficient and never persistent', () => {
    const result = assessPersistence(Array(10).fill('divergent'))
    expect(result.windowDays).toBe(10)
    expect(result.evidence).toBe('insufficient')
    expect(result.persistentlyDivergent).toBe(false)
  })
})
