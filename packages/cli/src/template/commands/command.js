"use strict";

const { log } = require("@boomerang-io/worker-core");

function hello() {
  log.sys("Hello from Boomerang");
}

module.exports = {
  hello,
};
