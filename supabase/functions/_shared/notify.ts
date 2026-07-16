// Email notifications via Resend. No SMS, no phone numbers.
// Without RESEND_API_KEY set, sends are logged instead (dry-run) so the whole
// flow still runs end to end before the owner creates an account.

const BRAND = { bg: '#0E0D11', surface: '#141217', border: '#34303A', purple: '#A855F7', text: '#FFFFFF', muted: '#A9A4AF' };

function wrap(inner: string): string {
  return `<div style="background:${BRAND.bg};color:${BRAND.text};font-family:system-ui,-apple-system,sans-serif;padding:24px">
  <div style="max-width:480px;margin:0 auto">
    <div style="color:${BRAND.purple};font-weight:800;letter-spacing:2px;font-size:13px;text-transform:uppercase;margin-bottom:16px">Brotherly Love Detailing</div>
    <div style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:16px;padding:20px">${inner}</div>
  </div>
</div>`;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('MAIL_FROM') ?? 'Brotherly Love Detailing <onboarding@resend.dev>';
  if (!key || !to) {
    console.log(`[email dry-run] to=${to} subject=${subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html: wrap(html) }),
  });
  if (!res.ok) console.error('resend error', res.status, await res.text());
}

export function ownerEmail(): string {
  return Deno.env.get('OWNER_EMAIL') ?? '';
}

export function functionsBaseUrl(): string {
  return Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? `${Deno.env.get('SUPABASE_URL')}/functions/v1`;
}

export function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:linear-gradient(135deg,#7028C9,#A855F7);color:#fff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:12px;margin-top:16px">${label}</a>`;
}
