import { spawn } from "node:child_process"
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { createServer } from "node:http"
import { dirname, extname, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import vercelApi from "./lib/vercel-api.cjs"

const uiDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(uiDir, "..")
const resultsDir = resolve(projectDir, "results")
const distDir = resolve(uiDir, "dist")
const clientModuleUrl = pathToFileURL(resolve(projectDir, "src/spread.ts")).href
const { copyPackagedResult } = vercelApi
const port = parsePort(process.env.API_PORT || process.env.PORT, 4174)
const host = process.env.API_HOST || "127.0.0.1"
const tasks = new Map()

const reportPattern =
  /^\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|End)\s+margin\s+€\s*([\d,]+(?:\.\d+)?)\s+revenue\s+€\s*([\d,]+(?:\.\d+)?)\s+(\d+)\s+orders\s+([\d.]+)%\s+on time\s+([\d.]+)%\s+not delivered\s*$/u
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/gu

function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("API_PORT must be an integer between 0 and 65535")
  }
  return parsed
}

function euros(value) {
  return Number(value.replaceAll(",", ""))
}

function parseReport(text, source, sourceFile) {
  const rows = []
  for (const line of text.replace(ansiPattern, "").split(/\r?\n/u)) {
    const match = reportPattern.exec(line)
    if (!match) continue
    rows.push({
      day: match[1],
      margin: euros(match[2]),
      revenue: euros(match[3]),
      orders: Number(match[4]),
      onTime: Number(match[5]),
      notDelivered: Number(match[6]),
    })
  }
  const ending = [...rows].reverse().find((row) => row.day === "End")
  const dailyRows = rows.filter((row) => row.day !== "End").slice(0, 7)
  const total = ending ?? [...rows].reverse().find((row) => row.day !== "End")
  if (!total) return null
  return {
    result: {
      margin: total.margin,
      revenue: total.revenue,
      orders: total.orders,
      onTime: total.onTime,
      notDelivered: total.notDelivered,
      marginShare: total.revenue ? Math.round((total.margin / total.revenue) * 1000) / 10 : 0,
      days: dailyRows,
      source,
      sourceFile,
    },
    complete: Boolean(ending),
    ranked: /(?:^|\n)\s*Ranked\.\s*(?:\n|$)/u.test(text),
  }
}

async function historicalResult() {
  let names
  try {
    names = await readdir(resultsDir)
  } catch {
    return copyPackagedResult()
  }
  const candidates = []
  for (const name of names.filter((entry) => entry.endsWith(".log"))) {
    const sourceFile = `results/${name}`
    try {
      const parsed = parseReport(await readFile(resolve(resultsDir, name), "utf8"), "saved historical result", sourceFile)
      if (parsed?.complete) candidates.push(parsed)
    } catch {
      // A missing or unreadable log is not a dashboard result.
    }
  }
  candidates.sort((left, right) =>
    Number(right.ranked) - Number(left.ranked) ||
    right.result.margin - left.result.margin ||
    right.result.onTime - left.result.onTime ||
    right.result.orders - left.result.orders,
  )
  return candidates[0]?.result ?? copyPackagedResult()
}

