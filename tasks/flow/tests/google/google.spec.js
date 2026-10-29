import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockServer, runCommand, tempDir } from "../helpers/harness.js";
import { serviceAccount } from "../../libs/google.js";

const hook = fileURLToPath(new URL("../hooks/google-mock.mjs", import.meta.url));
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const KEY_FILE = { type: "service_account", project_id: "flow", private_key_id: "k1", private_key: PRIVATE_KEY, client_email: "flow-bot@flow.iam.gserviceaccount.com", client_id: "1" };
// The key file as a single-line field delivers it: the newlines between members gone, the key's own as \n escapes.
const PASTED_KEY = JSON.stringify(KEY_FILE);

describe("google service-account credentials", () => {
  it("reads the whole JSON key file, pasted into a one-line field", () => {
    expect(PASTED_KEY).to.not.include("\n");
    expect(serviceAccount({ serviceAccountKey: PASTED_KEY })).to.deep.equal({ email: "flow-bot@flow.iam.gserviceaccount.com", key: PRIVATE_KEY });
  });

  it("reads the key file as downloaded, pretty-printed across lines", () => {
    expect(serviceAccount({ serviceAccountKey: JSON.stringify(KEY_FILE, null, 2) }).key).to.equal(PRIVATE_KEY);
  });

  it("prefers the key file over clientEmail and privateKey", () => {
    expect(serviceAccount({ serviceAccountKey: PASTED_KEY, clientEmail: "old@x", privateKey: "old" }).email).to.equal("flow-bot@flow.iam.gserviceaccount.com");
  });

  it("keeps the older clientEmail and privateKey, turning literal \\n into line breaks", () => {
    const typed = PRIVATE_KEY.replace(/\n/g, "\\n");
    expect(serviceAccount({ serviceAccountKey: "", clientEmail: "a@b", privateKey: typed })).to.deep.equal({ email: "a@b", key: PRIVATE_KEY });
  });

  it("refuses a key that is not JSON without echoing any of it", () => {
    const broken = PASTED_KEY.slice(0, -1);
    expect(() => serviceAccount({ serviceAccountKey: broken })).to.throw("serviceAccountKey is not valid JSON").with.property("message").that.does.not.include("PRIVATE");
  });

  it("refuses another kind of key, and a key file without its key", () => {
    expect(() => serviceAccount({ serviceAccountKey: JSON.stringify({ type: "authorized_user", client_id: "x" }) })).to.throw("'authorized_user' key");
    expect(() => serviceAccount({ serviceAccountKey: JSON.stringify({ type: "service_account", client_email: "a@b" }) })).to.throw("no client_email or private_key");
    expect(() => serviceAccount({ serviceAccountKey: "[]" })).to.throw("must be the JSON key file");
  });

  it("asks for the key file when nothing is given", () => {
    expect(() => serviceAccount({})).to.throw("Give serviceAccountKey");
  });
});

