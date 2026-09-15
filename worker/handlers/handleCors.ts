const ALLOWED_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"] as const
export const ALLOW_HEADER = ALLOWED_METHODS.join(", ")

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW_HEADER,
  "Access-Control-Max-Age": "86400",
}

export function handleOptions(request: Request) {
  const headers = request.headers
  if (headers.get("Origin") !== null && headers.get("Access-Control-Request-Method") !== null) {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Headers": "*",
      },
    })
  } else {
    return new Response(null, {
      headers: {
        Allow: ALLOW_HEADER,
      },
    })
  }
}

export function corsWrapResponse(response: Response) {
  if (response.headers !== undefined) response.headers.set("Access-Control-Allow-Origin", "*")
  return response
}
