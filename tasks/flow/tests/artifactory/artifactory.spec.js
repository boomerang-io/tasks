import { expect } from "chai";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mockServer, runCommand, tempDir } from "../helpers/harness.js";

const ACCESS_TOKEN = "eyJ2ZXIiOiIyIiwidHlwIjoiSldUIn0.access-token";
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

describe("artifactory commands", function () {
  this.timeout(20000);
  let server;
  let reply;
  let dir;

  beforeEach(async () => {
    dir = tempDir();
    reply = () => undefined;
    server = await mockServer((req) => reply(req));
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifact = () => `${server.url}/artifactory/libs-release/com/acme/widget/1.0/widget-1.0.jar`;

  describe("downloadFile", () => {
    it("downloads with an access token as a Bearer token, into a directory under the artifact's name", async () => {
      const bytes = Buffer.from("jar bytes");
      reply = () => ({ status: 200, headers: { "X-Checksum-Sha256": sha256(bytes) }, body: bytes });
      const run = await runCommand("artifactory", "downloadFile", { url: artifact(), destinationPath: dir, accessToken: ACCESS_TOKEN, apiKey: "ignored" });
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].headers.authorization).to.equal(`Bearer ${ACCESS_TOKEN}`);
      expect(server.requests[0].headers["x-jfrog-art-api"]).to.equal(undefined);
      const target = path.join(dir, "widget-1.0.jar");
      expect(fs.readFileSync(target)).to.deep.equal(bytes);
      expect(run.results).to.deep.equal({ path: target, size: String(bytes.length), sha256: sha256(bytes) });
      expect(run.output).to.not.include(ACCESS_TOKEN);
    });

    it("fails on a checksum mismatch and leaves no file", async () => {
      reply = () => ({ status: 200, headers: { "X-Checksum-Sha256": sha256("other") }, body: "corrupt" });
      const target = path.join(dir, "out.jar");
      const run = await runCommand("artifactory", "downloadFile", { url: artifact(), destinationPath: target, accessToken: ACCESS_TOKEN });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Checksum mismatch");
      expect(fs.readdirSync(dir)).to.deep.equal([]);
    });

    it("keeps the API key and username/password auth, Basic-encoded", async () => {
      reply = () => ({ status: 200, body: "x" });
      let run = await runCommand("artifactory", "downloadFile", { url: artifact(), destinationPath: path.join(dir, "a"), apiKey: "AKCp-key" });
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[0].headers["x-jfrog-art-api"]).to.equal("AKCp-key");

      run = await runCommand("artifactory", "downloadFile", { url: artifact(), destinationPath: path.join(dir, "b"), username: "ci", password: "s3cret" });
      expect(run.code, run.output).to.equal(0);
      expect(server.requests[1].headers.authorization).to.equal(`Basic ${Buffer.from("ci:s3cret").toString("base64")}`);
    });

    it("reports a failed download by status", async () => {
      reply = () => ({ status: 401, body: { errors: [{ status: 401, message: "Bad credentials" }] } });
      const run = await runCommand("artifactory", "downloadFile", { url: artifact(), destinationPath: dir, accessToken: ACCESS_TOKEN });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("failed with HTTP 401");
    });
  });

  describe("uploadFile", () => {
    it("puts the file with its length and checks the checksum Artifactory stored", async () => {
      const local = path.join(dir, "widget-1.0.jar");
      fs.writeFileSync(local, "jar bytes");
      reply = (req) => ({ status: 201, body: { downloadUri: artifact(), checksums: { sha256: sha256(req.body) } } });
      const run = await runCommand("artifactory", "uploadFile", { url: artifact(), file: local, accessToken: ACCESS_TOKEN });
      expect(run.code, run.output).to.equal(0);
      const [req] = server.requests;
      expect(req.method).to.equal("PUT");
      expect(req.headers["content-length"]).to.equal("9");
      expect(req.headers.authorization).to.equal(`Bearer ${ACCESS_TOKEN}`);
      expect(req.text).to.equal("jar bytes");
      expect(run.results).to.deep.equal({ downloadUri: artifact(), sha256: sha256("jar bytes"), size: "9" });
    });

    it("fails when the stored checksum differs from the file", async () => {
      const local = path.join(dir, "a.jar");
      fs.writeFileSync(local, "a");
      reply = () => ({ status: 201, body: { downloadUri: artifact(), checksums: { sha256: sha256("b") } } });
      const run = await runCommand("artifactory", "uploadFile", { url: artifact(), file: local, accessToken: ACCESS_TOKEN });
      expect(run.code).to.equal(1);
      expect(run.output).to.include(`Artifactory stored sha256 ${sha256("b")}`);
    });

    it("reports JFrog's error message", async () => {
      const local = path.join(dir, "a.jar");
      fs.writeFileSync(local, "a");
      reply = () => ({ status: 403, body: { errors: [{ status: 403, message: "Not enough permissions to deploy" }] } });
      const run = await runCommand("artifactory", "uploadFile", { url: artifact(), file: local, accessToken: ACCESS_TOKEN });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("failed with HTTP 403: Not enough permissions to deploy");
      expect(run.output).to.not.include(ACCESS_TOKEN);
    });

    it("refuses a missing file and a URL that is not http(s)", async () => {
      let run = await runCommand("artifactory", "uploadFile", { url: artifact(), file: path.join(dir, "none.jar") });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("file does not exist");
      run = await runCommand("artifactory", "uploadFile", { url: "ftp://repo/x.jar", file: "x" });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("url must be the artifact's http(s) URL");
      expect(server.requests).to.have.length(0);
    });
  });
});
