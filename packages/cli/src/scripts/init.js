import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import spawn from "cross-spawn";
import { fileURLToPath } from 'url';
import { log } from "@boomerang-io/task-core";

const CURR_DIR = process.cwd();

/**
 * @param {string} value - string to capitalize
 */
function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase() + value.slice(1)}`;
}

/**
 *  Check if directory at path is a git repo
 * @param {string} path - path to project directory
 */
function isInGitRepository(path) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: path, stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Try initializing git repo at path
 * @param {string} projectPath - path to project directory
 */
function tryGitInit(projectPath) {
  try {
    execSync("git --version", { cwd: projectPath, stdio: "ignore" });
    if (isInGitRepository()) {
      return false;
    }
    execSync("git init", { cwd: projectPath, stdio: "ignore" });
    return true;
  } catch (e) {
    log.warn("Git repo not initialized", e);
    return false;
  }
}

/**
 * Try first commit at path
 * @param {string} projectPath - path to project directory
 */
function tryGitCommit(projectPath) {
  try {
    execSync("git add -A", { cwd: projectPath, stdio: "ignore" });

    // first commit must be done without commitlint verification
    execSync('git commit -m "feat: initialize project using Boomerang Task cli" --no-verify', {
      cwd: projectPath,
      stdio: "ignore",
    });
    return true;
  } catch (e) {
    // We couldn't commit in already initialized git repo,
    // maybe the commit author config is not set.
    // In the future, we might supply our own committer
    // like Ember CLI does, but for now, let's just
    // remove the Git files to avoid a half-done state.
    log.warn("Git commit not created", e);
    log.warn("Removing .git directory...");
    try {
      // unlinkSync() doesn't work on directories.
      fs.removeSync(path.join(projectPath, ".git"));
    } catch (removeErr) {
      // Ignore.
    }
    return false;
  }
}

/**
 * Install project dependencies
 * @param {string} projectPath - path to project directory
 */
function installDependencies(projectPath) {
  const command = "pnpm";
  const args = ["install"];
  const proc = spawn.sync(command, args, { cwd: projectPath, stdio: "inherit" });
  if (proc.status !== 0) {
    log.err(`${command} ${args.join(" ")} failed`);
    return;
  }
}

/**
 * Intall @boomerang-worker dependencies
 * @param {string} projectPath - path to project directory
 */
function installBoomerangWorkerDependencies(projectPath) {
  const command = "pnpm";
  const args = ["install", "@boomerang-io/task-cli"];
  const proc = spawn.sync(command, args, { cwd: projectPath, stdio: "inherit" });
  if (proc.status !== 0) {
    log.err(`${command} ${args.join(" ")} failed`);
    return;
  }
}

/**
 * Update project package.json based on user input
 * @param {string} fileContent
 * @param {string} projectName
 */
function updatePackageJson(fileContent, projectName) {
  const packageJson = JSON.parse(fileContent);
  packageJson.name = projectName;
  packageJson.description = projectName.split(".").map(capitalize).join(" ");
  packageJson.repository = `git@github.com:boomerang-io/task-${projectName}.git`;
  packageJson.dependencies = {}; // Set to empty so latest versions of @boomerang-worker are installed
  return JSON.stringify(packageJson);
}

/**
 * Update readme based on user input
 * @param {string} fileContent
 * @param {string} commandName
 */
function updateReadme(fileContent, commandName) {
  const newFileContent = fileContent
    .replace(/command\.js/g, `${commandName}.js`)
    .replace(/command\.spec\.js/g, `${commandName}.spec.js`);
  return newFileContent;
}

/**
 * Recursively copy files from template directory to new project one
 * @param {string} templatePath - path to worker template
 * @param {string} projectName
 * @param {string} commandName
 * @param {string} directory - path to folder where project will be created
 */
function createDirectoryContents(templatePath, projectName, commandName, directory) {
  const filesToCreate = fs.readdirSync(templatePath);

  filesToCreate.forEach((file) => {
    const origFilePath = `${templatePath}/${file}`;

    // get stats about the current file
    const stats = fs.lstatSync(origFilePath);

    if (stats.isFile()) {
      let fileContent = fs.readFileSync(origFilePath, "utf8");

      // rename to command passed by user
      if (file === "command.js") {
        file = `${commandName}.js`;
      }

      // rename to command passed by user
      if (file === "command.spec.js") {
        file = `${commandName}.spec.js`;
      }

      // rename to account for .gitignore being renamed by npm
      if (file === "gitignore") {
        file = ".gitignore";
      }

      if (file === "package.json") {
        fileContent = updatePackageJson(fileContent, projectName);
      }

      if (file === "README.md") {
        fileContent = updateReadme(fileContent, commandName);
      }

      const writePath = `${directory}/${file}`;
      fs.writeFileSync(writePath, fileContent, "utf8");
    } else if (stats.isDirectory()) {
      fs.mkdirSync(`${directory}/${file}`);

      // recursive call if in directory
      createDirectoryContents(`${templatePath}/${file}`, projectName, commandName, `${directory}/${file}`);
    }
  });
}

/**
 * Initialize project given user input
 * @param {string} taskName
 * @param {string} commandName
 * @param {string} directory
 * @param {boolean} initGit
 */
export default function init(taskName, commandName, directory, initGit) {
  let fullProjectName = taskName;

  // Harcoded check for format
  // 2024/08/04 - Deprecated. No longer needs to start with a specific opinionated name
  // if (!projectName.startsWith(`boomerang.worker.`)) {
  //   fullProjectName = `boomerang.worker.${projectName}`;
  // }

  const fullProjectPath = `${CURR_DIR}/${directory}`;

  if (isInGitRepository(CURR_DIR)) {
    log.err("You are currently in a .git repo. Aborting...");
    return;
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const templatePath = path.resolve(__dirname, "../template");

    // create directory and add contents to directory
    fs.mkdirSync(fullProjectPath, { recursive: true });
    createDirectoryContents(templatePath, fullProjectName, commandName, fullProjectPath);
    log.sys(`Created project directory ${fullProjectName}`);

    // initialize git repo
    if (initGit) {
      tryGitInit(fullProjectPath);
      log.sys(`Initialized git repo in ${fullProjectName}`);
    }

    // install dependencies
    log.sys(`Installing project dependencies for ${fullProjectName}`);
    installBoomerangWorkerDependencies(fullProjectPath);
    installDependencies(fullProjectPath);

    // initial commit
    if (initGit) {
      tryGitCommit(fullProjectPath);
      log.sys(`Made initial commit`);
    }

    log.good(`All done! Your project has been initialized at ${fullProjectName}`);
  } catch (err) {
    log.err("Something went wrong", err);
  }
}