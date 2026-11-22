// The agent engine's pure parts: bounded tool results, context projection and native AI streams.
import { describe, expect, it } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema, Stream } from 'effect';
import {
	type AiRequest,
	type AiResponse,
	FacilityFailure,
	Port,
	type PortFailure
} from '@norbital-ai/host-api';
import type { Json } from '../src/decl/values.ts';
import type { Ai } from '../src/engine/ports.ts';
import type { AiEvent } from '@norbital-ai/host-api';
import type { FacilityCall } from '../src/engine/services.ts';
import {
	applyEdit,
	DEFAULT_STEPS,
	infer_facility,
	MODEL_FILES,
	modelCall,
	STALL_MS
} from '../src/engine/agent/ai.ts';
import { overLimit, type AgentSettings } from '../src/engine/agent/settings.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { jsonDiff } from '../src/engine/agent/draft.ts';
import {
	bound,
	bounded,
	BOUNDS,
	messages,
	modelTranscript,
	pageNote,
	pageWaiting,
	projection,
	state,
	storedToolResult,
	system,
	withStateNote
} from '../src/engine/agent/context.ts';
import { listed, type MessageRow } from '../src/engine/agent/schema.ts';
import { keyedSerial } from '../src/engine/agent/throttle.ts';
import {
	AGENT_LIMITS,
	callKey,
	clearToolFailures,
	recordCheckProgress,
	STREAM_FLUSH_MS,
	type CheckProgress
} from '../src/engine/agent/shared.ts';
import { makeStreamer } from '../src/engine/agent/turn-io.ts';
import {
	collectFullTranscript,
	exportTranscriptMarkdown
} from '../src/shell/agent/actions.ts';
import type { AgentRow } from '../src/protocol/wire.ts';
import { RunUnits } from '../src/engine/ports.ts';
import { preview } from '../src/engine/conversations/store.ts';
import { respond_system_1 } from '../../bolt-cli/src/test/effect.ts';
import { clock_probe } from './support/clock-probe.ts';

const required = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const promptSchema = (content: unknown) => {
	const prompt = Schema.decodeUnknownSync(Schema.String)(content);
	const fence = /```json\r?\n([\s\S]*?)\r?\n```/.exec(prompt);
	return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(fence?.[1]);
};
const row = (
	seq: number,
	over: Partial<Exclude<MessageRow, { role: 'tool' }>> = {}
): MessageRow => ({
	id: `m${seq}`,
	conversation: 'c',
	seq,
	role: 'user',
	content: { text: `t${seq}` },
	text: `t${seq}`,
	state: 'consumed',
	mode: 'agent',
	as: null,
	author: null,
	meta: null,
	supersedes: null,
	turn: null,
	...over
});
type Step = Ai['Service']['infer'];
describe('guidance follows the tools actually available', () => {
	it('adds what source is only to an author, and names no tool or step', () => {
		expect(system({ authors: false })).not.toContain('# Source');
		expect(system({ authors: false })).toContain('Source editing is unavailable');
		const prompt = system({ authors: true });
		expect(prompt).toContain('# Source');
		expect(prompt).not.toMatch(/workspace_|run_tool|bolt-primer|\bhost\b/);
	});
	it('a channel conversation gets its own guidance and the native-question rule', () => {
		const prompt = system({ envoy: 'Desk', authors: false });
		expect(prompt).toContain("This channel has no workspace tab of the person's.");
		expect(prompt).toContain('do not repeat its question, choices or summary');
	});
});

describe('programmatic messages in follow-up context', () => {
	it('keeps distinct full attachment ids when uploads share a time-based UUID prefix', () => {
		const first = '01a1e483-0000-7000-8000-000000000001';
		const second = '01a1e483-0000-7000-8000-000000000002';
		const text = JSON.stringify(
			messages([
				row(1, {
					files: [
						{ id: first, name: 'image.png', mime: 'image/png' },
						{ id: second, name: 'image.png', mime: 'image/png' }
					]
				})
			])
		);
		expect(text).toContain(`id ${first}`);
		expect(text).toContain(`id ${second}`);
	});
	it('keeps confirmed sends as assistant context and excludes unsent, uncertain and deleted messages', () => {
		const statuses = ['queued', 'sending', 'uncertain', 'failed', 'sent', 'delivered', 'read', 'opened', 'replied'];
		const outbound = statuses.map((status, index) => row(index + 1, {
			role: null, direction: 'outbound', state: null, status,
			text: `Daily report: ${status}`, content: null, deleted_at: null
		}));
		const removed = row(20, { role: null, direction: 'outbound', state: null, status: 'sent', text: 'Deleted report', content: null, deleted_at: '2026-09-25T10:00:00.000Z' });
		const followup = row(21, { text: 'What changed since that report?', content: { text: 'What changed since that report?' } });
		const expected = ['sent', 'delivered', 'read', 'opened', 'replied'].map((status) => ({ role: 'assistant', content: `Daily report: ${status}` }));
		expect(messages([...outbound, removed, followup])).toEqual([...expected, { role: 'user', content: { text: 'What changed since that report?' } }]);
		expect(projection([...outbound, removed, followup], { plan: null }).map(({ id }) => id)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9', 'm21']);
	});
});

describe('a page step', () => {
	const step = (result: Json): MessageRow => ({
		...row(2),
		role: 'tool',
		state: null,
		content: { id: 'c1', assistant: 'a1', name: 'page', behavior: { page: true }, result }
	});
	it('waits for its tab, then closes the context with what the tab shows', () => {
		const asked = { requested: true, navigation: '/app/ops' };
		expect(pageWaiting([row(1), step(asked)])).toBe(true);
		const shown = step({ ...asked, page_result: { ok: true, screen: 'Orders · New' } });
		expect(pageWaiting([row(1), shown])).toBe(false);
		expect(pageNote([row(1), shown])).toBe(
			'Your last page step ran. Their page shows: Orders · New'
		);
		// a path is accepted when called: the note says where the tab went, so the step is not sent again
		expect(pageNote([row(1), step(asked)])).toBe(
			"Your last page step sent the person's tab to /app/ops; it has not reported what that page shows yet. Do not send it there again."
		);
		expect(pageNote([row(1), step({ page: { click: 'x' }, requested: true })])).toBe(
			'Your last page step is awaiting the tab or the person. It has not reported completion; do not say it ran.'
		);
		expect(pageNote([row(1), step({ page: { click: 'x' }, requested: true, pageClaim: true })])).toContain('awaiting');
		expect(pageNote([row(1), step({ page_result: { ok: false, note: 'The person declined.' } })])).toBe(
			'Your last page step failed: The person declined.'
		);
	});
	it('stays the message it was sent, whatever the tab answers', () => {
		const sent = { requested: true, navigation: '/app/ops' };
		const later = step({ ...sent, pageClaim: true, page_result: { ok: true, screen: 'Orders' } });
		expect(messages([later], [later])).toEqual(messages([step(sent)], [step(sent)]));
	});
});
const response = (answer: AiResponse): Stream.Stream<AiEvent, PortFailure> =>
	Stream.succeed({ _tag: 'Response', response: answer });
const port = (answers: readonly Step[]) => {
	const requests: AiRequest[] = [];
	let index = 0;
	const p: Ai['Service'] = {
		ask: respond_system_1,
		maxChoices: undefined,
		models: ['default'],
		deciders: Effect.succeed({ models: [], default: '' }),
		catalog: Effect.succeed({ models: [{ id: 'default', label: 'Default' }], default: 'default' }),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.unwrap(
				Effect.sync(() => {
					requests.push(request);
					const answer = answers[index++];
					return answer === undefined
						? Stream.fail(new FacilityFailure({ kind: 'upstream', message: 'cassette exhausted' }))
						: answer(request);
				})
			)
	};
	return { p, requests };
};
/** A native stream that yields text and then stays open until interruption. */
const stalls =
	(text: string): Step =>
	() =>
		Stream.concat(
			Stream.fromIterable<AiEvent>(text === '' ? [] : [{ _tag: 'Delta', text }]),
			Stream.fromEffect(Effect.never)
		);
const done =
	(text: string): Step =>
	() =>
		response({ content: text, tool_calls: [], finish: 'stop', usage: { input: 1, output: 1 } });
const elapsed = clock_probe;

describe('tool results are bounded', () => {
	it('a result is bounded once when stored and rides the transcript as stored: whole within its bound, its start past it', () => {
		// stored as the engine settles a call: bounded once, the whole kept for read_file
		const stored = (bytes: number) => {
			const whole = 'x'.repeat(bytes);
			return messages([
				{
					...row(1),
					role: 'tool',
					state: null,
					content: { id: 'c', assistant: 'a1', name: 'skill', result: storedToolResult('c', bounded(whole).value, whole).result }
				}
			])[0];
		};
		expect(JSON.stringify(stored(BOUNDS.cellBytes - 1_000))).not.toContain('truncated');
		expect(stored(BOUNDS.cellBytes - 1_000)).toEqual({ role: 'tool', content: { id: 'c', name: 'skill', result: 'x'.repeat(BOUNDS.cellBytes - 1_000) } });
		expect(JSON.stringify(stored(BOUNDS.resultBytes + 1_000))).toContain('truncated');
	});
	it('clips long cells and drops trailing rows with a note, within the result bound', () => {
		const rows = Array.from({ length: 200 }, (_, i) => ({
			id: String(i),
			note: 'x'.repeat(BOUNDS.cellBytes + 800)
		}));
		const result = bound({ rows, next: null });
		const out = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Struct({ note: Schema.String })),
				clipped: Schema.String
			})
		)(result);
		expect(size(result)).toBeLessThanOrEqual(BOUNDS.resultBytes);
		expect(required(out.rows[0]).note).toMatch(new RegExp(`clipped, ${BOUNDS.cellBytes + 802} bytes`));
		expect(out.clipped).toMatch(new RegExp(`showing ${out.rows.length} of 200 rows`));
		expect(bound({ a: 1 })).toEqual({ a: 1 });
		// a read page's total is what the note counts against
		const counted = Schema.decodeUnknownSync(Schema.Struct({ clipped: Schema.String }))(
			bound({ rows, next: 'c', total: 1284 })
		);
		expect(counted.clipped).toMatch(/^showing \d+ of 1284 rows \(this page read 200\)/);
	});
	it('previews are at most 2 KiB', () => {
		expect(new TextEncoder().encode(preview('é'.repeat(3_000))).length).toBeLessThanOrEqual(2051);
		expect(preview('short')).toBe('short');
	});
});

