/**
 * The prebuilt identity pages.
 *
 * These ship with Pod rather than being authored per workspace: a login form is not tenant behaviour,
 * and asking every workspace to write one would mean every workspace could get it wrong. They are
 * server-rendered HTML with no imports from the workspace bundle, because they have to render before
 * a session exists. The code page carries only a tiny progressive-enhancement script for its six
 * accessible OTP cells; authentication and validation remain ordinary server form posts.
 *
 * Every user-facing string is translated through the pod catalog. The caller resolves the locale
 * per request (`?lang=` first, then `Accept-Language`) and hands in the runtime; the pages are pure
 * render functions and never touch the request themselves.
 */
import type { ServerI18n } from '$lib/i18n/index.js';

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

export type IdentityPageBranding = {
	readonly productName?: string;
	readonly logoUrl?: string;
};

function slateField(): string {
	return `<div class="slate-field" aria-hidden="true">${Array.from({ length: 221 }, (_, index) => {
		const column = index % 17;
		const row = Math.floor(index / 17);
		const delay = -((index * 1.37) % 13);
		const duration = 9 + ((index * 7) % 6);
		return `<span class="slate-cell" style="--slate-column:${column};--slate-row:${row};--slate-delay:${delay}s;--slate-duration:${duration}s"></span>`;
	}).join('')}</div>`;
}

function shell(
	i18n: ServerI18n,
	title: string,
	inner: string,
	branding: IdentityPageBranding = {}
): string {
	const productName = branding.productName?.trim() || 'Norbital';
	const brandMark = branding.logoUrl
		? `<img src="${escapeHtml(branding.logoUrl)}" alt="" aria-hidden="true" />`
		: escapeHtml(productName.slice(0, 1).toUpperCase());
	return `<!doctype html>
<html lang="${i18n.intlLocale}">
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
  body { margin: 0; min-height: 100dvh; overflow-x: hidden; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--background); color: var(--foreground); }
  .small-grid, .large-grid, .slate-field, .top-glow { position: fixed; inset: 0; pointer-events: none; }
  .small-grid { background-image: linear-gradient(rgb(255 255 255 / .035) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / .035) 1px, transparent 1px); background-size: 20px 20px; }
  .large-grid { --slate-size: max(76px, 6.25vw); background-image: linear-gradient(rgb(255 255 255 / .03) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / .03) 1px, transparent 1px); background-position: center; background-size: var(--slate-size) var(--slate-size); mask-image: radial-gradient(ellipse at center, black 35%, transparent 75%); }
  .top-glow { bottom: auto; height: 192px; background: radial-gradient(ellipse at top, oklch(0.696 0.185 46.5 / .05), transparent 70%); }
  .slate-field { --slate-size: max(76px, 6.25vw); display: grid; grid-template-columns: repeat(17, var(--slate-size)); grid-template-rows: repeat(13, var(--slate-size)); place-content: center; mask-image: radial-gradient(ellipse at center, black 35%, transparent 75%); }
  .slate-cell { grid-column: calc(var(--slate-column) + 1); grid-row: calc(var(--slate-row) + 1); animation: slate-light var(--slate-duration) ease-in-out var(--slate-delay) infinite; }
  .page { position: relative; width: min(100%, 32rem); min-height: 100dvh; margin: auto; padding: max(24px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left)); }
  .brand { position: absolute; z-index: 2; top: max(24px, env(safe-area-inset-top)); right: max(32px, env(safe-area-inset-right)); left: max(32px, env(safe-area-inset-left)); display: flex; align-items: center; justify-content: space-between; }
  .brand-name { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-size: .875rem; font-weight: 650; }
  .brand-mark { width: 32px; height: 32px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--border); border-radius: 4px; background: var(--card); box-shadow: 0 1px 2px rgb(0 0 0 / .08); font-size: 11px; font-weight: 750; }
  .brand-mark img { width: 100%; height: 100%; object-fit: cover; }
  .secure { color: var(--muted); font-size: .6875rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
  .center { position: relative; z-index: 1; display: grid; min-height: calc(100dvh - max(48px, env(safe-area-inset-top) + env(safe-area-inset-bottom))); place-items: center; }
  main { width: 100%; padding: 28px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); box-shadow: 0 1px 3px rgb(0 0 0 / .08); backdrop-filter: blur(10px); }
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
  @keyframes slate-light { 0%, 72%, 100% { background: transparent; } 78%, 86% { background: color-mix(in oklch, var(--brand) 14%, transparent); } }
  @media (max-width: 420px) { .page { padding-right: max(20px, env(safe-area-inset-right)); padding-left: max(20px, env(safe-area-inset-left)); } .brand { right: max(20px, env(safe-area-inset-right)); left: max(20px, env(safe-area-inset-left)); } main { padding: 22px 18px; } .pin { gap: 5px; } .pin input { height: 44px; } }
  @media (prefers-reduced-motion: no-preference) { main { animation: enter .18s ease-out both; } @keyframes enter { from { opacity: 0; transform: translateY(4px); } } }
  @media (prefers-reduced-motion: reduce) { .slate-cell { animation: none; } .slate-cell:nth-child(11n) { background: color-mix(in oklch, var(--brand) 9%, transparent); } }
</style>
</head>
<body><div class="small-grid" aria-hidden="true"></div><div class="large-grid" aria-hidden="true"></div><div class="top-glow" aria-hidden="true"></div>${slateField()}<div class="page"><header class="brand"><a class="brand-name" href="/"><span class="brand-mark">${brandMark}</span><span>${escapeHtml(productName)}</span></a><span class="secure">${escapeHtml(i18n.t('pod.identity.secureAccess'))}</span></header><div class="center"><main>${inner}</main></div></div></body>
</html>`;
}