describe("google commands", function () {
  // googleapis is slow to load, and a test may run a command three times.
  this.timeout(120000);
  let server;
  let reply;
  let dir;
  const google = (values) => ({ serviceAccountKey: PASTED_KEY, ...values });
  const env = () => ({ GOOGLE_MOCK_URL: server.url, NODE_OPTIONS: `--import=${hook}` });

  beforeEach(async () => {
    dir = tempDir();
    reply = () => undefined;
    server = await mockServer((req, n) => reply(req, n));
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("authenticates Sheets with the key file's service account", async () => {
    reply = () => ({ status: 200, body: { valueRanges: [{ values: [["a", "1"]] }, { values: [["b", "2"]] }] } });
    const run = await runCommand("googlesheets", "getData", google({ spreadsheetId: "sheet-1", ranges: "A1:B1,A2:B2" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].path).to.equal("/v4/spreadsheets/sheet-1/values:batchGet");
    expect(server.requests[0].headers.authorization).to.equal("Bearer test-token-for-flow-bot@flow.iam.gserviceaccount.com");
    expect(run.results.rows).to.equal('[["a","1"],["b","2"]]');
  });

  it("appends Sheets rows, which used to fail on an undeclared variable", async () => {
    reply = () => ({ status: 200, body: { updates: { updatedRows: 2 } } });
    const run = await runCommand("googlesheets", "append", google({ spreadsheetId: "sheet-1", range: "A1", values: "a;1\nb;2" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].json).to.deep.equal({ values: [["a", "1"], ["b", "2"]] });
  });

  it("fails a Sheets task on a broken key without printing it", async () => {
    const run = await runCommand("googlesheets", "getData", google({ serviceAccountKey: PASTED_KEY.slice(0, 40), spreadsheetId: "s", ranges: "A1" }), env());
    expect(run.code).to.equal(1);
    expect(run.output).to.include("serviceAccountKey is not valid JSON");
    expect(run.output).to.not.include("service_account");
    expect(server.requests).to.have.length(0);
  });

  it("copies a Drive file, which used to fail on an undeclared variable", async () => {
    reply = () => ({ status: 200, body: { id: "copy-1", name: "Copy" } });
    const run = await runCommand("googledrive", "copyFile", google({ fileId: "f1", parents: "folder-a", fileName: "Copy" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].json).to.deep.equal({ parents: ["folder-a"], name: "Copy" });
    expect(run.results.id).to.equal("copy-1");
  });

  it("lists a shared drive's files when driveId is set, under both result names", async () => {
    reply = () => ({ status: 200, body: { files: [{ id: "a" }] } });
    const run = await runCommand("googledrive", "listFiles", google({ query: "name contains 'report'", corpora: "", driveId: "drive-9" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].query).to.include({ corpora: "drive", driveId: "drive-9", includeItemsFromAllDrives: "true", supportsAllDrives: "true", q: "name contains 'report'" });
    expect(run.results.results).to.equal('{"files":[{"id":"a"}]}');
    expect(run.results.result).to.equal(run.results.results);
  });

  it("uploads a workspace file into a shared-drive folder", async () => {
    const local = path.join(dir, "build.log");
    fs.writeFileSync(local, "build ok\n");
    reply = () => ({ status: 200, body: { id: "new-1", name: "build-42.log", webViewLink: "https://drive.google.com/file/d/new-1/view" } });
    const run = await runCommand("googledrive", "uploadFile", google({ filePath: local, folderId: "folder-a", fileName: "build-42.log", mimeType: "text/plain" }), env());
    expect(run.code, run.output).to.equal(0);
    const [req] = server.requests;
    expect(req.path).to.equal("/upload/drive/v3/files");
    expect(req.query).to.include({ uploadType: "multipart", supportsAllDrives: "true" });
    expect(req.text).to.include('{"name":"build-42.log","parents":["folder-a"]}');
    expect(req.text).to.include("content-type: text/plain\r\n\r\nbuild ok\n");
    expect(req.text).to.include("build ok\n");
    expect(run.results).to.deep.equal({ fileId: "new-1", fileName: "build-42.log", webViewLink: "https://drive.google.com/file/d/new-1/view" });
  });

  it("downloads a stored file into a directory under its name", async () => {
    reply = (req) => (req.query.alt === "media" ? { status: 200, body: Buffer.from("%PDF-1.7") } : { status: 200, body: { id: "f1", name: "spec.pdf", mimeType: "application/pdf", size: "8" } });
    const run = await runCommand("googledrive", "downloadFile", google({ fileId: "f1", destinationPath: dir }), env());
    expect(run.code, run.output).to.equal(0);
    expect(fs.readFileSync(path.join(dir, "spec.pdf"), "utf8")).to.equal("%PDF-1.7");
    expect(run.results).to.deep.equal({ path: path.join(dir, "spec.pdf"), size: "8", mimeType: "application/pdf" });
  });

  it("exports a Google Doc, as .docx by default or as exportMimeType", async () => {
    reply = (req) => (req.path.endsWith("/export") ? { status: 200, body: Buffer.from(`exported as ${req.query.mimeType}`) } : { status: 200, body: { id: "d1", name: "Runbook", mimeType: "application/vnd.google-apps.document" } });
    let run = await runCommand("googledrive", "downloadFile", google({ fileId: "d1", destinationPath: dir + "/" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(run.results.path).to.equal(path.join(dir, "Runbook.docx"));
    expect(server.requests[1].path).to.equal("/drive/v3/files/d1/export");

    run = await runCommand("googledrive", "downloadFile", google({ fileId: "d1", destinationPath: path.join(dir, "runbook.pdf"), exportMimeType: "application/pdf" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(fs.readFileSync(path.join(dir, "runbook.pdf"), "utf8")).to.equal("exported as application/pdf");
  });

  it("refuses to download a folder", async () => {
    reply = () => ({ status: 200, body: { id: "f", name: "Reports", mimeType: "application/vnd.google-apps.folder" } });
    const run = await runCommand("googledrive", "downloadFile", google({ fileId: "f", destinationPath: dir }), env());
    expect(run.code).to.equal(1);
    expect(run.output).to.include("Reports is a folder, not a file");
  });

  it("shares a file with a user, with or without the notification email", async () => {
    reply = (req) => (req.path.endsWith("/permissions") ? { status: 200, body: { id: "perm-1" } } : { status: 200, body: { webViewLink: "https://drive.google.com/file/d/f1/view" } });
    const run = await runCommand("googledrive", "shareFile", google({ fileId: "f1", type: "user", role: "writer", emailAddress: "dev@acme.com", sendNotificationEmail: "false", emailMessage: "" }), env());
    expect(run.code, run.output).to.equal(0);
    const [create] = server.requests;
    expect(create.path).to.equal("/drive/v3/files/f1/permissions");
    expect(create.query).to.include({ sendNotificationEmail: "false", supportsAllDrives: "true" });
    expect(create.json).to.deep.equal({ type: "user", role: "writer", emailAddress: "dev@acme.com" });
    expect(run.results).to.deep.equal({ permissionId: "perm-1", webViewLink: "https://drive.google.com/file/d/f1/view" });
  });

  it("shares with anyone with the link, and checks what each share type needs", async () => {
    reply = (req) => (req.path.endsWith("/permissions") ? { status: 200, body: { id: "perm-2" } } : { status: 200, body: { webViewLink: "l" } });
    let run = await runCommand("googledrive", "shareFile", google({ fileId: "f1", type: "anyone", role: "reader" }), env());
    expect(run.code, run.output).to.equal(0);
    expect(server.requests[0].json).to.deep.equal({ type: "anyone", role: "reader" });
    expect(server.requests[0].query).to.not.have.property("sendNotificationEmail");

    run = await runCommand("googledrive", "shareFile", google({ fileId: "f1", type: "domain", role: "reader" }), env());
    expect(run.code).to.equal(1);
    expect(run.output).to.include("Sharing with a domain needs the domain");
    run = await runCommand("googledrive", "shareFile", google({ fileId: "f1", type: "user", role: "owner", emailAddress: "a@b" }), env());
    expect(run.code).to.equal(1);
    expect(run.output).to.include("role must be one of reader, commenter, writer");
  });

  it("reports Google's error message without the bearer token", async () => {
    reply = () => ({ status: 404, body: { error: { code: 404, message: "File not found: f9.", errors: [{ reason: "notFound" }], status: "NOT_FOUND" } } });
    const run = await runCommand("googledrive", "shareFile", google({ fileId: "f9", type: "anyone", role: "reader" }), env());
    expect(run.code).to.equal(1);
    expect(run.output).to.include("HTTP 404: NOT_FOUND: File not found: f9.");
    expect(run.output).to.not.include("test-token-for");
  });
});
