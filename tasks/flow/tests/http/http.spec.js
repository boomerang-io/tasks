import { expect } from "chai";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mockServer, runCommand, tempDir } from "../helpers/harness.js";

const TOKEN = "Bearer secret-api-token-0123456789";

describe("http execute", function () {
  this.timeout(60000);
  let server;
  let reply;
  let dir;

  beforeEach(async () => {
    dir = tempDir();
    reply = () => ({ status: 200, body: "ok" });
    server = await mockServer((req, n) => reply(req, n));
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (values, env) => runCommand("http", "execute", { url: `${server.url}/hook`, method: "GET", ...values }, env);

  it("sends the method and headers, and returns the status and the response", async () => {
    reply = () => ({ status: 200, body: { id: 7, state: "queued" } });
    const run = await call({ url: `${server.url}/jobs?api_key=query-secret`, method: "post", header: `Authorization: ${TOKEN}\n"X-Flow-Run": "run-1"\n\nAccept: application/json`, contentType: "", body: "" });
    expect(run.code, run.output).to.equal(0);
    const [req] = server.requests;
    expect(req.method).to.equal("POST");
    expect(req.headers.authorization).to.equal(TOKEN);
    expect(req.headers["x-flow-run"]).to.equal("run-1");
    expect(req.headers.accept).to.equal("application/json");
    expect(run.results).to.deep.equal({ statusCode: "200", response: '{"id":7,"state":"queued"}' });
    expect(run.output).to.not.include("secret-api-token");
    expect(run.output).to.not.include("query-secret");
    expect(run.output).to.include("POST http://127.0.0.1");
  });

  it("defaults to GET and sends no body", async () => {
    const run = await call({ method: "" });
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].method).to.equal("GET");
    expect(server.requests[0].body.length).to.equal(0);
  });

  it("sends a JSON body as written, so large numbers keep their digits", async () => {
    const body = '{\n  "id": 12345678901234567890,\n  "name": "build"\n}';
    const run = await call({ method: "POST", contentType: "application/json", body });
    expect(run.code, run.output).to.equal(0);
    const [req] = server.requests;
    expect(req.text).to.equal(body);
    expect(req.headers["content-type"]).to.equal("application/json");
    expect(req.headers["content-length"]).to.equal(String(Buffer.byteLength(body)));
  });

  it("accepts JSON pasted with raw line breaks inside a string, as the original command did", async () => {
    const run = await call({ method: "POST", header: "Content-Type: application/json", body: '{"text": "line one\nline two"}' });
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].text).to.equal('{"text": "line oneline two"}');
  });

  it("refuses a body that is not JSON for a JSON content type, without echoing it", async () => {
    const run = await call({ method: "POST", contentType: "application/json", body: "password=hunter2" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("body is not valid JSON, and the Content-Type is application/json");
    expect(run.output).to.not.include("hunter2");
    expect(server.requests).to.have.length(0);
  });

  it("sends any other body exactly as given, line breaks included", async () => {
    const body = "line one\nline\ttwo\n";
    const run = await call({ method: "PUT", contentType: "text/plain", body });
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].text).to.equal(body);
  });

  it("fails on a status that is not a success code, with the status and response as results", async () => {
    reply = () => ({ status: 404, body: { message: "no such job" } });
    const run = await call({ successcodes: "1xx,2xx" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("HTTP 404 Not Found is not a success code");
    expect(run.results).to.deep.equal({ statusCode: "404", response: '{"message":"no such job"}' });
  });

  it("treats a listed status as success, and fails at once on an error code without retrying", async () => {
    reply = () => ({ status: 404, body: "" });
    let run = await call({ successcodes: "2xx,404" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results.statusCode).to.equal("404");

    reply = () => ({ status: 503, body: "" });
    run = await call({ errorcodes: "5xx", retrycodes: "503", retrynumber: "3", retrydelay: "100" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("HTTP 503 Service Unavailable is an error code");
    expect(server.requests).to.have.length(2);
  });

  it("retries a retry code after the delay until it succeeds", async () => {
    reply = (req, n) => (n < 3 ? { status: 503, body: "busy" } : { status: 201, body: "created" });
    const run = await call({ method: "POST", retrycodes: "502,503", retrynumber: "3", retrydelay: "100" });
    expect(run.code, run.output).to.equal(0);
    expect(server.requests).to.have.length(3);
    expect(run.output).to.include("HTTP 503: retrying in 100 ms (2 of 3)");
    expect(run.results).to.deep.equal({ statusCode: "201", response: "created" });
  });

  it("fails once the retries are spent", async () => {
    reply = () => ({ status: 502, body: "bad gateway" });
    const run = await call({ retrycodes: "502", retrynumber: "2", retrydelay: "100" });
    expect(run.code).to.equal(1);
    expect(server.requests).to.have.length(3);
    expect(run.output).to.include("is a retry code, with no retries left");
    expect(run.results.statusCode).to.equal("502");
  });

  it("does not follow a redirect: a 3xx succeeds only when it is a success code", async () => {
    reply = () => ({ status: 302, headers: { Location: "/elsewhere" }, body: "" });
    let run = await call({});
    expect(run.code).to.equal(1);
    expect(run.output).to.include("HTTP 302 Found is not a success code");
    run = await call({ successcodes: "2xx,3xx" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results.statusCode).to.equal("302");
    expect(server.requests.map((r) => r.path)).to.deep.equal(["/hook", "/hook"]);
  });

  it("writes the response to outputFilePath, bytes as received, and leaves the response result empty", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x10]);
    reply = () => ({ status: 200, body: bytes });
    const out = path.join(dir, "out", "logo.png");
    const run = await call({ outputFilePath: out });
    expect(run.code, run.output).to.equal(0);
    expect(fs.readFileSync(out).equals(bytes)).to.equal(true);
    expect(run.results).to.deep.equal({ statusCode: "200" });
  });

  it("fails rather than cut short a response too large for a result, unless outputFilePath is set", async () => {
    reply = () => ({ status: 200, body: "z".repeat(5000) });
    const run = await call({});
    expect(run.code).to.equal(1);
    expect(run.output).to.include("The response is 5000 bytes, more than a task result can carry");
    expect(run.results).to.deep.equal({ statusCode: "200" });
  });

  it("retries a refused connection on the network schedule, then fails", async () => {
    const closed = await new Promise((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
    const run = await runCommand("http", "execute", { url: `http://127.0.0.1:${closed}/`, method: "GET", systemretrynumber: "2", systemretrydelay: "100" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("ECONNREFUSED: retrying in 100 ms (2 of 2)");
    expect(run.output).to.include("failed: ECONNREFUSED");
  });

  it("checks its params before sending anything", async () => {
    const cases = [
      [{ method: "FETCH" }, "method must be one of GET, HEAD, PUT, POST, PATCH, OPTIONS, DELETE"],
      [{ successcodes: "2xx,ok" }, "successcodes has 'ok', which is not a status code"],
      [{ retrynumber: "12" }, "retrynumber must be a whole number from 0 to 9"],
      [{ retrydelay: "50" }, "retrydelay must be a whole number from 100 to 300000"],
      [{ header: `Authorization ${TOKEN}` }, 'header line 1 is not "Name: value"'],
      [{ url: "ftp://files.example.com/a" }, "url must be http or https"],
      [{ url: "" }, "Missing required param: url"],
    ];
    for (const [values, message] of cases) {
      const run = await call(values);
      expect(run.code, message).to.equal(1);
      expect(run.output).to.include(message);
      expect(run.output).to.not.include("secret-api-token");
    }
    expect(server.requests).to.have.length(0);
  });

  describe("over TLS and through a proxy", () => {
    let tls;
    let tlsDir;
    let proxy;
    let tunnels;
    const sockets = [];

    before(async function () {
      tlsDir = tempDir("task-flow-tls-");
      try {
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tlsDir, "key.pem"), "-out", path.join(tlsDir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
      } catch {
        this.skip();
      }
      tls = https.createServer({ key: fs.readFileSync(path.join(tlsDir, "key.pem")), cert: fs.readFileSync(path.join(tlsDir, "cert.pem")) }, (req, res) => res.end("secure"));
      await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));

      // A CONNECT proxy that records where each tunnel goes.
      tunnels = [];
      proxy = http.createServer((req, res) => res.writeHead(405).end());
      proxy.on("connect", (req, socket, head) => {
        tunnels.push(req.url);
        sockets.push(socket);
        const [host, port] = req.url.split(":");
        const upstream = net.connect(Number(port), host, () => {
          sockets.push(upstream);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      // Tunnels and kept-alive TLS connections would hold the servers open.
      sockets.forEach((socket) => socket.destroy());
      tls?.closeAllConnections();
      await new Promise((resolve) => (tls ? tls.close(resolve) : resolve()));
      await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve()));
      fs.rmSync(tlsDir, { recursive: true, force: true });
    });

    beforeEach(() => (tunnels.length = 0));

    const tlsUrl = () => `https://127.0.0.1:${tls.address().port}/`;
    const proxyUrl = () => `http://127.0.0.1:${proxy.address().port}`;

    it("refuses a self-signed certificate unless allowUntrustedCerts is set", async () => {
      let run = await runCommand("http", "execute", { url: tlsUrl(), method: "GET", allowUntrustedCerts: "false" });
      expect(run.code).to.equal(1);
      expect(run.output).to.include("self-signed certificate");
      run = await runCommand("http", "execute", { url: tlsUrl(), method: "GET", allowUntrustedCerts: "true" });
      expect(run.code, run.output).to.equal(0);
      expect(run.results).to.deep.equal({ statusCode: "200", response: "secure" });
    });

    it("goes through HTTP_PROXY, untrusted certificate option included, and skips it for a NO_PROXY host", async () => {
      let run = await runCommand("http", "execute", { url: tlsUrl(), method: "GET", allowUntrustedCerts: "true" }, { HTTP_PROXY: proxyUrl(), NO_PROXY: "" });
      expect(run.code, run.output).to.equal(0);
      expect(tunnels).to.deep.equal([`127.0.0.1:${tls.address().port}`]);
      expect(run.results.response).to.equal("secure");

      run = await runCommand("http", "execute", { url: `${server.url}/direct`, method: "GET" }, { HTTP_PROXY: proxyUrl(), NO_PROXY: "localhost, .127.0.0.1" });
      expect(run.code, run.output).to.equal(0);
      expect(tunnels).to.have.length(1);
      expect(server.requests.map((r) => r.path)).to.deep.equal(["/direct"]);
    });
  });
});
