export const apiCorsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Origin": "*",
}

export function withCors(headers?: HeadersInit) {
  return {
    ...apiCorsHeaders,
    ...headers,
  }
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: withCors(),
  })
}
