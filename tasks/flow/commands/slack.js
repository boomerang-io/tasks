import { log, params, result } from "@boomerang-io/task-core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { IncomingWebhook } from "@slack/webhook";
import { WebClient } from "@slack/web-api";
import axios from "axios";
import fs from "fs";
import { run, required, asBoolean, TaskError } from "../libs/task.js";

// Internal Helper Functions

// Slack takes up to 3000 characters in a section's text, and 50 blocks in a message.
const SECTION_LIMIT = 3000;
const MAX_BLOCKS = 50;

/** Splits text into pieces of at most `limit` characters, at line breaks where it can. */
function chunkContent(content, limit) {
  const chunks = [];
  let current = "";
  for (const line of content.split("\n")) {
    // A line longer than a whole chunk is cut where the limit falls.
    for (let piece = line; ; piece = piece.slice(limit)) {
      const part = piece.slice(0, limit);
      const joined = current ? `${current}\n${part}` : part;
      if (joined.length <= limit) {
        current = joined;
      } else {
        chunks.push(current);
        current = part;
      }
      if (piece.length <= limit) {
        break;
      }
    }
  }
  if (current.trim()) {
    chunks.push(current);
  }
  return chunks.filter((chunk) => chunk.trim());
}

/** The incoming webhook for a URL, with the HTTP_PROXY agent when one is set. */
function incomingWebhook(url) {
  /** @todo see if we can set the proxy at the higher CLI level rather than have each plugin have to support a proxy*/
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    return new IncomingWebhook(url, { agent: new HttpsProxyAgent(process.env.HTTP_PROXY) });
  }
  return new IncomingWebhook(url);
}

/**
 * Posts to the webhook and fails the task on any error. The webhook URL is the credential, and
 * @slack/webhook's error carries the request config with it, so only the status and Slack's
 * answer (e.g. invalid_payload, no_service) are reported.
 */
async function sendToWebhook(url, payload) {
  log.debug("Payload:", JSON.stringify(payload));
  try {
    await incomingWebhook(url).send(payload);
  } catch (e) {
    const response = e.original?.response;
    if (response) {
      const answer = typeof response.data === "string" ? response.data.slice(0, 200) : JSON.stringify(response.data ?? "").slice(0, 200);
      throw new TaskError(`The Slack webhook answered HTTP ${response.status}${answer ? `: ${answer}` : ""}`);
    }
    const cause = e.original?.code ?? e.original?.message ?? e.code ?? "no response";
    throw new TaskError(`The Slack webhook could not be reached: ${cause}`);
  }
  log.good("Message sent");
}

/**
 * The sender fields a payload takes. Blank ones are left out, so the webhook's own name, icon and
 * channel apply; Slack apps' webhooks ignore them anyway, only legacy custom integrations use them.
 */
function sender({ channel, username, icon }) {
  const fields = {};
  if (channel && channel !== '""') {
    fields.channel = channel;
  } else {
    log.sys("No channel set: the message goes to the webhook's own channel");
  }
  if (username && username !== '""') {
    fields.username = username;
  }
  if (icon && icon !== '""') {
    fields.icon_emoji = icon;
  }
  return fields;
}

/** A JSON param that must parse; the parse error is not echoed. */
function jsonParam(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new TaskError(`${name} is not valid JSON`);
  }
}

// Available Task Functions
export async function sendSimpleMessage() {
  await run("Slack sendSimpleMessage", async () => {
    const { url, channel, username, message, icon } = params;
    required({ url, message }, ["url", "message"]);
    await sendToWebhook(url, { ...sender({ channel, username, icon }), text: message });
  });
}

export async function sendRichMessage() {
  await run("Slack sendRichMessage", async () => {
    const { url, channel, username, fallback, blocks, icon } = params;
    required({ url, blocks }, ["url", "blocks"]);
    const payload = { ...sender({ channel, username, icon }), blocks: jsonParam(blocks, "blocks") };
    if (fallback) {
      payload.text = fallback;
    }
    await sendToWebhook(url, payload);
  });
}

export async function sendCustomMessage() {
  await run("Slack sendCustomMessage", async () => {
    const { url, message } = params;
    required({ url, message }, ["url", "message"]);
    const payload = jsonParam(message, "message");
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TaskError("message must be a JSON object, the whole webhook payload");
    }
    await sendToWebhook(url, payload);
  });
}

