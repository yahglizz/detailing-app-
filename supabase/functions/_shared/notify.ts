export async function sendSMS(to: string, body: string): Promise<void> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');
  if (!sid || !token || !from) {
    console.log(`[SMS dry-run] to=${to}: ${body}`);
    return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) console.error('twilio error', res.status, await res.text());
}

export function functionsBaseUrl(): string {
  return Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1`;
}
