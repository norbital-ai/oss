// What every chat adapter's test shares: its real adapter over the real `chatProvider`, with the platform's API faked
// behind the global `fetch`, which is what a platform's SDK calls.
import { Effect } from 'effect';
import { chatProvider, type ChatPlatform } from '../../src/chat/adapter.ts';
import { host, json, type HostOptions } from '../kit.ts';

export type Call = { readonly url: string; readonly headers: Headers; readonly body: string };
/** Answers each call from `answer`, for one test: a platform's API, recording what the adapter sent it. */
export const platformApi = (answer: (call: Call) => Response) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const real = globalThis.fetch,
				calls: Call[] = [];
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const call = {
					url: request.url,
					headers: request.headers,
					body: await request.text()
				};
				calls.push(call);
				return answer(call);
			};
			return { real, calls };
		}),
		({ real }) =>
			Effect.sync(() => {
				globalThis.fetch = real;
			})
	);
/** The adapter connected with `settings`, through the same pairing a person's form goes through. */
export const connected = (
	platform: ChatPlatform,
	settings: Record<string, string>,
	options: HostOptions = {}
) =>
	Effect.gen(function* () {
		const h = yield* host(chatProvider(platform), fetch, undefined, options);
		if (h.link.pair === undefined)
			return yield* Effect.fail(new Error('The chat provider does not support pairing.'));
		yield* h.link.pair(settings);
		return h;
	});
export const webhook = (body: string, headers: Record<string, string>) =>
	new Request('https://hook.test/', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body
	});
export { json };