describe('the context projection', () => {
	it('keeps the whole transcript except superseded, ambient, queued, pre-checkpoint and pre-plan rows', () => {
		const rows = [
			row(1),
			row(2, { addressed: false }),
			row(3),
			row(4, { supersedes: 'm3' }),
			row(5, { role: 'assistant', content: { text: 'a', toolCalls: [] } }),
			row(6, {
				role: 'system',
				content: { text: 'summary' },
				meta: { tag: 'compact', cutoff: 5, keep: ['m1'] }
			}),
			row(7),
			row(8, { state: 'queued' }),
			row(9, { role: null, addressed: false })
		];
		expect(projection(rows, { plan: null }).map((r) => r.id)).toEqual(['m1', 'm6', 'm7']);
		expect(
			projection(rows, {
				plan: { revision: 1, body: 'p', status: 'active', checkpoint: 6, verdicts: 0 }
			}).map((r) => r.id)
		).toEqual(['m7']);
		expect(projection(rows.slice(0, 5), { plan: null }).map((r) => r.id)).toEqual([
			'm1',
			'm4',
			'm5'
		]);
	});
	it('every message carries its sender header, which says whom the turn serves; engine notes are user text', () => {
		const dm = {
			envoy: { name: 'desk', instance: 'wa', sender: '+65', member: 'u-ann', dm: true }
		};
		const out = messages([
			row(1, { author: 'Ann', as: dm }),
			row(2, { author: '+66', as: { envoy: { ...dm.envoy, member: null, dm: false } } }),
			row(3, {
				role: 'system',
				content: { text: 'ok' },
				meta: { tag: 'verdict', complete: true, gaps: [] }
			})
		]);
		expect(out).toEqual([
			{
				role: 'user',
				content: '[Ann · linked member u-ann] t1'
			},
			{ role: 'user', content: '[+66 · not linked] t2' },
			{ role: 'user', content: '[note]\nok' }
		]);
	});
	it('the system prompt is the kernel, brief, envoy, task, source note and identity: no skills, date or conversation state', () => {
		const s = system({ envoy: 'Norbius', brief: 'Brief.', task: 'Task.', authors: false });
		// what every conversation shares first (the brief), then the envoy's channel guidance and its task
		expect(s).toContain('\n\n# Brief\nBrief.\n\nYou are Norbius');
		expect(s.endsWith('\n\nTask.')).toBe(true);
		expect(s).not.toMatch(/20\d\d|clock|timezone|# Skills/i);
		// the channel guidance names the envoy, so a message that says the name is readable as addressed to it
		expect(s).toContain('You are Norbius, answering on a messaging channel.');
		// and it may not narrate the workspace's own checks
		expect(s).toContain("Never describe the workspace's own automated checks");
		// the author's source note follows the shared parts
		const layout = system({ brief: 'Brief.', authors: true });
		expect(layout.indexOf('# Brief')).toBeLessThan(layout.indexOf('# Source'));
		expect(layout).not.toMatch(/workspace_list|workspace_grep|workspace_glob|workspace_lang/);
	});
});

describe('the AI port under the 20 s idle wall', () => {
	const req: AiRequest = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
	it.effect('keeps the native response and records prompt sizes at the model boundary', () =>
		Effect.gen(function* () {
			const native: AiResponse = {
				content: { text: 'ready', extra: [1, 2] },
				reasoning: 'received reasoning',
				tool_calls: [{ id: 'c1', name: 'read', input: { id: 'one' }, invalid: 'provider note' }],
				finish: 'cut',
				continuation: 'next',
				usage: {
					input: 10,
					output: 4,
					cost: 0.2,
					call: 'call1',
					provider: 'provider1',
					cached: 3,
					reasoning: 2
				}
			};
			const { p, requests } = port([() => response(native)]);
			expect(yield* modelCall(p, req)).toEqual({
				...native,
				usage: {
					...native.usage,
					prompt: { system: 0, messages: JSON.stringify(req.messages).length, tools: 0 }
				}
			});
			expect(requests[0]).toBe(req);
		})
	);
	it.effect('resets a utility attempt’s private streamed progress before retrying', () =>
		Effect.gen(function* () {
			const failed: Step = () =>
				Stream.concat(
					Stream.succeed<AiEvent>({ _tag: 'Delta', text: 'discarded' }),
					Stream.fail(
						new FacilityFailure({ kind: 'upstream', status: 503, message: 'lost connection' })
					)
				);
			const { p, requests } = port([failed, stalls('kept')]);
			expect(
				yield* elapsed(modelCall(p, req, { wallMs: 20, retryUpstream: 1 }), 1_021)
			).toMatchObject({
				content: 'kept',
				finish: 'cut'
			});
			expect(requests).toHaveLength(2);
		})
	);
	it.effect('a chat call whose provider failed before answering is tried twice more; one that began is not', () =>
		Effect.gen(function* () {
			const dropped: Step = () =>
				Stream.fail(new FacilityFailure({ kind: 'upstream', message: 'Transport error' }));
			const quiet = port([dropped, dropped, stalls('answered')]);
			expect(yield* elapsed(modelCall(quiet.p, req, { wallMs: 20 }), 3_021)).toMatchObject({
				content: 'answered'
			});
			expect(quiet.requests).toHaveLength(3);
			const begun: Step = () =>
				Stream.concat(
					Stream.succeed<AiEvent>({ _tag: 'Delta', text: 'half' }),
					Stream.fail(new FacilityFailure({ kind: 'upstream', status: 503, message: 'lost connection' }))
				);
			const shown = port([begun, stalls('never')]);
			expect(yield* Effect.flip(modelCall(shown.p, req, { wallMs: 20 }))).toMatchObject({ kind: 'upstream' });
			expect(shown.requests).toHaveLength(1);
		})
	);
	it.effect(
		'the default response deadline cancels and settles a silent provider after 60 seconds to its first event',
		() =>
			Effect.gen(function* () {
				let settled = false;
				const silent: Step = () =>
					Stream.fromEffect(
						Effect.never.pipe(
							Effect.ensuring(
								Effect.sync(() => {
									settled = true;
								})
							)
						)
					);
				expect(yield* elapsed(Effect.flip(modelCall(port([silent]).p, req)), 60_001)).toMatchObject(
					{
						kind: 'timeout',
						message: 'the model yielded nothing within 60000 ms'
					}
				);
				expect(settled).toBe(true);
			})
	);
	it.effect(
		'valid progress keeps a 60-second response alive under the default 20-second idle deadline',
		() =>
			Effect.gen(function* () {
				const active: Step = () =>
					Stream.concat(
						Stream.fromIterable<AiEvent>(
							Array.from({ length: 4 }, () => ({ _tag: 'Progress', reasoning: undefined }))
						).pipe(Stream.mapEffect((event) => Effect.sleep('15 seconds').pipe(Effect.as(event)))),
						response({
							content: 'ready',
							tool_calls: [],
							finish: 'stop',
							usage: { input: 1, output: 1 }
						})
					);
				expect(yield* elapsed(modelCall(port([active]).p, req), 60_001)).toMatchObject({
					content: 'ready',
					finish: 'stop'
				});
			})
	);
	it.effect(
		'a provider idle timeout keeps received text as a cut and preserves an empty response failure',
		() =>
			Effect.gen(function* () {
				const error = new FacilityFailure({
					kind: 'timeout',
					message: 'ai.stream did not answer within 20000 ms'
				});
				const partial: Step = () =>
					Stream.concat(
						Stream.succeed<AiEvent>({ _tag: 'Delta', text: 'received' }),
						Stream.fail(error)
					);
				expect(yield* modelCall(port([partial]).p, req)).toMatchObject({
					content: 'received',
					finish: 'cut'
				});
				expect(yield* Effect.flip(modelCall(port([() => Stream.fail(error)]).p, req))).toBe(error);
			})
	);
	it.effect('an absent port or an unmapped class is unavailable; files are capped per call', () =>
		Effect.gen(function* () {
			expect(yield* Effect.flip(modelCall(undefined, req))).toMatchObject({ _tag: 'Unavailable' });
			expect(yield* Effect.flip(modelCall(port([]).p, { ...req, model: 'vision' }))).toMatchObject({
				_tag: 'Unavailable',
				reason: expect.stringContaining('vision')
			});
			const files = Array.from({ length: MODEL_FILES.count + 1 }, () => ({
				mime: 'image/png',
				bytes: new Uint8Array(1)
			}));
			expect(yield* Effect.flip(modelCall(port([]).p, { ...req, files }))).toMatchObject({
				kind: 'invalid'
			});
		})
	);
	it.effect(
		'a stream open at the wall is kept as a cut step; one that yields nothing is a timeout (OD-13)',
		() =>
			Effect.gen(function* () {
				expect(
					yield* elapsed(modelCall(port([stalls('partial ')]).p, req, { wallMs: 20 }), 21)
				).toMatchObject({
					finish: 'cut',
					content: 'partial '
				});
				expect(
					yield* elapsed(Effect.flip(modelCall(port([stalls('')]).p, req, { wallMs: 20 })), 21)
				).toMatchObject({
					kind: 'timeout'
				});
				const own: Step = () =>
					response({
						content: 'x',
						tool_calls: [],
						finish: 'cut',
						continuation: 'k',
						usage: { input: 1, output: 1 }
					});
				expect(yield* modelCall(port([own]).p, req, { wallMs: 20 })).toMatchObject({
					finish: 'cut',
					continuation: 'k'
				});
				expect(
					yield* Effect.flip(
						modelCall(
							port([
								() =>
									Stream.fail(
										new FacilityFailure({
											kind: 'upstream',
											message: 'prompt is too long',
											status: 400
										})
									)
							]).p,
							req
						)
					)
				).toMatchObject({ kind: 'upstream', status: 400 });
			})
	);
	it.effect('ctx.ai.sys_2.infer: a cut response continues as two calls and one answer', () =>
		Effect.gen(function* () {
			const { p, requests } = port([stalls('The answer '), done('is 42.')]);
			const infer = infer_facility(p, { wallMs: 20 });
			const call: Extract<FacilityCall, { _tag: 'ai.sys_2.infer' }> = {
				_tag: 'ai.sys_2.infer',
				args: [{ prompt: 'q' }]
			};
			expect(yield* elapsed(infer(call), 21)).toEqual({
				ok: true,
				value: 'The answer is 42.'
			});
			expect(requests).toHaveLength(2);
			expect(required(requests[1]).messages).toEqual([
				{ role: 'user', content: 'q' },
				{ role: 'assistant', content: 'The answer ' }
			]);
			const json = infer_facility(port([stalls('{"n":'), done('42}')]).p, { wallMs: 20 });
			expect(
				yield* elapsed(json({ ...call, args: [{ prompt: 'q', output: { kind: 'json' } }] }), 21)
			).toEqual({ ok: true, value: { n: 42 } });
			// no step budget and no time limit: a model that keeps streaming and never finishes runs until its caller's wall ends it
			const never = infer_facility(port(Array.from({ length: 200 }, () => stalls('a'))).p, {
				wallMs: 20
			});
			expect(
				yield* elapsed(
					Effect.flip(
						never({ ...call, args: [{ prompt: 'q' }] }).pipe(Port.call('the inference', 400))
					),
					401
				)
			).toMatchObject({
				kind: 'timeout',
				message: expect.stringContaining('did not answer within')
			});
		})
	);

	const call: Extract<FacilityCall, { _tag: 'ai.sys_2.infer' }> = {
		_tag: 'ai.sys_2.infer',
		args: []
	};
	const at = (o: Json) => ({ ...call, args: [o] });
	const tool =
		(name: string, input: Json, id = name) =>
		(): Stream.Stream<AiEvent, PortFailure> =>
			response({
				content: '',
				tool_calls: [{ id, name, input }],
				finish: 'tool',
				usage: { input: 1, output: 1 }
			});
	const output = {
		kind: 'object',
		fields: { n: { kind: 'int' }, note: { kind: 'text', optional: true } }
	};
	const DRAFT_TOOLS = ['edit', 'submit', 'refuse', 'read', 'find', 'diff'];
	const leave = {
		kind: 'object',
		fields: {
			leave: {
				kind: 'object',
				fields: {
					code: { kind: 'text' },
					days: { kind: 'int' },
					note: { kind: 'text', optional: true }
				},
				many: true,
				key: 'code'
			},
			tags: { kind: 'text', many: true }
		}
	} as const;

	it.effect(
		'sys_2.infer: a structured answer is built with edit and handed in with submit; a refused op and a failed submit come back by path and the loop goes on',
		() =>
			Effect.gen(function* () {
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '/n', set: 'x' }] }, 'e1'),
					tool('submit', {}, 's1'),
					tool(
						'edit',
						{
							ops: [
								{ path: '/n', set: 3 },
								{ path: '/note', set: 'seen' }
							]
						},
						'e2'
					),
					tool('submit', {}, 's2')
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3, note: 'seen' }
				});
				expect(required(required(requests[0]).tools).map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(required(requests[0]).output).toBeUndefined();
				// the shape to build is in the prompt, as JSON Schema
				expect(promptSchema(requests[0]?.messages[0]?.content)).toEqual({
					type: 'object',
					additionalProperties: false,
					properties: { n: { type: 'integer' }, note: { type: 'string' } },
					required: ['n']
				});
				// each op is checked as it applies: the refused value never reaches the draft
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'tool',
					content: {
						id: 'e1',
						result: { applied: 0, errors: [{ op: 0, error: '/n: expected a number' }] }
					}
				});
				expect(required(requests[2]).messages.at(-1)).toMatchObject({
					role: 'tool',
					content: { id: 's1', result: { error: expect.stringContaining('/n: is required') } }
				});
			})
	);

	it.effect(
		'sys_2.infer: a silent model call is asked again (for smaller calls when it went silent writing one); the answer still comes',
		() =>
			Effect.gen(function* () {
				const writing: Step = () =>
					Stream.concat(
						Stream.succeed<AiEvent>({ _tag: 'Progress', reasoning: undefined }),
						Stream.fromEffect(Effect.never)
					);
				const { p, requests } = port([
					stalls(''),
					writing,
					tool('edit', { ops: [{ path: '/n', set: 3 }] }, 'e1'),
					tool('submit', {}, 's1')
				]);
				expect(
					yield* elapsed(infer_facility(p, { wallMs: 20 })(at({ prompt: 'q', output })), 41)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(requests).toHaveLength(4);
				// silence alone asks again unchanged; silence while writing a call asks for smaller calls
				expect(required(requests[1]).messages).toEqual(required(requests[0]).messages);
				expect(required(requests[2]).messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('Make smaller calls')
				});
			})
	);

	it.effect(
		'sys_2.infer: quoted scalars ("true", "95") are read as the kind, nested too; other strings are still refused',
		() =>
			Effect.gen(function* () {
				// deepseek wrote `is_change_notice: "true"` and `confidence_pct: "95"`; every submit was refused
				const quoted = {
					kind: 'object',
					fields: {
						ok: { kind: 'bool' },
						pct: { kind: 'number', min: 0, max: 100 },
						parts: {
							kind: 'object',
							fields: { n: { kind: 'int' }, flags: { kind: 'bool', many: true } },
							many: true
						}
					}
				};
				const draft = (ok: Json, pct: Json) => ({
					ok,
					pct,
					parts: [{ n: '3', flags: [' FALSE ', 'true'] }]
				});
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '', set: draft('yes', '95 percent') }] }, 'e1'),
					tool('edit', { ops: [{ path: '', set: draft('True', '95') }] }, 'e2'),
					tool('submit', {}, 's2')
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', output: quoted }))).toEqual({
					ok: true,
					value: { ok: true, pct: 95, parts: [{ n: 3, flags: [false, true] }] }
				});
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'tool',
					content: {
						id: 'e1',
						result: {
							errors: [
								{
									error: expect.stringMatching(
										/\/ok: expected true or false.*\/pct: expected a number/
									)
								}
							]
						}
					}
				});
				// the same model re-edited the identical draft and never submitted: an unchanged draft that holds is the answer
				const repeat = () => tool('edit', { ops: [{ path: '', set: draft('true', '95') }] }, 'e');
				expect(
					yield* infer_facility(port([repeat(), repeat()]).p)(at({ prompt: 'q', output: quoted }))
				).toEqual({
					ok: true,
					value: { ok: true, pct: 95, parts: [{ n: 3, flags: [false, true] }] }
				});
			})
	);

	it.effect(
		'sys_2.infer advertises declared metadata rest while keeping named fields and closed objects strict',
		() =>
			Effect.gen(function* () {
				const declared = {
					kind: 'object',
					fields: { intent: { kind: 'text' }, summary: { kind: 'text' } },
					rest: { kind: 'object', fields: { source: { kind: 'text' } } }
				};
				const answer = {
					intent: 'record',
					summary: 'Record the submitted document.',
					metadata: { source: 'pcn' }
				};
				const { p, requests } = port([
					done(JSON.stringify({ metadata: answer.metadata })),
					done(JSON.stringify({ ...answer, metadata: 'pcn' })),
					done(JSON.stringify({ ...answer, metadata: { source: 'pcn', rogue: true } })),
					done(JSON.stringify(answer))
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', output: declared }))).toEqual({
					ok: true,
					value: answer
				});
				expect(promptSchema(requests[0]?.messages[0]?.content)).toEqual({
					type: 'object',
					properties: { intent: { type: 'string' }, summary: { type: 'string' } },
					required: ['intent', 'summary'],
					additionalProperties: {
						type: 'object',
						properties: { source: { type: 'string' } },
						required: ['source'],
						additionalProperties: false
					}
				});
				expect(requests).toHaveLength(4);
				expect(requests[1]?.messages.at(-1)?.content).toContain('/intent: is required');
				expect(requests[1]?.messages.at(-1)?.content).toContain('/summary: is required');
				expect(requests[2]?.messages.at(-1)?.content).toContain('/metadata: expected an object');
				expect(requests[3]?.messages.at(-1)?.content).toContain('/metadata/rogue: is not an input');

				const closed = port([
					done(JSON.stringify(answer)),
					done(JSON.stringify({ intent: answer.intent, summary: answer.summary }))
				]);
				expect(
					yield* infer_facility(closed.p)(
						at({
							prompt: 'q',
							output: { kind: 'object', fields: declared.fields }
						})
					)
				).toEqual({
					ok: true,
					value: { intent: answer.intent, summary: answer.summary }
				});
				expect(closed.requests).toHaveLength(2);
				expect(promptSchema(closed.requests[0]?.messages[0]?.content)).toMatchObject({
					additionalProperties: false
				});
				expect(closed.requests[1]?.messages.at(-1)?.content).toContain(
					'/metadata: is not an input'
				);
			})
	);

	it('applyEdit: a keyed list item is addressed by its key, so a removal shifts nothing; each op is checked as it applies', () => {
		const doc = {
			leave: [
				{ code: 'ANNUAL', days: 14 },
				{ code: 'SICK', days: 10 },
				{ code: 'UNPAID', days: 0 }
			],
			tags: ['a']
		};
		const edit = (d: Json, op: Parameters<typeof applyEdit>[1]) => Result.getOrThrow(applyEdit(d, op, leave));
		let d: Json = edit(doc, { path: '/leave/ANNUAL', remove: true });
		d = edit(d, { path: '/leave/UNPAID/days', set: '2' }); // by index this was item 2, now item 1
		d = edit(d, { path: '/leave/MATERNITY', set: { days: 98 } }); // a new item, its key filled from the path
		d = edit(d, { path: '/tags', append: 'b' });
		expect(d).toEqual({
			leave: [
				{ code: 'SICK', days: 10 },
				{ code: 'UNPAID', days: 2 },
				{ code: 'MATERNITY', days: 98 }
			],
			tags: ['a', 'b']
		});
		expect(doc.leave).toHaveLength(3); // the draft is never edited in place
		expect(() => edit(d, { path: '/leave/SICK/days', set: 'many' })).toThrow(
			'/leave/SICK/days: expected a number'
		);
		expect(() => edit(d, { path: '/leave/SICK/code', set: 'UNPAID' })).toThrow(
			'another item of /leave is keyed "UNPAID"'
		);
		expect(() => edit(d, { path: '/leave/X', set: { code: 'Y', days: 1 } })).toThrow(
			`the item's code is "Y", not "X"`
		);
		expect(() => edit(d, { path: '/leave/NEW', set: { note: 'n' } })).toThrow(
			'/leave/NEW/days: is required'
		);
		expect(() => edit(d, { path: '/leave/GONE', remove: true })).toThrow(
			'/leave has no item "GONE"'
		);
		expect(() => edit(d, { path: '/leave', append: { code: 'Z', days: 1 } })).toThrow(
			'a keyed list'
		);
		expect(() =>
			edit(d, {
				path: '/leave',
				set: [
					{ code: 'A', days: 1 },
					{ code: 'A', days: 2 }
				]
			})
		).toThrow("/leave/A/code: repeats the key 'A'");
		expect(() => edit(d, { path: '/tags', set: [], remove: true })).toThrow('exactly one');
		expect(() => edit(d, { path: '', remove: true })).toThrow('cannot remove the whole answer');
	});

	it('jsonDiff: leaves added, removed and changed by pointer; keyed items matched by key, other lists by index', () => {
		const before = {
			a: 1,
			list: [
				{ code: 'X', n: 1 },
				{ code: 'Y', n: 2 }
			],
			tags: ['p', 'q'],
			gone: true
		};
		const after = {
			a: 2,
			list: [
				{ code: 'Y', n: 3 },
				{ code: 'Z/1', n: 4 }
			],
			tags: ['q'],
			added: { b: null }
		};
		const keyed = {
			kind: 'object',
			fields: {
				list: {
					kind: 'object',
					fields: { code: { kind: 'text' }, n: { kind: 'int' } },
					many: true,
					key: 'code'
				}
			},
			rest: { kind: 'json' }
		} as const;
		expect(jsonDiff(before, after, keyed)).toEqual([
			{ path: '/a', kind: 'changed', before: 1, after: 2 },
			{ path: '/list/X', kind: 'removed', before: { code: 'X', n: 1 } },
			{ path: '/list/Y/n', kind: 'changed', before: 2, after: 3 },
			{ path: '/list/Z~11', kind: 'added', after: { code: 'Z/1', n: 4 } },
			{ path: '/tags/0', kind: 'changed', before: 'p', after: 'q' },
			{ path: '/tags/1', kind: 'removed', before: 'q' },
			{ path: '/gone', kind: 'removed', before: true },
			{ path: '/added', kind: 'added', after: { b: null } }
		]);
		// without the output every list is compared by index
		expect(jsonDiff(before.list, after.list).map((c) => c.path)).toEqual([
			'/0/code',
			'/0/n',
			'/1/code',
			'/1/n'
		]);
		expect(jsonDiff(before, before, keyed)).toEqual([]);
	});

	it.effect(
		'sys_2.infer: reads and edits an initial complete snapshot without changing the supplied object',
		() =>
			Effect.gen(function* () {
				const initial = { n: 2, note: 'keep' };
				const { p, requests } = port([
					tool('read', { path: '/note' }, 'r1'),
					tool('edit', { ops: [{ path: '/n', set: 3 }] }),
					tool('submit', {})
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'research', initial, output }))).toEqual({
					ok: true,
					value: { n: 3, note: 'keep' }
				});
				expect(initial).toEqual({ n: 2, note: 'keep' });
				expect(required(required(requests[0]).tools).map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'tool',
					content: { id: 'r1', result: { value: 'keep' } }
				});
				expect(yield* infer_facility(p)(at({ prompt: 'q', initial }))).toMatchObject({
					ok: false,
					error: { kind: 'invalid' }
				});
			})
	);

	it.effect("sys_2.infer: beside a workspace 'read' tool the draft reader is read_answer", () =>
		Effect.gen(function* () {
			const seen: Json[] = [];
			const records = {
				name: 'read',
				description: 'Read records',
				input: { type: 'object' },
				behavior: {},
				call: (input: Json) =>
					Effect.sync(() => {
						seen.push(input);
						return { rows: [] };
					})
			};
			const { p, requests } = port([
				tool('read', { model: 'purchase_orders' }, 'r1'),
				tool('read_answer', { path: '/note' }, 'r2'),
				tool('submit', {})
			]);
			expect(
				yield* infer_facility(p)(
					at({ prompt: 'q', initial: { n: 2, note: 'keep' }, output, tools: ['read'] }),
					[records]
				)
			).toEqual({ ok: true, value: { n: 2, note: 'keep' } });
			expect(seen).toEqual([{ model: 'purchase_orders' }]);
			expect(required(required(requests[0]).tools).map((t) => t.name)).toEqual([
				'read',
				'edit',
				'submit',
				'refuse',
				'read_answer',
				'find',
				'diff'
			]);
			expect(required(requests[2]).messages.at(-1)).toMatchObject({
				content: { id: 'r2', result: { value: 'keep' } }
			});
		})
	);

	it.effect(
		'model calls honor a capacity retry hint without replaying partial output or a permanent credit refusal',
		() =>
			Effect.gen(function* () {
				const asked = yield* Deferred.make<void>();
				const limited: Step = () =>
					Stream.unwrap(
						Deferred.succeed(asked, undefined).pipe(
							Effect.as(
								Stream.fail(
									Port.failure('ai')({
										kind: 'rate_limited',
										status: 402,
										retry_after_ms: 120_000,
										message: 'in-flight capacity'
									})
								)
							)
						)
					);
				const pending = port([limited, done('ready')]);
				const fiber = yield* modelCall(pending.p, { model: 'default', messages: [] }).pipe(
					Effect.forkChild
				);
				yield* Deferred.await(asked);
				yield* TestClock.adjust(119_999);
				expect(pending.requests).toHaveLength(1);
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust(1);
				expect(yield* Fiber.join(fiber)).toMatchObject({ content: 'ready' });
				expect(pending.requests).toHaveLength(2);
				const partial = port([
					() =>
						Stream.concat(
							Stream.succeed<AiEvent>({ _tag: 'Delta', text: 'kept' }),
							limited({ model: 'default', messages: [] })
						)
				]);
				expect(
					yield* modelCall(partial.p, { model: 'default', messages: [] }).pipe(Effect.flip)
				).toMatchObject({ kind: 'rate_limited' });
				expect(partial.requests).toHaveLength(1);
				const unpaid = port([
					() =>
						Stream.fail(
							new FacilityFailure({
								kind: 'upstream',
								status: 402,
								message: 'Insufficient credits'
							})
						)
				]);
				expect(yield* infer_facility(unpaid.p)(at({ prompt: 'research', output }))).toMatchObject({
					ok: false,
					error: { kind: 'upstream', status: 402 }
				});
				expect(unpaid.requests).toHaveLength(1);
			})
	);

	it.effect(
		'sys_2.infer: a transient provider failure resumes the same transcript and initialized draft',
		() =>
			Effect.gen(function* () {
				const fail: Step = () =>
					Stream.fail(new FacilityFailure({ kind: 'upstream', message: 'fetch failed' }));
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '/n', set: 3 }] }),
					fail,
					tool('submit', {})
				]);
				expect(
					yield* elapsed(
						infer_facility(p)(at({ prompt: 'research', initial: { n: 2, note: 'keep' }, output })),
						1_001
					)
				).toEqual({ ok: true, value: { n: 3, note: 'keep' } });
				expect(requests).toHaveLength(3);
				expect(required(requests[2]).messages).toEqual(required(requests[1]).messages);
				// six retries backing off from 1 s (1 + 2 + … + 32 = 63 s) before the failure ends the inference
				const exhausted = port(Array.from({ length: 7 }, () => fail));
				expect(
					yield* elapsed(infer_facility(exhausted.p)(at({ prompt: 'research', output })), 63_001)
				).toMatchObject({ ok: false, error: { kind: 'upstream' } });
				expect(exhausted.requests).toHaveLength(7);
				const capacity: Step = () =>
					Stream.fail(
						new FacilityFailure({
							kind: 'rate_limited',
							status: 429,
							message: 'capacity'
						})
					);
				const mixed = port([capacity, capacity, capacity, fail, fail, fail, fail]);
				expect(
					yield* elapsed(infer_facility(mixed.p)(at({ prompt: 'research', output })), 63_001)
				).toMatchObject({
					ok: false,
					error: { kind: 'upstream' }
				});
				expect(mixed.requests).toHaveLength(7);
			})
	);

	it.effect(
		'sys_2.infer: the wall is idle time, so a model streaming its reasoning past it is one call, never cut',
		() =>
			Effect.gen(function* () {
				// every 10 ms a reasoning token for 100 ms against a 30 ms wall, then the answer
				const reasons: Step = () =>
					Stream.concat(
						Stream.fromIterable(
							Array.from({ length: 10 }, (): AiEvent => ({
								_tag: 'Progress',
								reasoning: 'thinking '
							}))
						).pipe(Stream.mapEffect((event) => Effect.sleep('10 millis').pipe(Effect.as(event)))),
						response({
							content: '{"n":5}',
							tool_calls: [],
							finish: 'stop',
							usage: { input: 1, output: 1 }
						})
					);
				const { p, requests } = port([reasons]);
				expect(
					yield* elapsed(infer_facility(p, { wallMs: 30 })(at({ prompt: 'q', output })), 101)
				).toEqual({ ok: true, value: { n: 5 } });
				expect(requests).toHaveLength(1);
			})
	);

	it.effect(
		'sys_2.infer: a structured answer that misses the output is handed back with its problems, at most 3 times running',
		() =>
			Effect.gen(function* () {
				// one impossible field used to end the inference, which cost the automation that owned it the whole answer
				const { p, requests } = port([done('{"n":3.5}'), done('{"n":4}')]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 4 }
				});
				expect(requests).toHaveLength(2);
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('/n: Expected an integer')
				});
			})
	);

	it.effect(
		'sys_2.infer: a structured answer written out as text is taken as a submission; prose is asked to edit, at most 3 times running',
		() =>
			Effect.gen(function* () {
				// one chatty turn used to fail the whole inference, which failed the automation that owned it
				const { p, requests } = port([
					done('Sure! Here is the verdict: suspicious.'),
					done('{"n":3}')
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3 }
				});
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('Build the answer with edit')
				});
				expect(
					yield* infer_facility(
						port([done('prose'), done('more prose'), done('still prose'), done('never json')]).p
					)(at({ prompt: 'q', output }))
				).toMatchObject({
					ok: false,
					error: {
						kind: 'invalid',
						message: 'the model did not build its answer with edit and submit'
					}
				});
			})
	);

	it.effect(
		'sys_2.infer: draft-only turns that leave the answer unchanged end the call after 3 running, with the last failed submission',
		() =>
			Effect.gen(function* () {
				// a model rewriting a bool as the string "true" patched the same value for 30 minutes, holding its run
				const same = () => tool('edit', { ops: [{ path: '/n', set: 'x' }] }, 'e');
				const { p, requests } = port([
					tool('submit', {}, 's1'),
					...Array.from({ length: 20 }, same)
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', initial: { n: 'x' }, output }))
				).toMatchObject({
					ok: false,
					error: { kind: 'invalid', message: expect.stringContaining('/n: expected a number') }
				});
				expect(requests).toHaveLength(4);
			})
	);

	it.effect(
		'sys_2.infer: an edit the draft refused is no re-edit: the starting value is not the answer, and the model reads why',
		() =>
			Effect.gen(function* () {
				// a research audit's one edit was refused, and the call answered the empty list it started from
				const listed = {
					kind: 'object',
					fields: {
						findings: { kind: 'object', many: true, fields: { title: { kind: 'text' } } }
					}
				};
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '/findings/2', set: { title: 'EPF' } }] }, 'e1'),
					tool('edit', { ops: [{ path: '/findings', append: { title: 'EPF' } }] }, 'e2'),
					tool('submit', {}, 's')
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', initial: { findings: [] }, output: listed }))
				).toEqual({ ok: true, value: { findings: [{ title: 'EPF' }] } });
				expect(requests).toHaveLength(3);
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					role: 'tool',
					content: { id: 'e1', result: { applied: 0, errors: [{ op: 0 }] } }
				});
				// the next index of a plain list adds the item, as a new key does in a keyed one
				const next = port([
					tool('edit', { ops: [{ path: '/findings/0', set: { title: 'EPF' } }] }, 'e1'),
					tool('submit', {}, 's')
				]);
				expect(
					yield* infer_facility(next.p)(
						at({ prompt: 'q', initial: { findings: [] }, output: listed })
					)
				).toEqual({ ok: true, value: { findings: [{ title: 'EPF' }] } });
				// every edit refused, the step budget spent: a failure, never the empty start as an answer
				const lost = () =>
					tool('edit', { ops: [{ path: '/findings/2', set: { title: 'EPF' } }] }, 'e');
				expect(
					yield* infer_facility(port([lost(), lost(), lost(), lost()]).p)(
						at({ prompt: 'q', initial: { findings: [] }, output: listed, steps: 1 })
					)
				).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			})
	);

	it.effect(
		'sys_2.infer: a reasoning-only reply is continued, at most 3 times running',
		() =>
			Effect.gen(function* () {
				const { p, requests } = port([done(''), done('hi')]);
				expect(yield* infer_facility(p)(at({ prompt: 'q' }))).toEqual({
					ok: true,
					value: 'hi'
				});
				expect(required(requests[1]).messages.at(-1)).toEqual({
					role: 'user',
					content: 'Continue, and give your answer.'
				});
				expect(
					yield* infer_facility(port([done(''), done(''), done(''), done('')]).p)(
						at({ prompt: 'q' })
					)
				).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			})
	);

	it.effect(
		'sys_2.infer: refuse stops immediately and passes the message back; blank refusal asks to explain; validate errors feed back to the model',
		() =>
			Effect.gen(function* () {
				// structured refusal passes message straight back
				const { p: refusedStructured } = port([
					tool('refuse', { message: 'Cannot sort by pay because pay is on child records.' }, 'r1')
				]);
				expect(yield* infer_facility(refusedStructured)(at({ prompt: 'q', output }))).toEqual({
					ok: false,
					error: { kind: 'invalid', message: 'Cannot sort by pay because pay is on child records.' }
				});
				// unstructured refusal also works
				const { p: refusedText } = port([tool('refuse', { message: 'Missing invoice total.' }, 'r1')]);
				expect(yield* infer_facility(refusedText)(at({ prompt: 'q' }))).toEqual({
					ok: false,
					error: { kind: 'invalid', message: 'Missing invoice total.' }
				});
				// blank refusal message is rejected and the model can retry with a real reason
				const { p: retried, requests: retryRequests } = port([
					tool('refuse', { message: '   ' }, 'r1'),
					tool('refuse', { message: 'Field not exposed.' }, 'r2')
				]);
				expect(yield* infer_facility(retried)(at({ prompt: 'q', output }))).toEqual({
					ok: false,
					error: { kind: 'invalid', message: 'Field not exposed.' }
				});
				expect(required(retryRequests[1]).messages.at(-1)).toMatchObject({
					content: { id: 'r1', result: { error: expect.stringContaining('non-empty explanation') } }
				});
				// custom validate failure feeds back to the model so it can repair and resubmit
				const { p: validatedPort, requests: valRequests } = port([
					tool('edit', { ops: [{ path: '/n', set: 5 }] }, 'e1'),
					tool('submit', {}, 's1'),
					tool('edit', { ops: [{ path: '/n', set: 10 }] }, 'e2'),
					tool('submit', {}, 's2')
				]);
				expect(
					yield* infer_facility(validatedPort, {
						validate: (v) =>
							Effect.succeed(
								Schema.is(Schema.Struct({ n: Schema.Literal(10) }))(v)
									? { ok: true, value: v }
									: { ok: false, error: { kind: 'invalid', message: 'n must be 10' } }
							)
					})(at({ prompt: 'q', output }))
				).toEqual({ ok: true, value: { n: 10 } });
				expect(required(valRequests[2]).messages.at(-1)).toMatchObject({
					content: { id: 's1', result: { error: 'n must be 10' } }
				});
			})
	);

	it.effect('sys_2.infer rejects the retired schema output key before calling the provider', () =>
		Effect.gen(function* () {
			const { p, requests } = port([done('unused')]);
			for (const output of [{ jsonSchema: {} }, { json_schema: {}, jsonSchema: {} }]) {
				expect(yield* Effect.flip(infer_facility(p)(at({ prompt: 'q', output })))).toMatchObject({
					kind: 'invalid'
				});
			}
			expect(requests).toHaveLength(0);
		})
	);

	it.effect(
		'sys_2.infer with a JSON Schema output: the schema checks structure (if/then included), CEL rules check logic, both come back by path',
		() =>
			Effect.gen(function* () {
				const json_schema = {
					type: 'object',
					required: ['test'],
					properties: {
						test: {
							type: 'object',
							properties: {
								status: { enum: ['done', 'unable'] },
								reading: { type: 'number', minimum: 0 },
								reason: { type: 'string' }
							},
							if: { properties: { status: { const: 'unable' } } },
							then: { required: ['reason'] }
						}
					}
				};
				const rules = [
					{
						expression: "has(test.status) && test.status == 'unable' ? !has(test.reading) : true",
						message: 'an unperformed test has no reading'
					}
				];
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '/test', set: { status: 'unable', reading: -1 } }] }, 'e1'),
					tool('submit', {}, 's1'),
					tool(
						'edit',
						{
							ops: [
								{ path: '/test/reading', remove: true },
								{ path: '/test/reason', set: 'VTs connected' }
							]
						},
						'e2'
					),
					tool('submit', {}, 's2')
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', output: { json_schema, rules } }))
				).toEqual({ ok: true, value: { test: { status: 'unable', reason: 'VTs connected' } } });
				expect(required(required(requests[0]).messages[0]).content).toContain('an unperformed test has no reading');
				const back = JSON.stringify(required(requests[2]).messages.at(-1));
				expect(back).toContain('/test/reading');
				expect(back).toContain('reason');
				expect(back).toContain('rule broken: an unperformed test has no reading');
				// a rule that does not compile is the caller's, refused before any model call
				expect(
					yield* infer_facility(port([]).p)(
						at({
							prompt: 'q',
							output: { json_schema, rules: [{ expression: 'test.(', message: 'x' }] }
						})
					)
				).toMatchObject({
					ok: false,
					error: { kind: 'invalid', message: expect.stringContaining('rule "x"') }
				});
			})
	);

	it.effect(
		'sys_2.infer: edit and submit in one reply apply in order, so a clean read is one model turn and a fix is one more',
		() =>
			Effect.gen(function* () {
				const both =
					(ops: Json, id: string): Step =>
					() =>
						response({
							content: '',
							tool_calls: [
								{ id: `e${id}`, name: 'edit', input: { ops } },
								{ id: `s${id}`, name: 'submit', input: {} }
							],
							finish: 'tool',
							usage: { input: 1, output: 1 }
						});
				const clean = port([both([{ path: '/n', set: 3 }], '1')]);
				expect(yield* infer_facility(clean.p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3 }
				});
				expect(clean.requests).toHaveLength(1);
				expect(required(required(clean.requests[0]).messages[0]).content).toContain('in the same reply');
				const fixed = port([
					both([{ path: '/n', set: 'x' }], '1'),
					both([{ path: '/n', set: 4 }], '2')
				]);
				expect(yield* infer_facility(fixed.p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 4 }
				});
				expect(fixed.requests).toHaveLength(2);
				expect(required(fixed.requests[1]).messages.slice(-2)).toMatchObject([
					{
						role: 'tool',
						content: {
							id: 'e1',
							result: { applied: 0, errors: [{ op: 0, error: '/n: expected a number' }] }
						}
					},
					{
						role: 'tool',
						content: { id: 's1', result: { error: expect.stringContaining('/n: is required') } }
					}
				]);
			})
	);

	it.effect(
		'sys_2.infer: more files than one request carries are read in batches into one draft, checked only after the last',
		() =>
			Effect.gen(function* () {
				const loads: string[] = [];
				const load = (id: string) =>
					Effect.sync(() => {
						loads.push(id);
						return { mime: 'image/png', bytes: new Uint8Array(1) };
					});
				const json_schema = {
					type: 'object',
					required: ['rows'],
					properties: { rows: { type: 'array', minItems: 2, items: { type: 'string' } } }
				};
				const { p, requests } = port([
					tool('edit', { ops: [{ path: '/rows', set: ['a'] }] }, 'e1'),
					tool('submit', {}, 's1'),
					tool('edit', { ops: [{ path: '/rows', append: 'b' }] }, 'e2'),
					tool('submit', {}, 's2')
				]);
				const files = Array.from({ length: MODEL_FILES.count + 2 }, (_, i) => ({ id: `f${i}` }));
				expect(
					yield* infer_facility(p, { load })(at({ prompt: 'q', files, output: { json_schema } }))
				).toEqual({ ok: true, value: { rows: ['a', 'b'] } });
				expect(requests.map((r) => r.files?.length)).toEqual([
					MODEL_FILES.count,
					MODEL_FILES.count,
					2,
					2
				]);
				expect(loads).toEqual(files.map((f) => f.id));
				// the second batch starts from the first one's draft, which minItems alone would have refused
				expect(required(required(requests[2]).messages[0]).content).toContain(
					`files ${MODEL_FILES.count + 1}–${MODEL_FILES.count + 2}`
				);
				expect(required(required(requests[2]).messages[0]).content).toContain('{"rows":["a"]}');
			})
	);

	it.effect(
		'sys_2.infer with tools: the model calls them beside the draft tools',
		() =>
			Effect.gen(function* () {
				const seen: Json[] = [];
				const browse = {
					name: 'browse',
					description: 'Read a page',
					input: { type: 'object' },
				behavior: {},
					call: (input: Json) =>
						Effect.sync(() => {
							seen.push(input);
							return { text: 'rate is 3' };
						})
				};
				const { p, requests } = port([
					tool('browse', { url: 'https://x' }),
					tool('edit', { ops: [{ path: '/n', set: 3 }] }, 'e1'),
					tool('submit', {}, 's1')
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', output, tools: ['browse'] }), [browse])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toEqual([{ url: 'https://x' }]);
				expect(required(required(requests[0]).tools).map((t) => t.name)).toEqual(['browse', ...DRAFT_TOOLS]);
				expect(required(requests[1]).messages.at(-1)).toEqual({
					role: 'tool',
					content: { id: 'browse', name: 'browse', result: { text: 'rate is 3' } }
				});
			})
	);

	const browsing = () => {
		const seen: Json[] = [];
		const browse = {
			name: 'browse',
			description: 'Read a page',
			input: { type: 'object' },
				behavior: {},
			call: (input: Json) =>
				Effect.sync(() => {
					seen.push(input);
					return { text: 'rate is 3' };
				})
		};
		return { seen, browse };
	};
	const editAndSubmit = (): Stream.Stream<AiEvent, PortFailure> =>
		response({
			content: '',
			tool_calls: [
				{ id: 'e', name: 'edit', input: { ops: [{ path: '/n', set: 3 }] } },
				{ id: 's', name: 'submit', input: {} }
			],
			finish: 'tool',
			usage: { input: 1, output: 1 }
		});

	it.effect('sys_2.infer refuses a tool named like another or like a draft tool, before asking the model', () =>
		Effect.gen(function* () {
			const { seen, browse } = browsing();
			const { p, requests } = port([]);
			for (const tools of [[{ ...browse, name: 'edit' }], [browse, browse]])
				expect(yield* infer_facility(p)(at({ prompt: 'q', output, tools: ['browse'] }), tools)).toEqual({
					ok: false,
					error: { kind: 'invalid', message: expect.stringContaining('two tools are named') }
				});
			expect(requests).toEqual([]);
			expect(seen).toEqual([]);
		})
	);

	it.effect(
		'sys_2.infer steps: after N tool turns one final turn offers only the draft tools, and its submission is the answer',
		() =>
			Effect.gen(function* () {
				const { seen, browse } = browsing();
				const { p, requests } = port([
					tool('browse', { url: 'https://a' }, 'b1'),
					tool('browse', { url: 'https://b' }, 'b2'),
					editAndSubmit
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', output, tools: ['browse'], steps: 2 }), [
						browse
					])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toHaveLength(2);
				expect(requests).toHaveLength(3);
				expect(required(required(requests[1]).tools).map((t) => t.name)).toEqual(['browse', ...DRAFT_TOOLS]);
				expect(required(required(requests[2]).tools).map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(required(requests[2]).messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('budget')
				});
			})
	);

	it.effect(
		'sys_2.infer steps: read-only draft turns are exploration under the budget, not a stall',
		() =>
			Effect.gen(function* () {
				// a researcher told to read the indexed draft first read it four turns running, then browsed
				const { seen, browse } = browsing();
				const read = () => tool('read', { path: '' }, 'r');
				const { p } = port([
					read(),
					read(),
					read(),
					read(),
					tool('browse', { url: 'https://a' }, 'b1'),
					editAndSubmit
				]);
				expect(
					yield* infer_facility(p)(
						at({ prompt: 'q', output, initial: {}, tools: ['browse'], steps: 8 }),
						[browse]
					)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toHaveLength(1);
			})
	);

	it.effect(
		'sys_2.infer: STALL_MS without progress ends it, with the answer its draft already holds',
		() =>
			Effect.gen(function* () {
				// a page that never loads: no model token, reply or tool result for the stall window
				const hangs = {
					name: 'browse',
					description: 'Read a page',
					input: { type: 'object' },
				behavior: {},
					call: () => Effect.never
				};
				const held = port([
					tool('edit', { ops: [{ path: '/n', set: 3 }] }, 'e1'),
					tool('browse', { url: 'https://a' }, 'b1')
				]);
				expect(
					yield* elapsed(
						infer_facility(held.p)(at({ prompt: 'q', output, tools: ['browse'] }), [hangs]),
						STALL_MS + 1
					)
				).toEqual({ ok: true, value: { n: 3 } });
				const empty = port([tool('browse', { url: 'https://a' }, 'b1')]);
				expect(
					yield* elapsed(
						infer_facility(empty.p)(at({ prompt: 'q', output, tools: ['browse'] }), [hangs]),
						STALL_MS + 1
					)
				).toEqual({
					ok: false,
					error: { kind: 'timeout', message: expect.stringContaining('no progress for 5 minutes') }
				});
			})
	);

	it.effect('sys_2.infer: progress keeps it alive past any wall, with no time limit', () =>
		Effect.gen(function* () {
			// three pages of four minutes each: twelve minutes, never five without progress
			const slow = {
				name: 'browse',
				description: 'Read a page',
				input: { type: 'object' },
				behavior: {},
				call: () => Effect.sleep('4 minutes').pipe(Effect.as({ text: 'rate is 3' }))
			};
			const { p, requests } = port([
				tool('browse', { url: 'https://a' }, 'b1'),
				tool('browse', { url: 'https://b' }, 'b2'),
				tool('browse', { url: 'https://c' }, 'b3'),
				editAndSubmit
			]);
			expect(
				yield* elapsed(
					infer_facility(p)(at({ prompt: 'q', output, tools: ['browse'] }), [slow]),
					12 * 60_000 + 1
				)
			).toEqual({ ok: true, value: { n: 3 } });
			expect(requests).toHaveLength(4);
		})
	);

	it.effect(
		'sys_2.infer steps: a final turn without a valid answer is a step-budget failure, unless the draft already holds one',
		() =>
			Effect.gen(function* () {
				const spent = browsing();
				const one = port([
					tool('browse', { url: 'https://a' }, 'b1'),
					tool('browse', {}, 'b2'),
					tool('browse', {}, 'b3'),
					tool('browse', {}, 'b4')
				]);
				expect(
					yield* infer_facility(one.p)(at({ prompt: 'q', output, tools: ['browse'], steps: 1 }), [
						spent.browse
					])
				).toEqual({
					ok: false,
					error: { kind: 'invalid', message: expect.stringContaining('tool budget (1 steps') }
				});
				// the finishing turns' browse is not offered, so it is never run
				expect(spent.seen).toHaveLength(1);
				expect(one.requests).toHaveLength(4);

				const held = browsing();
				const two = port([
					tool('edit', { ops: [{ path: '/n', set: 3 }] }, 'e1'),
					tool('browse', { url: 'https://a' }, 'b1'),
					done('')
				]);
				expect(
					yield* infer_facility(two.p)(at({ prompt: 'q', output, tools: ['browse'], steps: 2 }), [
						held.browse
					])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(held.seen).toHaveLength(1);
				expect(two.requests).toHaveLength(3);

				expect(
					yield* Effect.flip(infer_facility(port([]).p)(at({ prompt: 'q', output, steps: 0 })))
				).toMatchObject({ kind: 'invalid' });
			})
	);

	it.effect(
		'sys_2.infer default step cap bounds inferences that omit steps, while explicit steps overrides it',
		() =>
			Effect.gen(function* () {
				const runaway = browsing();
				const loop = port(
					Array.from({ length: DEFAULT_STEPS + 10 }, (_, i) =>
						tool('browse', { url: `https://page/${i}` }, `b${i}`)
					)
				);
				expect(
					yield* infer_facility(loop.p)(at({ prompt: 'q', output, tools: ['browse'] }), [
						runaway.browse
					])
				).toEqual({
					ok: false,
					error: {
						kind: 'invalid',
						message: expect.stringContaining(`tool budget (${DEFAULT_STEPS} steps)`)
					}
				});
				expect(runaway.seen).toHaveLength(DEFAULT_STEPS);
				expect(loop.requests).toHaveLength(DEFAULT_STEPS + 3);

				// explicit steps above DEFAULT_STEPS is respected up to MAX_STEPS
				const explicit = browsing();
				const deep = port([
					...Array.from({ length: DEFAULT_STEPS + 2 }, (_, i) =>
						tool('browse', { url: `https://page/${i}` }, `d${i}`)
					),
					editAndSubmit
				]);
				expect(
					yield* infer_facility(deep.p)(
						at({ prompt: 'q', output, tools: ['browse'], steps: DEFAULT_STEPS + 5 }),
						[explicit.browse]
					)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(explicit.seen).toHaveLength(DEFAULT_STEPS + 2);
			})
	);

	it.effect(
		'sys_2.infer: keyed edits apply op by op (a refused one reported, later ones applied), and read, diff and find speak keyed paths',
		() =>
			Effect.gen(function* () {
				const initial = {
					leave: [
						{ code: 'ANNUAL', days: 14 },
						{ code: 'SICK', days: 10, note: 'certified' },
						{ code: 'UNPAID', days: 0 }
					],
					tags: []
				};
				const { p, requests } = port([
					tool(
						'edit',
						{
							ops: [
								{ path: '/leave/SICK/days', set: 'many' },
								{ path: '/leave/ANNUAL', remove: true },
								{ path: '/leave/UNPAID/days', set: 1 },
								{ path: '/leave/MATERNITY', set: { days: 98 } },
								{ op: 'add', value: 1 }
							]
						},
						'e1'
					),
					tool('read', { path: '/leave', fields: ['days'] }, 'r1'),
					tool('diff', {}, 'd1'),
					tool('find', { text: 'unp' }, 'f1'),
					tool('submit', {}, 's1')
				]);
				expect(yield* infer_facility(p)(at({ prompt: 'q', initial, output: leave }))).toEqual({
					ok: true,
					value: {
						leave: [
							{ code: 'SICK', days: 10, note: 'certified' },
							{ code: 'UNPAID', days: 1 },
							{ code: 'MATERNITY', days: 98 }
						],
						tags: []
					}
				});
				// the output says which lists are keyed, and by what
				expect(required(required(requests[0]).messages[0]).content).toContain('Keyed by \\"code\\"');
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					content: {
						id: 'e1',
						result: {
							applied: 3,
							errors: [
								{ op: 0, error: '/leave/SICK/days: expected a number' },
								{ op: 4, error: expect.any(String) }
							]
						}
					}
				});
				expect(required(requests[2]).messages.at(-1)).toMatchObject({
					content: {
						id: 'r1',
						result: {
							value: [
								{ code: 'SICK', days: 10 },
								{ code: 'UNPAID', days: 1 },
								{ code: 'MATERNITY', days: 98 }
							]
						}
					}
				});
				expect(required(requests[3]).messages.at(-1)).toMatchObject({
					content: {
						id: 'd1',
						result: {
							changes: [
								{ path: '/leave/ANNUAL', kind: 'removed', before: { code: 'ANNUAL', days: 14 } },
								{ path: '/leave/UNPAID/days', kind: 'changed', before: 0, after: 1 },
								{ path: '/leave/MATERNITY', kind: 'added', after: { code: 'MATERNITY', days: 98 } }
							]
						}
					}
				});
				expect(required(requests[4]).messages.at(-1)).toMatchObject({
					content: {
						id: 'f1',
						result: { matches: [{ path: '/leave/UNPAID/code', excerpt: 'UNPAID' }] }
					}
				});
			})
	);

	it.effect(
		'sys_2.infer rules on a declared output: an unfinished review is refused at submit, and a spent budget fails invalid with the rule',
		() =>
			Effect.gen(function* () {
				const review = {
					kind: 'object',
					fields: {
						coverage: {
							kind: 'object',
							fields: {
								area: { kind: 'text' },
								status: { kind: 'enum', values: ['pending', 'done'] }
							},
							many: true,
							key: 'area'
						}
					}
				};
				const rules = [
					{
						expression: "coverage.all(c, c.status != 'pending')",
						message: 'every area is reviewed'
					}
				];
				const initial = {
					coverage: [
						{ area: 'pay', status: 'pending' },
						{ area: 'leave', status: 'pending' }
					]
				};
				// submitting the initial draft untouched is refused, and the budget runs out with one area still pending; the
				// finishing turns that follow are each refused too
				const { p, requests } = port([
					tool('submit', {}, 's1'),
					tool('edit', { ops: [{ path: '/coverage/pay/status', set: 'done' }] }, 'e1'),
					tool('submit', {}, 's2'),
					tool('submit', {}, 's3'),
					tool('submit', {}, 's4')
				]);
				expect(
					yield* infer_facility(p)(at({ prompt: 'q', initial, output: review, rules, steps: 2 }))
				).toEqual({
					ok: false,
					error: {
						kind: 'invalid',
						message: expect.stringMatching(/tool budget.*rule broken: every area is reviewed/)
					}
				});
				expect(requests).toHaveLength(5);
				expect(required(required(requests[0]).messages[0]).content).toContain('every area is reviewed');
				expect(required(requests[1]).messages.at(-1)).toMatchObject({
					content: {
						id: 's1',
						result: { error: expect.stringContaining('rule broken: every area is reviewed') }
					}
				});
				// a refused final submission is repaired on the next finishing turn, with the draft tools only
				const repaired = port([
					tool('submit', {}, 's1'),
					tool('edit', { ops: [{ path: '/coverage/pay/status', set: 'done' }] }, 'e1'),
					tool('submit', {}, 's2'),
					tool('edit', { ops: [{ path: '/coverage/leave/status', set: 'done' }] }, 'e2'),
					tool('submit', {}, 's3')
				]);
				expect(
					yield* infer_facility(repaired.p)(
						at({ prompt: 'q', initial, output: review, rules, steps: 2 })
					)
				).toMatchObject({ ok: true });
				expect(required(required(repaired.requests.at(-1)).tools).map((t) => t.name)).not.toContain('browse');
				const finished = port([
					tool(
						'edit',
						{
							ops: [
								{ path: '/coverage/pay/status', set: 'done' },
								{ path: '/coverage/leave/status', set: 'done' }
							]
						},
						'e'
					),
					tool('submit', {}, 's')
				]);
				expect(
					yield* infer_facility(finished.p)(at({ prompt: 'q', initial, output: review, rules }))
				).toEqual({
					ok: true,
					value: {
						coverage: [
							{ area: 'pay', status: 'done' },
							{ area: 'leave', status: 'done' }
						]
					}
				});
			})
	);
});

describe('the panel conversation list', () => {
	it('admits a public envoy thread, and only what the read would return', () => {
		// an instance's thread carries no owner, so admitting it by owner alone would keep every thread out of the live list
		const own = { owner: 'ann', integration: null, parent: null, envoy: null };
		const child = { owner: 'ann', integration: null, parent: 'p', envoy: null };
		const other = { owner: 'bob', integration: null, parent: null, envoy: null };
		const publicThread = { owner: null, integration: 'whatsapp', parent: null, envoy: 'field_ops' };
		const privateThread = { owner: null, integration: 'whatsapp', parent: null, envoy: 'secret' };
		expect(listed(own, 'ann')).toBe(true);
		expect(listed(child, 'ann')).toBe(false); // a sub-agent is never a root
		expect(listed(other, 'ann')).toBe(false);
		expect(listed(other, 'ann', true)).toBe(false);
		expect(listed(other, 'ann', false, true)).toBe(false);
		expect(listed(other, 'ann', true, true)).toBe(true);
		expect(listed(publicThread, 'ann')).toBe(false);
		expect(listed(privateThread, 'ann')).toBe(false); // never a row the read would not return
		expect(listed(null, 'ann')).toBe(false);
	});
});

it.effect(
	'stops a pre-interrupted or uncooperative provider without waiting for the idle wall',
	() =>
		Effect.gen(function* () {
			const request: AiRequest = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
			const entered = yield* Deferred.make<void>();
			const released = yield* Deferred.make<void>();
			let calls = 0;
			const { p } = port([
				() =>
					Stream.fromEffect(
						Effect.acquireUseRelease(
							Effect.gen(function* () {
								calls++;
								yield* Deferred.succeed(entered, undefined);
							}),
							() => Effect.never,
							() => Deferred.succeed(released, undefined)
						)
					)
			]);
			const pending = yield* Effect.forkChild(modelCall(p, request));
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(pending);
			const stopped = yield* Fiber.await(pending);
			expect(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause)).toBe(true);
			expect(yield* Deferred.isDone(released)).toBe(true);
			// Interruption before invocation never pulls the native provider stream.
			const preInterrupted = yield* Effect.exit(
				Effect.andThen(Effect.interrupt, modelCall(p, request))
			);
			expect(Exit.isFailure(preInterrupted) && Cause.hasInterruptsOnly(preInterrupted.cause)).toBe(
				true
			);
			expect(calls).toBe(1);
		})
);

