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
  fitResult,
  writeOutputFile,
  proxyOptions,
  serviceMessage,
  TaskError,
} from "../libs/task.js";
import { graphClient, credentialsFrom } from "../libs/msgraph.js";

/**
 * SharePoint document libraries through Microsoft Graph with an app-only token: upload a workspace
 * file, download one to the workspace, list a folder.
 */

// Files up to this size go in one PUT; larger ones through a resumable upload session.
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
// An upload session takes chunks in multiples of 320 KiB: 32 of them is 10 MiB.
const CHUNK_SIZE = 32 * 320 * 1024;
const CONFLICT_BEHAVIORS = ["replace", "fail", "rename"];
const GRAPH_SITE_ID = /^[\w.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i;

/** A path within a library as a Graph path segment: each part encoded, slashes kept. */
function encodePath(itemPath) {
  return itemPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** The Graph path of an item (or folder) in a drive; blank is the library's root. */
function itemRef(driveId, itemPath) {
  const encoded = encodePath(itemPath ?? "");
  return encoded ? `/drives/${driveId}/root:/${encoded}:` : `/drives/${driveId}/root`;
}

/**
 * The site's ID from a site URL (https://contoso.sharepoint.com/sites/Engineering, or any page under
 * it) or a Graph site ID (hostname,siteCollectionId,webId).
 */
async function resolveSite(graph, site) {
  const value = site.trim();
  if (GRAPH_SITE_ID.test(value)) {
    return value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TaskError(`site must be a SharePoint site URL or a Graph site ID, got '${value}'`);
  }
  // A page or library URL under the site is cut back to /sites/<name> or /teams/<name>.
  const match = url.pathname.match(/^\/(sites|teams)\/[^/]+/i);
  const ref = match ? `${url.hostname}:/${encodePath(decodeURIComponent(match[0]))}` : url.hostname;
  const { data } = await graph.call(`Finding the site ${value}`, { method: "GET", url: `/sites/${ref}`, params: { $select: "id,webUrl" } });
  return data.id;
}

/** The drive ID of a document library by name (its display name or its URL name); blank is the site's default library. */
async function resolveDrive(graph, siteId, library) {
  if (!library) {
    const { data } = await graph.call("Finding the site's document library", { method: "GET", url: `/sites/${siteId}/drive`, params: { $select: "id" } });
    return data.id;
  }
  const { data } = await graph.call("Listing the site's document libraries", {
    method: "GET",
    url: `/sites/${siteId}/drives`,
    params: { $select: "id,name,webUrl" },
  });
  const wanted = library.trim().toLowerCase();
  const drives = data.value ?? [];
  const drive = drives.find(
    (d) => d.name?.toLowerCase() === wanted || decodeURIComponent(d.webUrl?.split("/").pop() ?? "").toLowerCase() === wanted,
  );
  if (!drive) {
    throw new TaskError(`No document library '${library}' on the site; it has: ${drives.map((d) => d.name).join(", ") || "none"}`);
  }
  return drive.id;
}

/** Connects, then resolves the site and library the params name. */
async function openLibrary() {
  const { site, library } = params;
  required({ site }, ["site"]);
  const graph = await graphClient(credentialsFrom(params));
  const siteId = await resolveSite(graph, site);
  const driveId = await resolveDrive(graph, siteId, library);
  return { graph, driveId };
}

/** Sends a large file in chunks through an upload session; the session URL is pre-authorised, so it takes no token. */
async function uploadInSession(graph, driveId, remotePath, local, size, conflictBehavior) {
  const { data: session } = await graph.call("Starting the upload session", {
    method: "POST",
    url: `${itemRef(driveId, remotePath)}/createUploadSession`,
    data: { item: { "@microsoft.graph.conflictBehavior": conflictBehavior } },
  });
  const fd = fs.openSync(local, "r");
  try {
    for (let start = 0; start < size; start += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, size - start);
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, start);
      const response = await axios.put(session.uploadUrl, chunk, {
        headers: { "Content-Length": length, "Content-Range": `bytes ${start}-${start + length - 1}/${size}` },
        maxBodyLength: Infinity,
        validateStatus: () => true,
        ...proxyOptions(),
      });
      if (response.status >= 400) {
        await axios.delete(session.uploadUrl, { validateStatus: () => true, ...proxyOptions() });
        const detail = serviceMessage(response.data);
        throw new TaskError(`Uploading bytes ${start}-${start + length - 1} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      log.debug(`Uploaded ${start + length} of ${size} bytes`);
      // The last chunk answers 200 or 201 with the new item.
      if (start + length >= size) {
        return response.data;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export async function uploadFile() {
  await run("SharePoint uploadFile", async () => {
    const { filePath, folder, fileName, conflictBehavior } = params;
    required({ filePath }, ["filePath"]);
    const behavior = conflictBehavior || "replace";
    if (!CONFLICT_BEHAVIORS.includes(behavior)) {
      throw new TaskError(`conflictBehavior must be one of ${CONFLICT_BEHAVIORS.join(", ")}, got '${conflictBehavior}'`);
    }
    const local = sourceFile(filePath, "filePath");
    const size = fs.statSync(local).size;
    const remotePath = [folder ?? "", fileName || path.basename(local)].join("/");

    const { graph, driveId } = await openLibrary();
    let item;
    if (size <= SIMPLE_UPLOAD_MAX) {
      ({ data: item } = await graph.call("Uploading the file", {
        method: "PUT",
        url: `${itemRef(driveId, remotePath)}/content`,
        params: { "@microsoft.graph.conflictBehavior": behavior },
        headers: { "Content-Type": "application/octet-stream" },
        data: fs.readFileSync(local),
      }));
    } else {
      item = await uploadInSession(graph, driveId, remotePath, local, size, behavior);
    }
    log.good(`Uploaded ${local} (${size} bytes) as ${item.name}: ${item.webUrl}`);
    await results({ itemId: item.id, webUrl: item.webUrl ?? "", name: item.name });
  });
}

export async function downloadFile() {
  await run("SharePoint downloadFile", async () => {
    const { path: remotePath, destinationPath } = params;
    required({ path: remotePath, destinationPath }, ["path", "destinationPath"]);

    const { graph, driveId } = await openLibrary();
    const { data: item } = await graph.call(`Finding ${remotePath}`, {
      method: "GET",
      url: itemRef(driveId, remotePath),
      params: { $select: "id,name,size,file,folder,@microsoft.graph.downloadUrl" },
    });
    if (item.folder || !item.file) {
      throw new TaskError(`${remotePath} is a folder, not a file`);
    }
    // The download URL is pre-authorised for a short time, so the token stays with Graph.
    const response = await axios.get(item["@microsoft.graph.downloadUrl"], {
      responseType: "stream",
      validateStatus: () => true,
      ...proxyOptions(),
    });
    if (response.status !== 200) {
      response.data.destroy();
      throw new TaskError(`Downloading ${remotePath} failed with HTTP ${response.status}`);
    }
    const target = destinationFile(destinationPath, item.name);
    const { size } = await writeStream(response.data, target);
    if (typeof item.size === "number" && size !== item.size) {
      fs.rmSync(target, { force: true });
      throw new TaskError(`Downloaded ${size} bytes of ${remotePath}, but SharePoint lists ${item.size}`);
    }
    log.good(`Downloaded ${remotePath} (${size} bytes) to ${target}`);
    await results({ path: target, size });
  });
}

export async function listFiles() {
  await run("SharePoint listFiles", async () => {
    const { folder, outputFile } = params;
    const { graph, driveId } = await openLibrary();

    const base = (folder ?? "").split("/").filter(Boolean).join("/");
    const entries = [];
    let next = `${itemRef(driveId, base)}/children`;
    let query = { $select: "id,name,size,webUrl,lastModifiedDateTime,file,folder", $top: 200 };
    while (next) {
      const { data } = await graph.call(`Listing ${base || "the library root"}`, { method: "GET", url: next, params: query });
      for (const entry of data.value ?? []) {
        entries.push({
          name: entry.name,
          path: base ? `${base}/${entry.name}` : entry.name,
          type: entry.folder ? "folder" : "file",
          size: entry.size ?? 0,
          lastModified: entry.lastModifiedDateTime ?? "",
          webUrl: entry.webUrl ?? "",
        });
      }
      // nextLink is absolute and carries its own query.
      next = data["@odata.nextLink"];
      query = undefined;
    }
    log.good(`${entries.length} item(s) in ${base || "the library root"}`);

    const listing = JSON.stringify(entries);
    const listResults = { count: entries.length };
    if (outputFile) {
      listResults.outputPath = writeOutputFile(outputFile, listing);
    }
    const files = fitResult(listing, "The listing", outputFile);
    if (files !== undefined) {
      listResults.files = files;
    }
    await results(listResults);
  });
}
