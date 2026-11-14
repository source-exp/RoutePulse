const { dashboardPayload, sendJson } = require("../ui/lib/vercel-api.cjs")

module.exports = async function dashboard(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, 405, { error: "Method not allowed." }, { allow: "GET" })
  }
  if (request.url?.includes("?") || Object.keys(request.query ?? {}).length > 0) {
    return sendJson(response, 400, { error: "Query parameters are not supported." })
  }

  try {
    return sendJson(
      response,
      200,
      await dashboardPayload(),
      { "cache-control": "public, max-age=0, s-maxage=15, stale-while-revalidate=45" },
    )
  } catch {
    return sendJson(response, 500, { error: "Dashboard data is unavailable." })
  }
}
