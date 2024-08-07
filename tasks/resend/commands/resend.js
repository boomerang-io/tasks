import { Resend } from "resend";
import { log, params, results, result } from "@boomerang-io/task-core";

export async function send() {
  const resend = new Resend(process.env.RESEND_API_KEY);

  //Retrieve params
  log.debug("Params: ", JSON.stringify(params, null, 2));
  const { from, to, subject, message } = params;

  log.debug("Started sendMail Resend Task");
  const { data, error } = await resend.emails.send({
    from: from,
    to: [to],
    subject: subject,
    html: message,
  });

  if (error) {
    // result("error", { error });
    return console.error({ error });
  }

  result("data", { data });
}
