import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OvhClient } from "../client/ovh.js";
import { registerBucketTools } from "./buckets.js";
import { registerObjectTools } from "./objects.js";
import { registerPolicyTools } from "./policies.js";
import { registerProjectTools } from "./projects.js";
import { registerRequestTool } from "./request.js";
import { registerUserTools } from "./users.js";

export type ToolContext = {
  /** Register the mutating tools too. Off by default — see OVH_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * Register the OVHcloud tools. Read tools are always registered; the write tools
 * are only registered when `allowWrites` is set, so with the flag off they are
 * not merely refused — they are invisible, and cannot be called at all.
 */
export const registerTools = (server: McpServer, client: OvhClient, ctx: ToolContext): void => {
  const { allowWrites } = ctx;
  registerProjectTools(server, client);
  registerBucketTools(server, client, allowWrites);
  registerObjectTools(server, client, allowWrites);
  registerUserTools(server, client, allowWrites);
  registerPolicyTools(server, client, allowWrites);
  registerRequestTool(server, client, allowWrites);
};
