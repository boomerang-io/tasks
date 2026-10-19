import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * In-process stand-ins for what a task-ai run talks to: an OpenAI-compatible endpoint and MCP
 * servers. Both answer from a fixture's script and record what they were sent, so a case asserts
 * on the request bodies as well as the results.
 */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/**
 * The provider: POST anything, get the next scripted {status, body}; the last entry repeats once
 * the script is exhausted, which is how a persistent 5xx is modelled.
 */
export async function startProvider(responses) {
  const requests = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      body,
    });
    const response = responses[Math.min(n, responses.length - 1)];
    n += 1;
    const payload = JSON.stringify(response.body);
    res.writeHead(response.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  const port = await listen(server);
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * One MCP server over streamable HTTP, stateless (a fresh protocol server per request), serving
 * the fixture's tools. Each tool answers with its scripted `result`: a string, {text, isError}, or
 * "echo" to return the arguments it was called with as JSON.
 */
export async function startMcpServer(name, spec) {
  const calls = [];
  const tools = (spec.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }));

  function toolResult(tool, args) {
    const scripted = (spec.tools ?? []).find((t) => t.name === tool)?.result ?? "";
    if (scripted === "echo") {
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    }
    if (typeof scripted === "string") {
      return { content: [{ type: "text", text: scripted }] };
    }
    return {
      content: scripted.image ? [{ type: "image", data: "AA==", mimeType: "image/png" }] : [{ type: "text", text: scripted.text ?? "" }],
      isError: scripted.isError === true,
    };
  }

  const httpServer = http.createServer(async (req, res) => {
    if (spec.token && req.headers.authorization !== `Bearer ${spec.token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const server = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name: tool, arguments: args } = request.params;
      calls.push({ server: name, tool, arguments: args ?? {} });
      return toolResult(tool, args ?? {});
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  const port = await listen(httpServer);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

/** OTLP span kinds by their protobuf enum number, as the JSON encoding carries them. */
const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];

function attributeValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(attributeValue);
  return value;
}

function attributeMap(attributes) {
  return Object.fromEntries((attributes ?? []).map((a) => [a.key, attributeValue(a.value)]));
}

/**
 * An OTLP/HTTP trace receiver. JSON exports are decoded into flat spans - {name, traceId, spanId,
 * parentSpanId, kind, status, attributes, resource} - so a case can assert on them; protobuf
 * exports are kept raw, with their content type, for byte-level checks.
 */
export async function startOtlpReceiver() {
  const requests = [];
  const spans = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    requests.push({ path: req.url, contentType, authorization: req.headers.authorization ?? null, body });
    if (contentType.includes("json")) {
      const payload = JSON.parse(body.toString("utf8"));
      for (const rs of payload.resourceSpans ?? []) {
        const resource = attributeMap(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            spans.push({
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? "",
              kind: SPAN_KINDS[span.kind] ?? String(span.kind),
              status: span.status?.code === 2 ? "error" : span.status?.code === 1 ? "ok" : "unset",
              statusMessage: span.status?.message ?? "",
              startTime: BigInt(span.startTimeUnixNano ?? 0),
              attributes: attributeMap(span.attributes),
              resource,
            });
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(200, { "Content-Type": "application/x-protobuf" });
      res.end();
    }
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    spans,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port nothing listens on, for a dead endpoint. */
export async function deadEndpoint() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
