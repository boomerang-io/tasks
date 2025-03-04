import { log, params, result } from "@boomerang-io/task-core";
import HttpsProxyAgent from "https-proxy-agent";
import { IncomingWebhook } from "@slack/webhook";
import { WebClient } from "@slack/web-api";
import axios from "axios";
import fs from "fs";

// Internal Helper Functions
async function ContentChunker(content, limit) {
  const contentByLines = content.split("\n");
  log.debug("Content by lines:", contentByLines);
  let limitIter = 0;
  let chunkIter = 0;
  let contentChunks = [];

  let tempLine = "";
  let tempLines;
  contentByLines.forEach((line) => {
    if (line.length != 0) {
      if (limitIter + line.length < limit) {
        tempLine += line + "\n";
        limitIter += tempLine.length;
      } else if (limitIter + line.length > limit) {
        tempLines = line.split(char[2999]);
        chunkIter++;
        tempLines.forEach((l) => {
          contentChunks[chunkIter] = l;
          chunkIter++;
        });
      } else {
        chunkIter++;
        tempLine = line + "\n";
        limitIter = tempLine.length;
      }
      contentChunks[chunkIter] = tempLine;
    }
  });

  log.debug("Content by chunks:", contentChunks);
  return contentChunks;
}

// Available Task Functions
export async function sendSimpleMessage() {
  log.debug("Inside Send Simple Slack Webhook Plugin");

  //Destructure and get properties ready.
  const { url, channel, username, message, icon } = params;

  //Variable Checks
  if (!url) {
    log.err("URL has not been set");
    process.exit(1);
  }
  if (!username) {
    log.debug("Setting default username to Boomerang Joe");
    username == "Boomerang Joe";
  }
  if (!icon) {
    log.debug("Setting default icon to :boomerang:");
    icon == ":boomerang:";
  }

  let webhook = new IncomingWebhook(url);

  /** @todo see if we can set the proxy at the higher CLI level rather than have each plugin have to support a proxy*/
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    webhook = new IncomingWebhook(url, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  let payload = {
    channel: channel,
    username: username,
    icon_emoji: icon,
    text: message,
    ts: datetime.create().epoch(),
  };
  if (!channel || channel === '""') {
    log.warn(
      "Channel or user has not been set. Leaving empty to default to the channel or user configured as part of the webhook."
    );
    delete payload.channel;
  }
  log.debug("Payload:", payload);
  await webhook.send(payload, function (err, res) {
    if (err) {
      /** @todo Catch HTTP error for timeout so we can return better exits */
      log.err("Slack sendWebhook error", err);
      process.exit(1);
    } else {
      log.good("Message sent: " + res.text);
    }
  });
}
export async function sendRichMessage() {
  log.debug("Inside Send Rich Slack Webhook Plugin");

  //Destructure and get properties ready.
  const { url, channel, username, fallback, blocks, icon } = params;

  //Variable Checks
  if (!url) {
    log.err("URL has not been set");
    process.exit(1);
  }
  if (!channel) {
    log.err("Channel or user has not been set");
    process.exit(1);
  }
  if (!username) {
    log.debug("Setting default username to Boomerang Joe");
    username == "Boomerang Joe";
  }
  if (!icon) {
    log.debug("Setting default icon to :boomerang:");
    icon == ":boomerang:";
  }

  let webhook = new IncomingWebhook(url);

  /** @todo see if we can set the proxy at the higher CLI level rather than have each plugin have to support a proxy*/
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    webhook = new IncomingWebhook(url, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  let payload = {
    channel: channel,
    username: username,
    icon_emoji: icon,
    ts: datetime.create().epoch(),
    text: fallback,
    blocks: JSON.parse(blocks),
  };
  log.debug("Payload:", payload);
  await webhook.send(payload, function (err, res) {
    if (err) {
      /** @todo Catch HTTP error for timeout so we can return better exits */
      log.err("Slack sendWebhook error", err);
      process.exit(1);
    } else {
      log.good("Message sent: " + res.text);
    }
  });
}
export async function sendCustomMessage() {
  log.debug("Inside Send Custom Slack Webhook Plugin");

  //Destructure and get properties ready.
  const { url, message } = params;

  //Variable Checks
  if (!url) {
    log.err("URL has not been set");
    process.exit(1);
  }
  if (!message) {
    log.err("Message Payload has not been set");
    process.exit(1);
  }

  let webhook = new IncomingWebhook(url);

  /** @todo see if we can set the proxy at the higher CLI level rather than have each plugin have to support a proxy*/
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    webhook = new IncomingWebhook(url, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  let payload = JSON.parse(message);
  log.debug("Payload:", payload);
  await webhook.send(payload, function (err, res) {
    if (err) {
      /** @todo Catch HTTP error for timeout so we can return better exits */
      log.err("Slack sendWebhook error", err);
      process.exit(1);
    } else {
      log.good("Message sent: " + res.text);
    }
  });
}
export async function sendFileMessage() {
  log.debug("Inside Send Log Slack Webhook Plugin");

  //Destructure and get properties ready.
  const { url, channel, icon, username, message, content, encoded, context } =
    params;

  //Variable Checks
  if (!url) {
    log.err("URL has not been set");
    process.exit(1);
  }
  if (!username) {
    log.debug("Setting default username to Boomerang Joe");
    username == "Boomerang Joe";
  }
  if (!icon) {
    log.debug("Setting default icon to :boomerang:");
    icon == ":boomerang:";
  }
  let contentDecoded;
  if (!encoded || encoded !== true) {
    contentDecoded = content;
  } else {
    log.debug("Decoding log content...");
    contentDecoded = Buffer.from(content, "base64").toString("utf-8");
  }

  let webhook = new IncomingWebhook(url);

  /** @todo see if we can set the proxy at the higher CLI level rather than have each plugin have to support a proxy*/
  if (process.env.HTTP_PROXY) {
    log.debug("Using Proxy", process.env.HTTP_PROXY);
    webhook = new IncomingWebhook(url, {
      agent: new HttpsProxyAgent(process.env.HTTP_PROXY),
    });
  }

  // Need to break content up as Slack has a 3000 character limit on each block
  let chunkedContent = await ContentChunker(contentDecoded, 3000);
  let blocks = [];
  blocks.push(
    {
      type: "section",
      text: {
        type: "plain_text",
        text: message,
      },
    },
    {
      type: "divider",
    }
  );
  chunkedContent.forEach((chunk) =>
    blocks.push({
      type: "section",
      text: {
        type: "plain_text",
        text: chunk,
      },
    })
  );
  blocks.push(
    {
      type: "divider",
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: context,
        },
      ],
    }
  );

  payload = {
    channel: channel,
    username: username,
    icon_emoji: icon,
    ts: datetime.create().epoch(),
    text: message,
    blocks: blocks,
  };
  if (!channel || channel === '""') {
    log.warn(
      "Channel or user has not been set. Leaving empty to default to the channel or user configured as part of the webhook."
    );
    delete payload.channel;
  }
  log.debug("Payload:", payload);
  await webhook.send(payload, function (err, res) {
    if (err) {
      /** @todo Catch HTTP error for timeout so we can return better exits */
      log.err("Slack upload file error", err);
      process.exit(1);
    } else {
      log.good("Message sent: " + res.text);
    }
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
