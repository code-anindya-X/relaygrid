import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OPERATOR_SESSION_TTL_SECONDS = 8 * 60 * 60;

export type OperatorSession = {
  operator: string;
  role: "operator" | "incident_commander" | "admin";
  issuedAt: number;
  expiresAt: number;
};

type SessionConfiguration = {
  accessCode: string;
  secret: string;
  operator: string;
  role: OperatorSession["role"];
};

const allowedRoles = new Set<OperatorSession["role"]>(["operator", "incident_commander", "admin"]);
const localDemoAccessCode = "relaygrid-demo";
const localDemoSessionSecret = "relaygrid-local-demo-session-secret-change-before-production-2026";

export function operatorSessionCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Host-relaygrid_operator_session"
    : "relaygrid_operator_session";
}

export function getSessionConfiguration(): SessionConfiguration | null {
  const accessCode = process.env.CONSOLE_OPERATOR_ACCESS_CODE?.trim() ?? "";
  const secret = process.env.CONSOLE_SESSION_SECRET?.trim() ?? "";
  const operator = process.env.CONSOLE_OPERATOR_NAME?.trim() ?? "Alex Sharma";
  const configuredRole = process.env.CONSOLE_OPERATOR_ROLE?.trim().toLowerCase() ?? "operator";
  const role = allowedRoles.has(configuredRole as OperatorSession["role"])
    ? configuredRole as OperatorSession["role"]
    : null;

  if (!accessCode || !secret || !operator || !role) return null;
  if (process.env.NODE_ENV === "production" && (
    accessCode.length < 12 ||
    secret.length < 32 ||
    accessCode === localDemoAccessCode ||
    secret === localDemoSessionSecret
  )) return null;
  return { accessCode, secret, operator, role };
}

function digest(value: string) {
  return createHmac("sha256", "relaygrid-console-code-comparison-v1").update(value).digest();
}

export function accessCodeMatches(candidate: string, expected: string) {
  return timingSafeEqual(digest(candidate), digest(expected));
}

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createOperatorSession(configuration: SessionConfiguration) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    operator: configuration.operator,
    role: configuration.role,
    iat: issuedAt,
    exp: issuedAt + OPERATOR_SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, configuration.secret)}`;
}

function cookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function readOperatorSession(request: Request): OperatorSession | null {
  const configuration = getSessionConfiguration();
  if (!configuration) return null;
  const token = cookieValue(request, operatorSessionCookieName());
  if (!token) return null;
  const [encodedPayload, suppliedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra.length) return null;

  const expectedSignature = signature(encodedPayload, configuration.secret);
  const suppliedBuffer = Buffer.from(suppliedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (payload.v !== 1 || typeof payload.operator !== "string" || payload.operator !== configuration.operator) return null;
    if (typeof payload.role !== "string" || payload.role !== configuration.role || !allowedRoles.has(payload.role as OperatorSession["role"])) return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.iat > now + 60 || payload.exp <= now) return null;
    if (payload.exp - payload.iat !== OPERATOR_SESSION_TTL_SECONDS) return null;
    return {
      operator: payload.operator,
      role: payload.role as OperatorSession["role"],
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

export function requestHasTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return false;
  try {
    const suppliedOrigin = new URL(origin).origin;
    const configuredOrigin = process.env.CONSOLE_ORIGIN?.trim();
    return suppliedOrigin === new URL(request.url).origin || (
      Boolean(configuredOrigin) && suppliedOrigin === new URL(configuredOrigin!).origin
    );
  } catch {
    return false;
  }
}
