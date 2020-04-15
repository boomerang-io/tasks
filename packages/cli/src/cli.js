"use strict";

const program = require("commander");
const inquirer = require("inquirer");
const requireAll = require("require-all");
const { init } = require("./scripts");
require("dotenv").config();
const { log } = require("@boomerang-worker/core");

/**
 * Prompt user to input name for command
 */
const askNameOfCommand = async () => {
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

async function cli(process) {
  //Import all Command Modules
  let commands = {};
  try {
    commands = requireAll({
      // dirname: __dirname + "/commands",
      dirname: `${process.cwd()}/commands`,
      filter: /(.+)\.js$/,
      excludeDirs: /^\.(git|svn)$/,
      recursive: true,
    });
  } catch (err) {
    log.warn("Error getting commands", err);
  }
  //CLI Commands
  program.version("2.0.0").description("Boomerang Worker CLI");
  log.sys(program.description(), program.version());

  /**
   * Initialize a project
   */
  program
    .command("init")
    .description("Initialize a Boomerang Worker project")

    .action(async () => {
      const { workerName, commmandName } = await askNameOfCommand();
      init(workerName, commmandName);
    });

  /**
   * Run command methods
   */
  program.arguments("<cmd> <method>").action((cmd, method) => {
    const command = commands[cmd] && commands[cmd][method];

    if (typeof command === "function") {
      log.sys("Executing", cmd, method);
      command();
    } else {
      log.err(`Could not find method ${method} for command ${cmd}`);
    }
  });

  program.parse(process.argv);
}

module.exports = cli;
