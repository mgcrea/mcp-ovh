import { z } from "zod";

/**
 * OVHcloud API endpoints. Each brand/region pair is a distinct API host with its
 * own application keys — a key created on `ovh-eu` is meaningless on `ovh-ca`.
 */
export const ENDPOINTS = {
  "ovh-eu": {
    api: "https://eu.api.ovh.com/1.0",
    oauth2: "https://www.ovh.com/auth/oauth2/token",
  },
  "ovh-ca": {
    api: "https://ca.api.ovh.com/1.0",
    oauth2: "https://ca.ovh.com/auth/oauth2/token",
  },
  "ovh-us": {
    api: "https://api.us.ovhcloud.com/1.0",
    oauth2: "https://us.ovhcloud.com/auth/oauth2/token",
  },
  "kimsufi-eu": { api: "https://eu.api.kimsufi.com/1.0", oauth2: undefined },
  "kimsufi-ca": { api: "https://ca.api.kimsufi.com/1.0", oauth2: undefined },
  "soyoustart-eu": { api: "https://eu.api.soyoustart.com/1.0", oauth2: undefined },
  "soyoustart-ca": { api: "https://ca.api.soyoustart.com/1.0", oauth2: undefined },
} as const satisfies Record<string, { api: string; oauth2: string | undefined }>;

export const ENDPOINT_NAMES = Object.keys(ENDPOINTS) as [EndpointName, ...EndpointName[]];
export type EndpointName = keyof typeof ENDPOINTS;

export const AUTH_METHODS = ["oauth2", "signature", "accessToken"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

const ConfigSchema = z
  .object({
    endpoint: z.enum(ENDPOINT_NAMES).default("ovh-eu"),
    /** Absolute API base, derived from `endpoint` unless OVH_API_URL overrides it. */
    baseUrl: z.url("OVH_API_URL must be a valid URL, e.g. https://eu.api.ovh.com/1.0"),
    authMethod: z.enum(AUTH_METHODS),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    applicationKey: z.string().min(1).optional(),
    applicationSecret: z.string().min(1).optional(),
    consumerKey: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    /** Default public cloud project (`serviceName`) — a 32-char hex id. */
    cloudProject: z.string().min(1).optional(),
    /** Default storage region, e.g. `GRA`, `SBG`, `UK`. Upper-cased for you. */
    region: z.string().min(1).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    refreshSkewSeconds: z.number().int().nonnegative().max(300).default(60),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.authMethod === "oauth2" && !(cfg.clientId && cfg.clientSecret)) {
      ctx.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "OVH_CLIENT_ID and OVH_CLIENT_SECRET are both required for OAuth2.",
      });
    }
    if (
      cfg.authMethod === "signature" &&
      !(cfg.applicationKey && cfg.applicationSecret && cfg.consumerKey)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["consumerKey"],
        message:
          "OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET and OVH_CONSUMER_KEY are all required " +
          "for the application-key signature method. Create the triplet at " +
          "https://eu.api.ovh.com/createToken/",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Pick the auth method from whichever credentials are present, mirroring go-ovh.
 * An explicit OVH_AUTH_METHOD always wins. OAuth2 is preferred: its tokens are
 * short-lived and its IAM policies are far more granular than a consumer key's
 * hand-listed access rules.
 */
export const inferAuthMethod = (env: NodeJS.ProcessEnv): AuthMethod | undefined => {
  const explicit = env.OVH_AUTH_METHOD?.trim();
  if (explicit) return explicit as AuthMethod;
  if (env.OVH_CLIENT_ID?.trim() && env.OVH_CLIENT_SECRET?.trim()) return "oauth2";
  if (env.OVH_APPLICATION_KEY?.trim() && env.OVH_APPLICATION_SECRET?.trim()) return "signature";
  if (env.OVH_ACCESS_TOKEN?.trim()) return "accessToken";
  return undefined;
};

/** Resolve an endpoint alias to its `/1.0` base URL, tolerating a trailing slash. */
export const resolveBaseUrl = (endpoint: EndpointName, override?: string): string =>
  (override ?? ENDPOINTS[endpoint].api).replace(/\/+$/, "");

/** The OAuth2 token URL for an endpoint. Not every brand has one. */
export const oauth2TokenUrl = (endpoint: EndpointName): string | undefined =>
  ENDPOINTS[endpoint].oauth2;

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const parseBool = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const authMethod = inferAuthMethod(env);
  if (!authMethod) {
    throw new Error(
      "No OVHcloud credentials found. Set one of: OVH_CLIENT_ID + OVH_CLIENT_SECRET (OAuth2, " +
        "recommended), OVH_APPLICATION_KEY + OVH_APPLICATION_SECRET + OVH_CONSUMER_KEY " +
        "(application key), or OVH_ACCESS_TOKEN.",
    );
  }
  const endpoint = (trimmed(env.OVH_ENDPOINT) ?? "ovh-eu") as EndpointName;
  if (!(endpoint in ENDPOINTS)) {
    throw new Error(
      `Unknown OVH_ENDPOINT '${endpoint}'. Expected one of: ${ENDPOINT_NAMES.join(", ")}.`,
    );
  }
  return ConfigSchema.parse({
    endpoint,
    baseUrl: resolveBaseUrl(endpoint, trimmed(env.OVH_API_URL)),
    authMethod,
    clientId: trimmed(env.OVH_CLIENT_ID),
    clientSecret: trimmed(env.OVH_CLIENT_SECRET),
    applicationKey: trimmed(env.OVH_APPLICATION_KEY),
    applicationSecret: trimmed(env.OVH_APPLICATION_SECRET),
    consumerKey: trimmed(env.OVH_CONSUMER_KEY),
    accessToken: trimmed(env.OVH_ACCESS_TOKEN),
    cloudProject: trimmed(env.OVH_CLOUD_PROJECT),
    region: trimmed(env.OVH_REGION)?.toUpperCase(),
    allowWrites: parseBool(env.OVH_ALLOW_WRITES),
    maxRetries: parseIntOpt(env.OVH_MAX_RETRIES),
    refreshSkewSeconds: parseIntOpt(env.OVH_REFRESH_SKEW_SECONDS),
  });
};