describe('the throttle lock (bug 37)', () => {
	it.effect('holds one decision per conversation and keeps no lock once its holders leave', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { serial, keys } = yield* keyedSerial();
				const order: string[] = [];
				const step = (id: string) => Effect.sync(() => order.push(id));
				yield* Effect.all(
					[serial('a')(Effect.andThen(step('a1'), Effect.yieldNow)), serial('a')(step('a2')), serial('b')(step('b1'))],
					{ concurrency: 'unbounded' }
				);
				expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
				expect([...(yield* keys)]).toEqual([]);
			})
		)
	);
});

describe('progress-check red circuit breaker', () => {
	it('allows convergence after a parse-unblock error spike while still stopping flat or oscillating loops', () => {
		const converging = new Map<string, CheckProgress>();
		for (const count of [2, 2, 2, 135, 61, 22, 5]) {
			recordCheckProgress(converging, 'workspace_diagnose', count);
			expect(converging.get('workspace_diagnose')?.red).toBeLessThanOrEqual(AGENT_LIMITS.failingSteps);
		}
		recordCheckProgress(converging, 'workspace_diagnose', 0);
		expect(converging.get('workspace_diagnose')).toEqual({
			red: 0,
			lowest: Number.POSITIVE_INFINITY,
			lastFailing: Number.POSITIVE_INFINITY
		});

		const flat = new Map<string, CheckProgress>();
		for (const count of [2, 2, 2, 2, 2, 2]) recordCheckProgress(flat, 'workspace_diagnose', count);
		expect(flat.get('workspace_diagnose')?.red).toBeGreaterThan(AGENT_LIMITS.failingSteps);

		const oscillating = new Map<string, CheckProgress>();
		for (const count of [10, 8, 10, 8, 10, 8, 10, 8, 10, 8, 10])
			recordCheckProgress(oscillating, 'workspace_diagnose', count);
		expect(oscillating.get('workspace_diagnose')?.red).toBeGreaterThan(AGENT_LIMITS.failingSteps);
	});

	it('scopes progress per tool so a passing workspace_diagnose does not reset workspace_test', () => {
		const checks = new Map<string, CheckProgress>();
		for (let i = 0; i < 6; i++) {
			recordCheckProgress(checks, 'workspace_test', 2);
			recordCheckProgress(checks, 'workspace_diagnose', 0);
		}
		expect(checks.get('workspace_diagnose')?.red).toBe(0);
		expect(checks.get('workspace_test')?.red).toBeGreaterThan(AGENT_LIMITS.failingSteps);
	});

	it('clearToolFailures clears only the succeeded tool, leaving other tools failures intact', () => {
		const failures = new Map<string, number>([
			[callKey('workspace_edit', { path: 'a.ts' }), 2],
			[callKey('workspace_read', { path: 'b.ts' }), 1]
		]);
		clearToolFailures(failures, 'workspace_read');
		expect(failures.get(callKey('workspace_edit', { path: 'a.ts' }))).toBe(2);
		expect(failures.has(callKey('workspace_read', { path: 'b.ts' }))).toBe(false);
		clearToolFailures(failures, 'workspace_edit');
		expect(failures.size).toBe(0);
	});
});

