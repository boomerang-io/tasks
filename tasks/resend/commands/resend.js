import { Resend } from "resend";
import { log, params, results } from "@boomerang-io/task-core";

export async function send() {
  const resend = new Resend(process.env.RESEND_API_KEY);

  //Retrieve params
  const { to, message } = params;

  log.debug("To: ", to);
  log.debug("Message: ", message);

  await results({ [success]: true });

  // log.debug("Started sendMail Resend Task");
  // const { data, error } = await resend.emails.send({
  //   from: 'noreply@backstop.dev>',
  //   to: ['tyson@lawrie.com.au'],
  //   subject: 'Testing Resend',
  //   html: '<strong>It works!</strong>',
  // });

  // if (error) {
  //   return console.error({ error });
  // }

  // console.log({ data });
}
