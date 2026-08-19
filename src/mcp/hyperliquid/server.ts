#!/usr/bin/env node
/**
 * AgentGlob Hyperliquid MCP server.
 *
 * Exposes Hyperliquid market data, account reads and bounded trading as typed
 * MCP tools backed by the dashboard's /api/runtime/hyperliquid/* endpoints.
 *
 * Holds no credential and never contacts the exchange directly: the Trading
 * Key, the owner-set caps and all signing live in the dashboard. An agent can
 * call those routes itself, so this server is ergonomics rather than a security
 * boundary, and is deliberately not treated as one.
 *
 * Runs as a stdio MCP server spawned by the openclaw gateway, inheriting
 * AGENTGLOB_RUNTIME_URL and AGENTGLOB_RUNTIME_TOKEN from its process env.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HyperliquidRuntimeClient, RuntimeClientError } from "./runtime-client.js";
import { HYPERLIQUID_TOOLS } from "./tools.js";

async function main(): Promise<void> {
  // Validate env up front so a missing-credential failure surfaces at startup
  // rather than as a confusing 401 on the first trade attempt.
  let client: HyperliquidRuntimeClient;
  try {
    client = HyperliquidRuntimeClient.fromEnv();
  } catch (err) {
    const msg = err instanceof RuntimeClientError ? err.message : String(err);
    console.error(`[hyperliquid-mcp] startup error: ${msg}`);
    process.exit(1);
  }

  const server = new Server(
    { name: "agentglob-hyperliquid", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: HYPERLIQUID_TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = HYPERLIQUID_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(client, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      if (err instanceof RuntimeClientError) {
        // Surface the cap code verbatim. A refusal is an answer, not a fault:
        // the model needs to see cap_exceeded and stop, not retry differently.
        const codeTag = err.code ? ` (code=${err.code})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Hyperliquid runtime error ${err.status}${codeTag}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Internal MCP error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[hyperliquid-mcp] fatal:", err);
  process.exit(1);
});
