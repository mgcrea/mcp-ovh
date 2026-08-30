import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isConfigured, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Registered unconditionally, before any credential check, so an unconfigured
 * server answers "here is what to set" instead of closing the connection with
 * its own explanation swallowed.
 */
export const registerStatusTool = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "ovh_auth_status",
    {
      title: "OVHcloud: Auth Status",
      description:
        "Report whether this server has working OVHcloud credentials, which auth method and " +
        "endpoint it uses, the default project and region, whether writes are enabled, and — " +
        "when something is missing — exactly what to set. Call this first when a tool you " +
        "expected is not listed: an absent tool here means missing configuration, not a bug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        configured: isConfigured(ctx.config),
        endpoint: ctx.config.endpoint,
        authMethod: ctx.config.authMethod ?? null,
        project: ctx.config.cloudProject ?? null,
        region: ctx.config.region ?? null,
        writes: ctx.allowWrites ? "enabled" : "disabled",
        setup: setupInstructions(ctx.config),
      })),
  );
};
