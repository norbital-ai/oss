/**
 * The prebuilt identity pages.
 *
 * These ship with Pod rather than being authored per workspace: a login form is not tenant behaviour,
 * and asking every workspace to write one would mean every workspace could get it wrong. They are
 * plain server-rendered HTML with no client JavaScript and no imports from the workspace bundle,
 * because they have to render before a session exists — which is exactly when the Svelte shell and its
 * authenticated data load are unavailable.
 */

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// These pages carry a credential form; nothing about them should be cached or framed.
			// Keep only the origin in referrers. `no-referrer` also makes Chromium submit a form with
			// `Origin: null`, which production frameworks correctly reject as a cross-site POST.
			'cache-control': 'no-store',
			'x-frame-options': 'DENY',
			'referrer-policy': 'strict-origin'
		}
	});
}

function shell(title: string, inner: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: Canvas; color: CanvasText; padding: 24px;
  }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: 0.7; }
  label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 0.375rem; }
  input {
    width: 100%; padding: 0.625rem 0.75rem; font: inherit; border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Field; color: FieldText;
  }
  input:focus-visible { outline: 2px solid AccentColor; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: 0.625rem 0.75rem; font: inherit; font-weight: 500;
    border: 0; border-radius: 0.5rem; background: AccentColor; color: AccentColorText; cursor: pointer;
  }
  .error {
    margin: 0 0 1rem; padding: 0.625rem 0.75rem; border-radius: 0.5rem; font-size: 0.875rem;
    background: color-mix(in srgb, #dc2626 12%, transparent);
    color: color-mix(in srgb, #dc2626 85%, CanvasText);
  }
  .muted { margin-top: 1.25rem; font-size: 0.8125rem; opacity: 0.65; }
  code { font-family: ui-monospace, monospace; font-size: 0.875em; }
</style>
</head>
<body><main>${inner}</main></body>
</html>`;
}

export function loginPage(input: {
	readonly organizationName: string;
	readonly error?: string;
}): Response {
	return html(
		shell(
			`Sign in — ${input.organizationName}`,
			`
<h1>Sign in</h1>
<p class="sub">${escapeHtml(input.organizationName)}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/login">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus />
  <button type="submit">Send sign-in code</button>
</form>
<p class="muted">We'll email you a six-digit code. No password required.</p>`
		),
		input.error ? 400 : 200
	);
}

export function codeEntryPage(input: {
	readonly email: string;
	readonly error?: string;
}): Response {
	return html(
		shell(
			'Enter your code',
			`
<h1>Enter your code</h1>
<p class="sub">Sent to ${escapeHtml(input.email)}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/login/code">
  <label for="code">Six-digit code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
         pattern="[0-9]{6}" maxlength="6" required autofocus />
  <button type="submit">Continue</button>
</form>
<p class="muted">The code expires in ten minutes. <a href="/login">Start over</a>.</p>`
		),
		input.error ? 400 : 200
	);
}

/**
 * Shown after provisioning, deliberately without the token.
 *
 * The pod mints the invitation token and emails it; the provisioning host never sees it, so it cannot
 * appear in a redirect URL even if someone wanted it to. This page exists to say so.
 */
export function checkEmailPage(input: { readonly organizationName: string }): Response {
	return html(
		shell(
			'Check your email',
			`
<h1>Check your email</h1>
<p class="sub">${escapeHtml(input.organizationName)}</p>
<p>We've sent an invitation link to the address you signed up with. Open it to finish setting up your
workspace.</p>
<p class="muted">The link is single-use and expires in three days. Already have access?
<a href="/login">Sign in</a>.</p>`
		)
	);
}

export function acceptInvitePage(input: {
	readonly organizationName: string;
	readonly token: string | null;
	readonly error?: string;
}): Response {
	if (!input.token) {
		return html(
			shell(
				'Invitation link required',
				`
<h1>That link is incomplete</h1>
<p class="sub">${escapeHtml(input.organizationName)}</p>
<p>Open the invitation link from your email — it carries a token this page needs.</p>
<p class="muted"><a href="/login">Sign in instead</a></p>`
			),
			400
		);
	}
	return html(
		shell(
			`Accept invitation — ${input.organizationName}`,
			`
<h1>Accept your invitation</h1>
<p class="sub">${escapeHtml(input.organizationName)}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/accept-invite">
  <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
  <label for="email">Confirm your email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus />
  <button type="submit">Accept and sign in</button>
</form>
<p class="muted">We'll email a code to confirm it's you before creating your account.</p>`
		),
		input.error ? 400 : 200
	);
}
