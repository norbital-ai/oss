import type { SignInTransport } from './i18n.js';

/**
 * A sign-in transport over two host endpoints.
 *
 * Minting the session cookie is the host's work — the credential is HttpOnly — so the host owns
 * two endpoints and this helper only owns the wire shape it expects of them: a JSON POST carrying
 * `{ email, workspace }` to `challengeUrl` and `{ email, code, workspace }` to `sessionUrl`, each
 * answered with `{ ok: true }` or `{ ok: false, reason }`. Any failure the host does not name is
 * `mint-failed`, which the form renders as the generic refusal.
 */
export const httpSignInTransport = (input: {
	readonly workspace: string;
	readonly challengeUrl: string;
	readonly sessionUrl: string;
	/** Called once a code verified: the first moment the address is known to be real. */
	readonly onVerified?: (email: string) => void;
}): SignInTransport => {
	const post = async (
		url: string,
		body: Readonly<Record<string, string>>
	): Promise<{ ok: true } | { ok: false; reason: string }> => {
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body)
			});
			const text = await response.text();
			const decoded: unknown = text === '' ? undefined : JSON.parse(text);
			const ok =
				typeof decoded === 'object' && decoded !== null && Reflect.get(decoded, 'ok') === true;
			if (response.ok && ok) return { ok: true };
			const reason =
				typeof decoded === 'object' && decoded !== null
					? Reflect.get(decoded, 'reason')
					: undefined;
			return { ok: false, reason: typeof reason === 'string' ? reason : 'mint-failed' };
		} catch {
			return { ok: false, reason: 'mint-failed' };
		}
	};
	return {
		sendCode: (email) => post(input.challengeUrl, { email, workspace: input.workspace }),
		verifyCode: async (email, code) => {
			const outcome = await post(input.sessionUrl, { email, code, workspace: input.workspace });
			if (outcome.ok) input.onVerified?.(email);
			return outcome;
		}
	};
};