export function loginPage(input: {
	readonly i18n: ServerI18n;
	readonly organizationName: string;
	readonly error?: string;
	readonly branding?: IdentityPageBranding;
}): Response {
	const { i18n, organizationName } = input;
	return html(
		shell(
			i18n,
			i18n.t('pod.identity.titleSignIn', { organization: organizationName }),
			`
<h1>${escapeHtml(i18n.t('pod.identity.headingSignIn'))}</h1>
<p class="sub">${escapeHtml(organizationName)}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/login">
  <label for="email">${escapeHtml(i18n.t('pod.identity.emailLabel'))}</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus />
  <button type="submit">${escapeHtml(i18n.t('pod.identity.sendCode'))}</button>
</form>
	<p class="muted">${escapeHtml(i18n.t('pod.identity.noPasswordHint'))}</p>`,
			input.branding
		),
		input.error ? 400 : 200
	);
}

export function codeEntryPage(input: {
	readonly i18n: ServerI18n;
	readonly email: string;
	readonly error?: string;
	readonly branding?: IdentityPageBranding;
}): Response {
	const { i18n, email } = input;
	const codeHeading = i18n.t('pod.identity.headingEnterCode');
	return html(
		shell(
			i18n,
			codeHeading,
			`
<h1>${escapeHtml(codeHeading)}</h1>
<p class="sub">${escapeHtml(i18n.t('pod.identity.sentTo', { email }))}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/login/code">
  <label for="code-1">${escapeHtml(i18n.t('pod.identity.codeLabel'))}</label>
  <input class="pin-hidden" id="code" name="code" pattern="[0-9]{6}" required tabindex="-1" aria-hidden="true" />
  <div class="pin" data-pin-group>
    ${Array.from(
			{ length: 6 },
			(_, index) =>
				`<input id="code-${index + 1}" data-pin inputmode="numeric" autocomplete="${
					index === 0 ? 'one-time-code' : 'off'
				}" pattern="[0-9]" maxlength="1" aria-label="${escapeHtml(i18n.t('pod.identity.digitAria', { index: index + 1 }))}" ${
					index === 0 ? 'autofocus' : ''
				} />`
		).join('')}
  </div>
  <button type="submit">${escapeHtml(i18n.t('pod.identity.verifyAndContinue'))}</button>
</form>
<p class="muted">${i18n.t('pod.identity.codeExpiresMuted', {
				link: `<a href="/login">${escapeHtml(i18n.t('pod.identity.changeEmail'))}</a>`
			})}</p>
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
</script>`,
			input.branding
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
export function checkEmailPage(input: {
	readonly i18n: ServerI18n;
	readonly organizationName: string;
	readonly branding?: IdentityPageBranding;
}): Response {
	const { i18n, organizationName } = input;
	const heading = i18n.t('pod.identity.headingCheckEmail');
	return html(
		shell(
			i18n,
			heading,
			`
<h1>${escapeHtml(heading)}</h1>
<p class="sub">${escapeHtml(organizationName)}</p>
<p>${escapeHtml(i18n.t('pod.identity.checkEmailBody'))}</p>
<p class="muted">${i18n.t('pod.identity.linkSingleUse', {
				link: `<a href="/login">${escapeHtml(i18n.t('pod.identity.signIn'))}</a>`
			})}</p>`,
			input.branding
		)
	);
}

export function acceptInvitePage(input: {
	readonly i18n: ServerI18n;
	readonly organizationName: string;
	readonly token: string | null;
	readonly error?: string;
	readonly branding?: IdentityPageBranding;
}): Response {
	const { i18n, organizationName } = input;
	if (!input.token) {
		return html(
			shell(
				i18n,
				i18n.t('pod.identity.titleInviteRequired'),
				`
<h1>${escapeHtml(i18n.t('pod.identity.headingLinkIncomplete'))}</h1>
<p class="sub">${escapeHtml(organizationName)}</p>
<p>${escapeHtml(i18n.t('pod.identity.linkIncompleteBody'))}</p>
	<p class="muted"><a href="/login">${escapeHtml(i18n.t('pod.identity.signInInstead'))}</a></p>`,
				input.branding
			),
			400
		);
	}
	return html(
		shell(
			i18n,
			i18n.t('pod.identity.titleAcceptInvitation', { organization: organizationName }),
			`
<h1>${escapeHtml(i18n.t('pod.identity.headingAcceptInvitation'))}</h1>
<p class="sub">${escapeHtml(organizationName)}</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/accept-invite">
  <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
  <label for="email">${escapeHtml(i18n.t('pod.identity.confirmEmailLabel'))}</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus />
  <button type="submit">${escapeHtml(i18n.t('pod.identity.acceptAndSignIn'))}</button>
</form>
	<p class="muted">${escapeHtml(i18n.t('pod.identity.confirmCodeMuted'))}</p>`,
			input.branding
		),
		input.error ? 400 : 200
	);
}
