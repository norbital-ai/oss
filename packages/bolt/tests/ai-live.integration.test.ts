// Opt-in live provider probe (L-BOLT-435): one tiny streamed turn; cassettes cover the loop offline.
import { expect, it } from '@effect/vitest';
import { Config, Effect, Option, Redacted, Stream } from 'effect';
import { openAiChat } from '../src/engine/agent/openai-chat.ts';

it.live(
	'a live provider streams a short answer with its usage',
	(context) =>
		Effect.gen(function* () {
			const endpoint = yield* Config.option(Config.String('BOLT_AI_SYS_2_ENDPOINT'));
			const credential = yield* Config.option(Config.Redacted('BOLT_AI_SYS_2_CREDENTIAL'));
			const model = yield* Config.option(Config.String('BOLT_AI_LIVE_MODEL'));
			if (
				Option.isNone(endpoint) ||
				Option.isNone(credential) ||
				Option.isNone(model) ||
				endpoint.value === '' ||
				Redacted.value(credential.value) === '' ||
				model.value === ''
			)
				return context.skip();
			const infer = openAiChat({
				endpoint: endpoint.value,
				credential: Redacted.value(credential.value),
				models: { default: model.value }
			});
			const events = yield* Stream.runCollect(
				infer({
					model: 'default',
					system: 'Answer with one word.',
					messages: [{ role: 'user', content: 'Reply with the word pong.' }]
				})
			).pipe(Effect.timeout('60 seconds'));
			const response = events.find((event) => event._tag === 'Response');
			if (response === undefined)
				return yield* Effect.die(new Error('provider emitted no response'));
			const r = response.response;
			expect(String(r.content).toLowerCase()).toContain('pong');
			expect(events.flatMap((event) => (event._tag === 'Delta' ? [event.text] : [])).join('')).toBe(
				r.content
			);
			expect(r.finish).toBe('stop');
			expect(r.usage.input).toBeGreaterThan(0);
		}),
	90_000
);
