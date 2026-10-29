import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { mockServer, runCommand, tempDir } from "../helpers/harness.js";

// An installation token's shape; it must never reach the output.
const TOKEN = "ghs_testInstallationToken0123456789";

describe("github pipeline commands", function () {
  this.timeout(20000);
  let server;
  let reply;

  beforeEach(async () => {
    reply = () => undefined;
    server = await mockServer((req, n) => reply(req, n));
  });

  afterEach(() => server.close());

  const base = (extra) => ({ url: server.url, token: TOKEN, owner: "acme", repo: "widgets", ...extra });

  describe("createIssue", () => {
    it("creates the issue with labels, assignees and milestone, and returns its number and URL", async () => {
      reply = () => ({ status: 201, body: { id: 77, number: 12, html_url: "https://github.com/acme/widgets/issues/12" } });
      const run = await runCommand("github", "createIssue", base({ title: "Build failed", body: "See run 5", labels: "bug, ci", assignees: "octocat\nhubot", milestone: "3" }));

      expect(run.code, run.output).to.equal(0);
      const [req] = server.requests;
      expect(req.method).to.equal("POST");
      expect(req.path).to.equal("/repos/acme/widgets/issues");
      expect(req.headers.authorization).to.equal(`token ${TOKEN}`);
      expect(req.json).to.deep.equal({ title: "Build failed", body: "See run 5", labels: ["bug", "ci"], assignees: ["octocat", "hubot"], milestone: 3 });
      expect(run.results).to.deep.equal({ issueNumber: "12", issueUrl: "https://github.com/acme/widgets/issues/12", issueId: "77" });
      expect(run.output).to.not.include(TOKEN);
    });

    it("leaves optional fields out when they are blank", async () => {
      reply = () => ({ status: 201, body: { id: 1, number: 1, html_url: "u" } });
      const run = await runCommand("github", "createIssue", base({ title: "t", body: "", labels: "", assignees: "", milestone: "" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].json).to.deep.equal({ title: "t" });
    });

    it("names every missing required param and sends nothing", async () => {
      const run = await runCommand("github", "createIssue", { url: server.url, token: TOKEN, owner: "acme" });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Missing required params: repo, title");
      expect(server.requests).to.have.length(0);
    });

    it("fails clearly when the workspace token param resolved to nothing", async () => {
      const run = await runCommand("github", "createIssue", base({ token: "", title: "t" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Missing required param: token");
    });

    it("reports GitHub's error message and status without the token", async () => {
      reply = () => ({ status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com" } });
      const run = await runCommand("github", "createIssue", base({ title: "t" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("HTTP 404: Not Found");
      expect(run.output).to.not.include(TOKEN);
    });
  });

  describe("commentOnIssueOrPullRequest", () => {
    it("comments through the issues API and returns the comment", async () => {
      reply = () => ({ status: 201, body: { id: 900, html_url: "https://github.com/acme/widgets/pull/4#issuecomment-900" } });
      const run = await runCommand("github", "commentOnIssueOrPullRequest", base({ number: "4", body: "Deployed to staging" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].path).to.equal("/repos/acme/widgets/issues/4/comments");
      expect(server.requests[0].json).to.deep.equal({ body: "Deployed to staging" });
      expect(run.results).to.deep.equal({ commentId: "900", commentUrl: "https://github.com/acme/widgets/pull/4#issuecomment-900" });
    });

    it("refuses a number that is not a whole number", async () => {
      const run = await runCommand("github", "commentOnIssueOrPullRequest", base({ number: "four", body: "x" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("number must be a whole number");
      expect(server.requests).to.have.length(0);
    });
  });

  describe("createPullRequest", () => {
    it("opens a draft pull request and returns its number and URL", async () => {
      reply = () => ({ status: 201, body: { number: 8, html_url: "https://github.com/acme/widgets/pull/8" } });
      const run = await runCommand("github", "createPullRequest", base({ title: "Bump", head: "bump-deps", base: "main", body: "", draft: "true" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].path).to.equal("/repos/acme/widgets/pulls");
      expect(server.requests[0].json).to.deep.equal({ title: "Bump", head: "bump-deps", base: "main", draft: true });
      expect(run.results).to.deep.equal({ pullRequestNumber: "8", pullRequestUrl: "https://github.com/acme/widgets/pull/8" });
    });

    it("surfaces GitHub's validation errors, such as a pull request that already exists", async () => {
      reply = () => ({ status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for acme:bump-deps." }] } });
      const run = await runCommand("github", "createPullRequest", base({ title: "Bump", head: "bump-deps", base: "main" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("A pull request already exists for acme:bump-deps.");
    });
  });

  describe("setCommitStatus", () => {
    it("sets the status with its context, target URL and description", async () => {
      reply = () => ({ status: 201, body: { id: 31, state: "success", context: "flow/build" } });
      const run = await runCommand("github", "setCommitStatus", base({ sha: "abc123", state: "success", context: "flow/build", targetUrl: "https://flow.example/run/1", description: "Passed" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].path).to.equal("/repos/acme/widgets/statuses/abc123");
      expect(server.requests[0].json).to.deep.equal({ state: "success", context: "flow/build", target_url: "https://flow.example/run/1", description: "Passed" });
      expect(run.results).to.deep.equal({ statusId: "31" });
    });

    it("shortens a description past GitHub's 140 characters", async () => {
      reply = () => ({ status: 201, body: { id: 1, state: "failure", context: "default" } });
      const run = await runCommand("github", "setCommitStatus", base({ sha: "abc", state: "failure", description: "x".repeat(200) }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].json.description).to.have.length(140);
    });

    it("refuses a state GitHub does not take", async () => {
      const run = await runCommand("github", "setCommitStatus", base({ sha: "abc", state: "passed" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("state must be one of pending, success, failure, error");
      expect(server.requests).to.have.length(0);
    });
  });

  describe("dispatchWorkflow", () => {
    it("asks for run details and returns the run", async () => {
      reply = () => ({ status: 200, body: { workflow_run_id: 4242, run_url: "https://api.github.com/repos/acme/widgets/actions/runs/4242", html_url: "https://github.com/acme/widgets/actions/runs/4242" } });
      const run = await runCommand("github", "dispatchWorkflow", base({ workflow: ".github/workflows/deploy.yml", ref: "main", inputs: '{"environment":"staging","dryRun":true}' }));
      expect(run.code, run.output).to.equal(0);
      const [req] = server.requests;
      expect(req.path).to.equal("/repos/acme/widgets/actions/workflows/deploy.yml/dispatches");
      expect(req.json).to.deep.equal({ ref: "main", inputs: { environment: "staging", dryRun: true }, return_run_details: true });
      expect(run.results).to.deep.equal({ runId: "4242", runUrl: "https://github.com/acme/widgets/actions/runs/4242" });
    });

    it("dispatches again without run details when the server refuses the key", async () => {
      reply = (req, n) =>
        n === 1
          ? { status: 422, body: { message: 'Invalid request.\n\n"return_run_details" is not a permitted key.' } }
          : { status: 204 };
      const run = await runCommand("github", "dispatchWorkflow", base({ workflow: "1234", ref: "v1.2.0" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests).to.have.length(2);
      expect(server.requests[1].json).to.deep.equal({ ref: "v1.2.0" });
      expect(run.results).to.deep.equal({ runId: "", runUrl: "" });
    });

    it("does not dispatch twice for any other validation error", async () => {
      reply = () => ({ status: 422, body: { message: "Unexpected inputs provided: [\"colour\"]" } });
      const run = await runCommand("github", "dispatchWorkflow", base({ workflow: "deploy.yml", ref: "main", inputs: '{"colour":"red"}' }));
      expect(run.code).to.equal(1);
      expect(server.requests).to.have.length(1);
      expect(run.output).to.include("Unexpected inputs provided");
    });

    it("refuses inputs that are not a JSON object", async () => {
      const run = await runCommand("github", "dispatchWorkflow", base({ workflow: "deploy.yml", ref: "main", inputs: '["a"]' }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("inputs must be a JSON object");
    });
  });

  describe("createRelease", () => {
    it("creates the release with generated notes and returns it", async () => {
      reply = () => ({ status: 201, body: { id: 55, tag_name: "v2.0.0", html_url: "https://github.com/acme/widgets/releases/tag/v2.0.0" } });
      const run = await runCommand("github", "createRelease", base({ tagName: "v2.0.0", targetCommitish: "main", name: "2.0.0", body: "", draft: "false", prerelease: "false", generateReleaseNotes: "true", makeLatest: "true" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].path).to.equal("/repos/acme/widgets/releases");
      expect(server.requests[0].json).to.deep.equal({ tag_name: "v2.0.0", target_commitish: "main", name: "2.0.0", draft: false, prerelease: false, generate_release_notes: true, make_latest: "true" });
      expect(run.results).to.deep.equal({ releaseId: "55", releaseUrl: "https://github.com/acme/widgets/releases/tag/v2.0.0" });
    });

    it("refuses a makeLatest GitHub does not take", async () => {
      const run = await runCommand("github", "createRelease", base({ tagName: "v1", makeLatest: "yes" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("makeLatest must be one of true, false, legacy");
    });
  });

  describe("getFileContents", () => {
    const file = (text, extra = {}) => ({ type: "file", path: "config/app.yaml", sha: "f00d", size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64"), ...extra });

    it("returns a small text file as the content result, at the ref", async () => {
      reply = () => ({ status: 200, body: file("replicas: 3\n") });
      const run = await runCommand("github", "getFileContents", base({ path: "/config/app.yaml", ref: "release" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].path).to.equal("/repos/acme/widgets/contents/config/app.yaml");
      expect(server.requests[0].query).to.deep.equal({ ref: "release" });
      expect(run.results).to.deep.equal({ sha: "f00d", size: "12", content: "replicas: 3\n" });
    });

    it("fails rather than cut short a file too large for a result, when there is no output file", async () => {
      reply = () => ({ status: 200, body: file("x".repeat(5000)) });
      const run = await runCommand("github", "getFileContents", base({ path: "big.txt" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("big.txt is 5000 bytes, more than a task result can carry");
    });

    it("writes the file to outputFile and leaves content out when it is too large", async () => {
      const dir = tempDir();
      reply = () => ({ status: 200, body: file("y".repeat(5000)) });
      const out = path.join(dir, "nested", "big.txt");
      const run = await runCommand("github", "getFileContents", base({ path: "big.txt", outputFile: out }));
      expect(run.code, run.output).to.equal(0);
      expect(fs.readFileSync(out, "utf8")).to.equal("y".repeat(5000));
      expect(run.results).to.deep.equal({ sha: "f00d", size: "5000", outputPath: out });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reads a file past 1 MB through the blob API", async () => {
      reply = (req) =>
        req.path.endsWith("/git/blobs/f00d")
          ? { status: 200, body: { sha: "f00d", encoding: "base64", content: Buffer.from("from the blob").toString("base64") } }
          : { status: 200, body: file("", { size: 2000000, encoding: "none", content: "" }) };
      const run = await runCommand("github", "getFileContents", base({ path: "huge.bin" }));
      expect(run.code, run.output).to.equal(0);
      expect(server.requests.map((r) => r.path)).to.deep.equal(["/repos/acme/widgets/contents/huge.bin", "/repos/acme/widgets/git/blobs/f00d"]);
      expect(run.results.content).to.equal("from the blob");
    });

    it("refuses a directory", async () => {
      reply = () => ({ status: 200, body: [{ type: "file", name: "a" }] });
      const run = await runCommand("github", "getFileContents", base({ path: "config" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("config is a directory in acme/widgets, not a file");
    });

    it("needs an output file for binary content", async () => {
      reply = () => ({ status: 200, body: { type: "file", path: "logo.png", sha: "b1", size: 4, encoding: "base64", content: Buffer.from([0x89, 0x50, 0xff, 0xfe]).toString("base64") } });
      const run = await runCommand("github", "getFileContents", base({ path: "logo.png" }));
      expect(run.code).to.equal(1);
      expect(run.output).to.include("logo.png is not UTF-8 text");
    });
  });
});
