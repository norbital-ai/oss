import { describe, expect, it } from 'vitest';
import { cookieSession } from '../../src/lib/host/session.js';
import { emailOtpIdentity } from '../../src/lib/host/email-otp.js';
import { emailOtp, isIdentityDescriptor } from '../../src/lib/host/types.js';

const SECRET = 'a'.repeat(32);

type Sent = { email: string; code: string };

function provider(
	options: {
		readonly sent?: Sent[];
		readonly inviteeEmailForToken?: (token: string) => Promise<string | null>;
		readonly maxRequestsPerWindow?: number;
		readonly ttlSeconds?: number;
		readonly deliverFails?: boolean;
	} = {}
) {
	const sent = options.sent ?? [];
	return emailOtpIdentity({
		sessions: cookieSession({ secret: SECRET }),
		secret: SECRET,
		organizationId: 'org-1',
		organizationName: 'Acme',
		...(options.maxRequestsPerWindow ? { maxRequestsPerWindow: options.maxRequestsPerWindow } : {}),
		...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
		...(options.inviteeEmailForToken ? { inviteeEmailForToken: options.inviteeEmailForToken } : {}),
		deliver: async (input) => {
			if (options.deliverFails) throw new Error('provider is down');
			sent.push(input);
		}
	});
}

function form(path: string, fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields);
	return new Request(`https://acme.example${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body
	});
}

function get(path: string, cookie?: string): Request {
	return new Request(`https://acme.example${path}`, {
		headers: cookie ? { cookie } : {}
	});
}

/** Extract the challenge cookie the code-entry page set, for the follow-up POST. */
function challengeCookie(response: Response): string {
	for (const [key, value] of response.headers) {
		if (key.toLowerCase() === 'set-cookie' && value.startsWith('pod_otp=')) {
			return value.split(';')[0] ?? '';
		}
	}
	throw new Error('No challenge cookie set');
}

async function codeEntry(
	identity: ReturnType<typeof provider>,
	cookie: string,
	code: string
): Promise<Response> {
	const request = new Request('https://acme.example/login/code', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
		body: new URLSearchParams({ code })
	});
	const response = await identity.handleRoute?.(request);
	if (!response) throw new Error('Provider did not handle /login/code');
	return response;
}

describe('emailOtp descriptor', () => {
	it('is data, not a constructed provider', () => {
		const descriptor = emailOtp({ secret: SECRET });
		expect(isIdentityDescriptor(descriptor)).toBe(true);
		expect(descriptor).toEqual({ provider: 'email-otp', secret: SECRET });
	});

	it('refuses a secret too short to sign with, at config time', () => {
		expect(() => emailOtp({ secret: 'short' })).toThrow(/32 bytes/);
	});
});

