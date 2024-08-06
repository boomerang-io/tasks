import { log } from "@boomerang-io/task-core";

export function hello() {
  log.sys("Hello from Boomerang Flow!");
}

export function helloFriend() {
  const { FLOW_FRIEND: name } = process.env;

  log.sys("Hello " + name + ", welcome to Boomerang Flow!");
}
