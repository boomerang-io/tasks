import { log, params, results, result } from "@boomerang-io/task-core";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

/**
 * checkIfEmpty - Check if param is set or not, in case of mandatory inputs
 * unsetField - Removes every property from object, with the name 'fieldName'
 * checkParameters - Validates all attributes of the supplied object. Returns true if all parameters are valid.
 * checkForJson - Validates the payload is JSON
 */
import { checkIfEmpty } from "../libs/utilities.js";
import { googleAuth } from "../libs/google.js";
import { run, required, asBoolean, sourceFile, destinationFile, writeStream, describeError, TaskError } from "../libs/task.js";

//Internal helper function
function assertExists(value, message) {
  if (value !== 0 && !value) {
    log.err(message);
    process.exit(1);
  }
}

/**
 * Create service account credentials: the JSON key file in serviceAccountKey, or the older
 * clientEmail and privateKey.
 * @description see https://developers.google.com/drive/api/v3/reference/files/copy?hl=en_GB#auth
 */
function getJwtClient(values) {
  try {
    return googleAuth(values, ["https://www.googleapis.com/auth/drive"]);
  } catch (e) {
    log.err(describeError(e));
    process.exit(1);
  }
}

// A Google API failure without the request config, which carries the bearer token.
function fail(err) {
  log.err(describeError(err));
  process.exit(1);
}

export async function copyFile() {
  log.debug("Starting Copy File task");

  const { fileId, parents, fileName } = params;
  const drive = google.drive({
    version: "v3",
    auth: getJwtClient(params),
  });
  assertExists(fileId, "FileId must be provided");

  let parentsArray = [];
  if (!checkIfEmpty(parents) && parents !== null) {
    parentsArray = parents.split("\n");
  }
  let requestBody = {
    parents: parentsArray,
  };
  if (!checkIfEmpty(fileName) && fileName !== null) {
    requestBody.name = fileName;
  }

  await drive.files
    .copy({
      fileId: fileId,
      fields: "id, name, parents, createdTime, modifiedTime, owners, permissions, shared, webViewLink",
      requestBody: requestBody,
      supportsAllDrives: true,
    })
    .then(async (response) => {
      log.debug("Response Received:", JSON.stringify(response.data));
      log.good("File successfully copied.");
      await results(response.data);
    })
    .catch(fail);

  log.debug("Finished Copy File task");
}

