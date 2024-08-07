import results from "./results.js";

/**
 * Result helper utility for v4
 *
 * - Pass in a single result to be saved for Tekton to retrieve
 */

export default async function set(key, value) {
  await results({ [key]: value });
}
