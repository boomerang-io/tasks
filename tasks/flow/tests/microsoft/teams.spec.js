import { expect } from "chai";
import { mockServer, runCommand } from "../helpers/harness.js";

const SECRET = "client-secret-value~0123456789";
const ACCESS_TOKEN = "graph-access-token-abcdef";

/** A mock Entra token endpoint and Graph on one server; `graph(req, n)` answers everything else. */
export async function microsoftServer(graph) {
  const server = await mockServer((req, n) => {
    if (req.path.endsWith("/oauth2/v2.0/token")) {
      return { status: 200, body: { token_type: "Bearer", expires_in: 3599, access_token: ACCESS_TOKEN } };
    }
    return graph(req, n);
  });
  server.env = { MICROSOFT_LOGIN_URL: server.url, MICROSOFT_GRAPH_URL: `${server.url}/v1.0` };
  server.graphRequests = () => server.requests.filter((r) => !r.path.endsWith("/oauth2/v2.0/token"));
  return server;
}

export const credentials = { tenantId: "contoso-tenant", clientId: "app-client-id", clientSecret: SECRET };
export { SECRET, ACCESS_TOKEN };

describe("teams commands", function () {
  this.timeout(20000);

  describe("sendMessage", () => {
    let server;
    let reply;
    beforeEach(async () => {
      reply = () => ({ status: 202, body: "" });
      server = await mockServer((req) => reply(req));
    });
    afterEach(() => server.close());

    // A Workflows webhook URL carries its signature in the query string.
    const hook = () => `${server.url}/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=webhook-signature-secret`;

    it("posts a title and message as an Adaptive Card attachment", async () => {
      const run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), title: "Deploy finished", message: "**prod** is on v2.1.0" });
      expect(run.code, run.output).to.equal(0);
      const [req] = server.requests;
      expect(req.method).to.equal("POST");
      expect(req.json).to.deep.equal({
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                { type: "TextBlock", text: "Deploy finished", size: "Large", weight: "Bolder", wrap: true },
                { type: "TextBlock", text: "**prod** is on v2.1.0", wrap: true },
              ],
            },
          },
        ],
      });
    });

    it("wraps a given Adaptive Card, and sends a given message as-is", async () => {
      const card = { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "custom" }] };
      let run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), title: "ignored", card: JSON.stringify(card) });
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].json.attachments[0].content).to.deep.equal(card);

      const message = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] };
      run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), card: JSON.stringify(message) });
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[1].json).to.deep.equal(message);
    });

    it("refuses a card of another type, and an empty message", async () => {
      let run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), card: '{"@type":"MessageCard"}' });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("card must be an Adaptive Card");
      run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), title: "", message: "" });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Give a title, a message, or a card");
      expect(server.requests).to.have.length(0);
    });

    it("fails on the webhook's error without logging the signed URL", async () => {
      reply = () => ({ status: 400, body: { error: { code: "TriggerInputSchemaMismatch", message: "The input body for trigger 'manual' did not match its schema" } } });
      const run = await runCommand("teams", "sendMessage", { webhookUrl: hook(), message: "hi" });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("The Teams webhook answered HTTP 400: TriggerInputSchemaMismatch");
      expect(run.output).to.not.include("webhook-signature-secret");
    });
  });

  describe("graph commands", () => {
    let server;
    let reply;
    beforeEach(async () => {
      reply = () => undefined;
      server = await microsoftServer((req, n) => reply(req, n));
    });
    afterEach(() => server.close());

    it("mints an app-only token with the client credentials and creates a standard channel", async () => {
      reply = () => ({ status: 201, body: { id: "19:abc@thread.tacv2", displayName: "release-42", webUrl: "https://teams.microsoft.com/l/channel/19%3aabc" } });
      const run = await runCommand("teams", "createChannel", { ...credentials, teamId: "team-1", displayName: "release-42", description: "Release 42", membershipType: "standard" }, server.env);
      expect(run.code, run.output).to.equal(0);

      const [tokenRequest, channelRequest] = server.requests;
      expect(tokenRequest.path).to.equal("/contoso-tenant/oauth2/v2.0/token");
      expect(Object.fromEntries(new URLSearchParams(tokenRequest.text))).to.deep.equal({
        client_id: "app-client-id",
        client_secret: SECRET,
        scope: `${server.url}/.default`,
        grant_type: "client_credentials",
      });
      expect(channelRequest.path).to.equal("/v1.0/teams/team-1/channels");
      expect(channelRequest.headers.authorization).to.equal(`Bearer ${ACCESS_TOKEN}`);
      expect(channelRequest.json).to.deep.equal({ displayName: "release-42", description: "Release 42", membershipType: "standard" });
      expect(run.results).to.deep.equal({ channelId: "19:abc@thread.tacv2", channelUrl: "https://teams.microsoft.com/l/channel/19%3aabc" });
      expect(run.output).to.not.include(SECRET);
      expect(run.output).to.not.include(ACCESS_TOKEN);
    });

    it("names the owner of a private channel, and refuses one without an owner before connecting", async () => {
      let run = await runCommand("teams", "createChannel", { ...credentials, teamId: "team-1", displayName: "incident", membershipType: "private" }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("A private channel needs an owner");
      expect(server.requests).to.have.length(0);

      reply = () => ({ status: 201, body: { id: "19:p@thread.tacv2", displayName: "incident" } });
      run = await runCommand("teams", "createChannel", { ...credentials, teamId: "team-1", displayName: "incident", membershipType: "private", owner: "o'brien@contoso.com" }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests()[0].json.members).to.deep.equal([
        { "@odata.type": "#microsoft.graph.aadUserConversationMember", "user@odata.bind": `${server.url}/v1.0/users('o''brien@contoso.com')`, roles: ["owner"] },
      ]);
      expect(run.results).to.deep.equal({ channelId: "19:p@thread.tacv2", channelUrl: "" });
    });

    it("refuses a channel name longer than Teams takes", async () => {
      const run = await runCommand("teams", "createChannel", { ...credentials, teamId: "t", displayName: "n".repeat(51) }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("displayName is 51 characters; Teams takes 50");
    });

    it("adds a member with no role and an owner with the owner role", async () => {
      reply = () => ({ status: 201, body: { id: "membership-1", userId: "user-guid", displayName: "Jacob" } });
      let run = await runCommand("teams", "addMember", { ...credentials, teamId: "team-1", user: "jacob@contoso.com", role: "member" }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests()[0].path).to.equal("/v1.0/teams/team-1/members");
      expect(server.graphRequests()[0].json).to.deep.equal({
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: [],
        "user@odata.bind": `${server.url}/v1.0/users('jacob@contoso.com')`,
      });
      expect(run.results).to.deep.equal({ membershipId: "membership-1", userId: "user-guid" });

      run = await runCommand("teams", "addMember", { ...credentials, teamId: "team-1", user: "jacob@contoso.com", role: "owner" }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests()[1].json.roles).to.deep.equal(["owner"]);
    });

    it("retries a throttled call after Retry-After", async () => {
      reply = (req) => (server.graphRequests().length === 1 ? { status: 429, headers: { "Retry-After": "1" }, body: { error: { code: "TooManyRequests", message: "slow down" } } } : { status: 201, body: { id: "m", userId: "u" } });
      const run = await runCommand("teams", "addMember", { ...credentials, teamId: "team-1", user: "u@contoso.com" }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests()).to.have.length(2);
      expect(run.output).to.include("Graph answered 429; retrying in 1s");
    });

    it("reports Graph's error code and message", async () => {
      reply = () => ({ status: 403, body: { error: { code: "Forbidden", message: "Missing role permissions on the request. API requires one of 'TeamMember.ReadWrite.All'" } } });
      const run = await runCommand("teams", "addMember", { ...credentials, teamId: "team-1", user: "u@contoso.com" }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Adding the member failed with HTTP 403: Forbidden: Missing role permissions");
    });

    it("reports a token failure with Entra's message, never the secret", async () => {
      await server.close();
      server = await mockServer(() => ({ status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 1" } }));
      const run = await runCommand("teams", "addMember", { ...credentials, teamId: "team-1", user: "u@contoso.com" }, { MICROSOFT_LOGIN_URL: server.url, MICROSOFT_GRAPH_URL: `${server.url}/v1.0` });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Could not get a Microsoft Graph token for client app-client-id in tenant contoso-tenant (HTTP 401): AADSTS7000215: Invalid client secret provided.");
      expect(run.output).to.not.include(SECRET);
    });

    it("names the missing credentials before any request", async () => {
      const run = await runCommand("teams", "addMember", { tenantId: "", clientId: "", clientSecret: "", teamId: "t", user: "u" }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Missing required params: tenantId, clientId, clientSecret");
      expect(server.requests).to.have.length(0);
    });
  });
});