export async function listFiles() {
  log.debug("Starting List Files task");

  const { query, corpora, driveId } = params;
  const drive = google.drive({
    version: "v3",
    auth: getJwtClient(params),
  });

  // A shared drive's files are listed only when the request says it can handle them.
  const sharedDrives = Boolean(corpora || driveId);
  await drive.files
    .list({
      fields: "*",
      q: query || undefined,
      corpora: corpora || (driveId ? "drive" : undefined),
      driveId: driveId || undefined,
      includeItemsFromAllDrives: sharedDrives || undefined,
      supportsAllDrives: sharedDrives || undefined,
    })
    .then(async (response) => {
      const data = JSON.stringify(response.data);
      log.sys("Response Received:", data);
      // The definition declares "results"; "result" is what this command wrote before, kept for flows that read it.
      await results({ results: data, result: data });
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished List Files task");
}

export async function listFilePermissions() {
  log.debug("Starting List File Permissions task");

  const { fileId } = params;
  const drive = google.drive({
    version: "v3",
    auth: getJwtClient(params),
  });
  assertExists(fileId, "FileID must be provided");

  await drive.permissions
    .list({
      fileId: fileId,
      supportsAllDrives: true,
    })
    .then(async (response) => {
      log.sys("Response Received:", JSON.stringify(response.data));
      await result("permissions", JSON.stringify(response.data));
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished List File Permissions task");
}

export async function deleteFile() {
  log.debug("Starting Delete File task");

  const { fileId } = params;
  const drive = google.drive({
    version: "v3",
    auth: getJwtClient(params),
  });
  assertExists(fileId, "FileId must be provided");

  await drive.files
    .delete({
      fileId: fileId,
      supportsAllDrives: true,
    })
    .then((response) => {
      // No data is provided in response of a successful deletion.
      log.debug("Status: " + response.status + " " + response.statusText);
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished Delete File task");
}

/** A Drive client for the newer commands, which fail through run() rather than exiting here. */
function driveClient() {
  return google.drive({ version: "v3", auth: googleAuth(params, ["https://www.googleapis.com/auth/drive"]) });
}

export async function uploadFile() {
  await run("Google Drive uploadFile", async () => {
    const { filePath, folderId, fileName, mimeType } = params;
    required({ filePath }, ["filePath"]);
    const local = sourceFile(filePath, "filePath");
    const drive = driveClient();

    // A service account has no Drive storage of its own, so the folder belongs in a shared drive it can write to.
    const { data } = await drive.files.create({
      requestBody: {
        name: fileName || path.basename(local),
        parents: folderId ? [folderId] : undefined,
      },
      media: { mimeType: mimeType || undefined, body: fs.createReadStream(local) },
      fields: "id, name, size, webViewLink",
      supportsAllDrives: true,
    });
    log.good(`Uploaded ${local} as '${data.name}' (${data.id})`);
    await results({ fileId: data.id, fileName: data.name, webViewLink: data.webViewLink ?? "" });
  });
}

// What a Google Docs, Sheets, Slides or Drawings file exports to when exportMimeType is blank, and the extension it gets.
const EXPORTS = {
  "application/vnd.google-apps.document": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  "application/vnd.google-apps.spreadsheet": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  "application/vnd.google-apps.presentation": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  "application/vnd.google-apps.drawing": ["image/png", ".png"],
};
const EXTENSIONS = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/rtf": ".rtf",
  "application/zip": ".zip",
  "application/epub+zip": ".epub",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

export async function downloadFile() {
  await run("Google Drive downloadFile", async () => {
    const { fileId, destinationPath, exportMimeType } = params;
    required({ fileId, destinationPath }, ["fileId", "destinationPath"]);
    const drive = driveClient();

    const { data: file } = await drive.files.get({ fileId, fields: "id, name, mimeType, size", supportsAllDrives: true });
    if (file.mimeType === "application/vnd.google-apps.folder") {
      throw new TaskError(`${file.name} is a folder, not a file`);
    }

    let response;
    let name = file.name;
    let mimeType = file.mimeType;
    if (file.mimeType.startsWith("application/vnd.google-apps.")) {
      // A Google Docs file has no bytes of its own: it is exported (to 10 MB) as another format.
      mimeType = exportMimeType || EXPORTS[file.mimeType]?.[0] || "application/pdf";
      const extension = EXTENSIONS[mimeType] ?? "";
      if (extension && !name.toLowerCase().endsWith(extension)) {
        name += extension;
      }
      response = await drive.files.export({ fileId, mimeType }, { responseType: "stream" });
    } else {
      if (exportMimeType) {
        log.warn(`exportMimeType applies to Google Docs, Sheets, Slides and Drawings; ${file.name} is ${file.mimeType}, so it downloads as-is`);
      }
      response = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    }

    const target = destinationFile(destinationPath, name);
    const { size } = await writeStream(response.data, target);
    log.good(`Downloaded '${file.name}' (${size} bytes, ${mimeType}) to ${target}`);
    await results({ path: target, size, mimeType });
  });
}

const SHARE_TYPES = ["user", "group", "domain", "anyone"];
const SHARE_ROLES = ["reader", "commenter", "writer"];

export async function shareFile() {
  await run("Google Drive shareFile", async () => {
    const { fileId, type, role, emailAddress, domain, sendNotificationEmail, emailMessage } = params;
    required({ fileId, type, role }, ["fileId", "type", "role"]);
    if (!SHARE_TYPES.includes(type)) {
      throw new TaskError(`type must be one of ${SHARE_TYPES.join(", ")}, got '${type}'`);
    }
    if (!SHARE_ROLES.includes(role)) {
      throw new TaskError(`role must be one of ${SHARE_ROLES.join(", ")}, got '${role}'`);
    }
    if ((type === "user" || type === "group") && !emailAddress) {
      throw new TaskError(`Sharing with a ${type} needs its emailAddress`);
    }
    if (type === "domain" && !domain) {
      throw new TaskError("Sharing with a domain needs the domain");
    }
    const drive = driveClient();

    // Google sends the notification by default when sharing with a user or group; it never does for a domain or anyone.
    const notifies = type === "user" || type === "group";
    const { data: permission } = await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      sendNotificationEmail: notifies ? asBoolean(sendNotificationEmail, true) : undefined,
      emailMessage: notifies && emailMessage ? emailMessage : undefined,
      requestBody: {
        type,
        role,
        emailAddress: notifies ? emailAddress : undefined,
        domain: type === "domain" ? domain : undefined,
      },
      fields: "id",
    });
    const { data: file } = await drive.files.get({ fileId, fields: "webViewLink", supportsAllDrives: true });
    log.good(`Shared ${fileId} with ${type === "anyone" ? "anyone with the link" : emailAddress || domain} as ${role}`);
    await results({ permissionId: permission.id, webViewLink: file.webViewLink ?? "" });
  });
}
