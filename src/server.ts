import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { createAuthProvider, type AuthProvider, type Logger } from "./client/auth.js";
import { OvhClient } from "./client/ovh.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-ovh-api-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the auth provider (tests). */
  auth?: AuthProvider;
};

export type CreatedServer = {
  server: McpServer;
  client: OvhClient;
  auth: AuthProvider;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const auth =
    opts.auth ??
    createAuthProvider({
      config,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const client = new OvhClient({
    baseUrl: config.baseUrl,
    auth,
    defaultProject: config.cloudProject,
    defaultRegion: config.region,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, { config, allowWrites: config.allowWrites });
  return { server, client, auth };
};
