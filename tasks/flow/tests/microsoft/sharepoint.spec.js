import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { runCommand, tempDir } from "../helpers/harness.js";
import { microsoftServer, credentials, ACCESS_TOKEN } from "./teams.spec.js";

const SITE_ID = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";

describe("sharepoint commands", function () {
  this.timeout(30000);
  let server;
  let reply;
  let dir;

  // The site and library lookups every command makes; anything else goes to `reply`.
  beforeEach(async () => {
    dir = tempDir();
    reply = () => undefined;
    server = await microsoftServer((req, n) => {
      if (req.path === "/v1.0/sites/contoso.sharepoint.com:/sites/Engineering") {
        return { status: 200, body: { id: SITE_ID } };
      }
      if (req.path === `/v1.0/sites/${SITE_ID}/drives`) {
        return { status: 200, body: { value: [{ id: "drive-docs", name: "Documents", webUrl: "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents" }, { id: "drive-rel", name: "Releases", webUrl: "https://contoso.sharepoint.com/sites/Engineering/Releases" }] } };
      }
      if (req.path === `/v1.0/sites/${SITE_ID}/drive`) {
        return { status: 200, body: { id: "drive-docs" } };
      }
      return reply(req, n);
    });
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const site = { ...credentials, site: "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Forms/AllItems.aspx" };

  describe("uploadFile", () => {
    it("puts a small file into a folder of the named library", async () => {
      const local = path.join(dir, "report.json");
      fs.writeFileSync(local, '{"ok":true}');
      reply = () => ({ status: 201, body: { id: "item-1", name: "report.json", webUrl: "https://contoso.sharepoint.com/sites/Engineering/Releases/Build%2042/report.json" } });
      const run = await runCommand("sharepoint", "uploadFile", { ...site, library: "releases", filePath: local, folder: "Build 42", fileName: "", conflictBehavior: "" }, server.env);
      expect(run.code, run.output).to.equal(0);
      const upload = server.graphRequests().at(-1);
      expect(upload.method).to.equal("PUT");
      expect(upload.path).to.equal("/v1.0/drives/drive-rel/root:/Build 42/report.json:/content");
      expect(upload.url).to.include("/root:/Build%2042/report.json:/content");
      expect(upload.query).to.deep.equal({ "@microsoft.graph.conflictBehavior": "replace" });
      expect(upload.text).to.equal('{"ok":true}');
      expect(upload.headers.authorization).to.equal(`Bearer ${ACCESS_TOKEN}`);
      expect(run.results).to.deep.equal({ itemId: "item-1", webUrl: "https://contoso.sharepoint.com/sites/Engineering/Releases/Build%2042/report.json", name: "report.json" });
    });

    it("finds a library by its URL name too, and refuses an unknown one with the names it has", async () => {
      const local = path.join(dir, "a.txt");
      fs.writeFileSync(local, "a");
      reply = () => ({ status: 201, body: { id: "i", name: "a.txt" } });
      let run = await runCommand("sharepoint", "uploadFile", { ...site, library: "Shared Documents", filePath: local }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests().at(-1).path).to.equal("/v1.0/drives/drive-docs/root:/a.txt:/content");

      run = await runCommand("sharepoint", "uploadFile", { ...site, library: "Archive", filePath: local }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("No document library 'Archive' on the site; it has: Documents, Releases");
    });

    it("sends a large file through an upload session in 320 KiB-multiple chunks, without the token", async () => {
      const local = path.join(dir, "image.tar");
      const size = 12 * 1024 * 1024 + 5;
      const bytes = Buffer.alloc(size, 7);
      fs.writeFileSync(local, bytes);
      const received = [];
      reply = (req) => {
        if (req.path.endsWith(":/createUploadSession")) {
          return { status: 200, body: { uploadUrl: `${server.url}/upload-session/xyz` } };
        }
        if (req.path === "/upload-session/xyz") {
          received.push(req);
          const [, end] = req.headers["content-range"].match(/bytes \d+-(\d+)\//);
          return Number(end) === size - 1 ? { status: 201, body: { id: "big", name: "image.tar", webUrl: "w" } } : { status: 202, body: { nextExpectedRanges: [`${Number(end) + 1}-`] } };
        }
      };
      const run = await runCommand("sharepoint", "uploadFile", { ...site, filePath: local, folder: "/images/", conflictBehavior: "rename" }, server.env);
      expect(run.code, run.output).to.equal(0);
      const session = server.graphRequests().find((r) => r.path.endsWith(":/createUploadSession"));
      expect(session.path).to.equal("/v1.0/drives/drive-docs/root:/images/image.tar:/createUploadSession");
      expect(session.json).to.deep.equal({ item: { "@microsoft.graph.conflictBehavior": "rename" } });
      expect(received.map((r) => r.headers["content-range"])).to.deep.equal([
        `bytes 0-10485759/${size}`,
        `bytes 10485760-${size - 1}/${size}`,
      ]);
      expect(received.every((r) => r.headers.authorization === undefined)).to.equal(true);
      expect(Buffer.concat(received.map((r) => r.body)).equals(bytes)).to.equal(true);
      expect(run.results.itemId).to.equal("big");
    });

    it("refuses a missing file before connecting", async () => {
      const run = await runCommand("sharepoint", "uploadFile", { ...site, filePath: path.join(dir, "nope.txt") }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("filePath does not exist");
      expect(server.requests).to.have.length(0);
    });
  });

  describe("downloadFile", () => {
    it("downloads through the pre-authorised URL into a directory, keeping the name", async () => {
      reply = (req) => {
        if (req.path === "/v1.0/drives/drive-docs/root:/Build 42/notes.md:") {
          return { status: 200, body: { id: "item-2", name: "notes.md", size: 9, file: {}, "@microsoft.graph.downloadUrl": `${server.url}/download/notes?tempauth=t` } };
        }
        if (req.path === "/download/notes") {
          return { status: 200, body: Buffer.from("# Notes\n\n") };
        }
      };
      const run = await runCommand("sharepoint", "downloadFile", { ...site, library: "", path: "Build 42/notes.md", destinationPath: dir + "/" }, server.env);
      expect(run.code, run.output).to.equal(0);
      const target = path.join(dir, "notes.md");
      expect(fs.readFileSync(target, "utf8")).to.equal("# Notes\n\n");
      expect(server.requests.find((r) => r.path === "/download/notes").headers.authorization).to.equal(undefined);
      expect(run.results).to.deep.equal({ path: target, size: "9" });
    });

    it("fails and leaves nothing when the bytes do not match the listed size", async () => {
      reply = (req) => (req.path === "/download/x" ? { status: 200, body: "short" } : { status: 200, body: { id: "i", name: "x.bin", size: 100, file: {}, "@microsoft.graph.downloadUrl": `${server.url}/download/x` } });
      const target = path.join(dir, "out.bin");
      const run = await runCommand("sharepoint", "downloadFile", { ...site, path: "x.bin", destinationPath: target }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Downloaded 5 bytes of x.bin, but SharePoint lists 100");
      expect(fs.readdirSync(dir)).to.deep.equal([]);
    });

    it("refuses a folder", async () => {
      reply = () => ({ status: 200, body: { id: "f", name: "Build 42", folder: { childCount: 2 } } });
      const run = await runCommand("sharepoint", "downloadFile", { ...site, path: "Build 42", destinationPath: dir }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("Build 42 is a folder, not a file");
    });
  });

  describe("listFiles", () => {
    const page = (names, next) => ({ status: 200, body: { value: names.map((name, i) => ({ id: name, name, size: i, webUrl: `w/${name}`, lastModifiedDateTime: "2026-10-01T00:00:00Z", ...(name.endsWith("/") ? { folder: {} } : { file: {} }) })), ...(next ? { "@odata.nextLink": next } : {}) } });

    it("lists a folder across pages, by a Graph site ID", async () => {
      reply = (req) => {
        if (req.path === "/v1.0/drives/drive-docs/root:/Build 42:/children") {
          return page(["a.txt", "logs/"], `${server.url}/v1.0/drives/drive-docs/items/x/children?$skiptoken=2`);
        }
        if (req.path === "/v1.0/drives/drive-docs/items/x/children") {
          return page(["b.txt"]);
        }
      };
      const run = await runCommand("sharepoint", "listFiles", { ...credentials, site: SITE_ID, folder: "Build 42" }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(server.graphRequests()[1].query.$top).to.equal("200");
      expect(server.graphRequests()[2].query).to.deep.equal({ $skiptoken: "2" });
      expect(run.results.count).to.equal("3");
      expect(JSON.parse(run.results.files)).to.deep.equal([
        { name: "a.txt", path: "Build 42/a.txt", type: "file", size: 0, lastModified: "2026-10-01T00:00:00Z", webUrl: "w/a.txt" },
        { name: "logs/", path: "Build 42/logs/", type: "folder", size: 1, lastModified: "2026-10-01T00:00:00Z", webUrl: "w/logs/" },
        { name: "b.txt", path: "Build 42/b.txt", type: "file", size: 0, lastModified: "2026-10-01T00:00:00Z", webUrl: "w/b.txt" },
      ]);
    });

    it("lists the library root, and needs outputFile for a listing too large for a result", async () => {
      const names = Array.from({ length: 60 }, (_, i) => `file-${i}.txt`);
      reply = (req) => (req.path === "/v1.0/drives/drive-docs/root/children" ? page(names) : undefined);
      let run = await runCommand("sharepoint", "listFiles", { ...site }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("more than a task result can carry");

      const out = path.join(dir, "listing.json");
      run = await runCommand("sharepoint", "listFiles", { ...site, outputFile: out }, server.env);
      expect(run.code, run.output).to.equal(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).to.have.length(60);
      expect(run.results).to.deep.equal({ count: "60", outputPath: out });
    });

    it("refuses a site that is neither a URL nor a site ID", async () => {
      const run = await runCommand("sharepoint", "listFiles", { ...credentials, site: "Engineering" }, server.env);
      expect(run.code).to.equal(1);
      expect(run.output).to.include("site must be a SharePoint site URL or a Graph site ID");
    });
  });
});
