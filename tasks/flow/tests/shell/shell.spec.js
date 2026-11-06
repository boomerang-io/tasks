import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { runCommand, tempDir } from "../helpers/harness.js";

describe("shell execute", function () {
  this.timeout(30000);
  let dir;
  beforeEach(() => (dir = fs.realpathSync(tempDir())));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("runs in the directory given, with or without a trailing slash", async () => {
    for (const given of [dir, `${dir}/`]) {
      const run = await runCommand("shell", "execute", { path: given, shell: "", script: "pwd" });
      expect(run.code, run.output).to.equal(0);
      expect(run.output).to.include(`${dir}\n`);
    }
  });

  it("resolves a relative directory against /workspace, and fails on one that does not exist", async () => {
    const run = await runCommand("shell", "execute", { path: "workflowrun/repo", shell: "", script: "pwd" });
    expect(run.code).to.equal(1);
    expect(run.output).to.include("No such directory: /workspace/workflowrun/repo");
  });

  it("fails with the script's exit status", async () => {
    const run = await runCommand("shell", "execute", { path: dir, shell: "", script: "echo before\nexit 3" });
    expect(run.code).to.equal(3);
  });

  it("keeps the last command's status by default, and stops at the first failure with failOnError", async () => {
    const script = "false\necho after-the-failure";
    let run = await runCommand("shell", "execute", { path: dir, shell: "", script });
    expect(run.code, run.output).to.equal(0);
    expect(run.output).to.include("after-the-failure");

    run = await runCommand("shell", "execute", { path: dir, shell: "", script, failOnError: "true" });
    expect(run.code).to.equal(1);
    expect(run.output).to.not.include("after-the-failure");
  });
});
