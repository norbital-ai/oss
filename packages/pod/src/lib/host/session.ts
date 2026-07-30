import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * What a session asserts: an address was verified, and for which workspace.
 *
 * Deliberately not a user id. Pod resolves the address to a user on every request, so a role change,
 * a deactivation, or a removal takes effect immediately instead of waiting for the cookie to expire —
 * which is what makes a long-lived stateless session acceptable without a revocation list.
 */
export type SessionClaims = {
	readonly email: string;
	readonly organizationId: string;
	readonly organizationName: string;
};

export type CookieSessionOptions = {
	/** Signing secret. At least 32 bytes; rotate by re-deploying with a new value. */
	readonly secret: string;
	/** Cookie name. Defaults to `pod_session`. */
	readonly name?: string;
	/** Lifetime in seconds. Defaults to 30 days. */
	readonly maxAgeSeconds?: number;
	/**
	 * Send the cookie only over HTTPS. Defaults to `true`; a loopback development host is the only
	 * reason to turn it off, and doing so on a routable address publishes the session.
	 */
	readonly secure?: boolean;
};

export type CookieSession = {
	/** A `Set-Cookie` response that redirects, for the end of a verified login. */
	issue(claims: SessionClaims, options?: { readonly redirectTo?: string }): Response;
	/** The claims this request carries, or `null` when absent, tampered, or expired. */
	read(request: Request): SessionClaims | null;
	/** A response that clears the cookie. */
	clear(options?: { readonly redirectTo?: string }): Response;
};

function base64url(input: Buffer): string {
	return input.toString('base64url');
}

function sign(secret: string, payload: string): string {
	return base64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * A signed, stateless session cookie.
 *
 * Stateless on purpose: a pod is evicted after fifteen minutes idle under Core, so a session held in
 * process memory would not survive the gap between two requests, and a session table would add a
 * read to every request for state the cookie can carry itself. The cost is that revocation waits for
 * expiry — acceptable while the only thing a session asserts is "this address was verified", and the
 * authoritative role and status are still read from the tenant database on every request.
 *
 * The payload is `claims.exp` signed with HMAC-SHA256 and compared in constant time, so neither a
 * forged payload nor a truncated signature is accepted.
 */
export function cookieSession(options: CookieSessionOptions): CookieSession {
	if (Buffer.byteLength(options.secret, 'utf8') < 32) {
		throw new Error('cookieSession secret must contain at least 32 bytes');
	}
	const name = options.name ?? 'pod_session';
	const maxAge = options.maxAgeSeconds ?? 30 * 24 * 60 * 60;
	const secure = options.secure ?? true;

	const serialize = (value: string, ageSeconds: number): string =>
		[
			`${name}=${value}`,
			'Path=/',
			'HttpOnly',
			'SameSite=Lax',
			...(secure ? ['Secure'] : []),
			`Max-Age=${ageSeconds}`
		].join('; ');

	return {
		issue(claims, issueOptions) {
			const payload = base64url(
				Buffer.from(
					JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + maxAge }),
					'utf8'
				)
			);
			const token = `${payload}.${sign(options.secret, payload)}`;
			return new Response(null, {
				status: 303,
				headers: {
					'set-cookie': serialize(token, maxAge),
					location: issueOptions?.redirectTo ?? '/'
				}
			});
		},

		read(request) {
			const cookie = request.headers.get('cookie');
			if (!cookie) return null;
			let token: string | undefined;
			for (const part of cookie.split(';')) {
				const [key, ...rest] = part.trim().split('=');
				if (key === name) token = rest.join('=');
			}
			if (!token) return null;
			const separator = token.lastIndexOf('.');
			if (separator <= 0) return null;
			const payload = token.slice(0, separator);
			const provided = Buffer.from(token.slice(separator + 1), 'utf8');
			const expected = Buffer.from(sign(options.secret, payload), 'utf8');
			// Length is compared first: timingSafeEqual throws on a mismatch rather than returning false.
			if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
					(SessionClaims & { exp?: number }) | null;
				if (!claims?.email || !claims.organizationId) return null;
				if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
				return {
					email: claims.email,
					organizationId: claims.organizationId,
					organizationName: claims.organizationName
				};
			} catch {
				return null;
			}
		},

		clear(clearOptions) {
			return new Response(null, {
				status: 303,
				headers: {
					'set-cookie': serialize('', 0),
					location: clearOptions?.redirectTo ?? '/login'
				}
			});
		}
	};
}

/** A URL-safe single-use token and the digest to store in its place. */
export function mintToken(): { readonly token: string; readonly hash: string } {
	const token = base64url(randomBytes(32));
	return { token, hash: hashToken(token) };
}

/**
 * The digest stored for a token.
 *
 * Plain SHA-256 rather than a password hash: the input is 256 bits of CSPRNG output, so it has no
 * guessable structure for a slow KDF to defend, and a lookup happens on every accept.
 */
export function hashToken(token: string): string {
	return createHmac('sha256', 'pod:token').update(token).digest('base64url');
}

/**
 * A keyed digest of an email, for the host-facing event stream.
 *
 * The host needs a stable per-person key to maintain a routing index; it does not need the address.
 * Keying (rather than plain hashing) means a host cannot confirm a guessed address by digesting it.
 */
export function subjectHmac(secret: string, email: string): string {
	return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('base64url');
}
