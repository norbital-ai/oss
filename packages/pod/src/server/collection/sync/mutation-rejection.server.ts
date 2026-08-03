import { isPodHttpError } from '$lib/server/http.js';

/** The rejection half of a `/_runtime/sync/mutate` result, without the `clientId`/`status` frame. */
export type MutationRejection = {
	readonly reason: string;
	readonly detail?: string;
	readonly currentRow?: Record<string, unknown>;
};

/**
 * Map a thrown error onto the rejection a client receives for one mutation.
 *
 * Two fields, two audiences. `reason` is machine-readable and callers switch on it
 * (`PERMISSION_DENIED`, `CONFLICT`, `HTTP_409`) — it never becomes prose. `detail` is the sentence
 * a person reads, and it exists only when the server actually wrote one.
 *
 * The line between "say it" and "stay quiet" is `HttpError` with a status below 500. An
 * `error(409, 'Cannot revise record until an approver requests changes.')` from a hook or an
 * access-control check is a considered refusal addressed to the caller: it is copy, written to be
 * read, and repeating it verbatim is the whole point. Anything else — a raw `Error`, a pg driver
 * failure, a 5xx the server raised about its own broken state — describes internals the caller
 * neither caused nor can act on, so it carries no `detail` at all and the client is left with the
 * generic `INTERNAL_ERROR`. Nothing that was never written for a user can leak into user copy,
 * because only a deliberately authored message is ever put in the field the UI reads.
 */
export function mutationRejection(err: unknown): MutationRejection {
	if (!isPodHttpError(err)) return { reason: 'INTERNAL_ERROR' };

	const code = typeof err.body.code === 'string' ? err.body.code : undefined;
	const reason = code ?? (err.status === 403 ? 'PERMISSION_DENIED' : `HTTP_${err.status}`);
	const currentRow =
		err.body.currentRow && typeof err.body.currentRow === 'object'
			? (err.body.currentRow as Record<string, unknown>)
			: undefined;
	const message = typeof err.body.message === 'string' ? err.body.message.trim() : '';
	const detail = err.status < 500 && message.length > 0 ? message : undefined;

	return {
		reason,
		...(detail ? { detail } : {}),
		...(currentRow ? { currentRow } : {})
	};
}

/** True when the failure is the server's own, not an answer written for the caller. */
export function isUnexpectedMutationError(err: unknown): boolean {
	return !isPodHttpError(err) || err.status >= 500;
}
