import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'

/**
 * Tests for the seed script:
 * - StrKey validation of hard-coded Stellar keys
 * - CLI argument parsing
 * - Shape, determinism, and network-tagging of fixture data
 * - Idempotency contract (skipDuplicates: true on all tables)
 * - Network isolation and network flag filtering
 */

import {
  TESTNET_USDC_ISSUER,
  MAINNET_USDC_ISSUER,
  PAIRS,
  ANCHOR,
  parseArgs,
  makePricePoints,
  makePoolSnapshots,
  makePriceAggregates,
  seedNetwork,
  seed,
} from '../../scripts/seed'

describe('seed fixtures', () => {
  // ── StrKey validation ────────────────────────────────────────────────────

  describe('Stellar address validation', () => {
    it('validates testnet USDC issuer is a valid Ed25519 public key', () => {
      expect(StrKey.isValidEd25519PublicKey(TESTNET_USDC_ISSUER)).toBe(true)
    })

    it('validates mainnet USDC issuer is a valid Ed25519 public key', () => {
      expect(StrKey.isValidEd25519PublicKey(MAINNET_USDC_ISSUER)).toBe(true)
    })

    it('rejects malformed public keys', () => {
      expect(StrKey.isValidEd25519PublicKey('G_NOT_A_VALID_KEY')).toBe(false)
      expect(StrKey.isValidEd25519PublicKey('')).toBe(false)
    })
  })

  // ── CLI argument parsing ─────────────────────────────────────────────────

  describe('parseArgs', () => {
    it('parses --network testnet as separate tokens', () => {
      expect(parseArgs(['--network', 'testnet'])).toEqual({ network: 'testnet' })
    })

    it('parses --network=testnet syntax', () => {
      expect(parseArgs(['--network=testnet'])).toEqual({ network: 'testnet' })
    })

    it('returns empty object when no flags provided', () => {
      expect(parseArgs([])).toEqual({ network: undefined })
    })
  })

  // ── Pair definitions ─────────────────────────────────────────────────────

  describe('PAIRS', () => {
    it('defines testnet and mainnet pairs', () => {
      expect(PAIRS).toHaveProperty('testnet')
      expect(PAIRS).toHaveProperty('mainnet')
    })

    it('uses valid USDC issuers matching the constants', () => {
      expect(PAIRS.testnet.pairKey).toContain(TESTNET_USDC_ISSUER)
      expect(PAIRS.mainnet.pairKey).toContain(MAINNET_USDC_ISSUER)
    })

    it('uses different pool IDs per network', () => {
      expect(PAIRS.testnet.poolId).not.toBe(PAIRS.mainnet.poolId)
    })

    it('pairKeys are alphabetically sorted (USDC before XLM)', () => {
      expect(PAIRS.testnet.pairKey).toMatch(/^USDC:.*\/XLM$/)
      expect(PAIRS.mainnet.pairKey).toMatch(/^USDC:.*\/XLM$/)
    })
  })

  // ── Price points ─────────────────────────────────────────────────────────

  describe('makePricePoints', () => {
    const testnetPoints = makePricePoints('testnet', PAIRS.testnet)
    const mainnetPoints = makePricePoints('mainnet', PAIRS.mainnet)

    it('produces 36 points per network (24 SDEX + 12 AMM)', () => {
      expect(testnetPoints).toHaveLength(36)
      expect(mainnetPoints).toHaveLength(36)
    })

    it('tags every point with the correct network', () => {
      for (const p of testnetPoints) expect(p.network).toBe('testnet')
      for (const p of mainnetPoints) expect(p.network).toBe('mainnet')
    })

    it('generates deterministic IDs containing the network name and source', () => {
      for (const p of testnetPoints) {
        expect(p.id).toMatch(/^seed-testnet-(sdex|amm)-\d+$/)
      }
      for (const p of mainnetPoints) {
        expect(p.id).toMatch(/^seed-mainnet-(sdex|amm)-\d+$/)
      }
    })

    it('produces identical output on repeated calls (deterministic)', () => {
      const second = makePricePoints('testnet', PAIRS.testnet)
      expect(second).toEqual(testnetPoints)
    })

    it('assigns SDEX points a null poolId and AMM points a non-null poolId', () => {
      const sdex = testnetPoints.filter(p => p.source === 'SDEX')
      const amm = testnetPoints.filter(p => p.source === 'AMM')
      expect(sdex.length).toBe(24)
      expect(amm.length).toBe(12)
      for (const p of sdex) expect(p.poolId).toBeNull()
      for (const p of amm) expect(p.poolId).toBe(PAIRS.testnet.poolId)
    })

    it('generates prices near the base price (within ±5%)', () => {
      for (const p of testnetPoints) {
        const price = Number(p.price)
        expect(price).toBeGreaterThan(PAIRS.testnet.basePrice * 0.95)
        expect(price).toBeLessThan(PAIRS.testnet.basePrice * 1.05)
      }
    })

    it('generates positive volumes', () => {
      for (const p of testnetPoints) {
        expect(Number(p.baseVolume)).toBeGreaterThan(0)
        expect(Number(p.counterVolume)).toBeGreaterThan(0)
      }
    })

    it('all timestamps are <= ANCHOR and within the last 24 hours', () => {
      const dayBeforeAnchor = ANCHOR.getTime() - 24 * 60 * 60 * 1000
      for (const p of testnetPoints) {
        expect(p.timestamp.getTime()).toBeLessThanOrEqual(ANCHOR.getTime())
        expect(p.timestamp.getTime()).toBeGreaterThanOrEqual(dayBeforeAnchor)
      }
    })

    it('IDs are unique across all points for a given network', () => {
      const ids = testnetPoints.map(p => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('testnet and mainnet IDs never collide', () => {
      const allIds = [...testnetPoints, ...mainnetPoints].map(p => p.id)
      expect(new Set(allIds).size).toBe(allIds.length)
    })
  })

  // ── Pool snapshots ───────────────────────────────────────────────────────

  describe('makePoolSnapshots', () => {
    const snaps = makePoolSnapshots('testnet', PAIRS.testnet)

    it('produces 6 snapshots', () => {
      expect(snaps).toHaveLength(6)
    })

    it('tags every snapshot with the correct network', () => {
      for (const s of snaps) expect(s.network).toBe('testnet')
    })

    it('generates deterministic IDs', () => {
      for (const s of snaps) {
        expect(s.id).toMatch(/^seed-testnet-snap-\d+$/)
      }
    })

    it('produces identical output on repeated calls', () => {
      const second = makePoolSnapshots('testnet', PAIRS.testnet)
      expect(second).toEqual(snaps)
    })

    it('assigns the correct poolId', () => {
      for (const s of snaps) {
        expect(s.poolId).toBe(PAIRS.testnet.poolId)
      }
    })

    it('generates positive reserves', () => {
      for (const s of snaps) {
        expect(Number(s.reserveA)).toBeGreaterThan(0)
        expect(Number(s.reserveB)).toBeGreaterThan(0)
      }
    })

    it('IDs are unique', () => {
      const ids = snaps.map(s => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  // ── Price aggregates ─────────────────────────────────────────────────────

  describe('makePriceAggregates', () => {
    const aggs = makePriceAggregates('testnet', PAIRS.testnet)

    it('produces aggregates for all four windows (1m, 5m, 1h, 24h)', () => {
      const windows = new Set(aggs.map(a => a.window))
      expect(windows).toEqual(new Set(['1m', '5m', '1h', '24h']))
    })

    it('tags every aggregate with the correct network', () => {
      for (const a of aggs) expect(a.network).toBe('testnet')
    })

    it('produces identical output on repeated calls', () => {
      const second = makePriceAggregates('testnet', PAIRS.testnet)
      expect(second).toEqual(aggs)
    })

    it('has valid OHLCV data (high >= low, volumes > 0)', () => {
      for (const a of aggs) {
        expect(Number(a.highPrice)).toBeGreaterThanOrEqual(Number(a.lowPrice))
        expect(Number(a.volume)).toBeGreaterThan(0)
        expect(a.tradeCount).toBeGreaterThan(0)
      }
    })

    it('composite keys are unique per (network, pairKey, window, bucket)', () => {
      const keys = aggs.map(a => `${a.network}|${a.pairKey}|${a.window}|${a.bucket.toISOString()}`)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('generates expected bucket counts per window', () => {
      const byWindow = new Map<string, number>()
      for (const a of aggs) byWindow.set(a.window, (byWindow.get(a.window) ?? 0) + 1)
      expect(byWindow.get('1m')).toBe(12)
      expect(byWindow.get('5m')).toBe(12)
      expect(byWindow.get('1h')).toBe(24)
      expect(byWindow.get('24h')).toBe(1)
    })
  })

  // ── Cross-network isolation ──────────────────────────────────────────────

  describe('network isolation', () => {
    it('testnet and mainnet price points have different pairKeys', () => {
      const testnet = makePricePoints('testnet', PAIRS.testnet)
      const mainnet = makePricePoints('mainnet', PAIRS.mainnet)
      const testnetKeys = new Set(testnet.map(p => p.pairKey))
      const mainnetKeys = new Set(mainnet.map(p => p.pairKey))
      for (const k of testnetKeys) expect(mainnetKeys.has(k)).toBe(false)
    })

    it('testnet and mainnet snapshots use different poolIds', () => {
      const testnet = makePoolSnapshots('testnet', PAIRS.testnet)
      const mainnet = makePoolSnapshots('mainnet', PAIRS.mainnet)
      const testnetPools = new Set(testnet.map(s => s.poolId))
      const mainnetPools = new Set(mainnet.map(s => s.poolId))
      for (const p of testnetPools) expect(mainnetPools.has(p)).toBe(false)
    })
  })

  // ── Database interaction & Idempotency contract ───────────────────────────

  describe('seedNetwork and idempotency', () => {
    it('calls createMany with skipDuplicates: true on all tables', async () => {
      const mockPrisma = {
        pricePoint: {
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
        },
        poolSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
        },
        priceAggregate: {
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
        },
      } as any

      const result = await seedNetwork(mockPrisma, 'testnet', PAIRS.testnet)

      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.poolSnapshot.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )
      expect(mockPrisma.priceAggregate.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true })
      )

      expect(result.pricePoints.inserted).toBe(36)
      expect(result.poolSnapshots.inserted).toBe(6)
      expect(result.priceAggregates.inserted).toBe(49)
    })

    it('simulates second run (idempotent / no-op) where 0 rows are inserted', async () => {
      const mockPrisma = {
        pricePoint: {
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        poolSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        priceAggregate: {
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as any

      const result = await seedNetwork(mockPrisma, 'testnet', PAIRS.testnet)

      expect(result.pricePoints.inserted).toBe(0)
      expect(result.poolSnapshots.inserted).toBe(0)
      expect(result.priceAggregates.inserted).toBe(0)
    })
  })

  // ── Seed CLI options ──────────────────────────────────────────────────────

  describe('seed function with network filter', () => {
    it('seeds both networks when no filter is specified', async () => {
      const mockPrisma = {
        pricePoint: {
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ client: mockPrisma })
      expect(results).toHaveProperty('testnet')
      expect(results).toHaveProperty('mainnet')
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(2)
    })

    it('seeds only testnet when network filter is "testnet"', async () => {
      const mockPrisma = {
        pricePoint: {
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ network: 'testnet', client: mockPrisma })
      expect(results).toHaveProperty('testnet')
      expect(results).not.toHaveProperty('mainnet')
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(1)
    })

    it('seeds only mainnet when network filter is "mainnet"', async () => {
      const mockPrisma = {
        pricePoint: {
          createMany: vi.fn().mockResolvedValue({ count: 36 }),
          count: vi.fn().mockResolvedValue(36),
        },
        poolSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 6 }),
          count: vi.fn().mockResolvedValue(6),
        },
        priceAggregate: {
          createMany: vi.fn().mockResolvedValue({ count: 49 }),
          count: vi.fn().mockResolvedValue(49),
        },
      } as any

      const results = await seed({ network: 'mainnet', client: mockPrisma })
      expect(results).toHaveProperty('mainnet')
      expect(results).not.toHaveProperty('testnet')
      expect(mockPrisma.pricePoint.createMany).toHaveBeenCalledTimes(1)
    })

    it('rejects an invalid network filter', async () => {
      const mockPrisma = {} as any
      await expect(seed({ network: 'invalid-net', client: mockPrisma })).rejects.toThrow(
        /Invalid --network value/
      )
    })
  })
})
