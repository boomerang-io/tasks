import { log, params, results } from "@boomerang-io/task-core";
import axios from "axios";
import fs from "fs";
import path from "path";
import {
  run,
  required,
  sourceFile,
  destinationFile,
  writeStream,
  fileSha256,
  proxyOptions,
  serviceMessage,
  TaskError,
} from "../libs/task.js";

/**
 * JFrog Artifactory: download an artifact to the workspace, or upload a workspace file. The
 * credential is an access token (sent as a Bearer token), an API key (which JFrog no longer
 * issues), or a username and password, in that order of preference.
 */

function authHeaders({ accessToken, apiKey, username, password }) {
  if (accessToken) {
    return { Authorization: `Bearer ${accessToken}` };
  }
  if (apiKey) {
    return { "X-JFrog-Art-Api": apiKey };
  }
  if (username && password) {
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }
  log.warn("No access token, API key, or username and password: the request is anonymous");
  return {};
}

/** The artifact URL, checked; never logged with any credential, since none travels in it. */
function artifactUrl(url) {
  required({ url }, ["url"]);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new TaskError(`url must be the artifact's http(s) URL, got '${url}'`);
  }
}

export async function downloadFile() {
  await run("Artifactory downloadFile", async () => {
    const { url, destinationPath } = params;
    const target = artifactUrl(url);
    required({ destinationPath }, ["destinationPath"]);

    const response = await axios.get(target.href, {
      headers: authHeaders(params),
      responseType: "stream",
      maxContentLength: Infinity,
      validateStatus: () => true,
      ...proxyOptions(),
    });
    if (response.status !== 200) {
      response.data.destroy();
      throw new TaskError(`Downloading ${target.href} failed with HTTP ${response.status}`);
    }
    const file = destinationFile(destinationPath, decodeURIComponent(path.posix.basename(target.pathname)) || "artifact");
    // Artifactory sends the stored checksum with the file, so a corrupt transfer is caught here.
    const { size, sha256 } = await writeStream(response.data, file, response.headers["x-checksum-sha256"]);
    log.good(`Downloaded ${target.href} (${size} bytes) to ${file}`);
    await results({ path: file, size, sha256 });
  });
}

export async function uploadFile() {
  await run("Artifactory uploadFile", async () => {
    const { url, file } = params;
    const target = artifactUrl(url);
    required({ file }, ["file"]);
    const local = sourceFile(file, "file");
    const size = fs.statSync(local).size;
    const sha256 = await fileSha256(local);

    const response = await axios.put(target.href, fs.createReadStream(local), {
      headers: { ...authHeaders(params), "Content-Type": "application/octet-stream", "Content-Length": size },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
      ...proxyOptions(),
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = serviceMessage(response.data);
      throw new TaskError(`Uploading to ${target.href} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    // Artifactory answers with the checksums it computed; a mismatch means the bytes stored are not the file sent.
    const stored = response.data?.checksums?.sha256;
    if (stored && stored.toLowerCase() !== sha256) {
      throw new TaskError(`Artifactory stored sha256 ${stored}, but ${local} is ${sha256}`);
    }
    log.good(`Uploaded ${local} (${size} bytes) to ${response.data?.downloadUri ?? target.href}`);
    await results({ downloadUri: response.data?.downloadUri ?? target.href, sha256, size });
  });
}
