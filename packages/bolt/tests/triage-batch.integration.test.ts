// System 1 triage admission for an envoy: one decision call judges every pending message of a burst (`m0`, `m1`, …),
// and only the message it answers `yes` is admitted to the turn; a `no` never reaches the model.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import type { AiRequest, AiResponse } from '../src/engine/contracts.ts';
import type { DecisionAnswer } from '../src/engine/decisions/index.ts';
import { TRIAGE_DEBOUNCE } from '../src/engine/agent/triage.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';

const say = (text: string) => (): AiResponse => ({
	content: text,
	toolCalls: [],
	finish: 'stop',
	usage: { input: 10, output: 5 }
});
function cassette(steps: (() => AiResponse)[], ask: Ai['Service']['ask']) {
	const requests: AiRequest[] = [];
	const ports = Layer.succeed(Ai, {
		ask,
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		infer: (req) =>
			Stream.fromEffect(
				Effect.try({
					try: () => {
						requests.push(req);
						const step = steps.shift();
						if (step === undefined) throw new Error('cassette exhausted');
						return { _tag: 'Response' as const, response: step() };
					},
					catch: Port.failure('ai')
				})
			)
	});
	return { ports, requests };
}
const setup = (options: TestOptions<Ai>) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer(options));
		return { t: Context.get(context, TestWorkspace) };
	});

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		integrations: {},
		policies: { desk: { description: 'Desk', grants: {} } },
		teams: {},
		automations: {},
		connections: { field_wa: { integration: 'whatsapp', envoy: 'field_ops' } },
		envoys: {
			field_ops: {
				audience: 'public',
				name: 'Norbius',
				policies: ['desk'],
				groupMessages: 'mention_or_reply',
				delegation: 'disabled',
				triage: {},
				task: 'Keep jobs up to date.'
			}
		},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} }
	})
);

describe('envoy triage admission', () => {
	it.live('one call judges every pending message, and only the one it answers is admitted', () =>
		Effect.scoped(
			Effect.gen(function* () {
				// the shape the decider is asked in: `m0`, `m1`, … each its own yes/no/delay, all in one request. Without this a
				// burst is one verdict for the conversation, so a message that says the name cannot be answered while chatter is
				// ignored — which is exactly the bug that made `hi Norbius` disappear.
				const calls: string[][] = [];
				const sys_1: Ai['Service']['ask'] = (r) =>
					Effect.sync(() => {
						const ids = Object.keys(r.questions).filter((id) => id !== 'wait');
						calls.push(ids);
						const answers: Record<string, DecisionAnswer> = Object.fromEntries(
							ids.map((id, i): readonly [string, DecisionAnswer] => [
								id,
								{
									type: 'choice',
									choice: i === 0 ? 'no' : 'yes',
									confidence: 0.9,
									probabilities: {}
								}
							])
						);
						answers['wait'] = {
							type: 'score',
							score: 0,
							level: 0,
							confidence: 0.9,
							probabilities: {},
							legend: {}
						};
						return { answers, costUsd: 0, provider: 'scripted' };
					});
				const ai = cassette([say('On the van.')], sys_1);
				const { t } = yield* setup({ manifest, ports: ai.ports });
				let n = 0;
				const inbound = (text: string, handle = '6591110000@s.whatsapp.net') =>
					t.receive('field_wa', {
						id: `n${++n}`,
						thread: '1203@g.us',
						sentAt: t.clock.now(),
						from: { handle, name: null },
						text,
						attachments: [],
						group: true
					});
				const texts = () =>
					t.fakes.links.sent.map(
						(s) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
					);

				yield* inbound('lunch at 12?', '6593330000@s.whatsapp.net'); // another member's chatter
				yield* inbound('Norbius, the van is late');
				t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
				yield* t.runDue();

				expect(calls).toEqual([['m0', 'm1']]); // one call, both messages
				expect(texts()).toEqual(['On the van.']);
				expect(JSON.stringify(ai.requests.map((r) => r.messages))).not.toContain('lunch at 12?'); // the `no` never reached the model
			})
		)
	);
});
