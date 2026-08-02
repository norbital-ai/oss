/**
 * The prebuilt identity pages.
 *
 * These ship with Pod rather than being authored per workspace: a login form is not tenant behaviour,
 * and asking every workspace to write one would mean every workspace could get it wrong. They are
 * server-rendered HTML with no imports from the workspace bundle, because they have to render before
 * a session exists. The code page carries only a tiny progressive-enhancement script for its six
 * accessible OTP cells; authentication and validation remain ordinary server form posts.
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
  :root {
    color-scheme: light dark;
    --background: light-dark(#f4f3ef, #11110e); --foreground: light-dark(#26251f, #f3f1e9);
    --card: light-dark(rgb(255 255 252 / .94), rgb(29 29 24 / .94));
    --muted: light-dark(#6f6d64, #aaa79d); --border: light-dark(#d6d3c9, #45443c);
    --field: light-dark(#fff, #22221d); --accent: light-dark(#28271f, #f2efe5);
    --accent-fg: light-dark(#fff, #1c1b17); --brand: #dc7c37;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background-color: var(--background); color: var(--foreground);
    background-image: linear-gradient(color-mix(in srgb, var(--foreground) 4%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--foreground) 4%, transparent) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .page { width: min(100%, 34rem); min-height: 100dvh; margin: auto; padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); display: grid; grid-template-rows: auto 1fr; }
  .brand { display: flex; align-items: center; justify-content: space-between; padding-bottom: 32px; }
  .brand-name { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-size: .875rem; font-weight: 650; }
  .brand-mark { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 7px; background: var(--card); box-shadow: 0 1px 2px rgb(0 0 0 / .08); font-size: 11px; font-weight: 750; }
  .secure { color: var(--muted); font-size: .6875rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
  .center { display: grid; align-items: center; }
  main { width: 100%; padding: 28px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: 0 1px 3px rgb(0 0 0 / .08); backdrop-filter: blur(10px); }
  h1 { font-size: 1.35rem; line-height: 1.2; letter-spacing: -.02em; margin: 0 0 .55rem; }
  p.sub { margin: 0 0 1.5rem; color: var(--muted); }
  label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 0.375rem; }
  input {
    width: 100%; padding: 0.625rem 0.75rem; font: inherit; border-radius: 0.5rem;
    border: 1px solid var(--border); background: var(--field); color: var(--foreground);
  }
  input:focus-visible { outline: 2px solid color-mix(in srgb, var(--brand) 72%, transparent); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: 0.625rem 0.75rem; font: inherit; font-weight: 500;
    border: 0; border-radius: 0.5rem; background: var(--accent); color: var(--accent-fg); cursor: pointer;
  }
  button:hover { opacity: .9; }
  .error {
    margin: 0 0 1rem; padding: 0.625rem 0.75rem; border-radius: 0.5rem; font-size: 0.875rem;
    background: color-mix(in srgb, #dc2626 12%, transparent); color: light-dark(#b91c1c, #fca5a5);
  }
  .muted { margin-top: 1.25rem; font-size: 0.8125rem; color: var(--muted); }
  a { color: inherit; text-underline-offset: 3px; }
  .pin { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  .pin input { height: 48px; padding: 0; text-align: center; font: 600 1.15rem/1 ui-monospace, SFMono-Regular, monospace; }
  .pin-hidden { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  code { font-family: ui-monospace, monospace; font-size: 0.875em; }
  @media (max-width: 420px) { main { padding: 22px 18px; } .pin { gap: 5px; } .pin input { height: 44px; } }
  @media (prefers-reduced-motion: no-preference) { main { animation: enter .18s ease-out both; } @keyframes enter { from { opacity: 0; transform: translateY(4px); } } }
</style>
</head>
<body><div class="page"><header class="brand"><a class="brand-name" href="/"><span class="brand-mark">N</span><span>Norbital</span></a><span class="secure">Secure access</span></header><div class="center"><main>${inner}</main></div></div></body>
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
  <label for="code-1">Six-digit code</label>
  <input class="pin-hidden" id="code" name="code" pattern="[0-9]{6}" required tabindex="-1" aria-hidden="true" />
  <div class="pin" data-pin-group>
    ${Array.from({ length: 6 }, (_, index) => `<input id="code-${index + 1}" data-pin inputmode="numeric" autocomplete="${index === 0 ? 'one-time-code' : 'off'}" pattern="[0-9]" maxlength="1" aria-label="Digit ${index + 1} of 6" ${index === 0 ? 'autofocus' : ''} />`).join('')}
  </div>
  <button type="submit">Verify and continue</button>
</form>
<p class="muted">The code expires in ten minutes. <a href="/login">Change email</a>.</p>
<script>
(() => {
  const group = document.querySelector('[data-pin-group]');
  if (!group) return;
  const cells = [...group.querySelectorAll('[data-pin]')];
  const hidden = document.querySelector('#code');
  const sync = () => { hidden.value = cells.map((cell) => cell.value).join(''); };
  const fill = (text) => { [...text.replace(/\\D/g, '').slice(0, 6)].forEach((digit, i) => { cells[i].value = digit; }); sync(); cells[Math.min(text.length, 5)].focus(); };
  cells.forEach((cell, index) => {
    cell.addEventListener('input', () => { cell.value = cell.value.replace(/\\D/g, '').slice(-1); sync(); if (cell.value && cells[index + 1]) cells[index + 1].focus(); });
    cell.addEventListener('keydown', (event) => { if (event.key === 'Backspace' && !cell.value && cells[index - 1]) cells[index - 1].focus(); });
    cell.addEventListener('paste', (event) => { event.preventDefault(); fill(event.clipboardData.getData('text')); });
  });
  group.closest('form').addEventListener('submit', (event) => { sync(); if (!/^[0-9]{6}$/.test(hidden.value)) { event.preventDefault(); cells.find((cell) => !cell.value)?.focus(); } });
})();
</script>`
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
