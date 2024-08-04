const chalk = require("chalk");
const { format } = require("date-fns");
const { isDebug } = require("./config");

const formatted = format(new Date(), "yyyy-MM-dd HH:mm:ss");

module.exports = {
  out(...args) {
    console.log(chalk.white("  ", args[1]));
  },
  debug(...args) {
    if (isDebug) {
      console.log(chalk.gray(formatted, "🔍 ", ...args);
    }
  },
  sys(...args) {
    console.log(chalk.blue(formatted, "🤖 ", ...args));
  },
  ci(...args) {
    console.log(
      chalk.blue(formatted, "🏗️ ", "-".repeat(20), ...args, "-".repeat(20))
    );
  },
  good(...args) {
    console.log(chalk.green(formatted, "✅ ", ...args));
  },
  warn(...args) {
    console.log(chalk.yellow(formatted, "⚠️ ", ...args));
  },
  err(...args) {
    console.log(chalk.red(formatted, "❗ ", ...args));
  },
};
