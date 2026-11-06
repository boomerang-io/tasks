import { log, params, results } from "@boomerang-io/task-core";
import { HttpsProxyAgent } from "https-proxy-agent";
import http from "http";
import https from "https";
import { checkIfEmpty } from "../libs/utilities.js";
import { run, asBoolean, writeOutputFile, RESULT_BUDGET, TaskError } from "../libs/task.js";

/**
 * HTTP Call: one request, judged by its status code against the success, error and retry codes,
 * with the response as the `response` result or written to `outputFilePath`, and the status as
 * `statusCode`. Serves execute-basic-http-call and execute-advanced-http-call.
 *
 * Codes are comma-separated, each a status or a pattern with x for a digit (5xx, 40x). A response
 * is judged in this order: it fails at once on an error code; it succeeds on any 2xx or a success
 * code; it is retried on a retry code while retries remain; anything else fails. Redirects are
 * not followed, so a 3xx is judged like any other status.
 */

const METHODS = ["GET", "HEAD", "PUT", "POST", "PATCH", "OPTIONS", "DELETE"];
// Failures before any response, retried on their own schedule (systemretrynumber, systemretrydelay).
const NETWORK_ERRORS = ["ECONNREFUSED", "ETIMEOUT", "ETIMEDOUT", "EAI_AGAIN"];
// How much of a failed call's response the log shows.
const ERROR_BODY_LOG = 500;

/** A param, blank (or the literal "" a v3 property file carried) as undefined. */
function value(input) {
  return checkIfEmpty(input) || String(input).trim() === "" ? undefined : String(input).trim();
}

/** A bounded whole number; blank gives the fallback. `lenient` falls back on a bad value instead of failing. */
function bounded(input, name, fallback, min, max, lenient = false) {
  const text = value(input);
  if (text === undefined) {
    return fallback;
  }
  const number = Number(text);
  if (Number.isInteger(number) && number >= min && number <= max) {
    return number;
  }
  if (lenient) {
    return fallback;
  }
  throw new TaskError(`${name} must be a whole number from ${min} to ${max}, got '${text}'`);
}

/** A comma-separated list of status codes and patterns (404, 5xx, 50x) as one anchored regex; blank is null. */
function codePattern(input, name) {
  const codes = (value(input) ?? "")
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  for (const code of codes) {
    if (!/^[1-5x][0-9x]{2}$/.test(code)) {
      throw new TaskError(`${name} has '${code}', which is not a status code or a pattern such as 404 or 5xx`);
    }
  }
  return codes.length ? new RegExp(`^(${codes.map((code) => code.replace(/x/g, "\\d")).join("|")})$`) : null;
}

/** Strips one pair of matching quotes, for headers written as "Name": "value". */
function unquote(text) {
  const trimmed = text.trim();
  return /^(["']).*\1$/.test(trimmed) && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The Headers param: one "Name: value" per line. A line with no colon fails, by line number only,
 * since a header line may hold a credential.
 */
function parseHeaders(text) {
  const headers = {};
  (value(text) ?? "").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const colon = line.indexOf(":");
    if (colon < 1) {
      throw new TaskError(`header line ${index + 1} is not "Name: value"`);
    }
    const name = unquote(line.slice(0, colon));
    // The last of a repeated header wins, whatever its case.
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) {
        delete headers[existing];
      }
    }
    headers[name] = unquote(line.slice(colon + 1));
  });
  return headers;
}

function headerValue(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function setHeader(headers, name, headerText) {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      delete headers[existing];
    }
  }
  headers[name] = headerText;
}

/**
 * The request body. For a JSON content type it must parse, and is sent as written (not
 * re-serialised, which would round large numbers); text pasted with raw line breaks inside its
 * strings parses once the breaks are removed, as the original command did. Any other body is sent
 * exactly as given.
 */
function requestBody(body, contentType) {
  if (body === undefined) {
    return undefined;
  }
  if (!contentType || !/^application\/([\w.+-]+\+)?json\b/i.test(contentType)) {
    return body;
  }
  for (const candidate of [body.trim(), body.replace(/[\n\r\t]/g, "").trim()]) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // try the next form
    }
  }
  throw new TaskError(`body is not valid JSON, and the Content-Type is ${contentType}`);
}

/** The proxy agent for this URL: HTTP_PROXY, unless NO_PROXY lists the host (or a parent domain of it). */
function agentFor(url) {
  const proxy = process.env.HTTP_PROXY;
  if (!proxy) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const bypass = (process.env.NO_PROXY ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean)
    .some((entry) => entry === "*" || host === entry || host.endsWith(`.${entry}`));
  if (bypass) {
    log.debug("NO_PROXY lists the host; no proxy");
    return undefined;
  }
  log.debug("Using Proxy", proxy);
  return new HttpsProxyAgent(proxy);
}

/** The URL for a log line: no credentials, no query string (either may hold a secret). */
function logUrl(url) {
  return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
}