describe('long-running stream CPU unit rotation', () => {
	it.effect('rotates RunUnits during multi-second AI streams so concurrent streams never overrun one 3 s unit', () =>
		Effect.gen(function* () {
			let steps = 0;
			const p: Ai['Service'] = {
				...port([]).p,
				infer: () =>
					Stream.fromIterable<AiEvent>([
						{ _tag: 'Progress', reasoning: 'a' },
						{ _tag: 'Progress', reasoning: 'b' },
						{ _tag: 'Delta', text: 'ok' },
						{
							_tag: 'Response',
							response: { content: 'ok', tool_calls: [], finish: 'stop', usage: { input: 1, output: 1 } }
						}
					]).pipe(
						Stream.tap(() => TestClock.adjust('2500 millis'))
					)
			};
			const answer = yield* modelCall(p, { model: 'default', messages: [{ role: 'user', content: 'hi' }] }).pipe(
				Effect.provideService(RunUnits, {
					next: () =>
						Effect.sync(() => {
							steps++;
						})
				})
			);
			expect(answer.content).toBe('ok');
			expect(steps).toBeGreaterThanOrEqual(3);
		})
	);
});

describe('spend cap overLimit with in-flight turn cost', () => {
	const dbWithSpend = (workspaceSpent: number, memberSpent: number) => {
		let reads = 0;
		const db = TenantDb.typed({
			read: (statements) =>
				Effect.sync(() => {
					reads++;
					return statements.map((s) => ({
						rows: [{ sum: s.params[0] === null ? workspaceSpent : memberSpent }],
						affected: 1
					}));
				}),
			write: () => Effect.sync(() => ({ rows: [], affected: 0 })),
			transaction: (batch) => Effect.sync(() => batch.statements.map(() => ({ rows: [], affected: 0 })))
		});
		return { db, reads: () => reads };
	};
	const baseSettings: AgentSettings = {
		monthly: 5,
		member: 2,
		policies: { vip: 10 },
		models: [],
		system1: null,
		system2: null
	};

	it.effect('counts inFlightUsd against workspace and member caps and short-circuits when in-flight alone exceeds cap', () =>
		Effect.gen(function* () {
			const { db, reads } = dbWithSpend(3, 1.5);
			// below both caps without in-flight spend
			expect(yield* overLimit(db, baseSettings, 'alice', [])).toBeNull();
			// below both caps with small in-flight spend (workspace 3.4 < 5, member 1.9 < 2)
			expect(yield* overLimit(db, baseSettings, 'alice', [], 0.4)).toBeNull();
			// crosses member cap (1.5 + 0.5 >= 2) while workspace (3.5 < 5) is under
			expect(yield* overLimit(db, baseSettings, 'alice', [], 0.5)).toBe('member');
			// generous policy cap keeps member under limit until workspace cap trips
			expect(yield* overLimit(db, baseSettings, 'alice', ['vip'], 0.5)).toBeNull();
			expect(yield* overLimit(db, baseSettings, 'alice', ['vip'], 2)).toBe('workspace');
			// in-flight spend alone >= workspace cap trips immediately with zero DB reads
			const before = reads();
			expect(yield* overLimit(db, baseSettings, 'alice', ['vip'], 5)).toBe('workspace');
			expect(reads()).toBe(before);
		})
	);
});

