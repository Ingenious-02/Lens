import type { FastifyInstance } from 'fastify'
import { getActivePairs, parseAssetStr, makePairKey, registerPair, persistPair, hasPair } from '../pairsRegistry'
import { pgPool } from '../db'

export async function registerPairsRoutes(app: FastifyInstance) {
  // GET /pairs — list all active pairs with latest price metadata
  app.get('/pairs', async () => {
    const activePairs = getActivePairs()
    
    // Fetch latest price for all pairs in one go
    const result = await pgPool.query(`
      SELECT DISTINCT ON (pair_key) pair_key, price, timestamp
      FROM price_points
      ORDER BY pair_key, timestamp DESC, ledger DESC
    `)
    
    const latestPrices = new Map<string, { price: number; timestamp: Date }>()
    result.rows.forEach(row => {
      latestPrices.set(row.pair_key, {
        price: parseFloat(row.price),
        timestamp: row.timestamp,
      })
    })

    return {
      pairs: activePairs.map(p => {
        const latest = latestPrices.get(p.pairKey)
        return {
          pairKey: p.pairKey,
          assetA: p.assetA,
          assetB: p.assetB,
          latestPrice: latest?.price ?? null,
          lastUpdated: latest?.timestamp ?? null,
        }
      })
    }
  })

  // POST /pairs — add a new trading pair at runtime
  app.post<{
    Body: { assetA?: string; assetB?: string }
  }>('/pairs', async (req, reply) => {
    // Auth check — read at request time so env can be set after module load
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY
    const key = req.headers['x-admin-key'] ?? req.headers['authorization']?.replace(/^Bearer /, '')
    if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
      return reply.status(401).send({ error: 'Unauthorized — provide a valid X-Admin-Key header' })
    }

    const { assetA: assetAStr, assetB: assetBStr } = req.body ?? {}

    if (!assetAStr || !assetBStr) {
      return reply.status(400).send({ error: 'assetA and assetB are required' })
    }

    const assetA = parseAssetStr(assetAStr)
    if (!assetA) {
      return reply.status(400).send({
        error: `Invalid assetA format "${assetAStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const assetB = parseAssetStr(assetBStr)
    if (!assetB) {
      return reply.status(400).send({
        error: `Invalid assetB format "${assetBStr}". Expected CODE or CODE:ISSUER (e.g. XLM:native or USDC:GBBD47...)`,
      })
    }

    const pairKey = makePairKey(assetA, assetB)

    if (hasPair(pairKey)) {
      return reply.status(409).send({ error: `Pair ${pairKey} is already being watched` })
    }

    const pair = { assetA, assetB, pairKey }
    registerPair(pair)
    await persistPair(pair)

    console.log(`[pairs] Added runtime pair: ${pairKey}`)
    return reply.status(201).send({ pairKey, assetA, assetB })
  })
}
