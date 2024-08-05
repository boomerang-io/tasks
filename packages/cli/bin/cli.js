#!/usr/bin/env node

import cli from '../src/cli.js';
import * as log from "@boomerang-io/task-core";

const { node: currentNodeVersion } = process.versions;
const semver = currentNodeVersion.split(".");
const major = semver[0];

process.on("unhandledRejection", (error) => {
  log.err(error);
});

function checkNodeVersion() {
  if (major < 18) {
    log.err(
      `You are running Node ${currentNodeVersion}.\n` +
      `boomerang-task-cli requires Node 18 or higher, please update your ` +
      `version of Node.`
    );
    process.exit(1);
  }
}

checkNodeVersion();

cli(process).catch((error) => {
  log.err(error);
  process.exit(1);
});
