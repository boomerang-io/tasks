import { log, params, results, result } from "@boomerang-io/task-core";
import { google } from "googleapis";
import { googleAuth } from "../libs/google.js";
import { describeError } from "../libs/task.js";

//Internal helper function
function assertExists(value, message) {
  if (value !== 0 && !value) {
    log.err(message);
    process.exit(1);
  }
}

// get service account auth credentials: the JSON key file, or the older clientEmail and privateKey
function getJwtClient(values) {
  try {
    return googleAuth(values, ["https://www.googleapis.com/auth/spreadsheets"]);
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

export async function create() {
  log.debug("Starting create Google Sheet task");

  const { title } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(title, "Title must be provided");

  const resource = {
    properties: {
      title,
    },
  };

  await sheets.spreadsheets
    .create({
      resource,
    })
    .then(async (response) => {
      const spreadsheet = JSON.stringify(response.data);
      log.sys("Response Received:", spreadsheet);
      await result("spreadsheet", spreadsheet);
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished create Google Sheet task");
}

export async function addSheet() {
  log.debug("Starting addSheet Google Sheets task");

  const { spreadsheetId, title } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(title, "Title must be provided");

  const requestBody = {
    requests: [
      {
        addSheet: {
          properties: {
            title,
          },
        },
      },
    ],
  };

  await sheets.spreadsheets
    .batchUpdate({
      spreadsheetId,
      requestBody,
    })
    .then((response) => {
      const spreadsheet = JSON.stringify(response.data);
      log.sys("Response Received:", spreadsheet);
      log.good("Successfully added sheet!");
    })
    .catch(fail);

  log.debug("Finished addSheet Google Sheets task");
}

export async function deleteSheet() {
  log.debug("Starting deleteSheet Google Sheets task");

  const { spreadsheetId, sheetId } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(sheetId, "Sheet Id must be provided");

  const requestBody = {
    requests: [
      {
        deleteSheet: {
          sheetId,
        },
      },
    ],
  };

  await sheets.spreadsheets
    .batchUpdate({
      spreadsheetId,
      requestBody,
    })
    .then((response) => {
      const spreadsheet = JSON.stringify(response.data);
      log.sys("Response Received:", spreadsheet);
      log.good("Successfully deleted sheet!");
    })
    .catch(fail);

  log.debug("Finished deleteSheet Google Sheets task");
}

export async function copySheetTo() {
  log.debug("Starting copySheetTo Google Sheets task");

  const {
    fromSpreadsheetId,
    sheetId,
    toSpreadsheetId,
  } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(fromSpreadsheetId, "The source spreadsheet Id must be provided");
  assertExists(
    toSpreadsheetId,
    "The destination spreadsheet Id must be provided"
  );
  assertExists(sheetId, "Sheet Id must be provided");

  await sheets.spreadsheets.sheets
    .copyTo({
      sheetId,
      spreadsheetId: fromSpreadsheetId,
      requestBody: {
        destinationSpreadsheetId: toSpreadsheetId,
      },
    })
    .then((response) => {
      const spreadsheet = JSON.stringify(response.data);
      log.sys("Response Received:", spreadsheet);
      log.good("Successfully copied sheet!");
    })
    .catch(fail);

  log.debug("Finished copySheetTo Google Sheets task");
}

export async function getData() {
  log.debug("Starting getData Google Sheets task");

  const { spreadsheetId, ranges } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(ranges, "Ranges must be provided");

  await sheets.spreadsheets.values
    .batchGet({
      spreadsheetId,
      ranges: ranges.split(","),
    })
    .then(async (body) => {
      const values = JSON.stringify(
        body.data.valueRanges
          .map((r) => r.values)
          .reduce((a, b) => a.concat(b), [])
      );
      log.sys("Response Received:", values);
      await result("rows", values);
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished getData Google Sheets task");
}

export async function clearData() {
  log.debug("Starting clearData Google Sheets task");

  const { spreadsheetId, ranges } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(ranges, "Ranges must be provided");

  await sheets.spreadsheets.values
    .batchClear({
      spreadsheetId,
      requestBody: {
        ranges: ranges.split(","),
      },
    })
    .then((body) => {
      log.sys("Response Received:", JSON.stringify(body.data));
      log.good("Successfully removed data!");
    })
    .catch(fail);

  log.debug("Finished clearData Google Sheets task");
}

export async function append() {
  log.debug("Starting append Google Sheets data task");

  const { spreadsheetId, range, values } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(range, "Range must be provided");
  assertExists(values, "Values must be provided");

  await sheets.spreadsheets.values
    .append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: values.split("\n").map((s) => s.split(";")),
      },
    })
    .then(async (body) => {
      const data = JSON.stringify(body.data);
      log.sys("Response Received:", data);
      await result("response", data);
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished append Google Sheets data task");
}

export async function update() {
  log.debug("Starting update Google Sheets data task");

  const { spreadsheetId, range, values } = params;
  const sheets = google.sheets({
    version: "v4",
    auth: getJwtClient(params),
  });
  assertExists(spreadsheetId, "Spreadsheet Id must be provided");
  assertExists(range, "Range must be provided");
  assertExists(values, "Values must be provided");

  await sheets.spreadsheets.values
    .update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: values.split("\n").map((s) => s.split(";")),
      },
    })
    .then(async (body) => {
      const response = JSON.stringify(body.data);
      log.sys("Response Received:", response);
      await result("response", response);
      log.good("Response successfully received!");
    })
    .catch(fail);

  log.debug("Finished update Google Sheets data task");
}
