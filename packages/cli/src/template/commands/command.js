"use strict";

const { log } = require("@boomerang-io/worker-core");

function hello() {
  log.sys("Hello from Boomerang Flow!");
}

function helloFriend() {
  const { FLOW_FRIEND: name } = process.env;

  log.sys("Hello " + name + ", welcome to Boomerang Flow!");
}

module.exports = {
  hello,
  helloFriend,
};