export async function sendFileMessage() {
  await run("Slack sendFileMessage", async () => {
    const { url, channel, icon, username, message, content, encoded, context } = params;
    required({ url }, ["url"]);
    const text = asBoolean(encoded) ? Buffer.from(content ?? "", "base64").toString("utf-8") : content ?? "";

    // Each block's text must be 1 to 3000 characters, so blank parts get no block.
    const head = [];
    if (message) {
      head.push({ type: "section", text: { type: "plain_text", text: message.slice(0, SECTION_LIMIT) } }, { type: "divider" });
    }
    const tail = [];
    if (context) {
      tail.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", text: context.slice(0, SECTION_LIMIT) }] });
    }
    let chunks = chunkContent(text, SECTION_LIMIT);
    // One block is kept back for the note when the content does not fit in one message.
    const room = MAX_BLOCKS - head.length - tail.length - 1;
    let note;
    if (chunks.length > room) {
      const left = chunks.slice(room).reduce((sum, chunk) => sum + chunk.length, 0);
      log.warn(`The content is longer than one Slack message holds; the last ${left} characters are left out`);
      chunks = chunks.slice(0, room);
      note = { type: "context", elements: [{ type: "mrkdwn", text: `…${left} more characters not shown` }] };
    }
    const blocks = [...head, ...chunks.map((chunk) => ({ type: "section", text: { type: "plain_text", text: chunk } })), ...(note ? [note] : []), ...tail];
    if (!blocks.length) {
      throw new TaskError("Give a message, content, or a context to send");
    }
    await sendToWebhook(url, { ...sender({ channel, username, icon }), text: message || "File contents", blocks });
  });
}
export async function uploadFileMessage() {
  log.debug("Inside Send File Slack Plugin");

  //Destructure and get properties ready.
  const {
    token,
    channel,
    message,
    encoded,
    fileName,
    fileContent,
    filePath,
    fileTitle,
  } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }

  const requestConfig = {
    filename: fileName,
    channels: channel,
    initial_comment: message,
    title: fileTitle,
  };

  /**
   * only create a file in the request config if the user provides a file path
   */
  if (filePath && filePath !== "") {
    requestConfig.file = fs.createReadStream(filePath);
    log.debug(requestConfig);
  }

  /**
   * if content is provided, check to see if it needs to be decoded
   */
  if (fileContent && fileContent !== "") {
    console.log("in content");
    if (!encoded || encoded !== true) {
      requestConfig.content = fileContent;
    } else {
      log.debug("Decoding log content...");
      requestConfig.content = Buffer.from(fileContent, "base64").toString(
        "utf-8"
      );
    }
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  try {
    const response = await web.files.upload(requestConfig);
    log.debug(response);
  } catch (error) {
    log.err("Well, that was unexpected.", error);
    process.exit(1);
  }
}
export async function lookUpUser() {
  log.debug("Inside Look Up User Slack Plugin");

  //Destructure and get properties ready.
  const { token, emailAddress } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!emailAddress) {
    log.err("Email address has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.users
    .lookupByEmail({
      email: emailAddress,
    })
    .then(async (body) => {
      log.debug("Response Received:", JSON.stringify(body));
      const user_id = body.user.id;
      log.sys("slackUserId Found:", user_id);
      await result("slackUserId", user_id);
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
}

export async function downloadDocument() {
  log.debug("Inside downloadDocument Slack Plugin");

  //Destructure and get properties ready.
  const { token, fileId } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!fileId) {
    log.err("File ID not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.files
    .info({
      file: fileId,
    })
    .then((body) => {
      log.debug("Response Received:", JSON.stringify(body));
      const file = body.file;
      log.sys("files returned:", file);

      if (body.error) {
        log.err("File was not found");
        process.exit(1);
      }

      const documentDownloadUrl = file.url_private;
      log.debug("Download url:", documentDownloadUrl);

      const config = {
        headers: { Authorization: `Bearer ${token}` },
      };

      axios
        .get(documentDownloadUrl, config)
        .then((res) => {
          utils.setOutputParameter("slackDocument", res);
          log.good("Response successfully received!");
        })
        .catch((err) => {
          log.err(err);
          process.exit(1);
        });
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
}

export async function findAndDownloadDocument() {
  log.debug("Inside findAndDownloadDocument Slack Plugin");

  //Destructure and get properties ready.
  const { token, fileName, channel, ts_from, ts_to, types, user } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!fileName) {
    log.err("File name has not been specified");
    process.exit(1);
  }

  if (!channel) {
    log.err("Channel has not been specified");
    process.exit(1);
  }

  if (!user) {
    log.err("User has not been specified");
    process.exit(1);
  }

  if (!ts_from) {
    log.debug("Setting default ts_from to 0");
    ts_from == 0;
  }

  if (!ts_to) {
    log.debug("Setting default ts_to to now");
    ts_to == "now";
  }

  if (!types) {
    log.debug("Setting default types to all");
    types == "all";
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.files
    .list({
      channel: channel,
      user: user,
      ts_from: ts_from,
      ts_to: ts_to,
      types: types,
    })
    .then((body) => {
      log.debug("Response Received:", JSON.stringify(body));
      const files = body.files;
      log.sys("files returned:", files);

      /**
       * what if a user uploads multiple of the same files to the same channel?
       * -current method grabs the first one returned (I believe that would be the oldest)
       */
      const desiredDocument = files.find((file) => file.name === fileName);

      if (desiredDocument === undefined) {
        log.err("File was not found");
        process.exit(1);
      }

      const documentDownloadUrl = desiredDocument.url_private;
      log.debug("Download url:", documentDownloadUrl);

      const config = {
        headers: { Authorization: `Bearer ${token}` },
      };

      axios
        .get(documentDownloadUrl, config)
        .then(async (res) => {
          await result("slackFoundDocument", res);
          log.good("Response successfully received!");
        })
        .catch((err) => {
          log.err(err);
          process.exit(1);
        });
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
}

export async function getChannelInfo() {
  log.debug("Inside Channel Info Slack Plugin");

  //Destructure and get properties ready.
  const { token, channel } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel Id has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.conversations
    .info({
      channel: channel,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Channel Info Slack Plugin");
}

export async function createChannel() {
  log.debug("Inside Create Channel Slack Plugin");

  //Destructure and get properties ready.
  const { token, name, isPrivate, team } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!name) {
    log.err("Channel Name has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  let data = {
    name: name,
  };
  if (!(isPrivate === undefined || isPrivate === null)) {
    data["is_private"] = isPrivate;
  }
  if (team) {
    data["team_id"] = team;
  }
  log.debug(`stringify request made by client: ${JSON.stringify(data)}`);

  await web.conversations
    .create(data)
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Create Channel Slack Plugin");
}

export async function getChannelMembers() {
  log.debug("Inside Get Channel Members Slack Plugin");

  //Destructure and get properties ready.
  const { token, channel } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel Id has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.conversations
    .members({
      channel: channel,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Get Channel Members Slack Plugin");
}

export async function getChannels() {
  log.debug("Inside Get Channels Slack Plugin");

  //Destructure and get properties ready.
  const { token, team, types } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  let data = {};
  if (team) {
    data["team_id"] = team;
  }
  if (types) {
    data["types"] = types;
  }
  log.debug(`stringify request made by client: ${JSON.stringify(data)}`);

  await web.conversations
    .list(data)
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Get Channels Slack Plugin");
}

export async function deleteChannel() {
  log.debug("Inside Delete Channel Slack Plugin");

  //Destructure and get properties ready.
  const { token, channel } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel Id has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.conversations
    .archive({
      channel: channel,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Delete Channel Slack Plugin");
}

export async function getUser() {
  log.debug("Inside Get User by id Slack Plugin");

  //Destructure and get properties ready.
  const { token, user } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!user) {
    log.err("User has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.users
    .info({
      user: user,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Get User by id Slack Plugin");
}

export async function inviteChannelMembers() {
  log.debug("Inside Invite Users to a Slack Channel Plugin");

  //Destructure and get properties ready.
  const { token, channel, users } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel Id has not been specified");
    process.exit(1);
  }
  if (!users) {
    log.err("Users has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.conversations
    .invite({
      channel: channel,
      users: users,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Invite Users to a Slack Channel Plugin");
}

export async function removeChannelMember() {
  log.debug("Inside Remove Channel Member Plugin");

  //Destructure and get properties ready.
  const { token, channel, user } = params;

  //Variable Checks
  if (!token) {
    log.err("Token has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel Id has not been specified");
    process.exit(1);
  }
  if (!user) {
    log.err("User has not been specified");
    process.exit(1);
  }

  let web = new WebClient(token);
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    web = new WebClient(token, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  await web.conversations
    .kick({
      channel: channel,
      user: user,
    })
    .then(async (body) => {
      log.sys("Response Received:", JSON.stringify(body));
      await result("response", JSON.stringify(body));
      log.good("Response successfully received!");
    })
    .catch((err) => {
      log.err(err);
      process.exit(1);
    });
  log.debug("Finished Remove Channel Member Plugin");
}
