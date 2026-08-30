import { OvhApiError } from "#/client/errors";
import { clockDelta, signRequest } from "#/client/signature";
import type { AuthMethod, Config } from "#/config";
import { oauth2TokenUrl } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type SignableRequest = {
  method: string;
  /** Absolute URL, query string included — OVH signs the whole thing. */
  url: string;
  /** Serialized body, or "" when there is none. */
  body: string;
};

/**
 * Produces the auth headers for one request. Unlike a plain bearer provider this
 * is per-request, because the application-key method signs the method, URL and
 * body of the very call being made.
 */
export type AuthProvider = {
  method: AuthMethod;
  headers(req: SignableRequest): Promise<Record<string, string>>;
  /** Drop any cached token so the next call re-authenticates (called on a 401). */
  invalidate(): void;
};

export type AuthProviderOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override `Date.now()` for tests. */
  now?: () => number;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

export type TokenResponse = { accessToken: string; expiresIn: number };

/**
 * OAuth2 client-credentials against the brand's login host (NOT the API host).
 * Scope `all` is what OVH's own SDKs request; the actual permissions come from
 * the IAM policy attached to the service account.
 */
export const requestOauth2Token = async (
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> => {
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "all",
    }).toString(),
  });

  const text = await res.text();
  const parsed = safeJsonParse(text);

  if (!res.ok) {
    const err = (parsed ?? {}) as { error?: unknown; error_description?: unknown };
    const detail = [err.error, err.error_description].filter(Boolean).join(": ");
    throw new OvhApiError(
      `OVH OAuth2 token request failed: HTTP ${res.status} ${res.statusText}`.trim() +
        (detail ? ` (${detail})` : "") +
        (res.status === 400 || res.status === 401
          ? " — check OVH_CLIENT_ID / OVH_CLIENT_SECRET and that the IAM service account still " +
            "exists in the same OVH account as OVH_ENDPOINT"
          : ""),
      { status: res.status, errors: parsed ?? text },
    );
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof obj.access_token !== "string") {
    throw new OvhApiError("OVH OAuth2 token response missing access_token", {
      status: res.status,
      errors: parsed,
    });
  }
  return {
    accessToken: obj.access_token,
    expiresIn: typeof obj.expires_in === "number" ? obj.expires_in : 3600,
  };
};

/** `GET /auth/time` — OVH's clock as unix seconds, in a plain-text body. */
export const fetchServerTime = async (
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> => {
  const res = await fetchImpl(`${baseUrl}/auth/time`, { method: "GET" });
  const text = await res.text();
  const seconds = Number(text.trim());
  if (!res.ok || !Number.isFinite(seconds)) {
    throw new OvhApiError(`OVH /auth/time failed: HTTP ${res.status} ${res.statusText}`.trim(), {
      status: res.status,
      errors: text,
    });
  }
  return seconds;
};

const oauth2Provider = (opts: AuthProviderOptions): AuthProvider => {
  const { config } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const tokenUrl = oauth2TokenUrl(config.endpoint);
  if (!tokenUrl) {
    throw new Error(
      `OVH_ENDPOINT '${config.endpoint}' has no OAuth2 login host. Use the application-key ` +
        `method (OVH_APPLICATION_KEY / OVH_APPLICATION_SECRET / OVH_CONSUMER_KEY) instead.`,
    );
  }

  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const authenticate = async (): Promise<string> => {
    opts.logger?.debug?.(`[ovh] requesting an OAuth2 token from ${tokenUrl}`);
    const result = await requestOauth2Token(
      tokenUrl,
      config.clientId ?? "",
      config.clientSecret ?? "",
      fetchImpl,
    );
    const lifetimeMs = result.expiresIn * 1000;
    const skewMs = Math.min(config.refreshSkewSeconds * 1000, lifetimeMs / 2);
    cached = { token: result.accessToken, expiresAt: now() + lifetimeMs - skewMs };
    return result.accessToken;
  };

  const getToken = async (): Promise<string> => {
    if (cached && now() < cached.expiresAt) return cached.token;
    if (!inflight) {
      inflight = authenticate().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };

  return {
    method: "oauth2",
    async headers() {
      return { Authorization: `Bearer ${await getToken()}` };
    },
    invalidate() {
      cached = undefined;
    },
  };
};

const signatureProvider = (opts: AuthProviderOptions): AuthProvider => {
  const { config } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  // Fetched ONCE and cached for the process lifetime. Without it, a host whose
  // clock has drifted more than ~30s fails every signed call.
  let deltaSeconds: number | undefined;
  let inflight: Promise<number> | undefined;

  const getDelta = async (): Promise<number> => {
    if (deltaSeconds !== undefined) return deltaSeconds;
    if (!inflight) {
      inflight = fetchServerTime(config.baseUrl, fetchImpl)
        .then((serverTime) => {
          const delta = clockDelta(serverTime, now());
          deltaSeconds = delta;
          if (Math.abs(delta) > 5) {
            opts.logger?.warn?.(
              `[ovh] local clock is ${delta}s off OVH's; correcting signed timestamps`,
            );
          }
          return delta;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };

  return {
    method: "signature",
    async headers(req) {
      const timestamp = Math.floor(now() / 1000) + (await getDelta());
      return {
        "X-Ovh-Application": config.applicationKey ?? "",
        "X-Ovh-Consumer": config.consumerKey ?? "",
        "X-Ovh-Timestamp": String(timestamp),
        "X-Ovh-Signature": signRequest({
          applicationSecret: config.applicationSecret ?? "",
          consumerKey: config.consumerKey ?? "",
          method: req.method,
          url: req.url,
          body: req.body,
          timestamp,
        }),
      };
    },
    invalidate() {
      // Re-probe the clock: a 401 here is far more often drift than a bad key.
      deltaSeconds = undefined;
    },
  };
};

const accessTokenProvider = (config: Config): AuthProvider => ({
  method: "accessToken",
  async headers() {
    return { Authorization: `Bearer ${config.accessToken ?? ""}` };
  },
  invalidate() {},
});

/** Build the provider matching the configured auth method. */
export const createAuthProvider = (opts: AuthProviderOptions): AuthProvider => {
  switch (opts.config.authMethod) {
    case "oauth2":
      return oauth2Provider(opts);
    case "signature":
      return signatureProvider(opts);
    case "accessToken":
      return accessTokenProvider(opts.config);
    default:
      // Unconfigured. The provider is still built so createServer stays total,
      // but no credential-requiring tool is registered, so it is never asked
      // for headers — and if something ever does ask, the message says why.
      return {
        method: "accessToken",
        async headers(): Promise<Record<string, string>> {
          throw new Error(
            "No OVHcloud credentials are configured. Call ovh_auth_status to see what to set.",
          );
        },
        invalidate() {},
      };
  }
};

/** Trivial provider returning fixed headers. Useful in tests. */
export const staticAuthProvider = (
  headers: Record<string, string> = { Authorization: "Bearer test" },
): AuthProvider => ({
  method: "accessToken",
  headers: async () => headers,
  invalidate: () => {},
});
