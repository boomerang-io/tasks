import { expect } from "chai";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(new URL("../helpers/run-command.js", import.meta.url));

// Starts the server on an ephemeral loopback port and resolves once it is listening.
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// Runs commands/artifact.js's upload or download in its own process, the way the dispatcher does.
function runCommand(command, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, command], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Turns { name: value } task params into the PARAM_NAMES / PARAM_<NAME> env vars task-core resolves
// them from, using the same normalisation as packages/core/src/params.js's envName().
function paramEnv(values) {
  const env = { PARAM_NAMES: Object.keys(values).join(",") };
  for (const [name, value] of Object.entries(values)) {
    env["PARAM_" + name.toUpperCase().replace(/[^A-Za-z0-9_]/g, "_")] = value;
  }
  return env;
}

describe("artifact upload/download commands", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-flow-artifact-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uploads a file with the right body, content-type, content-length, and passthrough headers", async () => {
    const fileContent = "hello artifact world\n".repeat(1000);
    const sourcePath = path.join(tmpDir, "upload-source.txt");
    await fs.writeFile(sourcePath, fileContent);

    let received;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received = { method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listen(server);

    const result = await runCommand(
      "upload",
      paramEnv({
        name: "upload-source.txt",
        path: sourcePath,
        url: `http://127.0.0.1:${port}/upload`,
        headers: JSON.stringify({ "x-test-header": "abc" }),
        "retention-days": "30", // set by Flow on every run; the worker must ignore it
      }),
    );
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(received.method).to.equal("PUT");
    expect(received.headers["x-test-header"]).to.equal("abc");
    expect(received.headers["content-type"]).to.equal("application/octet-stream");
    expect(Number(received.headers["content-length"])).to.equal(Buffer.byteLength(fileContent));
    expect(received.body.toString()).to.equal(fileContent);
  });

  it("uploads a directory as a tar.gz that extracts back to the same files", async () => {
    const sourceDir = path.join(tmpDir, "upload-dir");
    await fs.mkdir(path.join(sourceDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "a.txt"), "file a");
    await fs.writeFile(path.join(sourceDir, "sub", "b.txt"), "file b");

    let receivedTarball;
    let receivedHeaders;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        receivedTarball = Buffer.concat(chunks);
        receivedHeaders = req.headers;
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listen(server);

    const result = await runCommand(
      "upload",
      paramEnv({
        name: "upload-dir",
        path: sourceDir,
        url: `http://127.0.0.1:${port}/upload`,
        headers: "{}",
      }),
    );
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(receivedHeaders["content-type"]).to.equal("application/vnd.boomerang.artifact.tar+gzip");

    const tarballPath = path.join(tmpDir, "roundtrip.tar.gz");
    await fs.writeFile(tarballPath, receivedTarball);
    const extractDir = path.join(tmpDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDir]);

    expect(await fs.readFile(path.join(extractDir, "a.txt"), "utf8")).to.equal("file a");
    expect(await fs.readFile(path.join(extractDir, "sub", "b.txt"), "utf8")).to.equal("file b");
  });

  it("downloads a file, verifies its SHA-256, and writes it to the destination", async () => {
    const content = "download me please\n".repeat(500);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");

    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(content);
    });
    const port = await listen(server);

    const destinationPath = path.join(tmpDir, "downloaded.txt");
    const result = await runCommand(
      "download",
      paramEnv({
        name: "downloaded.txt",
        path: destinationPath,
        url: `http://127.0.0.1:${port}/download`,
        headers: "{}",
        sha256,
        contentType: "text/plain",
      }),
    );
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(await fs.readFile(destinationPath, "utf8")).to.equal(content);
  });

  it("downloads a tarball artifact and extracts it into the destination directory", async () => {
    const sourceDir = path.join(tmpDir, "dl-src");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "one.txt"), "one");
    const tarballPath = path.join(tmpDir, "dl-fixture.tar.gz");
    await execFileAsync("tar", ["-czf", tarballPath, "-C", sourceDir, "."]);
    const tarballBytes = await fs.readFile(tarballPath);
    const sha256 = crypto.createHash("sha256").update(tarballBytes).digest("hex");

    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(tarballBytes);
    });
    const port = await listen(server);

    const destinationDir = path.join(tmpDir, "dl-dest");
    const result = await runCommand(
      "download",
      paramEnv({
        name: "dl-src",
        path: destinationDir,
        url: `http://127.0.0.1:${port}/download`,
        headers: "{}",
        sha256,
        contentType: "application/vnd.boomerang.artifact.tar+gzip",
      }),
    );
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(await fs.readFile(path.join(destinationDir, "one.txt"), "utf8")).to.equal("one");
  });

  it("exits non-zero and writes nothing on a SHA-256 mismatch", async () => {
    const content = "tampered maybe";
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    const port = await listen(server);

    const destinationPath = path.join(tmpDir, "mismatch.txt");
    const result = await runCommand(
      "download",
      paramEnv({
        name: "mismatch.txt",
        path: destinationPath,
        url: `http://127.0.0.1:${port}/download`,
        headers: "{}",
        sha256: "0".repeat(64),
        contentType: "text/plain",
      }),
    );
    server.close();

    // log.err writes through console.log (chalk), so the message lands on stdout.
    expect(result.code).to.equal(1);
    expect(result.stdout).to.include("SHA-256 mismatch");
    expect(fsSync.existsSync(destinationPath)).to.equal(false);
  });

  it("resolves a relative upload path against the workspace root", async () => {
    await fs.mkdir(path.join(tmpDir, "workflowrun", "reports"), { recursive: true });
    const content = "relative upload\n";
    await fs.writeFile(path.join(tmpDir, "workflowrun", "reports", "sbom.json"), content);
    let received = "";
    const server = http.createServer((req, res) => {
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => {
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listen(server);

    const result = await runCommand("upload", {
      ARTIFACT_WORKSPACE_ROOT: tmpDir,
      ...paramEnv({ name: "sbom", path: "workflowrun/reports/sbom.json", url: `http://127.0.0.1:${port}/upload`, headers: "{}" }),
    });
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(received).to.equal(content);
  });

  it("resolves a relative download destination against the workspace root", async () => {
    const content = "relative download\n";
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    const port = await listen(server);

    const result = await runCommand("download", {
      ARTIFACT_WORKSPACE_ROOT: tmpDir,
      ...paramEnv({ name: "sbom.json", path: "workflow/inputs/", url: `http://127.0.0.1:${port}/download`, headers: "{}", sha256, contentType: "application/octet-stream" }),
    });
    server.close();

    expect(result.code, result.stdout + result.stderr).to.equal(0);
    expect(await fs.readFile(path.join(tmpDir, "workflow", "inputs", "sbom.json"), "utf8")).to.equal(content);
  });
});
