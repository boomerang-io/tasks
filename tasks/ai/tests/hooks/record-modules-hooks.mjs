import fs from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (process.env.TASK_AI_MODULE_RECORD) {
    fs.appendFileSync(process.env.TASK_AI_MODULE_RECORD, `${result.url}\n`);
  }
  return result;
}
