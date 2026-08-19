import type { BoltTransport } from '../../../client.js';

export type HttpBoltTransportOptions = Readonly<{
	/**
	 * Where a command is posted, as a prefix the command name is appended to.
	 *
	 * Stated rather than assumed. This was `${baseUrl}/api/bolt/command/…`, which is one host's
	 * routing table written into the framework: an artifact served by anything else answered
	 * commands at a path this transport could not name, and the only way to find out was every
	 * command failing with a 404 that read as a missing command.
	 */
	readonly endpoint: string;
	readonly credential: string;
}>;

/** A string field of an object, or nothing — the shape checks every branch below would repeat. */
const textField = (value: unknown, field: string): string | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const held = (value as Record<string, unknown>)[field];
	return typeof held === 'string' && held.trim() !== '' ? held : undefined;
};

/**
 * What the operator is told when a command is refused.
 *
 * This read `payload.message` and nothing else, so it found a message only when the body happened
 * to put one at the top level — and the two bodies that actually carry a refusal do not.
 *
 * A runtime refusal is a *wire error*: the host answers `{ error: { code, message } }` with the
 * bundle's own status, which is how every Postgres failure, every denied access check and every
 * facility fault comes back. A host refusal (Colony's 409) is a tagged failure serialised as its
 * fields. In both cases the reason was present in the response body and thrown away here, so a
 * unique-constraint violation and an unconfigured AI provider both reported themselves as
 * `Bolt command <name> failed (500)` — a status code, which is the one fact the caller already had.
 *
 * The status-only sentence stays as the last resort, for a body that genuinely says nothing.
 */
const refusalMessage = (command: string, status: number, payload: unknown): string => {
	const direct = textField(payload, 'message');
	if (direct !== undefined) return direct;
	const wire =
		payload !== null && typeof payload === 'object'
			? (payload as { readonly error?: unknown }).error
			: undefined;
	const nested = textField(wire, 'message');
	if (nested !== undefined) {
		const code = textField(wire, 'code');
		return code === undefined || code === '' ? nested : `${code}: ${nested}`;
	}
	const reason = textField(payload, 'reason');
	if (reason !== undefined) return reason;
	return `Bolt command ${command} failed (${status})`;
};

/** Browser transport that posts Bolt commands to the endpoint the host declared. */
export function createHttpBoltTransport(options: HttpBoltTransportOptions): BoltTransport {
	const endpoint = options.endpoint.replace(/\/$/, '');
	return {
		command: async (command, input, signal) => {
			const response = await fetch(`${endpoint}/${encodeURIComponent(command)}`, {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${options.credential}`
				},
				body: JSON.stringify(input),
				signal
			});
			const text = await response.text();
			const payload = text.length === 0 ? null : JSON.parse(text);
			if (!response.ok) {
				throw new Error(refusalMessage(command, response.status, payload));
			}
			return payload;
		}
	};
}
