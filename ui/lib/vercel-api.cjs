const PACKAGED_RESULT = Object.freeze({
  margin: 22396.75,
  revenue: 51871.38,
  orders: 486,
  onTime: 98.8,
  notDelivered: 0,
  marginShare: 43.2,
  days: Object.freeze([
    Object.freeze({ day: "Monday", margin: 495.69, revenue: 1563.2, orders: 110, onTime: 100, notDelivered: 0 }),
    Object.freeze({ day: "Tuesday", margin: 3630.37, revenue: 9840.02, orders: 218, onTime: 97.1, notDelivered: 0 }),
    Object.freeze({ day: "Wednesday", margin: 7916.37, revenue: 20048.69, orders: 325, onTime: 98.6, notDelivered: 0 }),
    Object.freeze({ day: "Thursday", margin: 12598.94, revenue: 30601.59, orders: 419, onTime: 98.1, notDelivered: 0 }),
    Object.freeze({ day: "Friday", margin: 20158.73, revenue: 45455.21, orders: 486, onTime: 98.6, notDelivered: 0 }),
    Object.freeze({ day: "Saturday", margin: 20462.78, revenue: 46386.59, orders: 486, onTime: 98.6, notDelivered: 0 }),
    Object.freeze({ day: "Sunday", margin: 20462.78, revenue: 46386.59, orders: 486, onTime: 98.6, notDelivered: 0 }),
  ]),
  source: "packaged historical snapshot · Season 7 run 5",
  sourceFile: null,
})

const SPREAD_URL_REQUIRED_MESSAGE =
  "Spread credentials are not configured; showing saved historical results."
const SPREAD_UNAVAILABLE_MESSAGE =
  "Spread is unavailable; showing saved historical results."

function copyPackagedResult() {
  return {
    ...PACKAGED_RESULT,
    days: PACKAGED_RESULT.days.map((day) => ({ ...day })),
  }
}

function configuredSpread(env) {
  const url = env.SPREAD_URL?.trim()
  const key = env.SPREAD_KEY?.trim()
  if (!url || !key) return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
    return { url: url.replace(/\/+$/u, ""), key }
  } catch {
    return null
  }
}

async function spreadGet(url, key, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error("Spread request failed")
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function scoreFields(score) {
  return {
    margin: score.marginCents / 100,
    revenue: score.revenueCents / 100,
    orders: score.wonOrders,
    onTime: score.onTimeShare * 100,
    notDelivered: score.undeliveredShare * 100,
    marginShare: score.marginShare * 100,
  }
}

async function readSpreadHealth(readActiveSnapshot = false, env = process.env) {
  const spread = configuredSpread(env)
  if (!spread) {
    return {
      connected: false,
      message: SPREAD_URL_REQUIRED_MESSAGE,
      activeWorld: null,
      map: null,
    }
  }

  try {
    const [map, worlds] = await Promise.all([
      spreadGet(`${spread.url}/v1/map`, spread.key),
      spreadGet(`${spread.url}/v1/worlds`, spread.key),
    ])
    if (!map || typeof map !== "object" || Array.isArray(map) || !Array.isArray(worlds)) {
      throw new Error("Invalid Spread response")
    }

    const active = worlds.find((world) => !world.ended && world.kind === "final")
      ?? worlds.find((world) => !world.ended)
      ?? null
    let activeWorld = active
      ? { worldId: active.worldId, kind: active.kind, level: active.level, ended: active.ended, snapshot: null }
      : null
    if (active && readActiveSnapshot) {
      try {
        const snapshot = await spreadGet(
          `${spread.url}/v1/worlds/${encodeURIComponent(active.worldId)}`,
          spread.key,
          2500,
        )
        if (snapshot?.score && typeof snapshot.score === "object") {
          activeWorld = {
            ...activeWorld,
            snapshot: {
              now: snapshot.now,
              endsAt: snapshot.endsAt,
              ...scoreFields(snapshot.score),
            },
          }
        }
      } catch {
        // The map and worlds reads already established a healthy connection.
      }
    }
    return {
      connected: true,
      message: "Connected to Spread; dashboard results are saved historical data.",
      activeWorld,
      map,
    }
  } catch {
    return {
      connected: false,
      message: SPREAD_UNAVAILABLE_MESSAGE,
      activeWorld: null,
      map: null,
    }
  }
}

async function dashboardPayload() {
  const [health, result] = await Promise.all([
    readSpreadHealth(true),
    Promise.resolve(copyPackagedResult()),
  ])
  return {
    status: {
      connected: health.connected,
      mode: health.connected ? "live" : "replay",
      message: health.message,
      activeWorld: health.activeWorld,
    },
    result,
    map: health.map,
  }
}

async function simulatePayload() {
  const message =
    "Vercel uses the bundled historical replay; live practice simulation remains local."
  return {
    mode: "replay",
    message,
    status: {
      mode: "replay",
      message,
    },
    result: copyPackagedResult(),
  }
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin")
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value)
  response.end(JSON.stringify(payload))
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function validateSimulationRequest(request) {
  let body = request.body
  if (body === undefined || body === null || body === "") return
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    if (Buffer.byteLength(body) > 4096) throw new ApiError(413, "Request body is too large.")
    try {
      body = JSON.parse(body.toString())
    } catch {
      throw new ApiError(400, "Expected a JSON request body.")
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "seed")) {
    throw new ApiError(400, "Request must contain only an optional seed.")
  }
  if (body.seed !== undefined && (typeof body.seed !== "string" || body.seed.length > 80)) {
    throw new ApiError(400, "Seed must be a string of at most 80 characters.")
  }
}

module.exports = {
  ApiError,
  dashboardPayload,
  readSpreadHealth,
  sendJson,
  simulatePayload,
  validateSimulationRequest,
  copyPackagedResult,
}
