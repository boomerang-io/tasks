import { program } from "commander";
import inquirer from "inquirer";
import * as log  from "./core/log.js"
import init from './scripts/init.js'
import 'dotenv/config';

/**
 * Prompt user for questions to initialize a project
 */
const askInitQuestions = async () => {
  const question = [
    {
      name: "workerName",
      type: "input",
      message: `Enter worker name (used to name the project in package.json)`,
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
  ];
  return await inquirer.prompt(question);
};

/** Find all command files */
async function importAll(directory) {
  const excludePattern = /^\.(git|svn|test|tests|__tests__)$/;
  const modules = {};

  const files = readdirSync(directory);
  for (const file of files) {
    if (excludePattern.test(file)) {
      continue; // Skip files or directories that match the exclusion pattern
    }
    const fullPath = join(directory, file);
    const stat = statSync(fullPath);

    if (stat.isFile() && file.endsWith('.js')) {
      const moduleName = basename(file, '.js');
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
  program.version("4.0.0").description("Boomerang Worker CLI");
  log.sys(program.description(), program.version());

  /**
   * Command to initialize a project
   */
  program
    .command("init")
    .description("Initialize a Boomerang Worker project")
    .action(async () => {
      const { workerName, commmandName, directory } = await askInitQuestions();
      init(workerName, commmandName, directory);
    });

  /**
   * Command to run user command methods
   */
  program.arguments("<cmd> <method>").action((cmd, method) => {
    // Import all Command Modules
    let commands = {};
    try {
      // Filter out test and other non-compliant .js files
      commands = importAll(`${process.cwd()}/commands`);
    } catch (err) {
      log.err("Failed to register commands", err);
      return;
    }

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