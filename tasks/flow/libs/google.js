import { log } from "@boomerang-io/task-core";
import { google } from "googleapis";
import { TaskError } from "./task.js";

/**
 * Service-account credentials for the Google Sheets and Drive tasks. The whole JSON key file in
 * serviceAccountKey is the way to give them; clientEmail and privateKey are the older form, kept
 * for revisions that declare those params.
 */

/** { email, key } from the params, or a TaskError. A key's contents never reach a message or a log. */
export function serviceAccount({ serviceAccountKey, clientEmail, privateKey }) {
  if (serviceAccountKey && serviceAccountKey.trim()) {
    let key;
    try {
      // Pasted into a one-line field the key stays valid JSON: the newlines between members go, and
      // the private key's own line breaks are \n escapes.
      key = JSON.parse(serviceAccountKey);
    } catch {
      throw new TaskError("serviceAccountKey is not valid JSON: paste the whole service-account key file");
    }
    if (key === null || typeof key !== "object" || Array.isArray(key)) {
      throw new TaskError("serviceAccountKey must be the JSON key file, an object");
    }
    if (key.type !== undefined && key.type !== "service_account") {
      throw new TaskError(`serviceAccountKey is a '${key.type}' key; these tasks take a service-account key`);
    }
    if (!key.client_email || !key.private_key) {
      throw new TaskError("serviceAccountKey has no client_email or private_key: paste the whole service-account key file");
    }
    if (clientEmail || privateKey) {
      log.debug("serviceAccountKey is set, so clientEmail and privateKey are not used");
    }
    return { email: key.client_email, key: key.private_key };
  }
  if (!clientEmail || !privateKey) {
    throw new TaskError("Give serviceAccountKey (the service-account JSON key file), or both clientEmail and privateKey");
  }
  // A private key typed into a field arrives with literal \n sequences for its line breaks.
  return { email: clientEmail, key: privateKey.replace(/\\n/g, "\n") };
}

/** A JWT client for the service account, with the given scopes. */
export function googleAuth(values, scopes) {
  const { email, key } = serviceAccount(values);
  return new google.auth.JWT({ email, key, scopes });
}
