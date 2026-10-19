import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";
import { log } from "@boomerang-io/task-core";
import { TaskError } from "./params.js";
import { KIND } from "./telemetry.js";

/**
 * The agent command's tools over MCP (streamable HTTP). Each server in `mcpServers` is connected
 * once, its tools are listed, and the model sees them in chat-completions function form. A
 * credential never travels in `mcpServers` itself: it comes from the password-typed `mcpTokens`
 * map, keyed by server name, as a bearer token.
 */

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const CLIENT_INFO = { name: "boomerang-task-ai", version: VERSION };

/** The MCP span attributes every call to one server carries. */
function serverAttributes(server) {
  return {
    "flow.mcp.server.name": server.name,
    "server.address": server.url.hostname,
    "server.port": Number(server.url.port || (server.url.protocol === "https:" ? 443 : 80)),
    "network.transport": "tcp",
  };
}

/** Runs fn under an MCP span named after the method; a failure marks the span and rethrows. */
async function mcpSpan(parent, method, target, server, fn, attributes = {}) {
  const span = parent.child(target ? `${method} ${target}` : method, {
    kind: KIND.CLIENT,
    attributes: { "mcp.method.name": method, ...serverAttributes(server), ...attributes },
  });
  try {
    return await fn(span);
  } catch (e) {
    span.fail(e?.name ?? "_OTHER", e?.message);
    throw e;
  } finally {
    span.end();
  }
}

// How much of a tool result to send back when it is not text: the model is told what it missed.
const NON_TEXT_NOTE = "[non-text content omitted]";

/** The entries of `mcpServers`, checked for shape: {name, url} and nothing else. */
export function validateMcpServers(servers) {
  const names = new Set();
  return servers.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TaskError("INVALID_PARAM", `mcpServers[${i}] must be an object with name and url`);
    }
    const extra = Object.keys(entry).filter((k) => k !== "name" && k !== "url");
    if (extra.length) {
      // A token in here would be stored and shown in clear, since Flow filters by param type.
      throw new TaskError(
        "INVALID_PARAM",
        `mcpServers[${i}] may carry only name and url, not ${extra.join(", ")}; a credential goes in mcpTokens`,
      );
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new TaskError("INVALID_PARAM", `mcpServers[${i}] needs a non-empty name`);
    }
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new TaskError("INVALID_PARAM", `mcpServers[${i}] ('${entry.name}') needs an absolute http(s) url`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TaskError("INVALID_PARAM", `mcpServers[${i}] ('${entry.name}') needs an http(s) url, got ${url.protocol}`);
    }
    if (names.has(entry.name)) {
      throw new TaskError("INVALID_PARAM", `mcpServers names a server '${entry.name}' twice`);
    }
    names.add(entry.name);
    return { name: entry.name, url };
  });
}

/** The `mcpTokens` map, checked for shape: string values keyed by server name. */
export function validateMcpTokens(tokens, servers) {
  const known = new Set(servers.map((s) => s.name));
  for (const [name, token] of Object.entries(tokens)) {
    if (typeof token !== "string") {
      throw new TaskError("INVALID_PARAM", `mcpTokens['${name}'] must be a string`);
    }
    if (!known.has(name)) {
      throw new TaskError("INVALID_PARAM", `mcpTokens names a server '${name}' that is not in mcpServers`);
    }
  }
  return tokens;
}

/**
 * Connects every server and lists its tools. Returns the tool registry: definitions for the model,
 * a `call` that routes by tool name, and a `close` for the end of the run. A tool name served by
 * two servers is refused, since the model names a tool and nothing else.
 */
export async function connectMcpServers(servers, tokens, parent) {
  const clients = [];
  const tools = new Map();

  for (const server of servers) {
    const token = tokens[server.name];
    const transport = new StreamableHTTPClientTransport(server.url, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    const client = new Client(CLIENT_INFO);
    let listed;
    try {
      await mcpSpan(parent, "initialize", undefined, server, (span) =>
        client.connect(transport).then(() => span.set({ "mcp.protocol.version": transport.protocolVersion })),
      );
      listed = await mcpSpan(parent, "tools/list", undefined, server, (span) =>
        client.listTools().then((result) => {
          span.set({ "flow.mcp.tool.count": (result.tools ?? []).length });
          return result;
        }),
      );
    } catch (e) {
      await Promise.allSettled(clients.map((c) => c.client.close()));
      throw new TaskError(
        "REQUEST_FAILED",
        `could not connect to MCP server '${server.name}' at ${server.url}: ${e.message}`,
      );
    }
    clients.push({ server, client });
    for (const tool of listed.tools ?? []) {
      if (tools.has(tool.name)) {
        await Promise.allSettled(clients.map((c) => c.client.close()));
        throw new TaskError(
          "INVALID_PARAM",
          `tool '${tool.name}' is served by both '${tools.get(tool.name).server.name}' and '${server.name}'`,
        );
      }
      tools.set(tool.name, { server, client, tool });
    }
    log.sys(`MCP server '${server.name}': ${(listed.tools ?? []).length} tool(s)`);
  }

  return {
    /** The tools by name: { server, client, tool }. */
    tools,
    /** Chat-completions function definitions for the given tool names. */
    definitions(names) {
      return names.map((name) => {
        const { tool } = tools.get(name);
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        };
      });
    },
    /** Calls a tool under a tools/call span; returns { server, text, isError } for the tool message. */
    async call(name, args, parent) {
      const entry = tools.get(name);
      return mcpSpan(
        parent,
        "tools/call",
        name,
        entry.server,
        async (span) => {
          const result = await entry.client.callTool({ name, arguments: args });
          const text = (result.content ?? [])
            .map((part) => (part.type === "text" ? part.text : NON_TEXT_NOTE))
            .join("\n");
          if (result.isError === true) {
            span.fail("tool_error", "the tool reported an error");
          }
          return { server: entry.server.name, text, isError: result.isError === true };
        },
        { "gen_ai.tool.name": name },
      );
    },
    async close() {
      await Promise.allSettled(clients.map((c) => c.client.close()));
    },
  };
}
