import { Asset } from '@stellar/stellar-sdk'
import { trades_ingested_total, last_trade_timestamp } from '../metrics'
import { config, activeNetwork, type NetworkName } from '../config'
import { getHorizonServer } from '../network/clients'
import { getActivePairs } from '../pairsRegistry'
import { upsertPricePoints, getIndexerCursor, setIndexerCursor } from '../db'
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

function toAsset(asset: { code: string; issuer: string | null }): Asset {
  if (!asset.issuer || asset.code === 'XLM') return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

export async function ingestPair(pair: WatchedPair, network: NetworkName = activeNetwork): Promise<void> {
  const stateId = `sdex:${network}:${pair.pairKey}`
  const cursor = await getIndexerCursor(stateId, network) ?? '0'

  try {
    const assetA = toAsset(pair.assetA)
    const assetB = toAsset(pair.assetB)

    const trades = await getHorizonServer(network)
      .trades()
      .forAssetPair(assetA, assetB)
      .cursor(cursor)
      .limit(config.indexer.sdexPageSize)
      .order('asc')
      .call()

    if (!trades.records.length) return

    const points = trades.records.map((t: any) => {
      const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
      const isForward = baseCode === pair.assetA.code

      const price = isForward
        ? parseFloat(t.price.n) / parseFloat(t.price.d)
        : parseFloat(t.price.d) / parseFloat(t.price.n)

      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'SDEX' as const,
        price,
        baseVolume: parseFloat(t.base_amount),
        counterVolume: parseFloat(t.counter_amount),
        ledger: 0,
        timestamp: new Date(t.ledger_close_time),
        eventId: t.id,
      }
    })

    if (points.length > 0) {
      const trackerKey = `${network}:${pair.pairKey}`
      const previousPrice = lastPrice.get(trackerKey) ?? points[0].price
      const currentPrice = points[points.length - 1].price

      await upsertPricePoints(points, network)
      lastPrice.set(trackerKey, currentPrice)

      // Metrics instrumentation
      trades_ingested_total.inc({ pair: pair.pairKey }, points.length)
      last_trade_timestamp.set({ pair: pair.pairKey }, Math.floor(points[points.length - 1].timestamp.getTime() / 1000))

      const lastCursor = trades.records[trades.records.length - 1].paging_token
      await setIndexerCursor(stateId, lastCursor, network)
      console.log(`[sdex] ${pair.pairKey}: ingested ${points.length} trades`)

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
      }).catch(err => console.error('[sdex] webhook dispatch error:', err.message))
    }
  } catch (err) {
    console.error(`[sdex] Error ingesting ${pair.pairKey}:`, (err as Error).message)
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function startSDEXIngester(network: NetworkName = activeNetwork): Promise<void> {
  console.log(`[sdex] Starting SDEX ingester for ${getActivePairs().length} pairs on ${network}`)

  while (true) {
    await Promise.all(getActivePairs().map(pair => ingestPair(pair, network)))
    await sleep(config.indexer.pollIntervalMs)
  }
}
