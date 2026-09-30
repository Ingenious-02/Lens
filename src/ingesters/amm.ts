import { amm_snapshots_total, trades_ingested_total, last_trade_timestamp } from '../metrics'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import { getActivePairs } from '../pairsRegistry'
import { upsertPricePoints, getIndexerCursor, setIndexerCursor, prisma } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'
import { publishPriceUpdate } from '../events'
import type { WatchedPair } from '../types'

// Last seen price per (network, pairKey) — used for threshold crossing detection
const lastPrice = new Map<string, number>()

export function _resetLastPrice(): void {
  lastPrice.clear()
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return lastPrice.get(`${network}:${pairKey}`)
}

export async function fetchPools(pair: WatchedPair, network: NetworkName = activeNetwork): Promise<any[]> {
  try {
    // Use Horizon's reserves filter to find pools for this specific pair
    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)
    params.set('limit', '10')

    const response = await fetch(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools?${params.toString()}`
    )
    const data = await response.json() as any
    if (!data._embedded?.records) return []
    return data._embedded.records
  } catch (err) {
    console.error(`[amm] Failed to fetch pools for ${pair.pairKey}:`, (err as Error).message)
    return []
  }
}

export async function snapshotPool(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  try {
    const r0 = pool.reserves[0]
    const r1 = pool.reserves[1]

    const code0 = r0.asset === 'native' ? 'XLM' : r0.asset.split(':')[0]
    const isForward = code0 === pair.assetA.code

    const reserveA = parseFloat(isForward ? r0.amount : r1.amount)
    const reserveB = parseFloat(isForward ? r1.amount : r0.amount)
    const spotPrice = reserveA > 0 ? reserveB / reserveA : 0
    const feeBp = pool.fee_bp ?? 30

    await prisma.poolSnapshot.create({
      data: {
        network,
        poolId: pool.id,
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        reserveA,
        reserveB,
        spotPrice,
        totalShares: parseFloat(pool.total_shares ?? '0'),
        feeBp,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
      },
    })

    amm_snapshots_total.inc({ pool: pool.id })

    // Also record spot price as a price point (no volume — it's a snapshot, not a trade)
    if (spotPrice > 0) {
      await upsertPricePoints([{
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'AMM',
        poolId: pool.id,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
        eventId: `amm-snapshot-${pool.id}-${Date.now()}`,
      }], network)

      const trackerKey = `${network}:${pair.pairKey}`
      const previousPrice = lastPrice.get(trackerKey) ?? spotPrice
      lastPrice.set(trackerKey, spotPrice)

      publishPriceUpdate({
        pair: pair.pairKey,
        price: spotPrice,
        ts: new Date().toISOString(),
        network,
      })

      dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice: spotPrice,
        network,
      }).catch(err => console.error('[amm] webhook dispatch error:', err.message))
    }
  } catch (err) {
    console.error(`[amm] Snapshot error for pool ${pool.id}:`, (err as Error).message)
  }
}

export async function ingestPoolTrades(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  const stateId = `amm:${network}:${pool.id}`
  const cursor = await getIndexerCursor(stateId, network) ?? '0'

  try {
    const response = await fetch(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools/${pool.id}/trades?cursor=${cursor}&limit=${config.indexer.ammPageSize}&order=asc`
    )
    const data = await response.json() as any
    const records = data._embedded?.records ?? []

    if (!records.length) return

    const points = records.map((t: any) => {
      const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
      const isForward = baseCode === pair.assetA.code
      const price = isForward
        ? parseFloat(t.counter_amount) / parseFloat(t.base_amount)
        : parseFloat(t.base_amount) / parseFloat(t.counter_amount)

      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'AMM' as const,
        poolId: pool.id,
        price,
        baseVolume: parseFloat(t.base_amount),
        counterVolume: parseFloat(t.counter_amount),
        ledger: 0,
        timestamp: new Date(t.ledger_close_time),
        eventId: t.id,
      }
    })

    const trackerKey = `${network}:${pair.pairKey}`
    const previousPrice = lastPrice.get(trackerKey) ?? points[0].price
    const currentPrice = points[points.length - 1].price

    await upsertPricePoints(points, network)
    lastPrice.set(trackerKey, currentPrice)

    // Metrics instrumentation
    trades_ingested_total.inc({ pair: pair.pairKey }, points.length)
    last_trade_timestamp.set({ pair: pair.pairKey }, Math.floor(points[points.length - 1].timestamp.getTime() / 1000))

    const lastCursor = records[records.length - 1].paging_token
    await setIndexerCursor(stateId, lastCursor, network)
    console.log(`[amm] Pool ${pool.id.slice(0, 8)}: ingested ${points.length} trades`)

    publishPriceUpdate({
      pair: pair.pairKey,
      price: currentPrice,
      ts: points[points.length - 1].timestamp.toISOString(),
      network,
    })

    dispatchPriceUpdate({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      previousPrice,
      currentPrice,
      network,
    }).catch(err => console.error('[amm] webhook dispatch error:', err.message))
  } catch (err) {
    console.error(`[amm] Trade ingest error for pool ${pool.id}:`, (err as Error).message)
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startAMMIngester(network: NetworkName = activeNetwork): Promise<void> {
  console.log(`[amm] Starting AMM ingester for ${getActivePairs().length} pairs on ${network}`)

  while (true) {
    for (const pair of getActivePairs()) {
      const pools = await fetchPools(pair, network)
      console.log(`[amm] ${pair.pairKey}: found ${pools.length} AMM pools`)

      await Promise.all(pools.map(async pool => {
        await snapshotPool(pool, pair, network)
        await ingestPoolTrades(pool, pair, network)
      }))
    }
    await sleep(config.indexer.pollIntervalMs)
  }
}
