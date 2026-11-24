// Email through Resend (free tier). Optional: if RESEND_API_KEY is not set, nothing is sent.

export const emailEnabled = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

export async function sendEmail(env, to, subject, text, fetchImpl = fetch) {
  if (!emailEnabled(env)) return false;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  });
  return res.ok;
}
