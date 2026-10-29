// Test-only preload (NODE_OPTIONS=--import): every Sheets and Drive request goes to GOOGLE_MOCK_URL
// with a fixed bearer token, since gtoken's token URL cannot be redirected. The rewrite sits on the
// JWT client's request, the one door every API call (media uploads included) goes through, and any
// other destination is refused so a test can never reach Google.
import { google } from "googleapis";

const rootUrl = process.env.GOOGLE_MOCK_URL.replace(/\/?$/, "/");
const JWT = google.auth.JWT.prototype;
const request = JWT.request;

JWT.getRequestMetadataAsync = async function () {
  return { headers: { Authorization: `Bearer test-token-for-${this.email}` } };
};
JWT.request = function (opts, callback) {
  const url = String(opts.url).replace(/^https:\/\/(www|sheets)\.googleapis\.com\//, rootUrl);
  if (!url.startsWith(rootUrl)) {
    throw new Error(`google-mock: refusing a request outside the mock: ${opts.url}`);
  }
  return request.call(this, { ...opts, url }, callback);
};
