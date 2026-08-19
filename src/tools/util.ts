import { z } from "zod";

import { OvhApiError, WritesDisabledError } from "../client/errors.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
    },
  ],
  isError: true,
});

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof OvhApiError) {
      return fail(err.message, {
        status: err.status,
        ...(err.queryId ? { queryId: err.queryId } : {}),
        ...(err.errorClass ? { class: err.errorClass } : {}),
        errors: err.errors,
      });
    }
    if (err instanceof Error) {
      return fail(err.message);
    }
    return fail("Unknown error", err);
  }
};

export { WritesDisabledError };

/** Every project-scoped tool can override OVH_CLOUD_PROJECT per call. */
export const projectArg = z
  .string()
  .optional()
  .describe(
    "Public cloud project id — the 32-char hex `serviceName`, NOT the project's display name. " +
      "Defaults to OVH_CLOUD_PROJECT. `ovh_list_projects` lists them.",
  );

/** Every storage tool can override OVH_REGION per call. */
export const regionArg = z
  .string()
  .optional()
  .describe(
    "Storage region, upper-case, e.g. `GRA`, `SBG`, `DE`, `UK`. Defaults to OVH_REGION. " +
      "A bucket only exists in one region — the wrong region returns 404, not an empty list.",
  );

export const bucketArg = z.string().min(1).describe("Bucket (container) name.");

export const objectKeyArg = z
  .string()
  .min(1)
  .describe("Object key, e.g. `uploads/2026/scan-01.usdz`. Slashes are part of the key.");

export const userIdArg = z
  .number()
  .int()
  .describe("Project user id — the numeric `id` from `ovh_list_project_users`, not the username.");

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(100)
  .describe("Maximum number of items to return (1-1000). Defaults to 100.");

/** Destructive tools require this, so an agent can never delete something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this destructively changes OVHcloud.");

/** Drop undefined values so we never send `{"tags": undefined}` to OVH. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `{}` is not a no-op body for OVH's PUT endpoints — send undefined instead. */
export const compactOrUndefined = <T extends Record<string, unknown>>(
  obj: T,
): Partial<T> | undefined => {
  const out = compact(obj);
  return Object.keys(out).length > 0 ? out : undefined;
};
