import { expect } from "chai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(new URL("../helpers/run-command.js", import.meta.url));

// Runs one commands/file.js export in its own process, the way the dispatcher does.
function runCommand(command, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, "file", command], {
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

describe("file commands", () => {
  let tmpDir;
  let filePath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-flow-file-"));
    filePath = path.join(tmpDir, "testfile.txt");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("createFile", () => {
    it("writes the content to the path", async () => {
      const result = await runCommand(
        "createFile",
        paramEnv({ path: filePath, content: "pandas are adorable" })
      );

      expect(result.code, result.stderr).to.equal(0);
      expect(await fs.readFile(filePath, "utf-8")).to.equal("pandas are adorable");
    });

    it("creates missing parent directories when createDir is set", async () => {
      const nestedPath = path.join(tmpDir, "a", "b", "testfile.txt");
      const result = await runCommand(
        "createFile",
        paramEnv({ path: nestedPath, content: "pandas are adorable", createDir: "true" })
      );

      expect(result.code, result.stderr).to.equal(0);
      expect(await fs.readFile(nestedPath, "utf-8")).to.equal("pandas are adorable");
    });
  });

  describe("checkFileContainsString", () => {
    it("succeeds when the expression is found", async () => {
      await fs.writeFile(filePath, "pandas are adorable");
      const result = await runCommand(
        "checkFileContainsString",
        paramEnv({ path: filePath, expression: "pandas", failIfNotFound: "true" })
      );

      expect(result.code, result.stderr).to.equal(0);
    });

    it("fails when the expression is missing and failIfNotFound is set", async () => {
      await fs.writeFile(filePath, "pandas are adorable");
      const result = await runCommand(
        "checkFileContainsString",
        paramEnv({ path: filePath, expression: "koalas", failIfNotFound: "true" })
      );

      expect(result.code).to.equal(1);
    });
  });

  describe("replaceStringInFile", () => {
    it("replaces the matched string in place", async () => {
      await fs.writeFile(filePath, "pandas are adorable");
      const result = await runCommand(
        "replaceStringInFile",
        paramEnv({ path: filePath, expression: "pandas", replaceString: "dogs" })
      );

      expect(result.code, result.stderr).to.equal(0);
      expect(await fs.readFile(filePath, "utf-8")).to.equal("dogs are adorable");
    });
  });
});