describe('secondary prompt cache-busters: prefix stability', () => {
	const msgRow = (
		seq: number,
		role: 'user' | 'assistant' | 'system',
		text: string,
		extra: Partial<Extract<MessageRow, { role: 'user' | 'assistant' | 'system' | null }>> = {}
	): MessageRow => ({
		id: `m-${seq}`,
		conversation: 'c1',
		seq,
		role,
		content: role === 'assistant' ? { text, toolCalls: [] } : { text },
		text,
		state: role === 'user' ? 'consumed' : null,
		mode: 'agent',
		as: null,
		author: null,
		meta: null,
		supersedes: null,
		turn: null,
		...extra
	});

	it('appends delayed/SmartThrottle messages monotonically instead of splicing into earlier cached prefix by seq', () => {
		const conv = { plan: null };
		const u1 = msgRow(1, 'user', 'First request', { turn: 'turn-1', delivered_turn: 'turn-1' });
		const a1 = msgRow(3, 'assistant', 'First reply', { turn: 'turn-1' });
		// While turn-1 ran, a delayed message arrived at seq=2 (pending -> later claimed by turn-2)
		const delayedPending = msgRow(2, 'user', 'Delayed follow-up', { state: 'pending', turn: null });

		// Step 1 (while delayed message is still pending): prefix is [u1, a1]
		const beforeAdmit = modelTranscript([u1, delayedPending, a1], conv);
		expect(beforeAdmit.map((m) => JSON.stringify(m))).toEqual([
			JSON.stringify({ role: 'user', content: { text: 'First request' } }),
			JSON.stringify({ role: 'assistant', content: { text: 'First reply', toolCalls: [] } })
		]);

		// Step 2 (delayed message admitted into turn-2, still holding seq=2): appends AFTER a1!
		const delayedAdmitted = msgRow(2, 'user', 'Delayed follow-up', {
			state: 'consumed',
			turn: 'turn-2',
			delivered_turn: 'turn-2'
		});
		const afterAdmit = modelTranscript([u1, delayedAdmitted, a1], conv);
		expect(afterAdmit.slice(0, beforeAdmit.length)).toEqual(beforeAdmit);
		expect(afterAdmit).toHaveLength(3);
		expect(afterAdmit[2]).toEqual({ role: 'user', content: { text: 'Delayed follow-up' } });

		// Step 3 (turn-2 finishes with a2 at seq=4): prefix [u1, a1, delayedAdmitted] stays identical!
		const a2 = msgRow(4, 'assistant', 'Second reply', { turn: 'turn-2' });
		const afterTurn2 = modelTranscript([u1, delayedAdmitted, a1, a2], conv);
		expect(afterTurn2.slice(0, afterAdmit.length)).toEqual(afterAdmit);
		expect(afterTurn2).toHaveLength(4);
	});

	it('keeps plan updates and fresh timestamps in the trailing dynamic suffix and freezes note on multi-cut continuations', () => {
		const u1 = msgRow(1, 'user', 'Plan this work', { turn: 't1', delivered_turn: 't1' });
		const a1 = msgRow(2, 'assistant', 'Drafted v1', { turn: 't1' });
		const planV1 = { revision: 1, body: '1. Step A', status: 'draft' as const, checkpoint: 0, verdicts: 0 };
		const planV2 = { revision: 2, body: '1. Step A\n2. Step B', status: 'draft' as const, checkpoint: 0, verdicts: 0 };

		const step1 = withStateNote([u1, a1], { plan: planV1 }, state({ plan: planV1 }, 'plan', 'Now: 12:00:00Z'));
		const step2 = withStateNote([u1, a1], { plan: planV2 }, state({ plan: planV2 }, 'plan', 'Now: 12:01:00Z'));
		// Prefix before trailing dynamic state note is identical across plan edits and clock ticks
		expect(step1.slice(0, -1)).toEqual(step2.slice(0, -1));
		expect(step1.at(-1)?.content).toContain('1. Step A');
		expect(step2.at(-1)?.content).toContain('2. Step B');
		expect(step2.at(-1)?.content).toContain('Now: 12:01:00Z');

		// Multi-cut continuation keeps frozen note before partial assistant segments so prefix stays identical
		const frozenNote = state({ plan: null }, 'agent', 'Now: 12:00:00Z');
		const cut1 = msgRow(2, 'assistant', 'Part 1', {
			turn: 't1',
			content: { text: 'Part 1', toolCalls: [], segments: [{ text: 'Part 1' }] },
			meta: { tag: 'cut' }
		});
		const cut2 = msgRow(2, 'assistant', 'Part 1 Part 2', {
			turn: 't1',
			content: {
				text: 'Part 1 Part 2',
				toolCalls: [],
				segments: [{ text: 'Part 1' }, { text: 'Part 2' }]
			},
			meta: { tag: 'cut' }
		});
		const firstAttempt = withStateNote([u1], { plan: null }, frozenNote, { continuing: false });
		const cont1 = withStateNote([u1, cut1], { plan: null }, frozenNote, { continuing: true });
		const cont2 = withStateNote([u1, cut2], { plan: null }, frozenNote, { continuing: true });
		expect(cont1.slice(0, firstAttempt.length)).toEqual(firstAttempt);
		expect(cont2.slice(0, cont1.length)).toEqual(cont1);
		expect(cont2.at(-1)).toEqual({ role: 'assistant', content: { text: 'Part 2' } });
	});
});

