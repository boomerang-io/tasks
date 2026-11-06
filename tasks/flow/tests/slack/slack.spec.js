import { expect } from "chai";
import { mockServer, runCommand } from "../helpers/harness.js";

describe("slack webhook commands", function () {
  this.timeout(30000);
  let server;
  let reply;

  beforeEach(async () => {
    reply = () => ({ status: 200, body: "ok" });
    server = await mockServer((req) => reply(req));
  });

  afterEach(() => server.close());

  // The webhook URL is the credential.
  const hook = () => `${server.url}/services/T000/B000/webhook-secret-token`;
  // @slack/webhook 7 merges its own timeout default into every payload; Slack ignores it.
  const sent = (n = 0) => {
    const { timeout, ...payload } = server.requests[n].json;
    return payload;
  };

  it("sends a simple message, which used to crash on an undefined datetime and exit 0", async () => {
    const run = await runCommand("slack", "sendSimpleMessage", { url: hook(), channel: "#builds", username: "Flow", icon: ":rocket:", message: "Build 42 passed" });
    expect(run.code, run.output).to.equal(0);
    expect(sent()).to.deep.equal({ channel: "#builds", username: "Flow", icon_emoji: ":rocket:", text: "Build 42 passed" });
    expect(run.output).to.include("Message sent");
  });

  it("leaves blank sender fields out, so the webhook's own channel, name and icon apply", async () => {
    const run = await runCommand("slack", "sendSimpleMessage", { url: hook(), channel: "", username: "", icon: "", message: "hi" });
    expect(run.code, run.output).to.equal(0);
    expect(sent()).to.deep.equal({ text: "hi" });
  });

  it("fails the task on Slack's error, without the webhook URL", async () => {
    reply = () => ({ status: 404, body: "no_service" });
    const run = await runCommand("slack", "sendSimpleMessage", { url: hook(), message: "hi" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("The Slack webhook answered HTTP 404: no_service");
    expect(run.output).to.not.include("webhook-secret-token");
  });

  it("fails a custom message on Slack's error, a network error, or invalid JSON", async () => {
    reply = () => ({ status: 400, body: "invalid_payload" });
    let run = await runCommand("slack", "sendCustomMessage", { url: hook(), message: '{"text":"hi","blocks":"nope"}' });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("HTTP 400: invalid_payload");

    run = await runCommand("slack", "sendCustomMessage", { url: "http://127.0.0.1:1/services/x", message: '{"text":"hi"}' });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("The Slack webhook could not be reached: ECONNREFUSED");

    run = await runCommand("slack", "sendCustomMessage", { url: hook(), message: '{"text": "hi"' });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("message is not valid JSON");
    expect(server.requests).to.have.length(1);
  });

  it("sends a custom message payload as given", async () => {
    const payload = { text: "fallback", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }] };
    const run = await runCommand("slack", "sendCustomMessage", { url: hook(), message: JSON.stringify(payload) });
    expect(run.code, run.output).to.equal(0);
    expect(sent()).to.deep.equal(payload);
  });

  it("sends file contents in blocks of at most 3000 characters, decoding base64 when encoded", async () => {
    const log = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const run = await runCommand("slack", "sendFileMessage", { url: hook(), channel: "", message: "Build log", content: Buffer.from(log).toString("base64"), encoded: "true", context: "run 42" });
    expect(run.code, run.output).to.equal(0);
    const { text, blocks } = server.requests[0].json;
    expect(text).to.equal("Build log");
    expect(blocks[0]).to.deep.equal({ type: "section", text: { type: "plain_text", text: "Build log" } });
    expect(blocks.at(-1)).to.deep.equal({ type: "context", elements: [{ type: "mrkdwn", text: "run 42" }] });
    const sections = blocks.slice(2, -2).map((b) => b.text.text);
    expect(sections.every((t) => t.length <= 3000)).to.equal(true);
    expect(sections.join("\n")).to.equal(log);
  });

  it("cuts a very long line, and keeps the message under 50 blocks with a note", async () => {
    const run = await runCommand("slack", "sendFileMessage", { url: hook(), message: "", content: "y".repeat(200000), encoded: "false", context: "" });
    expect(run.code, run.output).to.equal(0);
    const { blocks } = server.requests[0].json;
    expect(blocks).to.have.length(50);
    expect(blocks.at(-1).elements[0].text).to.match(/^…\d+ more characters not shown$/);
    expect(run.output).to.include("longer than one Slack message holds");
  });
});
