import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { CookieSession } from './session.js';
import type { HostAuthentication, HostIdentityProvider } from './types.js';
import { loginPage, codeEntryPage, checkEmailPage, acceptInvitePage } from './identity-pages.js';

export type EmailOtpDeliver = (input: {
	readonly email: string;
	readonly code: string;
}) => Promise<void>;

export type EmailOtpIdentityOptions = {
	readonly sessions: CookieSession;
	/** Sends the code. Pod has no mailer of its own; the host's messaging facility does this. */
	readonly deliver: EmailOtpDeliver;
	readonly organizationId: string;
	readonly organizationName: string;
	/** Signing secret for the stateless code challenge. At least 32 bytes. */
	readonly secret: string;
	/** Code lifetime in seconds. Defaults to 10 minutes. */
	readonly ttlSeconds?: number;
	/** Max code requests per address per window. Defaults to 5 per 15 minutes. */
	readonly maxRequestsPerWindow?: number;
	/**
	 * Send the challenge cookie over HTTPS only. Defaults to `true`.
	 *
	 * Set false only for a loopback development bind. A `Secure` cookie is silently discarded over
	 * plain HTTP, and the discard is invisible: the code arrives, the form accepts it, and the browser
	 * simply has no challenge to send back — so sign-in fails with no error anywhere.
	 */
	readonly secureCookies?: boolean;
	/**
	 * Which address an invitation token was issued to, or `null`.
	 *
	 * Supplied by the host because the invitation lives in the tenant database and this provider runs
	 * outside it. Omitting it disables `/accept-invite`, which is correct for a host whose users are
	 * provisioned some other way.
	 */
	readonly inviteeEmailForToken?: (token: string) => Promise<string | null>;
};

type Attempt = { count: number; windowStart: number };

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Guesses allowed against one address before its challenge is burned.
 *
 * Six digits is only 10^6, so an unbounded verify path does not make a short code "slow to
 * brute-force" — it makes it a credential worth about 500k tries on average, which a single host
 * saturates in minutes. This bound is what makes a short code safe; the length never was.
 */
const MAX_VERIFICATIONS = 5;

/**
 * Rejects the mangled addresses that made the digest encoding ambiguous, and the ones a mailer would
 * misroute. `includes('@')` accepted an address containing NUL bytes, spaces, or a second `@`.
 */
