#!/usr/bin/env node

import cli from './src/cli';
import { log } from "../src/core";

const { node: currentNodeVersion } = process.versions;
const semver = currentNodeVersion.split(".");
const major = semver[0];

process.on("unhandledRejection", (error) => {
  log.err(error);
});

if (major < 18) {
  log.err(
    `You are running Node ${currentNodeVersion}.\n` +
      `boomerang-worker-cli requires Node 18 or higher, please update your ` +
      `version of Node.`
  );
  process.exit(1);
}

cli(process).catch((error) => {
  log.err(error);
  process.exit(1);
});
