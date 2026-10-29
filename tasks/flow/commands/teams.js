import { log, params, results } from "@boomerang-io/task-core";
import axios from "axios";
import { run, required, asJsonObject, proxyOptions, serviceMessage, TaskError } from "../libs/task.js";
import { graphClient, credentialsFrom, userBind } from "../libs/msgraph.js";

/**
 * Microsoft Teams: a message through a Teams Workflows webhook, and channels and members through
 * Microsoft Graph with an app-only token.
 */

const ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive";
// Teams caps a channel name at 50 characters.
const CHANNEL_NAME_MAX = 50;

/** The Adaptive Card for a title and a message, each a wrapped TextBlock (which takes Teams' Markdown subset). */
function textCard(title, message) {
  const body = [];
  if (title) {
    body.push({ type: "TextBlock", text: title, size: "Large", weight: "Bolder", wrap: true });
  }
  if (message) {
    body.push({ type: "TextBlock", text: message, wrap: true });
  }
  return { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body };
}

/** The webhook payload: a card is wrapped as a message attachment; a whole message is sent as given. */
function webhookPayload(title, message, cardParam) {
  const card = asJsonObject(cardParam, "card");
  if (card) {
    if (card.type === "message") {
      return card;
    }
    if (card.type !== "AdaptiveCard") {
      throw new TaskError(`card must be an Adaptive Card (type AdaptiveCard) or a whole message (type message), got type '${card.type}'`);
    }
    return { type: "message", attachments: [{ contentType: ADAPTIVE_CARD, contentUrl: null, content: card }] };
  }
  if (!title && !message) {
    throw new TaskError("Give a title, a message, or a card");
  }
  return { type: "message", attachments: [{ contentType: ADAPTIVE_CARD, contentUrl: null, content: textCard(title, message) }] };
}

export async function sendMessage() {
  await run("Teams sendMessage", async () => {
    const { webhookUrl, title, message, card } = params;
    required({ webhookUrl }, ["webhookUrl"]);
    let target;
    try {
      target = new URL(webhookUrl);
    } catch {
      throw new TaskError("webhookUrl is not a URL");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new TaskError("webhookUrl must be an http(s) URL");
    }

    const response = await axios.post(webhookUrl, webhookPayload(title, message, card), {
      ...proxyOptions(),
      validateStatus: () => true,
    });
    // The URL carries the webhook's signature, so it is never logged.
    if (response.status < 200 || response.status >= 300) {
      const detail = serviceMessage(response.data);
      throw new TaskError(`The Teams webhook answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    log.good(`Teams webhook accepted the message (HTTP ${response.status})`);
  });
}

export async function createChannel() {
  await run("Teams createChannel", async () => {
    const { teamId, displayName, description, membershipType = "standard", owner } = params;
    required({ teamId, displayName }, ["teamId", "displayName"]);
    const type = membershipType || "standard";
    if (type !== "standard" && type !== "private") {
      throw new TaskError(`membershipType must be standard or private, got '${membershipType}'`);
    }
    if (displayName.length > CHANNEL_NAME_MAX) {
      throw new TaskError(`displayName is ${displayName.length} characters; Teams takes ${CHANNEL_NAME_MAX}`);
    }
    // An app-only call has no signed-in user to become the owner, so a private channel names one.
    if (type === "private" && !owner) {
      throw new TaskError("A private channel needs an owner: give the user's object ID or user principal name");
    }
    if (type === "standard" && owner) {
      log.warn("owner applies to a private channel only; a standard channel takes the team's members");
    }

    const graph = await graphClient(credentialsFrom(params));
    const body = { displayName, description: description || undefined, membershipType: type };
    if (type === "private") {
      body.members = [{ "@odata.type": "#microsoft.graph.aadUserConversationMember", "user@odata.bind": userBind(owner), roles: ["owner"] }];
    }
    const { data } = await graph.call("Creating the channel", {
      method: "POST",
      url: `/teams/${encodeURIComponent(teamId)}/channels`,
      data: body,
    });
    log.good(`Created ${type} channel '${data.displayName}' (${data.id})`);
    await results({ channelId: data.id, channelUrl: data.webUrl ?? "" });
  });
}

export async function addMember() {
  await run("Teams addMember", async () => {
    const { teamId, user, role = "member" } = params;
    required({ teamId, user }, ["teamId", "user"]);
    const memberRole = role || "member";
    if (memberRole !== "member" && memberRole !== "owner") {
      throw new TaskError(`role must be member or owner, got '${role}'`);
    }

    const graph = await graphClient(credentialsFrom(params));
    const { data } = await graph.call("Adding the member", {
      method: "POST",
      url: `/teams/${encodeURIComponent(teamId)}/members`,
      data: {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        // A basic member carries no role; an owner carries "owner".
        roles: memberRole === "owner" ? ["owner"] : [],
        "user@odata.bind": userBind(user),
      },
    });
    log.good(`Added ${data.displayName ?? user} to the team as ${memberRole}`);
    await results({ membershipId: data.id, userId: data.userId ?? "" });
  });
}
