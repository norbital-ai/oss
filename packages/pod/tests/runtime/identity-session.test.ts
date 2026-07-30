import { describe, expect, it } from 'vitest';
import { cookieSession, hashToken, mintToken, subjectHmac } from '../../src/lib/host/session.js';

const SECRET = 'a'.repeat(32);

function cookieFrom(response: Response): string {
	const header = response.headers.get('set-cookie');
	if (!header) throw new Error('Response carried no Set-Cookie');
	return header.split(';')[0] ?? '';
}

function requestWith(cookie: string): Request {
	return new Request('https://acme.example/', { headers: { cookie } });
}

describe('cookieSession', () => {
	const sessions = cookieSession({ secret: SECRET });

	it('refuses a secret too short to sign with', () => {
		expect(() => cookieSession({ secret: 'short' })).toThrow(/32 bytes/);
	});

	it('round-trips the verified address and workspace', () => {
		const issued = sessions.issue({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
		expect(sessions.read(requestWith(cookieFrom(issued)))).toEqual({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
	});

	it('sets HttpOnly, Secure, and SameSite so the cookie is not script-readable or cross-site', () => {
		const header = sessions
			.issue({ email: 'bob@example.com', organizationId: 'o', organizationName: 'A' })
			.headers.get('set-cookie');
		expect(header).toContain('HttpOnly');
		expect(header).toContain('Secure');
		expect(header).toContain('SameSite=Lax');
	});

	it('rejects a tampered payload', () => {
		const issued = sessions.issue({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
		const [name, value] = cookieFrom(issued).split('=');
		const [payload, mac] = value.split('.');
		// Re-encode the claims as a different person, keeping the original signature.
		const forged = Buffer.from(
			JSON.stringify({
				email: 'attacker@example.com',
				organizationId: 'org-1',
				organizationName: 'Acme',
				exp: Math.floor(Date.now() / 1000) + 3600
			}),
			'utf8'
		).toString('base64url');
		expect(sessions.read(requestWith(`${name}=${forged}.${mac}`))).toBeNull();
		expect(payload).not.toEqual(forged);
	});

	it('rejects a truncated or empty signature', () => {
		const issued = sessions.issue({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
		const [name, value] = cookieFrom(issued).split('=');
		const [payload, mac] = value.split('.');
		expect(sessions.read(requestWith(`${name}=${payload}.${mac?.slice(0, 8)}`))).toBeNull();
		expect(sessions.read(requestWith(`${name}=${payload}.`))).toBeNull();
		expect(sessions.read(requestWith(`${name}=${payload}`))).toBeNull();
	});

	it('rejects a session signed with a different secret', () => {
		const other = cookieSession({ secret: 'b'.repeat(32) });
		const issued = other.issue({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
		expect(sessions.read(requestWith(cookieFrom(issued)))).toBeNull();
	});

	it('rejects an expired session even though its signature is valid', () => {
		const brief = cookieSession({ secret: SECRET, maxAgeSeconds: -1 });
		const issued = brief.issue({
			email: 'bob@example.com',
			organizationId: 'org-1',
			organizationName: 'Acme'
		});
		// The signature covers the expiry, so a client cannot extend its own window by editing it.
		expect(brief.read(requestWith(cookieFrom(issued)))).toBeNull();
	});

	it('reads nothing from a request with no cookie', () => {
		expect(sessions.read(new Request('https://acme.example/'))).toBeNull();
	});

	it('clears by expiring the cookie rather than relying on the client to forget', () => {
		const header = sessions.clear().headers.get('set-cookie');
		expect(header).toContain('Max-Age=0');
	});
});

describe('token minting', () => {
	it('stores a digest that cannot be replayed as the token', () => {
		const { token, hash } = mintToken();
		expect(hash).not.toEqual(token);
		expect(hashToken(token)).toEqual(hash);
		// A stolen table gives an attacker the digest, and digesting it again does not reproduce it.
		expect(hashToken(hash)).not.toEqual(hash);
	});

	it('never repeats a token', () => {
		const seen = new Set(Array.from({ length: 200 }, () => mintToken().token));
		expect(seen.size).toBe(200);
	});
});

describe('subjectHmac', () => {
	it('is stable per address and case-insensitive', () => {
		expect(subjectHmac(SECRET, 'Bob@Example.com ')).toEqual(subjectHmac(SECRET, 'bob@example.com'));
	});

	it('is keyed, so a host cannot confirm a guessed address without the key', () => {
		expect(subjectHmac(SECRET, 'bob@example.com')).not.toEqual(
			subjectHmac('b'.repeat(32), 'bob@example.com')
		);
	});

	it('does not leak the address it digests', () => {
		expect(subjectHmac(SECRET, 'bob@example.com')).not.toContain('bob');
	});
});
