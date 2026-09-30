/**
 * Seed the Lens database with deterministic fixture data.
 *
 * Creates price_points, pool_snapshots and price_aggregates for the default
 * pair on one or both networks so that /price, /pairs and /pools all return
 * non-empty, sensible data immediately after `docker compose up`.
 *
 * Usage:
 *   npm run seed                       # seed both networks
 *   npm run seed -- --network testnet  # seed testnet only
 *   npm run seed -- --network mainnet  # seed mainnet only
 *
 * Idempotent — every row uses a deterministic ID derived from network + index,
 * and INSERT … ON CONFLICT DO NOTHING ensures running it twice is a no-op.
 *
 * Requires DATABASE_URL to be set (same as the server).
 */
import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
import { StrKey } from '@stellar/stellar-sdk'

// ── USDC Issuers ─────────────────────────────────────────────────────────────
// Validated with StrKey.isValidEd25519PublicKey per ground rules
export const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

if (!StrKey.isValidEd25519PublicKey(TESTNET_USDC_ISSUER)) {
  throw new Error(`Invalid testnet USDC issuer: ${TESTNET_USDC_ISSUER}`)
}
if (!StrKey.isValidEd25519PublicKey(MAINNET_USDC_ISSUER)) {
  throw new Error(`Invalid mainnet USDC issuer: ${MAINNET_USDC_ISSUER}`)
}

// ── CLI args ──────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { network?: string } {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const rest = arg.slice(2)
      if (rest.includes('=')) {
        const [k, ...v] = rest.split('=')
        args[k] = v.join('=')
      } else {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) {
          args[rest] = next
          i++
        } else {
          args[rest] = 'true'
        }
      }
    }
  }
  return { network: args.network }
}

// ── Pair definitions ─────────────────────────────────────────────────────────

export interface PairDef {
  assetA: string       // e.g. "XLM"
  assetB: string       // e.g. "USDC"
  pairKey: string      // alphabetically sorted canonical key
  poolId: string       // deterministic pool ID for AMM rows
  basePrice: number    // approximate centre price for the fixture
}

export const PAIRS: Record<string, PairDef> = {
  testnet: {
    assetA: 'XLM',
    assetB: 'USDC',
    pairKey: `USDC:${TESTNET_USDC_ISSUER}/XLM`,
    poolId: 'seed-pool-testnet-xlm-usdc',
    basePrice: 0.12,
  },
  mainnet: {
    assetA: 'XLM',
    assetB: 'USDC',
    pairKey: `USDC:${MAINNET_USDC_ISSUER}/XLM`,
    poolId: 'seed-pool-mainnet-xlm-usdc',
    basePrice: 0.18,
  },
}

// ── Deterministic timestamp anchors ──────────────────────────────────────────
// All seed data is pinned to a fixed anchor so timestamps are reproducible.
// We lay out 24 price points across the last 24 hours from the anchor.

export const ANCHOR = new Date('2025-01-15T12:00:00.000Z')

export function hoursAgo(hours: number): Date {
  return new Date(ANCHOR.getTime() - hours * 60 * 60 * 1000)
}

// ── Price point generation ───────────────────────────────────────────────────

export function makePricePoints(network: string, pair: PairDef) {
  const points: {
    id: string
    network: string
    assetA: string
    assetB: string
    pairKey: string
    source: string
    poolId: string | null
    price: Prisma.Decimal
    baseVolume: Prisma.Decimal
    counterVolume: Prisma.Decimal
    ledger: number
    timestamp: Date
  }[] = []

  // 24 SDEX points, 1 per hour over the past 24h
  for (let i = 0; i < 24; i++) {
    // Deterministic small price variation: ±3% sine wave
    const priceVar = pair.basePrice * (1 + 0.03 * Math.sin((i * Math.PI) / 12))
    const price = parseFloat(priceVar.toFixed(8))
    const vol = 5000 + i * 200
    points.push({
      id: `seed-${network}-sdex-${i}`,
      network,
      assetA: pair.assetA,
      assetB: pair.assetB,
      pairKey: pair.pairKey,
      source: 'SDEX',
      poolId: null,
      price: new Prisma.Decimal(price),
      baseVolume: new Prisma.Decimal(vol),
      counterVolume: new Prisma.Decimal(parseFloat((vol * price).toFixed(7))),
      ledger: 50000000 + i * 100,
      timestamp: hoursAgo(23 - i),
    })
  }

  // 12 AMM points, 1 per 2 hours
  for (let i = 0; i < 12; i++) {
    const priceVar = pair.basePrice * (1 + 0.025 * Math.sin((i * Math.PI) / 6))
    const price = parseFloat(priceVar.toFixed(8))
    const vol = 3000 + i * 150
    points.push({
      id: `seed-${network}-amm-${i}`,
      network,
      assetA: pair.assetA,
      assetB: pair.assetB,
      pairKey: pair.pairKey,
      source: 'AMM',
      poolId: pair.poolId,
      price: new Prisma.Decimal(price),
      baseVolume: new Prisma.Decimal(vol),
      counterVolume: new Prisma.Decimal(parseFloat((vol * price).toFixed(7))),
      ledger: 50000050 + i * 200,
      timestamp: hoursAgo(22 - i * 2),
    })
  }

  return points
}

