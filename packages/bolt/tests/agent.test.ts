// The agent engine's pure parts (rules 60, 62, 63): bounded tool results, context projection and native AI streams.
import { describe, expect, it } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, AiResponse } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port, type PortFailure } from '../src/engine/port.ts';
import type { Ai, AiEvent } from '../src/engine/ports.ts';
import type { FacilityCall } from '../src/engine/services.ts';
import { applyEdit, inferFacility, modelCall } from '../src/engine/agent/ai.ts';
import { jsonDiff } from '../src/engine/agent/draft.ts';
import {
	bound,
	BOUNDS,
	messages,
	outline,
	projection,
	system
} from '../src/engine/agent/context.ts';
import { LAYOUT_HELP } from '../src/decl/layout.ts';
import { listed, type MessageRow } from '../src/engine/agent/schema.ts';
import { preview } from '../src/engine/conversations/store.ts';
import { respondSystem1 } from '../src/test/effect.ts';
import { clockProbe } from './support/clock-probe.ts';

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const row = (seq: number, over: Partial<MessageRow> = {}): MessageRow => ({
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
const response = (answer: AiResponse): Stream.Stream<AiEvent, PortFailure> =>
	Stream.succeed({ _tag: 'Response', response: answer });
const port = (answers: readonly Step[]) => {
	const requests: AiRequest[] = [];
	let index = 0;
	const p: Ai['Service'] = {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
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
		response({ content: text, toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } });
const elapsed = clockProbe;

describe('tool results are bounded (rule 62)', () => {
	it('clips long cells and drops trailing rows with a note, within 16 KiB', () => {
		const rows = Array.from({ length: 200 }, (_, i) => ({
			id: String(i),
			note: 'x'.repeat(2_000)
		}));
		const result = bound({ rows, next: null });
		const out = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Struct({ note: Schema.String })),
				clipped: Schema.String
			})
		)(result);
		expect(size(result)).toBeLessThanOrEqual(BOUNDS.resultBytes);
		expect(out.rows[0]!.note).toMatch(/clipped, 2002 bytes/);
		expect(out.clipped).toMatch(new RegExp(`showing ${out.rows.length} of 200 rows`));
		expect(bound({ a: 1 })).toEqual({ a: 1 });
	});
	it('previews are at most 2 KiB', () => {
		expect(new TextEncoder().encode(preview('é'.repeat(3_000))).length).toBeLessThanOrEqual(2051);
		expect(preview('short')).toBe('short');
	});
});

