import type { Climate, ClimateProposal, ProposalBasis } from '@grove/core'
import { and, desc, eq } from 'drizzle-orm'

import type { GroveDb } from './client'
import { getDb } from './client'
import { climateDeclarations, climateProposals } from './schema'

export type ProposalStatus = 'active' | 'accepted' | 'dismissed' | 'withdrawn'

export interface StoredProposal {
  id: number
  climate: Climate
  basis: ProposalBasis
  triggerType: string
  observedSeason: string | null
  observation: string
  status: ProposalStatus
  proposedAt: string
  respondedAt: string | null
  stewardId: number | null
  /** Last evaluation whose window carried enough evidence and reproduced the pattern */
  lastSupportedAt: string | null
  /** JSON array of `{ fullName, githubId? }` the proposal drew on; null for proposals recorded before this was tracked */
  sourceRepositories: string | null
}

/** A repository whose persistence a proposal drew on. */
export interface ProposalSource {
  fullName: string
  githubId?: number
}

/** Parse the stored source list; undefined when the proposal predates source tracking. */
export function parseProposalSources(
  stored: string | null,
): ProposalSource[] | undefined {
  if (!stored) return undefined
  try {
    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed.filter(
      (s): s is ProposalSource =>
        typeof s === 'object' && s !== null && typeof s.fullName === 'string',
    )
  } catch {
    return undefined
  }
}

/**
 * Record that an evaluation with sufficient evidence reproduced the pattern
 * behind the active proposal. Evaluations without evidence never call this,
 * so `last_supported_at` is an honest "last seen", not a heartbeat.
 */
export function markProposalSupported(
  proposalId: number,
  supportedAt: string,
  db: GroveDb = getDb(),
) {
  db.update(climateProposals)
    .set({ lastSupportedAt: supportedAt })
    .where(eq(climateProposals.id, proposalId))
    .run()
}

/**
 * Get the current active proposal for a specific steward, if one exists.
 * §2.3 — Only one active proposal may exist at a time per steward.
 * Proposals are scoped to stewardId to match the per-steward climate
 * declaration model in climate-store.ts.
 */
export function getActiveProposal(
  stewardId: number,
  db: GroveDb = getDb(),
): StoredProposal | undefined {
  const row = db
    .select()
    .from(climateProposals)
    .where(
      and(
        eq(climateProposals.status, 'active'),
        eq(climateProposals.stewardId, stewardId),
      ),
    )
    .orderBy(desc(climateProposals.id))
    .limit(1)
    .get()

  return row as StoredProposal | undefined
}

/**
 * Persist a new climate proposal. Withdraws any existing active proposal
 * for this steward first.
 * §2.3 — Only one active proposal may exist at a time per steward.
 */
export function persistProposal(
  proposal: ClimateProposal,
  observation: string,
  stewardId: number,
  db: GroveDb = getDb(),
  sources?: ProposalSource[],
) {
  db.transaction((tx) => {
    // Withdraw any existing active proposal for this steward
    const existing = tx
      .select({ id: climateProposals.id })
      .from(climateProposals)
      .where(
        and(
          eq(climateProposals.status, 'active'),
          eq(climateProposals.stewardId, stewardId),
        ),
      )
      .all()

    for (const row of existing) {
      tx.update(climateProposals)
        .set({
          status: 'withdrawn',
          respondedAt: new Date().toISOString(),
        })
        .where(eq(climateProposals.id, row.id))
        .run()
    }

    tx.insert(climateProposals)
      .values({
        climate: proposal.climate,
        basis: proposal.basis,
        triggerType: proposal.triggerType,
        observedSeason: proposal.observedSeason ?? null,
        observation,
        status: 'active',
        proposedAt: new Date().toISOString(),
        stewardId,
        lastSupportedAt: new Date().toISOString(),
        sourceRepositories: sources ? JSON.stringify(sources) : null,
      })
      .run()
  })
}

/**
 * Accept a proposal — steward confirms the suggested climate.
 * Atomically marks the proposal as accepted and persists the climate
 * declaration in a single transaction.
 */
export function acceptProposal(
  proposalId: number,
  stewardId: number,
  stewardLogin: string,
  db: GroveDb = getDb(),
) {
  db.transaction((tx) => {
    const proposal = tx
      .select()
      .from(climateProposals)
      .where(
        and(
          eq(climateProposals.id, proposalId),
          eq(climateProposals.stewardId, stewardId),
        ),
      )
      .get()

    if (!proposal || proposal.status !== 'active') {
      throw new Error('No active proposal found for this steward')
    }

    tx.update(climateProposals)
      .set({
        status: 'accepted',
        respondedAt: new Date().toISOString(),
      })
      .where(eq(climateProposals.id, proposalId))
      .run()

    tx.insert(climateDeclarations)
      .values({
        climate: proposal.climate,
        declaredAt: new Date().toISOString(),
        declaredBy: stewardLogin,
        declaredById: stewardId,
      })
      .run()
  })
}

/**
 * Dismiss a proposal — steward declines the suggestion.
 * Validates the proposal belongs to the requesting steward.
 */
export function dismissProposal(
  proposalId: number,
  stewardId: number,
  db: GroveDb = getDb(),
) {
  db.update(climateProposals)
    .set({
      status: 'dismissed',
      respondedAt: new Date().toISOString(),
    })
    .where(
      and(eq(climateProposals.id, proposalId), eq(climateProposals.stewardId, stewardId)),
    )
    .run()
}

/**
 * §2.3 — Withdraw a proposal when the underlying pattern reverses.
 * Scoped to the specific steward's active proposal.
 */
export function withdrawActiveProposal(stewardId: number, db: GroveDb = getDb()) {
  const active = getActiveProposal(stewardId, db)
  if (!active) return

  db.update(climateProposals)
    .set({
      status: 'withdrawn',
      respondedAt: new Date().toISOString(),
    })
    .where(eq(climateProposals.id, active.id))
    .run()
}