function configured() {
  return Boolean(process.env.SPREAD_URL?.trim() && process.env.SPREAD_KEY?.trim())
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

async function spreadHealth(readActiveSnapshot) {
  if (!configured()) {
    return {
      connected: false,
      message: "Spread credentials are not configured; showing saved historical results.",
      activeWorld: null,
      map: null,
    }
  }
  try {
    const { Client } = await import(clientModuleUrl)
    const client = new Client()
    const [map, worlds] = await Promise.all([client.map(), client.worlds()])
    const active = worlds.find((world) => !world.ended && world.kind === "final")
      ?? worlds.find((world) => !world.ended)
      ?? null
    let activeWorld = active
      ? { worldId: active.worldId, kind: active.kind, level: active.level, ended: active.ended, snapshot: null }
      : null
    if (active && readActiveSnapshot) {
      try {
        const snapshot = await client.world(active.worldId).snapshot()
        activeWorld = {
          ...activeWorld,
          snapshot: {
            now: snapshot.now,
            endsAt: snapshot.endsAt,
            ...scoreFields(snapshot.score),
          },
        }
      } catch {
        // A snapshot is optional; the read-only map/worlds health check already succeeded.
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
      message: "Spread is unavailable; showing saved historical results.",
      activeWorld: null,
      map: null,
    }
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(JSON.stringify(value))
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readJson(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > 4096) throw new HttpError(413, "Request body is too large.")
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpError(400, "Expected a JSON request body.")
  }
}

function safeSeed(value) {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new HttpError(400, "Seed must be a string.")
  const seed = value
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/gu, "-")
    .slice(0, 80)
    .replace(/^[.-]+|[.-]+$/gu, "")
  return seed || undefined
}

function createRedactor(secret, emit) {
  let pending = ""
  const emitSafe = (text) => {
    const safe = secret ? text.replaceAll(secret, "[redacted]") : text
    if (safe) emit(safe)
  }
  return {
    push(text) {
      pending += text
      const hold = secret ? secret.length - 1 : 0
      if (pending.length <= hold) return
      let safeLength = pending.length - hold
      if (secret) {
        const secretStart = pending.indexOf(secret)
        if (secretStart >= 0 && secretStart < safeLength && secretStart + secret.length > safeLength) {
          safeLength = secretStart
        }
      }
      if (safeLength === 0) return
      emitSafe(pending.slice(0, safeLength))
      pending = pending.slice(safeLength)
    },
    finish() {
      emitSafe(pending)
      pending = ""
    },
  }
}

async function startSimulation(seed) {
  const taskId = randomUUID()
  const date = new Date().toISOString().slice(0, 10)
  const sourceFile = `results/ui-sim-${date}-${taskId}.log`
  const logPath = resolve(projectDir, sourceFile)
  await mkdir(resultsDir, { recursive: true })
  const log = await open(logPath, "wx", 0o600)
  const task = {
    taskId,
    status: "running",
    sourceFile,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    logError: false,
  }
  tasks.set(taskId, task)

  let writes = Promise.resolve()
  const writeLog = (text) => {
    if (!text) return
    writes = writes.then(() => log.write(text)).catch(() => {
      task.logError = true
    })
  }
  const attachOutput = (stream, channel) => {
    const decoder = new StringDecoder("utf8")
    const redactor = createRedactor(process.env.SPREAD_KEY || "", (text) => {
      task[channel] += text
      writeLog(text)
    })
    stream.on("data", (chunk) => redactor.push(decoder.write(chunk)))
    stream.on("end", () => {
      redactor.push(decoder.end())
      redactor.finish()
    })
  }

  let child
  try {
    const args = [
      "--no-warnings",
      resolve(projectDir, "src/starter.ts"),
      "--level",
      "8",
      ...(seed ? ["--seed", seed] : []),
    ]
    child = spawn(process.execPath, args, {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    attachOutput(child.stdout, "stdout")
    attachOutput(child.stderr, "stderr")
  } catch {
    task.status = "failed"
    task.stderr = "Unable to start simulation.\n"
    writeLog(task.stderr)
    await writes
    await log.close()
    return task
  }

  child.once("error", (error) => {
    const safeError = createRedactor(process.env.SPREAD_KEY || "", (text) => {
      task.stderr += text
      writeLog(text)
    })
    safeError.push(`Unable to start simulation: ${error.message}\n`)
    safeError.finish()
    task.status = "failed"
  })
  child.once("close", async (code, signal) => {
    task.exitCode = code
    task.signal = signal
    await writes
    await log.close().catch(() => {})
    task.status = code === 0 && !task.logError ? "complete" : "failed"
  })
  return task
}

function taskResult(task) {
  const parsed = parseReport(`${task.stdout}\n${task.stderr}`, "simulation", task.sourceFile)
  return parsed?.result ?? null
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const [result, health] = await Promise.all([historicalResult(), spreadHealth(true)])
    return sendJson(response, 200, {
      status: {
        connected: health.connected,
        mode: health.connected ? "live" : "replay",
        message: health.message,
        activeWorld: health.activeWorld,
      },
      result,
      map: health.map,
    })
  }

  if (url.pathname === "/api/simulate" && request.method === "POST") {
    const body = await readJson(request)
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "seed")) {
      throw new HttpError(400, "Request must contain only a seed.")
    }
    const seed = safeSeed(body.seed)
    const health = await spreadHealth(false)
    if (!health.connected) {
      return sendJson(response, 200, {
        mode: "replay",
        status: "complete",
        message: health.message,
        result: await historicalResult(),
      })
    }
    const task = await startSimulation(seed)
    return sendJson(response, 202, {
      mode: "live",
      taskId: task.taskId,
      status: task.status,
    })
  }

  const taskMatch = /^\/api\/simulate\/([a-f0-9-]+)$/iu.exec(url.pathname)
  if (taskMatch && request.method === "GET") {
    const task = tasks.get(taskMatch[1])
    if (!task) return sendJson(response, 404, { error: "Simulation task not found." })
    return sendJson(response, 200, {
      taskId: task.taskId,
      status: task.status,
      result: taskResult(task),
      sourceFile: task.sourceFile,
      ...(task.status === "failed" ? { message: "Simulation failed." } : {}),
    })
  }

  if (url.pathname.startsWith("/api/")) {
    return sendJson(response, 404, { error: "API route not found." })
  }
  return false
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
])

async function serveUi(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" })
    return response.end()
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    response.writeHead(400)
    return response.end()
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "")
  let filePath = resolve(distDir, relative)
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) {
    response.writeHead(403)
    return response.end()
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error("not a file")
  } catch {
    filePath = resolve(distDir, "index.html")
    try {
      await stat(filePath)
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      return response.end("Build the UI with npm run build first.\n")
    }
  }
  const content = await readFile(filePath)
  response.writeHead(200, {
    "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
    "content-length": content.length,
    "x-content-type-options": "nosniff",
  })
  response.end(request.method === "HEAD" ? undefined : content)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1")
    const apiResult = await handleApi(request, response, url)
    if (apiResult !== false) return
    await serveUi(request, response, url)
  } catch (error) {
    if (response.headersSent) return response.destroy()
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof HttpError ? error.message : "Internal server error."
    sendJson(response, status, { error: message })
  }
})

server.listen(port, host, () => {
  const address = server.address()
  const boundPort = typeof address === "object" && address ? address.port : port
  console.log(`RoutePulse UI/API listening on http://${host}:${boundPort}`)
})
