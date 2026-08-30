import type { AuthProvider, Logger } from "#/client/auth";
import { OvhApiError } from "#/client/errors";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
};

export type OvhClientOptions = {
  baseUrl: string;
  auth: AuthProvider;
  /** Default `serviceName` for /cloud/project paths. */
  defaultProject?: string | undefined;
  /** Default storage region, e.g. `GRA`, `UK`. */
  defaultRegion?: string | undefined;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

/**
 * Percent-encode one path segment. Object keys routinely contain `/`, `+` and
 * spaces (`uploads/2026/scan 01.usdz`) and OVH addresses them as a SINGLE path
 * segment, so the slashes must be encoded too — `encodeURIComponent` is right
 * and `encodeURI` is not.
 */
export const encodeSegment = (value: string): string => encodeURIComponent(value);

/**
 * Minimal fetch client for the OVHcloud `/1.0` API.
 *
 * Auth headers are produced per request (the application-key method signs the
 * method, full URL and body). Retries a 401 once with fresh credentials, and
 * 429/5xx with exponential backoff.
 */
export class OvhClient {
  readonly baseUrl: string;
  readonly defaultProject: string | undefined;
  readonly defaultRegion: string | undefined;
  private readonly auth: AuthProvider;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;

  constructor(opts: OvhClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.auth = opts.auth;
    this.defaultProject = opts.defaultProject;
    this.defaultRegion = opts.defaultRegion;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-ovh-api-js";
  }

  get authMethod(): string {
    return this.auth.method;
  }

  /** Resolve the project id for a call, falling back to OVH_CLOUD_PROJECT. */
  project(override?: string): string {
    const value = override ?? this.defaultProject;
    if (!value) {
      throw new Error(
        "No public cloud project. Pass `project` (the 32-char serviceName) or set " +
          "OVH_CLOUD_PROJECT. `ovh_list_projects` shows the ones this account can see.",
      );
    }
    return value;
  }

  /** Resolve the storage region for a call, falling back to OVH_REGION. */
  region(override?: string): string {
    const value = (override ?? this.defaultRegion)?.toUpperCase();
    if (!value) {
      throw new Error(
        "No storage region. Pass `region` (e.g. `GRA`, `SBG`, `UK`) or set OVH_REGION. " +
          "`ovh_list_regions` shows the ones enabled on the project.",
      );
    }
    return value;
  }

  /** Build a `/cloud/project/{serviceName}` path. */
  projectPath(project: string | undefined, suffix = ""): string {
    return `/cloud/project/${encodeSegment(this.project(project))}${suffix}`;
  }

  /** Build a `/cloud/project/{serviceName}/region/{regionName}/storage/...` path. */
  storagePath(
    project: string | undefined,
    region: string | undefined,
    bucket?: string,
    suffix = "",
  ): string {
    const base = `${this.projectPath(project)}/region/${encodeSegment(this.region(region))}/storage`;
    return bucket === undefined ? base : `${base}/${encodeSegment(bucket)}${suffix}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    // Serialize ONCE: the signature covers the exact bytes we send, so building
    // the body twice risks signing something we didn't transmit.
    const bodyText = hasBody ? JSON.stringify(opts.body) : "";
    let attempt = 0;

    for (;;) {
      this.logger?.debug?.(`[ovh] ${method} ${url} (attempt ${attempt + 1})`);
      const authHeaders = await this.auth.headers({ method, url, body: bodyText });
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...authHeaders,
        },
        ...(hasBody ? { body: bodyText } : {}),
      });

      if (res.status === 401 && attempt < this.maxRetries) {
        this.logger?.warn?.(`[ovh] HTTP 401 — refreshing credentials and retrying`);
        this.auth.invalidate();
        attempt += 1;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`[ovh] HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        attempt += 1;
        continue;
      }

      const text = await res.text();

      if (!res.ok) {
        const parsed = safeJsonParse(text);
        const details = (parsed ?? {}) as { message?: unknown; class?: unknown };
        throw new OvhApiError(this.errorMessage(res, method, path, details), {
          status: res.status,
          queryId: res.headers.get("X-Ovh-QueryID") ?? undefined,
          errorClass: typeof details.class === "string" ? details.class : undefined,
          errors: parsed,
        });
      }

      // Most PUT/DELETE endpoints answer 200 with an empty body, not 204.
      if (res.status === 204 || text.trim() === "") return null as T;
      return safeJsonParse(text) as T;
    }
  }

  private errorMessage(
    res: Response,
    method: string,
    path: string,
    details: { message?: unknown },
  ): string {
    const queryId = res.headers.get("X-Ovh-QueryID");
    const base =
      `OVH API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim() +
      (typeof details.message === "string" ? ` — ${details.message}` : "") +
      (queryId ? ` [X-Ovh-QueryID: ${queryId}]` : "");

    if (res.status === 403) {
      return (
        `${base} — the credentials authenticated but are not allowed here. For an OAuth2 ` +
        `service account, check its IAM policy covers this resource; for an application key, ` +
        `check the consumer key's access rules list this path and method (they are fixed at ` +
        `creation time and cannot be widened afterwards — you must create a new token). ` +
        `Call ovh_whoami to see which identity is live.`
      );
    }
    if (res.status === 404) {
      return `${base} — check the project serviceName (32-char hex, not the project name), the region (upper-case, e.g. \`GRA\`), and that the bucket exists in THAT region.`;
    }
    return base;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  put<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  del<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { body, query });
  }
}
