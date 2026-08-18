import type { BoltTransport } from '../../../client.js';

export type HttpBoltTransportOptions = Readonly<{
	readonly baseUrl?: string;
	readonly credential: string;
}>;

/** Browser transport that posts Bolt commands through Colony's same-origin proxy. */
export function createHttpBoltTransport(options: HttpBoltTransportOptions): BoltTransport {
	const baseUrl = options.baseUrl ?? '';
	return {
		command: async (command, input, signal) => {
			const response = await fetch(`${baseUrl}/api/bolt/command/${encodeURIComponent(command)}`, {
				method: 'POST',
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
