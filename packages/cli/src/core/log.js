import chalk from "chalk";
import { format } from "date-fns";
import { isDebug } from "./config";

const formatted = format(new Date(), "yyyy-MM-dd HH:mm:ss");

export function out(...args) {
  console.log(chalk.white("  ", args[1]));
}

export function debug(...args) {
  if (isDebug) {
    console.log(chalk.gray(formatted, "🔍 ", ...args));
  }
}

export function sys(...args) {
  console.log(chalk.blue(formatted, "🤖 ", ...args));
}

export function ci(...args) {
  console.log(
    chalk.blue(formatted, "🏗️ ", "-".repeat(20), ...args, "-".repeat(20))
  );
}

export function good(...args) {
  console.log(chalk.green(formatted, "✅ ", ...args));
}

export function warn(...args) {
  console.log(chalk.yellow(formatted, "⚠️ ", ...args));
}

export function err(...args) {
  console.log(chalk.red(formatted, "❗ ", ...args));
}
