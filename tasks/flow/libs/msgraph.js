import { log } from "@boomerang-io/task-core";
import axios from "axios";
import { required, proxyOptions, serviceMessage, TaskError } from "./task.js";

/**
 * Microsoft Graph with an app-only token: each task mints its own through the client-credentials
 * flow from tenantId, clientId and clientSecret, so nothing outside the task refreshes a token.
 * The URLs default to the global cloud; MICROSOFT_LOGIN_URL and MICROSOFT_GRAPH_URL point at a
 * national cloud (or a test server) instead.
 */

const LOGIN_URL = (process.env.MICROSOFT_LOGIN_URL || "https://login.microsoftonline.com").replace(/\/+$/, "");
export const GRAPH_URL = (process.env.MICROSOFT_GRAPH_URL || "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");

// Throttled (429) or briefly unavailable (503) calls are retried this many times in all, honouring Retry-After.
const ATTEMPTS = 3;
const MAX_RETRY_WAIT_SECONDS = 30;

/** A Graph call that failed: the status and Graph's own error code and message. */
export class GraphError extends TaskError {
  constructor(what, response) {
    const detail = serviceMessage(response.data);
    super(`${what} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    this.status = response.status;
  }
}

async function token({ tenantId, clientId, clientSecret }) {
  required({ tenantId, clientId, clientSecret }, ["tenantId", "clientId", "clientSecret"]);
  const response = await axios.post(
    `${LOGIN_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: `${new URL(GRAPH_URL).origin}/.default`,
      grant_type: "client_credentials",
    }),
    { ...proxyOptions(), validateStatus: () => true },
  );
  if (response.status !== 200 || !response.data?.access_token) {
    const detail = serviceMessage(response.data);
    throw new TaskError(`Could not get a Microsoft Graph token for client ${clientId} in tenant ${tenantId} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  log.debug("Minted an app-only Microsoft Graph token");
  return response.data.access_token;
}

/**
 * A Graph client for one task: `call(what, config)` sends a request relative to GRAPH_URL (or to an
 * absolute nextLink) and returns the response, throwing a GraphError for any status of 400 or more.
 */
export async function graphClient(credentials) {
  const accessToken = await token(credentials);
  const http = axios.create({
    baseURL: GRAPH_URL,
    headers: { Authorization: `Bearer ${accessToken}` },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
    ...proxyOptions(),
  });

  async function call(what, config) {
    for (let attempt = 1; ; attempt++) {
      const response = await http.request(config);
      const retryable = response.status === 429 || response.status === 503;
      // A stream body is spent after one send, so only a buffered request is retried.
      if (retryable && attempt < ATTEMPTS && typeof config.data?.pipe !== "function") {
        const wait = Math.min(Number(response.headers["retry-after"]) || 2 ** attempt, MAX_RETRY_WAIT_SECONDS);
        log.warn(`${what}: Graph answered ${response.status}; retrying in ${wait}s`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        continue;
      }
      if (response.status >= 400) {
        throw new GraphError(what, response);
      }
      return response;
    }
  }

  return { call };
}

/** The OData bind for a user, by object ID or user principal name. */
export function userBind(user) {
  return `${GRAPH_URL}/users('${String(user).trim().replace(/'/g, "''")}')`;
}

/** The credentials params every Graph task takes. */
export function credentialsFrom(params) {
  const { tenantId, clientId, clientSecret } = params;
  return { tenantId, clientId, clientSecret };
}
