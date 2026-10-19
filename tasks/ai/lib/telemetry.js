import fs from "fs";
import { log } from "@boomerang-io/task-core";

/**
 * Optional OpenTelemetry spans for model calls, tool calls and MCP calls.
 *
 * Off unless the executor configures an OTLP endpoint (OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT). Off, nothing from @opentelemetry is imported at all and every
 * span below is a no-op. On, the SDK is imported dynamically, spans become children of the run's
 * TRACEPARENT when Flow provides one, and they are exported over OTLP/HTTP (protobuf or JSON).
 *
 * Telemetry never changes what the task does: an export failure is one warning line, the flush
 * before exit is bounded, and results and the exit code are the same with or without it.
 *
 * Spans follow the OpenTelemetry GenAI semantic conventions (chat, invoke_agent, execute_tool) and
 * the MCP ones (initialize, tools/list, tools/call). Prompt and completion content are added only
 * with OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true, and even then image data and URL
 * query strings are left out.
 */

const FLUSH_TIMEOUT_MS = 5000;
const TRACER_NAME = "boomerang-task-ai";
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const KIND = { CLIENT: "client", INTERNAL: "internal" };

class NoopSpan {
  child() {
    return this;
  }
  set() {
    return this;
  }
  fail() {
    return this;
  }
  end() {}
}
const NOOP_SPAN = new NoopSpan();

let state = {
  enabled: false,
  captureContent: false,
  root: () => NOOP_SPAN,
  shutdown: async () => {},
};

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  log.warn(`OpenTelemetry: ${message}; spans may be dropped, the task is unaffected`);
}

/** Whether spans are being exported. */
export function telemetryEnabled() {
  return state.enabled;
}

/** Whether prompt and completion content may go on spans. */
export function captureContent() {
  return state.enabled && state.captureContent;
}

/** A span at the top of this task's work: a child of TRACEPARENT when there is one. */
export function rootSpan(name, options = {}) {
  return state.root(name, options);
}

/** Flushes and stops the exporter, within FLUSH_TIMEOUT_MS. Never throws. */
export async function shutdownTelemetry() {
  try {
    await state.shutdown();
  } catch (e) {
    warnOnce(`shutdown failed: ${e.message}`);
  }
}

function configured(env) {
  if (String(env.OTEL_SDK_DISABLED ?? "").toLowerCase() === "true") return false;
  if (String(env.OTEL_TRACES_EXPORTER ?? "").toLowerCase() === "none") return false;
  return Boolean((env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "").trim() || (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim());
}

/**
 * Starts exporting when the environment asks for it. Called once, before the command runs. A
 * failure to start leaves telemetry off with one warning; it never fails the task.
 */
export async function startTelemetry(env = process.env) {
  if (!configured(env)) return;

  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf").trim();
  if (protocol !== "http/protobuf" && protocol !== "http/json") {
    warnOnce(`OTLP protocol '${protocol}' is not supported by this image (http/protobuf or http/json only), so nothing is exported`);
    return;
  }

  try {
    const api = await import("@opentelemetry/api");
    const core = await import("@opentelemetry/core");
    const { BasicTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { detectResources, envDetector, resourceFromAttributes } = await import("@opentelemetry/resources");
    const { OTLPTraceExporter } =
      protocol === "http/json"
        ? await import("@opentelemetry/exporter-trace-otlp-http")
        : await import("@opentelemetry/exporter-trace-otlp-proto");

    // Export errors reach the SDK's global error handler and its diagnostic logger; both become
    // the one warning line. Neither carries the request headers, which hold the backend's auth.
    core.setGlobalErrorHandler((error) => warnOnce(`export failed: ${error?.message ?? error}`));
    api.diag.setLogger(
      {
        error: (message) => warnOnce(String(message)),
        warn: () => {},
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      api.DiagLogLevel.ERROR,
    );

    // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win over the image's own defaults.
    const resource = resourceFromAttributes({ "service.name": "task-ai", "service.version": VERSION }).merge(
      detectResources({ detectors: [envDetector] }),
    );
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    const tracer = provider.getTracer(TRACER_NAME, VERSION);

    let parent = api.ROOT_CONTEXT;
    const traceparent = (env.TRACEPARENT ?? "").trim();
    if (traceparent) {
      parent = new core.W3CTraceContextPropagator().extract(
        api.ROOT_CONTEXT,
        { traceparent, ...(env.TRACESTATE ? { tracestate: env.TRACESTATE } : {}) },
        api.defaultTextMapGetter,
      );
      if (!api.trace.getSpanContext(parent)) {
        log.warn("OpenTelemetry: TRACEPARENT is not a valid W3C traceparent; spans start a new trace");
      }
    }

    const kinds = { client: api.SpanKind.CLIENT, internal: api.SpanKind.INTERNAL };

    class Span {
      constructor(span) {
        this.span = span;
      }
      child(name, options = {}) {
        return start(name, options, api.trace.setSpan(api.ROOT_CONTEXT, this.span));
      }
      set(attributes) {
        this.span.setAttributes(clean(attributes));
        return this;
      }
      fail(type, message) {
        this.span.setAttribute("error.type", type || "_OTHER");
        this.span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(message ?? "").slice(0, 512) });
        return this;
      }
      end() {
        this.span.end();
      }
    }

    function start(name, options, context) {
      return new Span(
        tracer.startSpan(name, { kind: kinds[options.kind] ?? api.SpanKind.INTERNAL, attributes: clean(options.attributes ?? {}) }, context),
      );
    }

    state = {
      enabled: true,
      captureContent: String(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "").toLowerCase() === "true",
      root: (name, options) => start(name, options, parent),
      shutdown: async () => {
        let timer;
        const timedOut = new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), FLUSH_TIMEOUT_MS);
          timer.unref();
        });
        const outcome = await Promise.race([
          provider
            .forceFlush()
            .then(() => provider.shutdown())
            .then(() => "done"),
          timedOut,
        ]);
        clearTimeout(timer);
        if (outcome === "timeout") {
          warnOnce(`the flush did not finish within ${FLUSH_TIMEOUT_MS / 1000} s`);
        }
      },
    };
    log.sys(`OpenTelemetry: exporting spans over ${protocol}${traceparent ? " under TRACEPARENT" : ""}`);
  } catch (e) {
    warnOnce(`could not start: ${e.message}`);
  }
}

/** Attribute values OTel accepts: primitives and arrays of them; undefined, null and "" are dropped. */
function clean(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "object" ? JSON.stringify(v) : v));
    } else if (typeof value === "object") {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A URL without its query string or fragment, where a presigned URL keeps its signature. */
export function urlWithoutQuery(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}

/**
 * Messages as they may go on a span: image data replaced and URL query strings dropped, so content
 * capture never ships a base64 image or a presigned URL's signature.
 */
export function redactMessages(messages) {
  return JSON.parse(JSON.stringify(messages), (key, value) => {
    if (key === "url" && typeof value === "string") {
      if (value.startsWith("data:")) return "[image data omitted]";
      if (/^https?:/i.test(value)) return urlWithoutQuery(value);
    }
    return value;
  });
}