function isPlausibleEmail(email: string): boolean {
	if (email.length === 0 || email.length > 254) return false;
	// eslint-disable-next-line no-control-regex -- a control byte in an address is exactly the case.
	if (/[\u0000-\u001f\s,;:<>"'\\()[\]]/.test(email)) return false;
	const at = email.indexOf('@');
	return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1;
}

function normalize(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * A six-digit code, and the digest that proves it was issued by us.
 *
 * Stateless on purpose: a pod is evicted after fifteen minutes idle, so a code held in memory would
 * not survive the interval between requesting and entering one. The challenge cookie carries
 * `email.expiry.hmac(email + code + expiry)`, so the code is verifiable without being stored — and
 * because the digest covers the expiry, a client cannot extend its own window.
 *
 * The fields are **length-prefixed** rather than delimited. A NUL separator is unambiguous only if no
 * field can contain a NUL, and nothing enforced that: an address carrying NUL bytes would be re-read
 * as `address + code + expiry`, so one digest covered several splittings of the same message. A length
 * prefix admits exactly one splitting whatever the fields hold.
 */
function challenge(secret: string, email: string, code: string, expiry: number): string {
	const message = [email, code, String(expiry)].map((part) => `${part.length}:${part}`).join('');
	return createHmac('sha256', secret).update(message).digest('base64url');
}

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Email one-time codes — the zero-configuration default.
 *
 * Pod stores no password and no code: the address is the credential, and proving control of it is the
 * whole authentication. The provider returns a *verified subject* rather than a user id, so the
 * directory stays in the tenant database and this file never needs to know who exists.
 *
 * `handleRoute` owns `/login`, `/login/code`, `/accept-invite`, and `/logout`, and it is consulted
 * before authentication — which is what makes those pages reachable with no session.
 */
export function emailOtpIdentity(options: EmailOtpIdentityOptions): HostIdentityProvider {
	if (Buffer.byteLength(options.secret, 'utf8') < 32) {
		throw new Error('emailOtpIdentity secret must contain at least 32 bytes');
	}
	const ttl = (options.ttlSeconds ?? 600) * 1000;
	const maxRequests = options.maxRequestsPerWindow ?? 5;
	// Per-process, which is the honest scope: it throttles the common case without pretending to be a
	// distributed limiter. A multi-process deployment should rate-limit at its ingress as well.
	const attempts = new Map<string, Attempt>();
	// Guesses against a challenge, and the digests already spent. Both are per-process for the same
	// reason as `attempts`, and both are keyed by a value the client cannot choose freely.
	const verifications = new Map<string, Attempt>();
	const consumed = new Map<string, number>();

	/** Drops expired entries on write so a hostile caller cannot grow these maps without bound. */
	function prune(now: number): void {
		for (const [key, value] of attempts)
			if (now - value.windowStart > WINDOW_MS) attempts.delete(key);
		for (const [key, value] of verifications) {
			if (now - value.windowStart > WINDOW_MS) verifications.delete(key);
		}
		for (const [key, expiry] of consumed) if (expiry <= now) consumed.delete(key);
	}

	function withinLimit(bucket: Map<string, Attempt>, key: string, max: number): boolean {
		const now = Date.now();
		prune(now);
		const current = bucket.get(key);
		if (!current || now - current.windowStart > WINDOW_MS) {
			bucket.set(key, { count: 1, windowStart: now });
			return true;
		}
		current.count += 1;
		return current.count <= max;
	}

	function withinRateLimit(email: string): boolean {
		return withinLimit(attempts, email, maxRequests);
	}

	const secureCookies = options.secureCookies ?? true;
	const challengeCookie = (value: string, ageSeconds: number): string =>
		[
			`pod_otp=${value}`,
			'Path=/',
			'HttpOnly',
			'SameSite=Lax',
			...(secureCookies ? ['Secure'] : []),
			`Max-Age=${ageSeconds}`
		].join('; ');

	/**
	 * Send a code and return the entry page carrying its challenge.
	 *
	 * Delivery failure is logged, not surfaced: telling the caller that sending failed for this
	 * address but succeeded for another turns the form into an existence oracle.
	 */
	async function issueCode(email: string): Promise<Response> {
		const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
		const expiry = Date.now() + ttl;
		const mac = challenge(options.secret, email, code, expiry);
		await options.deliver({ email, code }).catch((cause: unknown) => {
			console.error('[pod:identity] code delivery failed', cause);
		});
		// Built by adding a cookie to the page's own response, not by re-wrapping its body: rebuilding
		// the headers dropped `no-store`, `x-frame-options: DENY`, and `referrer-policy` from the one
		// page that carries the credential form.
		const page = codeEntryPage({ email });
		const headers = new Headers(page.headers);
		headers.append(
			'set-cookie',
			challengeCookie(encodeURIComponent(`${email}|${expiry}|${mac}`), Math.ceil(ttl / 1000))
		);
		return new Response(page.body, { status: page.status, headers });
	}

	function readChallenge(request: Request): { email: string; expiry: number; mac: string } | null {
		const cookie = request.headers.get('cookie') ?? '';
		for (const part of cookie.split(';')) {
			const [key, ...rest] = part.trim().split('=');
			if (key !== 'pod_otp') continue;
			const [email, expiry, mac] = decodeURIComponent(rest.join('=')).split('|');
			if (!email || !expiry || !mac) return null;
			return { email, expiry: Number(expiry), mac };
		}
		return null;
	}

	return {
		name: 'email-otp',

		async handleRoute(request) {
			const url = new URL(request.url);
			const path = url.pathname.replace(/\/+$/, '') || '/';

			// POST only: a cross-site `<img src="/logout">` would otherwise log the user out on sight.
			if (path === '/logout') {
				if (request.method !== 'POST')
					return new Response(null, { status: 405, headers: { allow: 'POST' } });
				return options.sessions.clear({ redirectTo: '/login' });
			}

			if (path === '/login' && request.method === 'GET') {
				return loginPage({ organizationName: options.organizationName });
			}

			if (path === '/login' && request.method === 'POST') {
				const form = await request.formData();
				const email = normalize(String(form.get('email') ?? ''));
				// The response is identical whether or not the address exists. Anything else turns this
				// form into an oracle for which people belong to this workspace.
				if (!isPlausibleEmail(email)) {
					return loginPage({
						organizationName: options.organizationName,
						error: 'Enter a valid email address.'
					});
				}
				if (withinRateLimit(email)) return issueCode(email);
				return codeEntryPage({ email, error: 'Too many requests. Try again shortly.' });
			}

			if (path === '/login/code' && request.method === 'POST') {
				const form = await request.formData();
				const code = String(form.get('code') ?? '').trim();
				const pending = readChallenge(request);
				if (!pending || pending.expiry <= Date.now()) {
					return loginPage({
						organizationName: options.organizationName,
						error: 'That code expired. Request a new one.'
					});
				}
				if (consumed.has(pending.mac)) {
					return loginPage({
						organizationName: options.organizationName,
						error: 'That code was already used. Request a new one.'
					});
				}
				// Bounded before the comparison, and keyed by the challenge rather than the address: the
				// client supplies the cookie, so a per-address counter alone would let a fresh challenge
				// reset the budget for the same guessing run.
				if (!withinLimit(verifications, pending.mac, MAX_VERIFICATIONS)) {
					consumed.set(pending.mac, pending.expiry);
					return loginPage({
						organizationName: options.organizationName,
						error: 'Too many incorrect codes. Request a new one.'
					});
				}
				const expected = challenge(options.secret, pending.email, code, pending.expiry);
				if (!constantTimeEquals(expected, pending.mac)) {
					return codeEntryPage({ email: pending.email, error: 'That code is not correct.' });
				}
				// Single-use is enforced here, not by clearing the cookie: the digest stays valid until
				// expiry, so a client that simply keeps its own cookie could otherwise mint unlimited
				// sessions from one code. The cookie is still cleared, for the honest client's benefit.
				consumed.set(pending.mac, pending.expiry);
				const session = options.sessions.issue(
					{
						email: pending.email,
						organizationId: options.organizationId,
						organizationName: options.organizationName
					},
					{ redirectTo: '/' }
				);
				// `new Headers(other)` does NOT carry `set-cookie` across — it is the one header the Headers
				// constructor collapses rather than copies. Building the response that way dropped the
				// session cookie entirely: sign-in answered 303 to `/`, set nothing, and bounced straight
				// back to the login page with no error anywhere. `getSetCookie()` is the accessor that
				// returns each cookie separately.
				const headers = new Headers();
				for (const [name, value] of session.headers) {
					if (name.toLowerCase() !== 'set-cookie') headers.set(name, value);
				}
				for (const cookie of session.headers.getSetCookie()) {
					headers.append('set-cookie', cookie);
				}
				headers.append('set-cookie', challengeCookie('', 0));
				return new Response(null, { status: session.status, headers });
			}

			if (path === '/accept-invite' && request.method === 'GET') {
				return acceptInvitePage({
					organizationName: options.organizationName,
					token: url.searchParams.get('token')
				});
			}

			if (path === '/accept-invite' && request.method === 'POST') {
				if (!options.inviteeEmailForToken) return null;
				const form = await request.formData();
				const token = String(form.get('token') ?? '');
				const claimed = normalize(String(form.get('email') ?? ''));
				const invited = await options.inviteeEmailForToken(token);
				// The token proves an invitation exists; the code proves the address. Requiring the typed
				// address to match the invited one means a leaked link cannot be redeemed by someone else,
				// and the error is deliberately identical for a bad token and a mismatched address so the
				// form does not reveal which invitations exist.
				if (!invited || invited !== claimed) {
					return acceptInvitePage({
						organizationName: options.organizationName,
						token,
						error: 'That invitation link and email address do not match.'
					});
				}
				if (!withinRateLimit(claimed)) {
					return acceptInvitePage({
						organizationName: options.organizationName,
						token,
						error: 'Too many requests. Try again shortly.'
					});
				}
				// From here the flow is an ordinary sign-in. The invitation itself is claimed during
				// subject resolution on the first authenticated request, which is what keeps the
				// single-use guarantee in the database rather than in this handler.
				return issueCode(claimed);
			}

			if (path === '/check-email') {
				return checkEmailPage({ organizationName: options.organizationName });
			}

			return null;
		},

		authenticate(request): HostAuthentication {
			const claims = options.sessions.read(request);
			if (!claims) {
				// A person needs somewhere to go; a bare 401 sends them nowhere. `handleRoute` above
				// already serves `/login` without a session, so this redirect always lands.
				//
				// But only for a navigation. A `fetch` follows a 303 transparently and then tries to
				// parse an HTML login page as JSON, so an API caller is told plainly that it is
				// unauthenticated and where to send its user instead.
				const wantsDocument = (request.headers.get('accept') ?? '').includes('text/html');
				if (!wantsDocument) {
					return new Response(JSON.stringify({ error: 'Unauthorized', login: '/login' }), {
						status: 401,
						headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(null, { status: 303, headers: { location: '/login' } });
			}
			return {
				subject: { email: claims.email },
				organizationId: claims.organizationId,
				organizationName: claims.organizationName
			};
		}
	};
}