describe('the context projection (rule 60)', () => {
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
	it('every message carries its sender header, which says whom the turn serves (rule 57, P32); engine notes are user text', () => {
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
	it('the system prompt is the kernel, brief, task and skills list only: no date, actor or conversation state (rule 62)', () => {
		const s = system({
			envoy: 'Norbius',
			brief: 'Brief.',
			task: 'Task.',
			skills: { pricing: '---\ndescription: How we price\n---\nbody' }
		});
		expect(s).toContain(
			'Brief.\n\nTask.\n\nSkills (read one with the skill tool):\n- pricing: How we price'
		);
		expect(s).not.toMatch(/20\d\d|clock|timezone/i);
		// the channel guidance names the envoy, so a message that says the name is readable as addressed to it
		expect(s).toContain('You are Norbius, answering on a messaging channel.');
		// and it may not narrate the workspace's own checks
		expect(s).toContain("Never describe the workspace's own automated checks");
		// a turn without the source tools (an envoy's) is never told to call them; staff in the app are
		expect(system({ skills: {}, outline: '# Workspace outline' })).not.toMatch(
			/workspace_search|workspace_type/
		);
		expect(
			system({ skills: {}, outline: '# Workspace outline', tools: [{ name: 'workspace_search' }] })
		).toMatch(/workspace_search reads the source[\s\S]*# Source layout/);
		// the layout is the compiler's own role table, so a file is never guessed without its +
		const layout = system({
			skills: {},
			outline: '# Workspace outline',
			tools: [{ name: 'workspace_search' }]
		});
		expect(layout).toContain(LAYOUT_HELP);
		expect(layout).toContain('src/data/model/+<name>.model.ts');
		expect(layout).toContain('src/app/<app>/+<name>.page.svelte');
		expect(layout).toContain('src/data/collection/<name>/+collection.ts');
	});
});

describe('the workspace outline', () => {
	it("names each collection's write contract and nested relation writes, so a write needs no type lookup", () => {
		const m: EngineManifest = {
			models: {
				sites: {
					description: 'A site',
					label: 'name',
					fields: { name: { kind: 'text' }, code: { kind: 'text', optional: true } }
				},
				jobs: {
					description: 'A job',
					label: 'title',
					fields: { title: { kind: 'text' }, done: { kind: 'enum', values: ['2', '10'] } },
					unique: [{ fields: ['title'] }]
				}
			},
			collections: {
				sites: {
					read: { fields: 'all' },
					create: {
						input: {
							columns: ['name', 'code'],
							with: { tasks: { create: { columns: ['title', 'site_id'] }, link: {} } }
						}
					},
					update: {
						input: {
							columns: ['name', 'code'],
							with: { tasks: { create: { columns: ['title', 'site_id'] }, link: {} } }
						}
					},
					delete: {}
				},
				jobs: {
					read: { fields: 'all' },
					create: { input: { columns: ['title'] } },
					update: { input: { columns: ['title', 'done'] } }
				}
			},
			relationships: { 'jobs.site_id': { to: 'sites', inverse: 'tasks', optional: true } },
			pipelines: {
				jobs: {
					import: { description: 'Import jobs', input: {} },
					export: { description: 'Export jobs', select: ['title', 'done'], format: 'json' }
				}
			},
			integrations: {
				erp: {
					description: 'The ERP',
					driver: 'http',
					feeds: { jobs: { into: 'jobs', key: ['title'], cron: '0 * * * *' } }
				}
			},
			customFields: {},
			apps: {},
			automations: {},
			policies: {},
			workspace: { tz: 'UTC', locale: 'en' },
			teams: {},
			connections: {},
			envoys: {},
			mcp: {},
			agent: { skills: {} }
		};
		const lines = outline(m, null).split('\n');
		expect(lines.find((l) => l.startsWith('- jobs'))).toContain('fed by erp.jobs');
		expect(lines.find((l) => l.startsWith('- sites'))).toContain(
			'create(name, code?, tasks{create(title, site_id?), link}), update(as create), upsert, delete'
		);
		expect(lines.find((l) => l.startsWith('- jobs'))).toContain(
			'create(title), update(title, done), upsert, pipeline(import|export)'
		);
		expect(lines.find((l) => l.startsWith('- jobs'))).toContain('done("2"|"10")');
		// every source file by folder, + files included, so a read names the exact path
		expect(
			outline(m, [
				'src/data/model/+jobs.model.ts',
				'src/data/collection/jobs/+collection.ts',
				'src/lib/util.ts',
				'package.json'
			])
		).toContain(
			'## Source files\n- src/data/collection/jobs/ +collection.ts\n- src/data/model/ +jobs.model.ts\n- src/lib/ util.ts'
		);
	});
});

describe('the AI port under the 20 s idle wall (rule 63)', () => {
	const req: AiRequest = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
	it.effect(
		'the default response deadline cancels and settles a silent provider after 20 seconds',
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
				expect(yield* elapsed(Effect.flip(modelCall(port([silent]).p, req)), 20_001)).toMatchObject(
					{
						kind: 'timeout',
						message: 'the model yielded nothing within 20000 ms'
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
							toolCalls: [],
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
			const files = Array.from({ length: 9 }, () => ({
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
						toolCalls: [],
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
			const infer = inferFacility(p, { wallMs: 20 });
			const call: Extract<FacilityCall, { _tag: 'ai.sys_2.infer' }> = {
				_tag: 'ai.sys_2.infer',
				args: [{ prompt: 'q' }]
			};
			expect(yield* elapsed(infer(call), 21)).toEqual({
				ok: true,
				value: 'The answer is 42.'
			});
			expect(requests).toHaveLength(2);
			expect(requests[1]!.messages).toEqual([
				{ role: 'user', content: 'q' },
				{ role: 'assistant', content: 'The answer ' }
			]);
			const json = inferFacility(port([stalls('{"n":'), done('42}')]).p, { wallMs: 20 });
			expect(
				yield* elapsed(json({ ...call, args: [{ prompt: 'q', output: { kind: 'json' } }] }), 21)
			).toEqual({ ok: true, value: { n: 42 } });
			// no step budget: a model that never finishes runs until the ceiling on the whole call (the run's signal) ends it
			const never = inferFacility(port(Array.from({ length: 200 }, () => stalls('a'))).p, {
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
				toolCalls: [{ id, name, input }],
				finish: 'tool',
				usage: { input: 1, output: 1 }
			});
	const output = {
		kind: 'object',
		fields: { n: { kind: 'int' }, note: { kind: 'text', optional: true } }
	};
	const DRAFT_TOOLS = ['edit', 'submit', 'read', 'find', 'diff'];
	const leave = {
		kind: 'object',
		fields: {
			leave: {
				kind: 'list',
				key: 'code',
				of: {
					kind: 'object',
					fields: {
						code: { kind: 'text' },
						days: { kind: 'int' },
						note: { kind: 'text', optional: true }
					}
				}
			},
			tags: { kind: 'list', of: { kind: 'text' } }
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3, note: 'seen' }
				});
				expect(requests[0]!.tools!.map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(requests[0]!.output).toBeUndefined();
				// the shape to build is in the prompt, as JSON Schema
				expect(requests[0]!.messages[0]!.content).toContain('"required":["n"]');
				expect(requests[0]!.messages[0]!.content).toContain('"n":{"type":"integer"}');
				// each op is checked as it applies: the refused value never reaches the draft
				expect(requests[1]!.messages.at(-1)).toMatchObject({
					role: 'tool',
					content: {
						id: 'e1',
						result: { applied: 0, errors: [{ op: 0, error: '/n: expected a number' }] }
					}
				});
				expect(requests[2]!.messages.at(-1)).toMatchObject({
					role: 'tool',
					content: { id: 's1', result: { error: expect.stringContaining('/n: is required') } }
				});
			})
	);

	it.effect(
		'sys_2.infer: half its tool time gone with nothing written, the model is asked once to write what it has verified',
		() =>
			Effect.gen(function* () {
				// a turn that only reads the draft, after 13 of the 24 minutes for tools
				const late: Step = () =>
					Stream.fromEffect(Effect.sleep('13 minutes')).pipe(
						Stream.flatMap(() =>
							response({
								content: '',
								toolCalls: [{ id: 'r', name: 'read', input: { path: '' } }],
								finish: 'tool',
								usage: { input: 1, output: 1 }
							})
						)
					);
				const { p, requests } = port([
					late,
					tool('edit', { ops: [{ path: '/n', set: 3 }] }, 'e1'),
					tool('submit', {}, 's1')
				]);
				expect(
					yield* elapsed(
						inferFacility(p, { wallMs: 30 * 60_000 })(at({ prompt: 'q', output })),
						14 * 60_000
					)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(requests[1]!.messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('Half your time for tools is gone')
				});
				// once only: the next request carries no second nudge
				expect(
					requests[2]!.messages.filter(
						(message) =>
							typeof message.content === 'string' && message.content.startsWith('Half your time')
					)
				).toHaveLength(1);
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
					yield* elapsed(inferFacility(p, { wallMs: 20 })(at({ prompt: 'q', output })), 41)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(requests).toHaveLength(4);
				// silence alone asks again unchanged; silence while writing a call asks for smaller calls
				expect(requests[1]!.messages).toEqual(requests[0]!.messages);
				expect(requests[2]!.messages.at(-1)).toMatchObject({
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
							kind: 'list',
							of: {
								kind: 'object',
								fields: { n: { kind: 'int' }, flags: { kind: 'list', of: { kind: 'bool' } } }
							}
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output: quoted }))).toEqual({
					ok: true,
					value: { ok: true, pct: 95, parts: [{ n: 3, flags: [false, true] }] }
				});
				expect(requests[1]!.messages.at(-1)).toMatchObject({
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
					yield* inferFacility(port([repeat(), repeat()]).p)(at({ prompt: 'q', output: quoted }))
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output: declared }))).toEqual({
					ok: true,
					value: answer
				});
				const prompt = Schema.decodeUnknownSync(Schema.String)(requests[0]?.messages[0]?.content);
				const advertised = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
					prompt.slice(prompt.lastIndexOf('\n') + 1)
				);
				expect(advertised).toEqual({
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
					yield* inferFacility(closed.p)(
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
				expect(closed.requests[0]?.messages[0]?.content).toContain('"additionalProperties":false');
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
		const edit = (d: Json, op: Parameters<typeof applyEdit>[1]) => applyEdit(d, op, leave);
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
					kind: 'list',
					key: 'code',
					of: { kind: 'object', fields: { code: { kind: 'text' }, n: { kind: 'int' } } }
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
				expect(yield* inferFacility(p)(at({ prompt: 'research', initial, output }))).toEqual({
					ok: true,
					value: { n: 3, note: 'keep' }
				});
				expect(initial).toEqual({ n: 2, note: 'keep' });
				expect(requests[0]!.tools!.map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(requests[1]!.messages.at(-1)).toMatchObject({
					role: 'tool',
					content: { id: 'r1', result: { value: 'keep' } }
				});
				expect(yield* inferFacility(p)(at({ prompt: 'q', initial }))).toMatchObject({
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
				call: (input: Json) =>
					Effect.sync(() => {
						seen.push(input);
						return { rows: [] };
					})
			};
			const { p, requests } = port([
				tool('read', { collection: 'purchase_orders' }, 'r1'),
				tool('read_answer', { path: '/note' }, 'r2'),
				tool('submit', {})
			]);
			expect(
				yield* inferFacility(p)(
					at({ prompt: 'q', initial: { n: 2, note: 'keep' }, output, tools: ['read'] }),
					[records]
				)
			).toEqual({ ok: true, value: { n: 2, note: 'keep' } });
			expect(seen).toEqual([{ collection: 'purchase_orders' }]);
			expect(requests[0]!.tools!.map((t) => t.name)).toEqual([
				'read',
				'edit',
				'submit',
				'read_answer',
				'find',
				'diff'
			]);
			expect(requests[2]!.messages.at(-1)).toMatchObject({
				content: { id: 'r2', result: { value: 'keep' } }
			});
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
						inferFacility(p)(at({ prompt: 'research', initial: { n: 2, note: 'keep' }, output })),
						1_001
					)
				).toEqual({ ok: true, value: { n: 3, note: 'keep' } });
				expect(requests).toHaveLength(3);
				expect(requests[2]!.messages).toEqual(requests[1]!.messages);
				// six retries backing off from 1 s (1 + 2 + … + 32 = 63 s) before the failure ends the inference
				const exhausted = port(Array.from({ length: 7 }, () => fail));
				expect(
					yield* elapsed(inferFacility(exhausted.p)(at({ prompt: 'research', output })), 63_001)
				).toMatchObject({ ok: false, error: { kind: 'upstream' } });
				expect(exhausted.requests).toHaveLength(7);
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
							toolCalls: [],
							finish: 'stop',
							usage: { input: 1, output: 1 }
						})
					);
				const { p, requests } = port([reasons]);
				expect(
					yield* elapsed(inferFacility(p, { wallMs: 30 })(at({ prompt: 'q', output })), 101)
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 4 }
				});
				expect(requests).toHaveLength(2);
				expect(requests[1]!.messages.at(-1)).toMatchObject({
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3 }
				});
				expect(requests[1]!.messages.at(-1)).toMatchObject({
					role: 'user',
					content: expect.stringContaining('Build the answer with edit')
				});
				expect(
					yield* inferFacility(
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
					yield* inferFacility(p)(at({ prompt: 'q', initial: { n: 'x' }, output }))
				).toMatchObject({
					ok: false,
					error: { kind: 'invalid', message: expect.stringContaining('/n: expected a number') }
				});
				expect(requests).toHaveLength(4);
			})
	);

	it.effect(
		'sys_2.infer: a reasoning-only reply is continued, at most 3 times running (L-BOLT-371)',
		() =>
			Effect.gen(function* () {
				const { p, requests } = port([done(''), done('hi')]);
				expect(yield* inferFacility(p)(at({ prompt: 'q' }))).toEqual({
					ok: true,
					value: 'hi'
				});
				expect(requests[1]!.messages.at(-1)).toEqual({
					role: 'user',
					content: 'Continue, and give your answer.'
				});
				expect(
					yield* inferFacility(port([done(''), done(''), done(''), done('')]).p)(
						at({ prompt: 'q' })
					)
				).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			})
	);

	it.effect(
		'sys_2.infer with a JSON Schema output: the schema checks structure (if/then included), CEL rules check logic, both come back by path',
		() =>
			Effect.gen(function* () {
				const jsonSchema = {
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', output: { jsonSchema, rules } }))).toEqual(
					{ ok: true, value: { test: { status: 'unable', reason: 'VTs connected' } } }
				);
				expect(requests[0]!.messages[0]!.content).toContain('an unperformed test has no reading');
				const back = JSON.stringify(requests[2]!.messages.at(-1));
				expect(back).toContain('/test/reading');
				expect(back).toContain('reason');
				expect(back).toContain('rule broken: an unperformed test has no reading');
				// a rule that does not compile is the caller's, refused before any model call
				expect(
					yield* inferFacility(port([]).p)(
						at({
							prompt: 'q',
							output: { jsonSchema, rules: [{ expression: 'test.(', message: 'x' }] }
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
							toolCalls: [
								{ id: `e${id}`, name: 'edit', input: { ops } },
								{ id: `s${id}`, name: 'submit', input: {} }
							],
							finish: 'tool',
							usage: { input: 1, output: 1 }
						});
				const clean = port([both([{ path: '/n', set: 3 }], '1')]);
				expect(yield* inferFacility(clean.p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 3 }
				});
				expect(clean.requests).toHaveLength(1);
				expect(clean.requests[0]!.messages[0]!.content).toContain('in the same reply');
				const fixed = port([
					both([{ path: '/n', set: 'x' }], '1'),
					both([{ path: '/n', set: 4 }], '2')
				]);
				expect(yield* inferFacility(fixed.p)(at({ prompt: 'q', output }))).toEqual({
					ok: true,
					value: { n: 4 }
				});
				expect(fixed.requests).toHaveLength(2);
				expect(fixed.requests[1]!.messages.slice(-2)).toMatchObject([
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
				const jsonSchema = {
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
				const files = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }));
				expect(
					yield* inferFacility(p, { load })(at({ prompt: 'q', files, output: { jsonSchema } }))
				).toEqual({ ok: true, value: { rows: ['a', 'b'] } });
				expect(requests.map((r) => r.files?.length)).toEqual([8, 8, 2, 2]);
				expect(loads).toEqual(files.map((f) => f.id));
				// the second batch starts from the first one's draft, which minItems alone would have refused
				expect(requests[2]!.messages[0]!.content).toContain('files 9–10');
				expect(requests[2]!.messages[0]!.content).toContain('{"rows":["a"]}');
			})
	);

	it.effect(
		'sys_2.infer with tools: the model calls them beside the draft tools (L-BOLT-372)',
		() =>
			Effect.gen(function* () {
				const seen: Json[] = [];
				const browse = {
					name: 'browse',
					description: 'Read a page',
					input: { type: 'object' },
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
					yield* inferFacility(p)(at({ prompt: 'q', output, tools: ['browse'] }), [browse])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toEqual([{ url: 'https://x' }]);
				expect(requests[0]!.tools!.map((t) => t.name)).toEqual(['browse', ...DRAFT_TOOLS]);
				expect(requests[1]!.messages.at(-1)).toEqual({
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
			toolCalls: [
				{ id: 'e', name: 'edit', input: { ops: [{ path: '/n', set: 3 }] } },
				{ id: 's', name: 'submit', input: {} }
			],
			finish: 'tool',
			usage: { input: 1, output: 1 }
		});

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
					yield* inferFacility(p)(at({ prompt: 'q', output, tools: ['browse'], steps: 2 }), [
						browse
					])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toHaveLength(2);
				expect(requests).toHaveLength(3);
				expect(requests[1]!.tools!.map((t) => t.name)).toEqual(['browse', ...DRAFT_TOOLS]);
				expect(requests[2]!.tools!.map((t) => t.name)).toEqual(DRAFT_TOOLS);
				expect(requests[2]!.messages.at(-1)).toMatchObject({
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
					yield* inferFacility(p)(
						at({ prompt: 'q', output, initial: {}, tools: ['browse'], steps: 8 }),
						[browse]
					)
				).toEqual({ ok: true, value: { n: 3 } });
				expect(seen).toHaveLength(1);
			})
	);

	it.effect(
		'sys_2.infer: near the time ceiling the tools end and the final turn answers, as when steps are spent',
		() =>
			Effect.gen(function* () {
				// a long research: the first page takes the call past its answer-by time, 24 of its 30 minutes
				const seen: Json[] = [];
				const slow = {
					name: 'browse',
					description: 'Read a page',
					input: { type: 'object' },
					call: (input: Json) =>
						TestClock.adjust('25 minutes').pipe(
							Effect.andThen(Effect.sync(() => seen.push(input))),
							Effect.as({ text: 'rate is 3' })
						)
				};
				const { p, requests } = port([tool('browse', { url: 'https://a' }, 'b1'), editAndSubmit]);
				expect(
					yield* inferFacility(p)(
						at({ prompt: 'q', output, initial: {}, tools: ['browse'], steps: 1000 }),
						[slow]
					)
				).toEqual({ ok: true, value: { n: 3 } });
				// with 999 steps left, the second turn is the final one: only the draft tools are offered
				expect(seen).toHaveLength(1);
				expect(requests).toHaveLength(2);
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
					yield* inferFacility(one.p)(at({ prompt: 'q', output, tools: ['browse'], steps: 1 }), [
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
					yield* inferFacility(two.p)(at({ prompt: 'q', output, tools: ['browse'], steps: 2 }), [
						held.browse
					])
				).toEqual({ ok: true, value: { n: 3 } });
				expect(held.seen).toHaveLength(1);
				expect(two.requests).toHaveLength(3);

				expect(
					yield* Effect.flip(inferFacility(port([]).p)(at({ prompt: 'q', output, steps: 0 })))
				).toMatchObject({ kind: 'invalid' });
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
				expect(yield* inferFacility(p)(at({ prompt: 'q', initial, output: leave }))).toEqual({
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
				expect(requests[0]!.messages[0]!.content).toContain('Keyed by \\"code\\"');
				expect(requests[1]!.messages.at(-1)).toMatchObject({
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
				expect(requests[2]!.messages.at(-1)).toMatchObject({
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
				expect(requests[3]!.messages.at(-1)).toMatchObject({
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
				expect(requests[4]!.messages.at(-1)).toMatchObject({
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
							kind: 'list',
							key: 'area',
							of: {
								kind: 'object',
								fields: {
									area: { kind: 'text' },
									status: { kind: 'enum', values: ['pending', 'done'] }
								}
							}
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
					yield* inferFacility(p)(at({ prompt: 'q', initial, output: review, rules, steps: 2 }))
				).toEqual({
					ok: false,
					error: {
						kind: 'invalid',
						message: expect.stringMatching(/tool budget.*rule broken: every area is reviewed/)
					}
				});
				expect(requests).toHaveLength(5);
				expect(requests[0]!.messages[0]!.content).toContain('every area is reviewed');
				expect(requests[1]!.messages.at(-1)).toMatchObject({
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
					yield* inferFacility(repaired.p)(
						at({ prompt: 'q', initial, output: review, rules, steps: 2 })
					)
				).toMatchObject({ ok: true });
				expect(repaired.requests.at(-1)!.tools?.map((t) => t.name)).not.toContain('browse');
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
					yield* inferFacility(finished.p)(at({ prompt: 'q', initial, output: review, rules }))
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
		expect(listed(publicThread, 'ann', ['field_ops'])).toBe(true);
		expect(listed(privateThread, 'ann', ['field_ops'])).toBe(false); // never a row the read would not return
		expect(listed(null, 'ann', ['field_ops'])).toBe(false);
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
