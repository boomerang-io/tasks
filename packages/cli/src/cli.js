import { program } from "commander";
import fs from "fs";
import filePath from "path";
import inquirer from "inquirer";
import { log } from "@boomerang-io/task-core";
import init from "./scripts/init.js";
import "dotenv/config";

/**
 * Prompt user for questions to initialize a project
 */
const askInitQuestions = async () => {
  const question = [
    {
      name: "taskName",
      type: "input",
      message: `Enter Task name (used to name the project in package.json)`,
      default: "template",
      validate: (input) => {
        if (/^([.a-z\-_\d])+$/.test(input)) {
          return true;
        } else {
          return "Worker name may only include lower-case letters, dots, numbers, underscores and hashes.";
        }
      },
    },
    {
      name: "commmandName",
      type: "input",
      message: `Enter command (used to name the module and to invoke its methods)`,
      default: "command",
      validate: (input) => {
        if (!input) {
          return "Command is required";
        }

        if (/^([A-Za-z])+$/.test(input)) {
          return true;
        } else {
          return "Command may only include letters";
        }
      },
    },
    {
      name: "directory",
      type: "input",
      message: `Where should we create your new worker?`,
      default: "./",
      validate: (input) => {
        if (/^[a-zA-Z0-9._\-\/]+$/.test(input)) {
          return true;
        } else {
          return "Directory is required. Enter './' for current location.";
        }
      },
    },
    {
      name: "initGit",
      type: "confirm",
      message: `Would you like to initialise Git?`,
      default: true,
    },
  ];
  return await inquirer.prompt(question);
};

/** Find all command files */
async function importAll(directory) {
  const excludePattern = /^\.(git|svn|test|tests|__tests__)$/;
  const modules = {};

  const files = fs.readdirSync(directory);
  for (const file of files) {
    if (excludePattern.test(file)) {
      continue; // Skip files or directories that match the exclusion pattern
    }
    const fullPath = filePath.join(directory, file);
    const stat = fs.statSync(fullPath);

    if (stat.isFile() && file.endsWith(".js")) {
      const moduleName = filePath.basename(file, ".js");
      const module = await import(fullPath);
      modules[moduleName] = module;
    } else if (stat.isDirectory()) {
      modules[file] = await importAll(fullPath);
    }
  }

  return modules;
}

/**
 * Boomerang Worker CLI
 * @param {EventEmitter} process - global Node.js process object for the current process
 */
export default async function cli(process) {
  program.version("4.0.0").description("Boomerang Task CLI");
  log.sys(program.description(), program.version());

  /**
   * Command to initialize a task
   */
  program
    .command("init")
    .description("Initialize a Boomerang Task from template")
    .action(async () => {
      const { taskName, commmandName, directory, initGit } =
        await askInitQuestions();
      init(taskName, commmandName, directory, initGit);
    });

  /**
   * Command to run user command methods
   */
  program.arguments("<cmd> <method>").action(async (cmd, method) => {
    // Import all Command Modules
    let commands = {};
    try {
      // Filter out test and other non-compliant .js files
      commands = await importAll(`${process.cwd()}/commands`);
    } catch (err) {
      log.err("Failed to register commands", err);
      return;
    }

    log.debug("Registered commands:", JSON.stringify(commands));

    // Check that command exists
    const registeredCommand = commands[cmd];
    if (!registeredCommand || typeof registeredCommand !== "object") {
      log.err(`Could not find command ${cmd}`);
      return;
    }

    // Look for method on command and call it
    const registeredMethod = registeredCommand[method];
    if (typeof registeredMethod === "function") {
      log.sys("Executing", cmd, method);
      registeredMethod();
    } else {
      log.err(`Could not find method ${method} for command ${cmd}`);
      return;
    }
  });

  program.parse(process.argv);
}