describe('streaming DB writes in turn-io (bounded sub-quadratic flushes)', () => {
	const makeMockStreamer = () => {
		const writes: { readonly kind: 'insert' | 'update'; readonly textLen: number }[] = [];
		let rowCounter = 0;
		const streamer = makeStreamer({
			id: 'c1',
			turn: 't1',
			insert: (row) =>
				Effect.sync(() => {
					const text = row.text ?? '';
					writes.push({ kind: 'insert', textLen: text.length });
					return {
						id: `s-${++rowCounter}`,
						conversation: 'c1',
						seq: rowCounter,
						role: 'assistant',
						content: { text, toolCalls: [] },
						text,
						state: 'streaming',
						mode: null,
						as: null,
						author: null,
						meta: null,
						supersedes: null,
						turn: 't1'
					} satisfies MessageRow;
				}),
			messageStatement: (chain) =>
				Effect.sync(() => {
					const text = typeof chain.params[0] === 'string' ? chain.params[0] : '';
					writes.push({ kind: 'update', textLen: text.length });
					return [
						{
							id: `s-${rowCounter}`,
							conversation: 'c1',
							seq: rowCounter,
							role: 'assistant',
							content: { text, toolCalls: [] },
							text,
							state: 'streaming',
							mode: null,
							as: null,
							author: null,
							meta: null,
							supersedes: null,
							turn: 't1'
						} satisfies MessageRow
					];
				})
		});
		return { writes, streamer };
	};

	it.effect('skips no-op writes and redundant pre-settle flush on fast completion, and bounds updates on large streams', () =>
		Effect.scoped(
			Effect.gen(function* () {
				// 1. Empty deltas and fast normal completion (end(false)) cause 0 streaming DB writes
				const fast = makeMockStreamer();
				const s1 = yield* fast.streamer(null);
				s1.delta('');
				s1.delta('quick answer');
				const partial1 = yield* s1.end(false);
				expect(partial1).toBeNull();
				expect(fast.writes).toEqual([]);

				// 2. Large streamed reply (60 ticks of 200-char chunks = 12 KB) performs far fewer writes than ticks
				const long = makeMockStreamer();
				const s2 = yield* long.streamer(null);
				const chunk = 'x'.repeat(200);
				for (let i = 0; i < 60; i++) {
					s2.delta(chunk);
					yield* TestClock.adjust(STREAM_FLUSH_MS);
				}
				const partial2 = yield* s2.end(false);
				expect(partial2).not.toBeNull();
				// First insert + geometric growth / max-silence updates << 60 full-row updates
				expect(long.writes.length).toBeGreaterThan(1);
				expect(long.writes.length).toBeLessThan(25);

				// 3. Interrupt/stop (end(true)) flushes buffered tail so partial text is not lost
				const cut = makeMockStreamer();
				const s3 = yield* cut.streamer(null);
				s3.delta('partial before stop');
				const partial3 = yield* s3.end(true);
				expect(partial3?.text).toBe('partial before stop');
				expect(cut.writes).toHaveLength(1);
			})
		)
	);
});

