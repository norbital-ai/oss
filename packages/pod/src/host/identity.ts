import { timingSafeEqual } from 'node:crypto';
import { BaseScopeSchema } from '@norbital-ai/platform-utils/scope/types';
import { safeParse } from '@norbital-ai/std/json';
import type { HostIdentity, HostIdentityProvider } from './types.js';

export const TRUSTED_HOST_TOKEN_HEADER = 'x-norbital-host-token';

/**
 * Compare a presented host token with the expected one in constant time.
 *
 * Exported because the hosted runtime's control routes carry no identity to check alongside the
 * token, and a second comparison written by hand is how one of them ends up leaking the token's
 * length or its first differing byte to anyone who can time a request.
 */
export function hostTokenMatches(provided: string, expected: string): boolean {
	const providedBytes = Buffer.from(provided, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	// Compare lengths first: timingSafeEqual throws on a length mismatch rather than returning false.
	return (
		providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
	);
}

/**
 * The production provider: an authenticated host in front of the runtime forwards the identity it
 * already established, proving it is that host with a shared token.
 *
 * The token is what makes the forwarded headers trustworthy. Without it any client could set
 * `x-norbital-user-id` and become anyone, which is why this provider refuses a request whose token
 * is absent or wrong before it looks at the identity headers at all.
 */
export function trustedHeaderIdentity(options: { readonly token: string }): HostIdentityProvider {
	if (Buffer.byteLength(options.token, 'utf8') < 32) {
		throw new Error('Trusted host token must contain at least 32 bytes');
	}
	return {
		name: 'trusted-header',
		authenticate(request) {
			const token = request.headers.get(TRUSTED_HOST_TOKEN_HEADER)?.trim() ?? '';
			if (!hostTokenMatches(token, options.token)) return null;

			const userId = request.headers.get('x-norbital-user-id')?.trim() ?? '';
			const organizationId = request.headers.get('x-norbital-org-id')?.trim() ?? '';
			const organizationName = request.headers.get('x-norbital-org-name')?.trim() ?? '';
			const rawScope = request.headers.get('x-norbital-base-scope-json')?.trim() ?? '';
			if (!userId || !organizationId || !organizationName || !rawScope) return null;

			let scope: unknown;
			try {
				scope = safeParse(rawScope);
			} catch {
				return null;
			}
			const parsed = BaseScopeSchema.safeParse(scope);
			if (
				!parsed.success ||
				parsed.data.requestor.norbital_id !== userId ||
				parsed.data.organization.norbital_id !== organizationId ||
				parsed.data.organization.name !== organizationName
			) {
				return null;
			}
			return { userId, organizationId, organizationName, baseScope: parsed.data };
		}
	};
}

/**
 * The local-development provider: every request is the bootstrapped admin.
 *
 * There is no credential here and none is implied — this exists so that `pod dev` opens in a
 * browser. `resolveStandaloneHost` refuses to install it on a non-loopback bind, so the failure
 * mode is a refusal to start rather than an unauthenticated workspace on a public port.
 *
 * No `baseScope` is returned. Pod resolves the real one from the tenant database, so a dev session
 * sees the same role, status, and team membership the deployed workspace would give that user
 * instead of a forged scope that can drift from it.
 */
export function devIdentity(options: {
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationName: string;
}): HostIdentityProvider {
	const identity: HostIdentity = {
		userId: options.userId,
		organizationId: options.organizationId,
		organizationName: options.organizationName
	};
	return {
		name: 'dev',
		authenticate() {
			return identity;
		}
	};
}
