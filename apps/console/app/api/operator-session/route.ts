import {
  OPERATOR_SESSION_TTL_SECONDS,
  accessCodeMatches,
  createOperatorSession,
  getSessionConfiguration,
  operatorSessionCookieName,
  readOperatorSession,
  requestHasTrustedOrigin,
} from "@/lib/operator-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store" };

function publicSession(request: Request) {
  const session = readOperatorSession(request);
  return session
    ? {
        authenticated: true as const,
        configured: true,
        operator: session.operator,
        role: session.role,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      }
    : {
        authenticated: false as const,
        configured: Boolean(getSessionConfiguration()),
      };
}

export async function GET(request: Request) {
  return Response.json(publicSession(request), { headers: noStoreHeaders });
}

export async function POST(request: Request) {
  if (!requestHasTrustedOrigin(request)) {
    return Response.json({ error: "Untrusted request origin" }, { status: 403, headers: noStoreHeaders });
  }
  const configuration = getSessionConfiguration();
  if (!configuration) {
    return Response.json({ error: "Operator access is not configured" }, { status: 503, headers: noStoreHeaders });
  }

  let accessCode = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.accessCode === "string" && body.accessCode.length <= 256) accessCode = body.accessCode;
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400, headers: noStoreHeaders });
  }
  if (!accessCode || !accessCodeMatches(accessCode, configuration.accessCode)) {
    return Response.json({ error: "Invalid operator access code" }, { status: 401, headers: noStoreHeaders });
  }

  const response = Response.json({
    authenticated: true,
    configured: true,
    operator: configuration.operator,
    role: configuration.role,
    expiresAt: new Date((Math.floor(Date.now() / 1000) + OPERATOR_SESSION_TTL_SECONDS) * 1000).toISOString(),
  }, { headers: noStoreHeaders });
  response.headers.append("set-cookie", [
    `${operatorSessionCookieName()}=${createOperatorSession(configuration)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    process.env.NODE_ENV === "production" ? "Secure" : "",
    `Max-Age=${OPERATOR_SESSION_TTL_SECONDS}`,
  ].filter(Boolean).join("; "));
  return response;
}

export async function DELETE(request: Request) {
  if (!requestHasTrustedOrigin(request)) {
    return Response.json({ error: "Untrusted request origin" }, { status: 403, headers: noStoreHeaders });
  }
  const response = Response.json({ authenticated: false, configured: Boolean(getSessionConfiguration()) }, { headers: noStoreHeaders });
  response.headers.append("set-cookie", [
    `${operatorSessionCookieName()}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    process.env.NODE_ENV === "production" ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; "));
  return response;
}
