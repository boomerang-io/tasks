import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { runCommand, tempDir } from "../helpers/harness.js";

describe("system jsonpath commands", function () {
  this.timeout(30000);
  const doc = JSON.stringify({ auth: { token: "tok-secret-123" }, items: [{ id: 1 }, { id: 2 }] });

  it("sets the matched value as evaluation, and keeps it out of the log", async () => {
    const run = await runCommand("system", "jsonPathToProperty", { json: doc, query: "$.auth.token" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results).to.deep.equal({ evaluation: "tok-secret-123" });
    expect(run.output).to.not.include("tok-secret-123");
    expect(run.output).to.include("the query matched a string");
  });

  it("sets an object or array match as JSON", async () => {
    const run = await runCommand("system", "jsonPathToProperty", { json: doc, query: "$.items" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results.evaluation).to.equal('[{"id":1},{"id":2}]');
  });

  it("succeeds with an empty evaluation and a warning when nothing matches", async () => {
    const run = await runCommand("system", "jsonPathToProperty", { json: doc, query: "$.missing" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results).to.deep.equal({ evaluation: "" });
    expect(run.output).to.include("The query '$.missing' matched nothing");
  });

  it("fails on a missing query or an invalid expression", async () => {
    let run = await runCommand("system", "jsonPathToProperty", { json: doc, query: "" });
    expect(run.code).to.equal(1);
    run = await runCommand("system", "jsonPathToProperty", { json: doc, query: "$..[?(" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("Invalid JSON path expression");
  });

  it("reads a file by absolute path, and resolves a relative one against /workspace", async () => {
    const dir = tempDir();
    const file = path.join(dir, "out.json");
    fs.writeFileSync(file, doc);
    let run = await runCommand("system", "jsonFilePathToProperty", { filePath: file, query: "$.items[1].id" });
    expect(run.code, run.output).to.equal(0);
    expect(run.results).to.deep.equal({ evaluation: "2" });
    run = await runCommand("system", "jsonFilePathToProperty", { filePath: "workflowrun/out.json", query: "$.a" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("/workspace/workflowrun/out.json");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
