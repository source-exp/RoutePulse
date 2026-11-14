const {
  ApiError,
  sendJson,
  simulatePayload,
  validateSimulationRequest,
} = require("../ui/lib/vercel-api.cjs")

module.exports = async function simulate(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed." }, { allow: "POST" })
  }

  try {
    validateSimulationRequest(request)
    return sendJson(response, 200, await simulatePayload())
  } catch (error) {
    if (error instanceof ApiError) {
      return sendJson(response, error.status, { error: error.message })
    }
    return sendJson(response, 500, { error: "Simulation replay is unavailable." })
  }
}