// ── Pool snapshot generation ─────────────────────────────────────────────────

export function makePoolSnapshots(network: string, pair: PairDef) {
  const snapshots: {
    id: string
    network: string
    poolId: string
    assetA: string
    assetB: string
    reserveA: Prisma.Decimal
    reserveB: Prisma.Decimal
    spotPrice: Prisma.Decimal
    totalShares: Prisma.Decimal
    feeBp: number
    ledger: number
    timestamp: Date
  }[] = []

  // 6 snapshots, 1 per 4 hours
  for (let i = 0; i < 6; i++) {
    const reserveA = 500000 + i * 10000
    const reserveB = parseFloat((reserveA * pair.basePrice).toFixed(7))
    const spotPrice = parseFloat(pair.basePrice.toFixed(8))
    snapshots.push({
      id: `seed-${network}-snap-${i}`,
      network,
      poolId: pair.poolId,
      assetA: pair.assetA,
      assetB: pair.assetB,
      reserveA: new Prisma.Decimal(reserveA),
      reserveB: new Prisma.Decimal(reserveB),
      spotPrice: new Prisma.Decimal(spotPrice),
      totalShares: new Prisma.Decimal(100000),
      feeBp: 30,
      ledger: 50000000 + i * 400,
      timestamp: hoursAgo(20 - i * 4),
    })
  }

  return snapshots
}

// ── Price aggregate generation ───────────────────────────────────────────────

export function makePriceAggregates(network: string, pair: PairDef) {
  const windows = ['1m', '5m', '1h', '24h'] as const
  const aggregates: {
    pairKey: string
    network: string
    window: string
    bucket: Date
    vwap: Prisma.Decimal
    sdexVwap: Prisma.Decimal
    ammVwap: Prisma.Decimal
    volume: Prisma.Decimal
    sdexVolume: Prisma.Decimal
    ammVolume: Prisma.Decimal
    tradeCount: number
    openPrice: Prisma.Decimal
    closePrice: Prisma.Decimal
    highPrice: Prisma.Decimal
    lowPrice: Prisma.Decimal
  }[] = []

  for (const window of windows) {
    // Number of buckets per window type
    const bucketCount = window === '1m' ? 12 : window === '5m' ? 12 : window === '1h' ? 24 : 1
    const bucketMinutes = window === '1m' ? 1 : window === '5m' ? 5 : window === '1h' ? 60 : 1440

    for (let i = 0; i < bucketCount; i++) {
      const bucketTime = new Date(ANCHOR.getTime() - i * bucketMinutes * 60 * 1000)
      const priceVar = pair.basePrice * (1 + 0.02 * Math.sin((i * Math.PI) / 6))
      const vwap = parseFloat(priceVar.toFixed(8))
      const sdexVwap = parseFloat((priceVar * 1.001).toFixed(8))
      const ammVwap = parseFloat((priceVar * 0.999).toFixed(8))
      const vol = 2000 + i * 100
      const sdexVol = parseFloat((vol * 0.6).toFixed(7))
      const ammVol = parseFloat((vol * 0.4).toFixed(7))
      const high = parseFloat((vwap * 1.015).toFixed(8))
      const low = parseFloat((vwap * 0.985).toFixed(8))

      aggregates.push({
        pairKey: pair.pairKey,
        network,
        window,
        bucket: bucketTime,
        vwap: new Prisma.Decimal(vwap),
        sdexVwap: new Prisma.Decimal(sdexVwap),
        ammVwap: new Prisma.Decimal(ammVwap),
        volume: new Prisma.Decimal(vol),
        sdexVolume: new Prisma.Decimal(sdexVol),
        ammVolume: new Prisma.Decimal(ammVol),
        tradeCount: 10 + i,
        openPrice: new Prisma.Decimal(parseFloat((vwap * 0.998).toFixed(8))),
        closePrice: new Prisma.Decimal(parseFloat((vwap * 1.002).toFixed(8))),
        highPrice: new Prisma.Decimal(high),
        lowPrice: new Prisma.Decimal(low),
      })
    }
  }

  return aggregates
}

