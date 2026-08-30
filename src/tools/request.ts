import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { OvhClient } from "#/client/ovh";
import { wrap } from "#/tools/util";

/**
 * Guard the escape hatch against being pointed somewhere it shouldn't go: at
 * another host (which would leak the credentials), or up out of the API root via
 * `..`.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("`path` must be a path, not an absolute URL — the server sets the host.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` must not contain `..` segments.");
  }
};

export const registerRequestTool = (
  server: McpServer,
  client: OvhClient,
  allowWrites: boolean,
): void => {
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "ovh_request",
    {
      title: "OVHcloud: Request",
      description:
        "Escape hatch: call any OVHcloud `/1.0` endpoint directly. Use it when no curated tool " +
        "fits — billing, domains, dedicated servers, Kubernetes, databases, IAM policies, or " +
        "the storage corners this server doesn't wrap (multipart uploads, cold archive, object " +
        "restore, replication jobs). " +
        "`path` is relative to the API root, e.g. `/me`, `/cloud/project`, " +
        "`/cloud/project/{serviceName}/kube`. The full endpoint reference is at " +
        "https://api.ovh.com/console/. " +
        (allowWrites
          ? "Writes are ENABLED, so POST/PUT/DELETE are permitted — there is no confirmation " +
            "step, so check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set OVH_ALLOW_WRITES=1 to allow mutations."),
      inputSchema: {
        method: z.enum(methods).default("GET"),
        path: z
          .string()
          .min(1)
          .describe("API path relative to the `/1.0` root, e.g. `/me/bill` or `/cloud/project`."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
        body: z.unknown().optional().describe("JSON request body, for POST/PUT/DELETE."),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`ovh_request with method ${method}`);
        }
        assertSafePath(path);
        const resolved = path.startsWith("/") ? path : `/${path}`;
        return client.request(method, resolved, {
          query,
          ...(body !== undefined ? { body } : {}),
        });
      }),
  );
};
