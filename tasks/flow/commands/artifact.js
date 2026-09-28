import { log, params } from "@boomerang-io/task-core";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Content type the dispatcher uses for a folder artifact, packed as a tarball of its contents.
const TAR_CONTENT_TYPE = "application/vnd.boomerang.artifact.tar+gzip";
const MAX_ERROR_BODY_BYTES = 1024;

// Agent for the presigned-URL request, mirroring the HTTP_PROXY handling used by the other commands.
function proxyAgent() {
  if (!process.env.HTTP_PROXY) {
    return undefined;
  }
  log.debug("Using Proxy", process.env.HTTP_PROXY);
  return new HttpsProxyAgent(process.env.HTTP_PROXY);
}

// params.headers is a JSON object string, possibly empty or missing; every header it lists must be sent as-is.
function parseHeaders(json) {
  const headers = json ? JSON.parse(json) : {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new Error("The parameter 'headers' is not a JSON object");
  }
  return headers;
}

// Buffers up to `max` bytes of a response stream/string for an error log, never the whole body.
async function truncatedBody(data, max = MAX_ERROR_BODY_BYTES) {
  if (typeof data === "string") {
    return data.slice(0, max);
  }
  if (!data || typeof data.on !== "function") {
    return JSON.stringify(data).slice(0, max);
  }
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    data.on("data", (chunk) => {
      if (buffer.length < max) {
        buffer = Buffer.concat([buffer, chunk]);
      } else {
        data.destroy();
      }
    });
    data.once("close", () => resolve(buffer.subarray(0, max).toString("utf8")));
    data.once("error", () => resolve(buffer.subarray(0, max).toString("utf8")));
  });
}

// Renames across filesystems too, falling back to copy+remove when the temp dir and destination differ in mount.
function moveFile(sourcePath, destinationPath) {
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (e) {
    if (e.code !== "EXDEV") {
      throw e;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    fs.rmSync(sourcePath, { force: true });
  }
}

export async function upload() {
  log.debug("Started Artifact Upload Command");

  // params["retention-days"] is read and applied by Flow, not the worker; nothing to do with it here.
  const { name: artifactName, path: sourcePath, url: artifactUrl, headers: headersParam } = params;

  if (!artifactUrl) {
    log.err("The parameter 'url' is not defined or empty");
    process.exit(1);
    return;
  }
  if (!sourcePath) {
    log.err("The parameter 'path' is not defined or empty");
    process.exit(1);
    return;
  }
  if (!fs.existsSync(sourcePath)) {
    log.err(`Path does not exist: ${sourcePath}`);
    process.exit(1);
    return;
  }

  let tempTarball;
  try {
    const headers = parseHeaders(headersParam);
    const isDirectory = fs.statSync(sourcePath).isDirectory();

    let uploadPath = sourcePath;
    let contentType = "application/octet-stream";
    if (isDirectory) {
      tempTarball = path.join(os.tmpdir(), `${crypto.randomUUID()}.tar.gz`);
      // -C sourcePath so the archive holds the directory's contents, not the directory itself.
      await execFileAsync("tar", ["-czf", tempTarball, "-C", sourcePath, "."]);
      uploadPath = tempTarball;
      contentType = TAR_CONTENT_TYPE;
    }

    const size = fs.statSync(uploadPath).size;
    const response = await axios.put(artifactUrl, fs.createReadStream(uploadPath), {
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": size,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpsAgent: proxyAgent(),
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      log.err(`Artifact upload failed with status ${response.status}:`, await truncatedBody(response.data));
      process.exit(1);
      return;
    }

    log.good(`Uploaded artifact '${artifactName}'`, `(${size} bytes)`);
  } catch (e) {
    log.err(e);
    process.exit(1);
    return;
  } finally {
    if (tempTarball) {
      fs.rmSync(tempTarball, { force: true });
    }
  }

  log.debug("Finished Artifact Upload Command");
}

export async function download() {
  log.debug("Started Artifact Download Command");

  const { name: artifactName, path: destinationPath, url: artifactUrl, headers: headersParam, sha256: artifactSha256, contentType: artifactContentType } = params;

  if (!artifactUrl) {
    log.err("The parameter 'url' is not defined or empty");
    process.exit(1);
    return;
  }
  if (!artifactSha256) {
    log.err("The parameter 'sha256' is not defined or empty");
    process.exit(1);
    return;
  }
  if (!destinationPath) {
    log.err("The parameter 'path' is not defined or empty");
    process.exit(1);
    return;
  }

  const tempFile = path.join(os.tmpdir(), `${crypto.randomUUID()}.download`);
  try {
    const headers = parseHeaders(headersParam);
    const response = await axios.get(artifactUrl, {
      headers,
      responseType: "stream",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpsAgent: proxyAgent(),
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      log.err(`Artifact download failed with status ${response.status}:`, await truncatedBody(response.data));
      process.exit(1);
      return;
    }

    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(tempFile);
      response.data.on("data", (chunk) => hash.update(chunk));
      response.data.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      response.data.pipe(writeStream);
    });

    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== artifactSha256.toLowerCase()) {
      fs.rmSync(tempFile, { force: true });
      log.err(`SHA-256 mismatch: expected ${artifactSha256}, got ${actualSha256}`);
      process.exit(1);
      return;
    }

    if (artifactContentType === TAR_CONTENT_TYPE) {
      fs.mkdirSync(destinationPath, { recursive: true });
      await execFileAsync("tar", ["-xzf", tempFile, "-C", destinationPath]);
      fs.rmSync(tempFile, { force: true });
    } else {
      const isDirectory = fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory();
      const target = isDirectory || destinationPath.endsWith("/") ? path.join(destinationPath, artifactName) : destinationPath;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      moveFile(tempFile, target);
    }

    log.good(`Downloaded artifact '${artifactName}' to ${destinationPath}`);
  } catch (e) {
    fs.rmSync(tempFile, { force: true });
    log.err(e);
    process.exit(1);
    return;
  }

  log.debug("Finished Artifact Download Command");
}