describe('full /export transcript pagination', () => {
	const agentRow = (seq: number, role: 'user' | 'assistant', text: string): AgentRow => ({
		id: `r-${seq}`,
		seq,
		role,
		text,
		state: role === 'user' ? 'consumed' : null,
		tag: role === 'assistant' ? 'reply' : null
	});

	it.effect('paginates backwards through all older pages and exports the entire conversation in chronological order', () =>
		Effect.gen(function* () {
			const all = Array.from({ length: 150 }, (_, i) =>
				agentRow(i + 1, i % 2 === 0 ? 'user' : 'assistant', `Message ${i + 1}`)
			);
			// Client only holds the trailing 60-row window (seq 91..150), with before = 91
			const loadedWindow = all.slice(90);
			const fetchedCursors: number[] = [];
			const fetchOlder = (_conv: string, before: number, _limit: number) =>
				Effect.sync(() => {
					fetchedCursors.push(before);
					// Simulate 50-row pages from the server
					const slice = all.filter((r) => r.seq < before).slice(-50);
					const first = slice[0]?.seq ?? before;
					return { rows: slice, more: first > 1, first };
				});

			const collected = yield* collectFullTranscript('conv-1', loadedWindow, 91, fetchOlder);
			expect(fetchedCursors).toEqual([91, 41]);
			expect(collected).toHaveLength(150);
			expect(collected.map((r) => r.seq)).toEqual(all.map((r) => r.seq));

			const markdown = exportTranscriptMarkdown(collected, 'Long Chat');
			expect(markdown).toContain('# Long Chat');
			expect(markdown).toContain('**user**: Message 1');
			expect(markdown).toContain('**assistant**: Message 150');
		})
	);
});
