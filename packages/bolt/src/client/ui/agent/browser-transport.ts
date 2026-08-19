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
				const message =
					payload !== null &&
					typeof payload === 'object' &&
					'message' in payload &&
					typeof payload.message === 'string'
						? payload.message
						: `Bolt command ${command} failed (${response.status})`;
				throw new Error(message);
			}
			return payload;
		}
	};
}
