import { Resend } from 'resend';
import { log, params } from "@boomerang-io/task-core"

export async function send() {
  const resend = new Resend(process.env.RESEND_API_KEY);

  //Retrieve params
  const { to, message } = params;

  console.log("To: ", to);
  console.log("Message: ", message);

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
};