// ── Idempotent upsert helpers ────────────────────────────────────────────────
// Prisma's createMany with skipDuplicates: true translates to
// INSERT INTO ... ON CONFLICT DO NOTHING, making subsequent runs no-ops.

export async function seedNetwork(prisma: PrismaClient, network: string, pair: PairDef) {
  // 1. Price points
  const points = makePricePoints(network, pair)
  const ppResult = await prisma.pricePoint.createMany({
    data: points,
    skipDuplicates: true,
  })

  // 2. Pool snapshots
  const snaps = makePoolSnapshots(network, pair)
  const psResult = await prisma.poolSnapshot.createMany({
    data: snaps,
    skipDuplicates: true,
  })

  // 3. Price aggregates
  const aggs = makePriceAggregates(network, pair)
  const paResult = await prisma.priceAggregate.createMany({
    data: aggs,
    skipDuplicates: true,
  })

  return {
    pricePoints: { total: points.length, inserted: ppResult.count },
    poolSnapshots: { total: snaps.length, inserted: psResult.count },
    priceAggregates: { total: aggs.length, inserted: paResult.count },
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function seed(options?: { network?: string; client?: PrismaClient }) {
  const prisma = options?.client ?? new PrismaClient()
  try {
    const networkFilter = options?.network
    if (networkFilter && networkFilter !== 'testnet' && networkFilter !== 'mainnet') {
      throw new Error(`Invalid --network value: "${networkFilter}". Must be "testnet" or "mainnet".`)
    }

    const networks = networkFilter ? [networkFilter] : ['testnet', 'mainnet']

    const results: Record<string, Awaited<ReturnType<typeof seedNetwork>>> = {}

    for (const network of networks) {
      const pair = PAIRS[network]
      if (!pair) {
        throw new Error(`Unknown network: ${network}. Must be "testnet" or "mainnet".`)
      }
      results[network] = await seedNetwork(prisma, network, pair)
    }

    // Print summary
    console.log('\n🌱 Lens seed complete\n')
    for (const [network, r] of Object.entries(results)) {
      const pair = PAIRS[network]
      console.log(`  ${network}  (${pair.pairKey})`)
      console.log(`    price_points     ${r.pricePoints.inserted} inserted (${r.pricePoints.total} total)`)
      console.log(`    pool_snapshots   ${r.poolSnapshots.inserted} inserted (${r.poolSnapshots.total} total)`)
      console.log(`    price_aggregates ${r.priceAggregates.inserted} inserted (${r.priceAggregates.total} total)`)
      console.log()
    }

    // Verify
    for (const network of networks) {
      const pair = PAIRS[network]
      const ppCount = await prisma.pricePoint.count({
        where: { network, pairKey: pair.pairKey },
      })
      const psCount = await prisma.poolSnapshot.count({
        where: { network, poolId: pair.poolId },
      })
      const paCount = await prisma.priceAggregate.count({
        where: { network, pairKey: pair.pairKey },
      })
      console.log(`  ✅ ${network}: ${ppCount} price_points, ${psCount} pool_snapshots, ${paCount} price_aggregates`)
    }
    console.log()
    return results
  } finally {
    if (!options?.client) {
      await prisma.$disconnect()
    }
  }
}

// ── Run when executed directly ───────────────────────────────────────────────

const isDirectRun = process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2))

  if (args.network && args.network !== 'testnet' && args.network !== 'mainnet') {
    console.error(`Invalid --network value: "${args.network}". Must be "testnet" or "mainnet".`)
    process.exit(1)
  }

  seed({ network: args.network }).catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
}
