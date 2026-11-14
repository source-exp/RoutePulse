import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const uiDir = dirname(fileURLToPath(import.meta.url))
const env = {
  ...process.env,
  API_PORT: process.env.API_PORT || "4174",
  VITE_PORT: process.env.VITE_PORT || "5173",
  VITE_HOST: process.env.VITE_HOST || "127.0.0.1",
}
const viteCli = resolve(uiDir, "node_modules/vite/bin/vite.js")
const children = [
  spawn(process.execPath, [resolve(uiDir, "server.mjs")], {
    cwd: uiDir,
    env,
    stdio: "inherit",
  }),
  spawn(process.execPath, [viteCli], {
    cwd: uiDir,
    env,
    stdio: "inherit",
  }),
]

let stopping = false
function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
  process.exitCode = exitCode
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(`Unable to start UI development service: ${error.message}`)
    stop(1)
  })
  child.once("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0))
  })
}

process.once("SIGINT", () => stop(0))
process.once("SIGTERM", () => stop(0))