/** Sends one request; resolves { status, statusMessage, body (Buffer) }, rejects on a network failure. */
function send(url, options, body) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, statusMessage: response.statusMessage, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function execute() {
  await run("HTTP execute", async () => {
    const {
      url: urlParam,
      method: methodParam,
      header,
      contentType: contentTypeParam,
      body: bodyParam,
      allowUntrustedCerts,
      outputFilePath,
      successcodes,
      errorcodes,
      retrycodes = "502,503",
      retrydelay,
      retrynumber,
      systemretrynumber,
      systemretrydelay,
    } = params;

    let url;
    try {
      url = new URL(value(urlParam) ?? "");
    } catch {
      throw new TaskError(value(urlParam) ? "url is not a valid URL" : "Missing required param: url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TaskError(`url must be http or https, got ${url.protocol}`);
    }
    const method = (value(methodParam) ?? "GET").toUpperCase();
    if (!METHODS.includes(method)) {
      throw new TaskError(`method must be one of ${METHODS.join(", ")}, got '${methodParam}'`);
    }

    const success = codePattern(successcodes, "successcodes");
    const error = codePattern(errorcodes, "errorcodes");
    const retry = codePattern(retrycodes, "retrycodes");
    const retries = bounded(retrynumber, "retrynumber", 0, 0, 9);
    const retryDelay = bounded(retrydelay, "retrydelay", 200, 100, 300000);
    const networkRetries = bounded(systemretrynumber, "systemretrynumber", 3, 1, 9, true);
    const networkDelay = bounded(systemretrydelay, "systemretrydelay", 5000, 100, 300000, true);

    const headers = parseHeaders(header);
    const contentType = value(contentTypeParam);
    if (contentType) {
      setHeader(headers, "Content-Type", contentType);
    }
    const body = requestBody(value(bodyParam) === undefined ? undefined : bodyParam, headerValue(headers, "Content-Type"));
    if (body !== undefined) {
      setHeader(headers, "Content-Length", String(Buffer.byteLength(body)));
    }

    const untrusted = asBoolean(allowUntrustedCerts);
    if (untrusted && url.protocol === "https:") {
      log.warn("allowUntrustedCerts is set: the server's certificate is not verified");
    }
    const options = { method, headers, agent: agentFor(url), rejectUnauthorized: !untrusted };
    // Header names only: a value may be a credential.
    log.sys(`${method} ${logUrl(url)}`, Object.keys(headers).length ? `(headers: ${Object.keys(headers).join(", ")})` : "");

    let response;
    for (let attempt = 0, networkAttempt = 0; ; ) {
      try {
        response = await send(url, options, body);
      } catch (e) {
        if (NETWORK_ERRORS.includes(e.code) && networkAttempt < networkRetries) {
          networkAttempt++;
          log.warn(`${e.code}: retrying in ${networkDelay} ms (${networkAttempt} of ${networkRetries})`);
          await sleep(networkDelay);
          continue;
        }
        throw new TaskError(`The request to ${logUrl(url)} failed: ${e.code ? `${e.code} ` : ""}${e.message}`);
      }
      const code = String(response.status);
      if (error?.test(code)) {
        break;
      }
      if (/^2\d\d$/.test(code) || success?.test(code)) {
        break;
      }
      if (retry?.test(code) && attempt < retries) {
        attempt++;
        log.warn(`HTTP ${code}: retrying in ${retryDelay} ms (${attempt} of ${retries})`);
        await sleep(retryDelay);
        continue;
      }
      break;
    }

    const code = String(response.status);
    const succeeded = !error?.test(code) && (/^2\d\d$/.test(code) || Boolean(success?.test(code)));
    const text = response.body.toString("utf8");
    const callResults = { statusCode: response.status };
    if (!succeeded) {
      // The status and, when it fits, the body are still results, for a later task to read.
      if (Buffer.byteLength(text) <= RESULT_BUDGET) {
        callResults.response = text;
      }
      await results(callResults);
      const why = error?.test(code) ? "an error code" : retry?.test(code) ? "a retry code, with no retries left" : "not a success code";
      throw new TaskError(`HTTP ${code} ${response.statusMessage ?? ""} is ${why}${text ? `: ${text.slice(0, ERROR_BODY_LOG)}` : ""}`);
    }

    log.good(`HTTP ${code}, ${response.body.length} bytes`);
    log.debug("Response:", text);
    if (value(outputFilePath)) {
      // The bytes as received; the response result is then left empty.
      writeOutputFile(outputFilePath.trim(), response.body);
    } else if (Buffer.byteLength(text) > RESULT_BUDGET) {
      await results(callResults);
      throw new TaskError(`The response is ${Buffer.byteLength(text)} bytes, more than a task result can carry (${RESULT_BUDGET}); set outputFilePath to write it to the workspace instead`);
    } else {
      callResults.response = text;
    }
    await results(callResults);
  });
}
