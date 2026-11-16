/**
 * The one-time code email every Norbital surface sends: workspace sign-in, signup, platform and command-center
 * sign-in, recovery. Tables and inline styles only, so every client renders it. `code` is the sender's own digits.
 */
export const code_mail = (code: string, workspace?: string) => {
	const destination = workspace?.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
	const context = destination ? ` for ${destination}` : '';
	const escaped = context
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
	return {
		subject: `Your Norbital code${context}: ${code}`,
		text: `Your Norbital code${context} is ${code}. It expires in 10 minutes. If you did not ask for this code, you can ignore this email.`,
		html: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Your Norbital code</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
<tr><td style="padding:32px 32px 0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;color:#18181b">Norbital</td></tr>
<tr><td style="padding:24px 32px 8px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#3f3f46">Your code${escaped} is:</td></tr>
<tr><td style="padding:8px 32px;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#18181b">${code}</td></tr>
<tr><td style="padding:8px 32px 32px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#52525b">It expires in 10 minutes. If you did not ask for this code, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`
	};
};
