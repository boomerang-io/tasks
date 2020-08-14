"use strict";

const program = require("commander");
const inquirer = require("inquirer");
const requireAll = require("require-all");
const { log } = require("@boomerang-io/worker-core");
const { init } = require("./scripts");
require("dotenv").config();

/**
 * Prompt user for questions to initialize a project
 */
const askInitQuestions = async () => {
  const question = [
    {
      name: "workerName",
      type: "input",
      message: `Enter worker name (used to name the project with boomerang.worker.<workerName> convention)`,
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
  ];
  return await inquirer.prompt(question);
};

/**
 * Boomerang Worker CLI
 * @param {EventEmitter} process - global Node.js process object for the current process
 */
async function cli(process) {
  program.version("2.0.0").description("Boomerang Worker CLI");
  log.sys(program.description(), program.version());

  /**
   * Command to initialize a project
   */
  program
    .command("init")
    .description("Initialize a Boomerang Worker project")

    .action(async () => {
      const { workerName, commmandName } = await askInitQuestions();
      init(workerName, commmandName);
    });

  /**
   * Command to run user command methods
   */
  program.arguments("<cmd> <method>").action((cmd, method) => {
    // Import all Command Modules
    let commands = {};
    try {
      // TODO: filter out test and other non-compliant .js files
      commands = requireAll({
        dirname: `${process.cwd()}/commands`,
        filter: /(.+)\.js$/,
        excludeDirs: /^\.(git|svn|test|tests|__tests__)$/,
        recursive: true,
      });
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

module.exports = cli;