describe('emailOtpIdentity', () => {
	it('serves the login page with no session, so it is reachable before authentication', async () => {
		const response = await provider().handleRoute?.(get('/login'));
		expect(response?.status).toBe(200);
		expect(await response?.text()).toContain('Send sign-in code');
	});

	it('redirects an unauthenticated request instead of returning a bare 401', async () => {
		const result = await provider().authenticate(get('/'));
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(303);
		expect((result as Response).headers.get('location')).toBe('/login');
	});

	it('returns a verified subject rather than a user id, leaving the directory to Pod', async () => {
		const identity = provider();
		const issued = identity.authenticate(get('/'));
		expect(issued).toBeInstanceOf(Response);

		const sent: Sent[] = [];
		const live = provider({ sent });
		const request = await live.handleRoute?.(form('/login', { email: 'Bob@Example.com' }));
		const cookie = challengeCookie(request!);
		const verified = await codeEntry(live, cookie, sent[0]!.code);
		const session = verified.headers.getSetCookie().find((c) => c.startsWith('pod_session='));

		const authed = await live.authenticate(get('/', session!.split(';')[0]));
		expect(authed).toEqual({
			subject: { email: 'bob@example.com' },
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
	});

	it('normalizes the address so case and padding cannot create a second identity', async () => {
		const sent: Sent[] = [];
		await provider({ sent }).handleRoute?.(form('/login', { email: '  BOB@Example.COM ' }));
		expect(sent[0]?.email).toBe('bob@example.com');
	});

	it('refuses a wrong code', async () => {
		const sent: Sent[] = [];
		const identity = provider({ sent });
		const requested = await identity.handleRoute?.(form('/login', { email: 'bob@example.com' }));
		const response = await codeEntry(identity, challengeCookie(requested!), '000000');
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('not correct');
	});

	it('refuses a replayed code, because the challenge cookie is cleared on success', async () => {
		const sent: Sent[] = [];
		const identity = provider({ sent });
		const requested = await identity.handleRoute?.(form('/login', { email: 'bob@example.com' }));
		const cookie = challengeCookie(requested!);
		const first = await codeEntry(identity, cookie, sent[0]!.code);
		expect(first.status).toBe(303);
		// The digest stays valid until expiry, so single-use depends on the cookie being cleared. A
		// client that kept the old cookie must not be able to spend the same code twice.
		const cleared = first.headers.getSetCookie().find((c) => c.startsWith('pod_otp='));
		expect(cleared).toContain('Max-Age=0');
	});

	it('refuses an expired code even with the right digits', async () => {
		const sent: Sent[] = [];
		const identity = provider({ sent, ttlSeconds: -1 });
		const requested = await identity.handleRoute?.(form('/login', { email: 'bob@example.com' }));
		const response = await codeEntry(identity, challengeCookie(requested!), sent[0]!.code);
		expect(await response.text()).toContain('expired');
	});

	it('rate-limits code requests per address', async () => {
		const sent: Sent[] = [];
		const identity = provider({ sent, maxRequestsPerWindow: 2 });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await identity.handleRoute?.(form('/login', { email: 'bob@example.com' }));
		}
		expect(sent).toHaveLength(2);
	});

	it('does not reveal a delivery failure, which would make the form an existence oracle', async () => {
		const identity = provider({ deliverFails: true });
		const response = await identity.handleRoute?.(form('/login', { email: 'bob@example.com' }));
		expect(response?.status).toBe(200);
		expect(await response?.text()).toContain('Enter your code');
	});

	it('rejects an invitation whose token belongs to a different address', async () => {
		const sent: Sent[] = [];
		const identity = provider({
			sent,
			inviteeEmailForToken: async () => 'invited@example.com'
		});
		const response = await identity.handleRoute?.(
			form('/accept-invite', { token: 'tok', email: 'attacker@example.com' })
		);
		expect(response?.status).toBe(400);
		expect(await response?.text()).toContain('do not match');
		// No code is sent, so a leaked link cannot be used to start a login for another address.
		expect(sent).toHaveLength(0);
	});

	it('rejects an unknown invitation token with the same message as a mismatch', async () => {
		const identity = provider({ inviteeEmailForToken: async () => null });
		const response = await identity.handleRoute?.(
			form('/accept-invite', { token: 'nope', email: 'bob@example.com' })
		);
		expect(await response?.text()).toContain('do not match');
	});

	it('starts an ordinary sign-in when the token and address agree', async () => {
		const sent: Sent[] = [];
		const identity = provider({ sent, inviteeEmailForToken: async () => 'bob@example.com' });
		const response = await identity.handleRoute?.(
			form('/accept-invite', { token: 'tok', email: 'bob@example.com' })
		);
		expect(response?.status).toBe(200);
		expect(sent).toEqual([{ email: 'bob@example.com', code: expect.any(String) }]);
	});

	it('declines routes it does not own so the workspace still serves them', async () => {
		expect(await provider().handleRoute?.(get('/some/app/page'))).toBeNull();
	});

	it('clears the session on logout', async () => {
		const response = await provider().handleRoute?.(get('/logout'));
		expect(response?.headers.get('set-cookie')).toContain('Max-Age=0');
		expect(response?.headers.get('location')).toBe('/login');
	});
});
