"use strict";

const core = require("@boomerang-worker/core");

function command() {
  core.log.good("Made it here!");
}

module.export = command;
