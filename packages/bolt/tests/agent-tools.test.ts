// The agent catalogue over typed native ports: one-write act, approvals, workspace search and run waits.
import { memberCap } from '../src/engine/agent/settings.ts';
import { createHash } from 'node:crypto';
import { encode as encodePng } from 'fast-png';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Predicate,
	Schema,
	Scope
} from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import type {
	Authority,
	HttpFetchOptions,
	HttpRequest,
	HttpResponse,
	LogRow
} from '../src/engine/contracts.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { AgentEngine } from '../src/engine/agent/index.ts';
import {
	catalogue,
	jobs,
	type HostTool,
	type HostToolContext,
	type ToolContext,
	type WorkspacePort,
	workspaceSchema,
	describeWorkspace,
	messageCatalogue,
	OVERVIEW_BYTES
} from '../src/engine/agent/tools.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { TenantDb, type RawDb } from '../src/engine/db/tenant-db.ts';
import { layered, type EngineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { Browser, Bundler, Files, GuestIsolates, Http, Images, Logs } from '../src/engine/ports.ts';
import { browserTools } from '../src/engine/agent/browser.ts';
import { off } from '../src/facilities/index.ts';
import { filesOf, skillOf } from './support/run-file-trees.ts';
import { REFERENCE } from '../src/engine/agent/run-js.ts';
import { BOUNDS } from '../src/engine/agent/context.ts';
import { treeDigest } from '../src/engine/artifact/read.ts';
import { Approvals, Callables, Live, Reads, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/effect.ts';
import { toolSchema } from '../src/engine/agent/ai.ts';
import { fileAttachments } from '../src/engine/agent/attachments.ts';
import type { Ingested } from '../src/engine/contracts.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { ToolAnswer } from '../src/engine/agent/ai.ts';
import { randomUUID } from 'node:crypto';
import { actorRef } from '../src/engine/write/commit.ts';

const member = (
	o: { external?: boolean; admin?: boolean; tools?: readonly string[]; team?: string } = {}
): Authority => ({
	key: 'k',
	actor: {
		kind: 'member',
		id: 'ann',
		email: null,
		phone: null,
		external: o.external ?? false,
		admin: o.admin ?? false,
		party: null,
		teams: o.team === undefined ? [] : [o.team],
		teamPath: o.team === undefined ? [] : [o.team]
	},
	admin: o.admin ?? false,
	policies: [],
	// an administrator reads every output of every workspace model, as `compileAuthority` grants it
	models:
		o.admin === true
			? compileAuthority(
					manifest,
					{
						actor: { kind: 'system', run: 'r', by: { platform: 'test' } },
						admin: true,
						policies: []
					},
					'k'
				).models
			: {},
	automations: [],
	capabilities: { apps: [], tools: o.tools ?? [], mcp: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	exposures: {
		tasks: { read: { tasks: { fields: 'all' } }, create: { columns: { tasks: ['title'] } } }
	},
	models: {
		tasks: {
			description: 'A task',
			label: 'title',
			fields: { title: { kind: 'text' } },
			search: { text: ['title'] }
		}
	},
	relationships: {},
	integrations: {},
	agent: { skills: {} },
	policies: {
		staff: {
			description: '',
			grants: { tasks: { create: { check: true } } }
		}
	},
	teams: { Leads: [] },
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {}
};
type EngineOverrides = Omit<Partial<AgentEngine>, 'db' | 'calls' | 'approvals' | 'files'> & {
	db?: Partial<RawDb>;
	calls?: Partial<AgentEngine['calls']>;
	approvals?: Partial<AgentEngine['approvals']>;
	files?: Partial<Files['Service']>;
};
// One workspace for the file: every context runs its tools against this engine, its own pieces swapped in per test.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const workspace = Effect.runSync(
	Effect.cached(Layer.build(TestWorkspace.layer({ manifest })).pipe(Scope.provide(fileScope)))
);
/** Each context's kit host runtime log: its rows (oldest first). */
const kitLogs = new WeakMap<ToolContext, LogRow[]>();
/** Each context's kit files origin: what `download` fetches. */
const kitOrigins = new WeakMap<ToolContext, Map<string, Uint8Array>>();
const ctx = (
	over: Partial<Omit<ToolContext, 'engine' | 'jobs'>> = {},
	engine: EngineOverrides = {}
) =>
	Effect.gen(function* () {
		const m = engine.manifest ?? manifest;
		const native = yield* workspace;
		const db = Context.get(native, TenantDb),
			calls = Context.get(native, Callables),
			approvals = Context.get(native, Approvals),
			files = Context.get(native, Files);
		const x: ToolContext = {
			engine: {
				manifest: m,
				db: TenantDb.typed({ ...db, ...engine.db }),
				live: Context.get(native, Live),
				calls: { ...calls, ...engine.calls },
				read: Context.get(native, Reads).run,
				act: Context.get(native, Writes).act,
				approvals: { ...approvals, ...engine.approvals },
				files: { ...files, ...engine.files },
				images: engine.images ?? Context.get(native, Images),
				...(engine.read === undefined ? {} : { read: engine.read }),
				...(engine.act === undefined ? {} : { act: engine.act }),
				...(engine.convert === undefined ? {} : { convert: engine.convert }),
				guest: engine.guest ?? Context.get(native, GuestIsolates),
				...(engine.http === undefined ? {} : { http: engine.http }),
				...(engine.bundler === undefined ? {} : { bundler: engine.bundler })
			},
			authority: member({ admin: true }),
			bindings: { now: '2026-09-26T00:00:00.000Z', today: '2026-09-26', tz: 'UTC' },
			turn: 't1',
			conv: {
				id: 'c1',
				title: null,
				owner: 'ann',
				envoy: null,
				integration: null,
				thread: null,
				parent: null,
				status: 'idle',
				model: 'default',
				plan: null,
				goals: []
			},
			mode: 'agent',
			inApp: true,
			delegation: false,
			child: false,
			skills: {},
			agents: [],
			mcp: { tools: () => Effect.succeed([]), call: () => Port.unavailable('mcp') },
			logs: Context.get(native, Logs),
			mcpTools: [],
			hostTools: [],
			receipts: [],
			read: new Map(),
			files: [],
			jobs: yield* jobs(),
			setPlan: () => Effect.void,
			setGoals: () => Effect.void,
			ask: () => {},
			messages: () => Effect.succeed([]),
			output: () => Effect.succeed(undefined),
			history: () => Effect.succeed([]),
			subagent: {
				spawn: () => Effect.succeed(null),
				list: () => Effect.succeed(null),
				read: () => Effect.succeed(null),
				message: () => Effect.succeed(null),
				stop: () => Effect.succeed(null),
				running: () => Effect.succeed(0),
				report: () => Effect.succeed(false)
			},
			...over
		};
		kitOrigins.set(x, Context.get(native, TestWorkspace).fakes.files.origin);
		kitLogs.set(x, Context.get(native, TestWorkspace).fakes.logs);
		return x;
	});
/** The file's shared runtime log, replaced by `rows` (`id` their position). */
const logRows = (
	x: ToolContext,
	rows: readonly (Pick<LogRow, 'at' | 'severity' | 'event' | 'invocation' | 'attributes'> &
		Partial<Pick<LogRow, 'run'>>)[]
) => {
	const log = kitLogs.get(x);
	if (log === undefined) throw new Error('no kit log for this context');
	log.length = 0;
	for (const row of rows)
		log.push({ run: null, conversation: null, turn: null, ...row, id: String(log.length + 1) });
};
/** This step's tool names, one tool of its toolkit (or none), and one call run as the actor (P7: the catalogue is a toolkit). */
const names = (x: ToolContext) => Effect.map(catalogue(x), (c) => c.tools.map((t) => t.name));
const tool = (x: ToolContext, name: string) =>
	Effect.map(catalogue(x), (c) =>
		Object.hasOwn(c.toolkit.tools, name) ? c.toolkit.tools[name] : undefined
	);
const requiredTool = (x: ToolContext, name: string) =>
	Effect.flatMap(tool(x, name), (t) =>
		t === undefined ? Effect.die(new Error(`missing tool ${name}`)) : Effect.succeed(t)
	);
/** A read's keys as its list: tests name what they read as a map, `read` takes `reads`. */
const called = (name: string, input: Json): Json =>
	name === 'read' && Predicate.isObject(input) && !('reads' in input)
		? {
				reads: Object.entries(input).map(([of, layer]) => ({
					of,
					...(Predicate.isObject(layer) ? layer : {})
				}))
			}
		: input;
const result = (x: ToolContext, name: string, input: Json) =>
	Effect.flatMap(catalogue(x), (c) => c.run(name, called(name, input), 'call'));
/** `describe_workspace { names: [name] }`'s shape: the JSON line closing its answer. */
const shape = (x: ToolContext, name: string) =>
	Effect.map(result(x, 'describe_workspace', { names: [name] }), (answer) =>
		Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
			Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(answer)
				.result.split('\n')
				.at(-1) ?? ''
		)
	);
const first = <A>(items: readonly A[]): A => {
	const item = items[0];
	if (item === undefined) throw new Error('fixture produced no item');
	return item;
};
describe('job waits', () => {
	it.effect('retains a host preview role when its job is collected later', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const list = yield* jobs();
				const id = yield* list.add(
					'workspace_validate',
					Effect.succeed({ preview: 'https://preview.test/' }),
					{ studio: 'preview' }
				);
				expect(yield* list.wait([id], 1000)).toMatchObject({
					job: id,
					studio: 'preview',
					result: { preview: 'https://preview.test/' }
				});
			})
		)
	);
	it.effect('releases abort listeners after completed waits and retains uncollected jobs', () =>
		Effect.gen(function* () {
			const list = yield* jobs();
			const signal = yield* Effect.abortSignal;
			for (let i = 0; i < 12; i++) {
				const id = yield* list.add('work', Effect.succeed(i));
				expect(yield* list.wait([id], 60_000)).toMatchObject({ job: id, result: i });
				expect(list.has(id)).toBe(false);
				expect(getEventListeners(signal, 'abort')).toHaveLength(0);
			}
			const id = yield* list.add('held', Effect.never);
			const entered = yield* Deferred.make<void>();
			const waiting = yield* Effect.forkChild(
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(list.wait([id], 60_000)))
			);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(waiting);
			expect(list.has(id)).toBe(true);
			const timed = yield* Effect.forkChild(list.wait([id], 1));
			yield* TestClock.adjust('1 millis');
			expect(yield* Fiber.join(timed)).toBeNull();
			expect(list.has(id)).toBe(true);
		})
	);
	it.effect('closing a turn scope interrupts every admitted job', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>(),
				released = yield* Deferred.make<void>();
			yield* Effect.scoped(
				Effect.gen(function* () {
					const turnJobs = yield* jobs();
					yield* turnJobs.add(
						'in-flight model tool',
						Effect.scoped(
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
								yield* Deferred.succeed(started, undefined);
								return yield* Effect.never;
							})
						)
					);
					yield* Deferred.await(started);
				})
			);
			expect(yield* Deferred.isDone(released)).toBe(true);
		})
	);
});
describe('job steering lines', () => {
	it.effect('a finished job leaves one line for the next step; wait collects it instead', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const list = yield* jobs();
				const a = yield* list.add('first', Effect.succeed({ ok: true }));
				const b = yield* list.add(
					'second',
					Effect.fail(BoltError.make('invalidInput', 'decode', 'bad input'))
				);
				const c = yield* list.add('third', Effect.succeed(3), {
					done: (id) => `[job ${id} done] custom`
				});
				expect(yield* list.settled(10_000)).toBe(true);
				expect(yield* list.wait([c], 1000)).toMatchObject({ job: c, result: 3 });
				expect(list.take()).toEqual([
					`[job ${a} done] first: {"ok":true}`,
					`[job ${b} failed] second: bad input; tell the person`
				]);
				expect(list.take()).toEqual([]);
				expect(list.pending()).toEqual([]);
			})
		)
	);
	it.effect('a detached job outlives the turn: its line, and any left untaken, go to late', () =>
		Effect.gen(function* () {
			const late: string[] = [];
			const detached = yield* FiberSet.make<unknown, never>();
			const gate = yield* Deferred.make<void>();
			let id = '',
				untaken = '';
			yield* Effect.scoped(
				Effect.gen(function* () {
					const list = yield* jobs({
						detached,
						late: (lines) => Effect.sync(() => late.push(...lines))
					});
					id = yield* list.add('ingest of a.pdf', Deferred.await(gate).pipe(Effect.as('ok')), {
						detach: true
					});
					untaken = yield* list.add('quick', Effect.succeed(1));
					yield* list.settled(10_000);
					// a detached job does not hold the turn open
					expect(list.running()).toBe(0);
				})
			);
			expect(late).toEqual([`[job ${untaken} done] quick: 1`]);
			yield* Deferred.succeed(gate, undefined);
			yield* FiberSet.awaitEmpty(detached);
			expect(late).toEqual([
				`[job ${untaken} done] quick: 1`,
				`[job ${id} done] ingest of a.pdf: "ok"`
			]);
		}).pipe(Effect.scoped)
	);
});
describe('spending caps', () => {
	it('a member gets the most generous cap among their policies, else the default', () => {
		const s = { monthly: null, member: 5, policies: { rep: 2, lead: 20 }, models: [] };
		expect(memberCap(s, ['rep', 'lead'])).toBe(20);
		expect(memberCap(s, ['rep'])).toBe(2);
		expect(memberCap(s, ['other'])).toBe(5);
		expect(memberCap({ ...s, member: null }, [])).toBeNull();
	});
});
describe('tool schemas', () => {
	it.effect(
		'every parameter declares its type: an untyped one reaches a routed model as { item: … } (Jev, staging)',
		() =>
			Effect.gen(function* () {
				const untyped: string[] = [];
				const walk = (schema: Json, at: string): void => {
					if (!Predicate.isObject(schema)) return;
					if (
						at !== '' &&
						schema['type'] === undefined &&
						schema['anyOf'] === undefined &&
						schema['enum'] === undefined &&
						schema['$ref'] === undefined
					)
						untyped.push(at);
					const properties = schema['properties'];
					if (Predicate.isObject(properties))
						for (const [key, value] of Object.entries(properties)) walk(value, `${at}.${key}`);
					if (schema['items'] !== undefined) walk(schema['items'], `${at}[]`);
				};
				const workspace: WorkspacePort = {
					files: async () => [],
					read: async () => null
				};
				const tools = [
					...Object.values((yield* catalogue(yield* ctx({ inApp: false }))).toolkit.tools),
					...Object.values(
						(yield* catalogue(yield* ctx({ workspace, authority: member() }))).toolkit.tools
					)
				];
				expect(tools.map((t) => t.name)).toEqual(
					expect.arrayContaining(['read', 'act', 'workspace_search'])
				);
				// the JSON Schema each tool is offered with, its definitions included
				for (const t of tools) {
					const schema = toolSchema(t);
					walk(schema, t.name);
					const defs = Predicate.isObject(schema) ? schema['$defs'] : undefined;
					if (Predicate.isObject(defs))
						for (const [name, definition] of Object.entries(defs))
							walk(definition, `${t.name}.$defs.${name}`);
				}
				expect(untyped).toEqual([]);
			})
	);
});
describe('fewer calls for the common paths', () => {
	it.effect(
		'act reports native relational fields, including writer-filled and owned-parent links',
		() =>
			Effect.gen(function* () {
				const model: EngineManifest = {
					...manifest,
					models: {
						...manifest.models,
						task_lines: {
							description: 'An owned line',
							label: 'value',
							fields: { value: { kind: 'text' } }
						}
					},
					relationships: {
						'tasks.owner': { to: 'sys_user' },
						'task_lines.task': { to: 'tasks', inverse: 'lines', owned: true },
						'task_lines.member': { to: 'sys_user' }
					},
					exposures: {
						tasks: {
							read: { tasks: { fields: 'all' }, 'tasks.lines': { fields: 'all' } },
							create: { columns: { tasks: ['title'], 'tasks.lines': ['value', 'member'] } }
						},
						task_lines: { read: { task_lines: { fields: 'all' } } }
					}
				};
				const task = '01950000-0000-7000-8000-000000000001',
					line = '01950000-0000-7000-8000-000000000002';
				const child = { id: line, value: 'Known source', task, member: 'ann' };
				const x = yield* ctx(
					{},
					{
						manifest: model,
						act: () =>
							Effect.succeed({
								v: 1,
								captured: [
									{
										model: 'tasks',
										id: task,
										op: 'create',
										revision: 1,
										old: null,
										new: { id: task, title: 'Source', owner: 'ann' },
										cause: 'direct'
									},
									{
										model: 'task_lines',
										id: line,
										op: 'create',
										revision: 1,
										old: null,
										new: child,
										cause: 'direct'
									}
								],
								outcome: {
									kind: 'committed',
									output: null,
									records: [
										{ model: 'tasks', id: task, revision: 1 },
										{ model: 'task_lines', id: line, revision: 1 }
									]
								}
							}),
						read: () =>
							Effect.succeed([
								{
									tasks: { rows: [{ id: task, title: 'Source', owner: 'ann' }] },
									'tasks.lines': { rows: [child] },
									task_lines: { rows: [child] }
								}
							])
					}
				);
				expect(
					yield* result(x, 'act', {
						callable: 'tasks.create',
						input: [{ title: 'Source', lines: [{ value: 'Known source', member: 'ann' }] }]
					})
				).toMatchObject({
					result: {
						fieldMap: [
							{
								model: 'tasks',
								row: task,
								field: 'tasks.owner',
								targetModel: 'sys_user',
								decision: 'LINK',
								value: 'ann'
							},
							{
								model: 'task_lines',
								row: line,
								field: 'task_lines.task',
								targetModel: 'tasks',
								decision: 'CREATE',
								value: task
							},
							{
								model: 'task_lines',
								row: line,
								field: 'task_lines.member',
								targetModel: 'sys_user',
								decision: 'LINK',
								value: 'ann'
							}
						]
					}
				});
			})
	);

	it.effect(
		'read takes one layer map: every root in one crossing; an unreadable root refuses the call',
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const id = '01a17f00-7596-7197-9dc4-f6789dfe8829';
				const answer = { tasks: { rows: [{ id, title: 'Fix the van' }] } };
				const x = yield* ctx(
					{},
					{
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [answer];
							})
					}
				);
				expect(
					yield* result(x, 'read', { tasks: { where: { id: { eq: id } }, limit: 5 } })
				).toMatchObject({ result: answer });
				expect(reads).toHaveLength(1);
				// an unreadable root is the handler's refusal, naming what the caller reads
				expect(yield* result(x, 'read', { tasks: {}, secrets: {} })).toEqual({
					result: { error: expect.stringMatching(/^You read no 'secrets'\. Models: .*tasks/) }
				});
				// options beside the list instead of inside a read: a wrong call
				expect(
					yield* result(x, 'read', { reads: [{ of: 'tasks' }], fields: ['title'], limit: 5 })
				).toEqual({
					result: { error: expect.stringContaining("Invalid parameters for tool 'read'") }
				});
				// the schema is static: no caller's model is a property of it
				const read = yield* requiredTool(x, 'read');
				expect(JSON.stringify(toolSchema(read))).not.toContain('"tasks"');
				expect(reads).toHaveLength(1);
				// the same model twice: the second answer under <model>#2
				expect(
					yield* result(x, 'read', {
						reads: [{ of: 'tasks' }, { of: 'tasks', aggregate: { count: true } }]
					})
				).toMatchObject({ result: { tasks: answer.tasks, 'tasks#2': answer.tasks } });
				expect(reads).toHaveLength(3);
			})
	);
	it.effect(
		"read's variables: the requestor stays an actor operand, { clock } is this turn's literal before decode",
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const dated: EngineManifest = {
					...manifest,
					models: {
						tasks: {
							...manifest.models.tasks!,
							fields: { title: { kind: 'text' }, due: { kind: 'date' }, seen: { kind: 'instant' } }
						}
					}
				};
				const x = yield* ctx(
					{},
					{
						manifest: dated,
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [{ tasks: { rows: [] } }];
							})
					}
				);
				yield* result(x, 'read', {
					tasks: {
						where: {
							title: { eq: { var: 'requestor.id' } },
							due: { gte: { var: 'today - days(7)' }, lte: { var: 'today' } },
							seen: { lt: { var: 'now + hours(1)' } }
						}
					}
				});
				const sent = JSON.stringify(reads);
				expect(sent).toContain('"Var"');
				expect(sent).toContain('2026-09-19');
				expect(sent).toContain('2026-09-26');
				expect(sent).toContain('2026-09-26T01:00:00.000Z');
				expect(sent).not.toContain('today');
				// a bad expression is the read's own refusal, before any read
				expect(
					yield* result(x, 'read', {
						tasks: { where: { due: { eq: { var: 'today - hours(1)' } } } }
					})
				).toMatchObject({ result: { error: expect.stringContaining('whole days') } });
				expect(reads).toHaveLength(1);
			})
	);
	it.effect(
		"describe_workspace answers a name's declared shape, and reads nothing for it",
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const x = yield* ctx(
					{},
					{
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [{ tasks: { rows: [] } }];
							})
					}
				);
				expect(yield* shape(x, 'tasks')).toMatchObject({
					model: 'tasks',
					fields: { title: expect.any(String) }
				});
				expect(reads).toHaveLength(0);
				// read takes no describe: a wrong call, and nothing is read
				expect(yield* result(x, 'read', { tasks: { describe: true } })).toEqual({
					result: { error: expect.stringContaining("Invalid parameters for tool 'read'") }
				});
				expect(reads).toHaveLength(0);
			})
	);
	const outputs: EngineManifest = {
		...manifest,
		models: {
			tasks: {
				...manifest.models.tasks!,
				fields: { title: { kind: 'text' }, cost: { kind: 'int' } }
			}
		},
		exposures: {
			tasks: {
				read: { tasks: { fields: 'all' } },
				outputs: { brief: { tasks: { fields: ['title'] } } }
			}
		},
		policies: {
			viewer: { description: '', grants: { tasks: { outputs: { brief: true } } } }
		}
	};
	const viewer = compileAuthority(
		outputs,
		{ actor: member().actor, admin: false, policies: ['viewer'] },
		'v'
	);
	it.effect(
		'read names one output per root; the schema and describe answer per output the caller holds',
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const x = yield* ctx(
					{ authority: viewer },
					{
						manifest: outputs,
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [{ tasks: { rows: [] } }];
							})
					}
				);
				// the prompt names the models only; fields are describe's
				const schema = workspaceSchema(outputs, viewer) ?? '';
				expect(schema).toContain('# Models you read\n');
				expect(schema).toContain('tasks');
				expect(schema).not.toContain('cost');
				// the read names its output; the engine reads it
				yield* result(x, 'read', { tasks: { output: 'brief' } });
				expect(JSON.stringify(reads)).toContain('"output":"brief"');
				// a root that names none reads the first output the caller holds, never a refused default
				reads.length = 0;
				expect(yield* result(x, 'read', { tasks: {} })).toHaveProperty('result');
				expect(JSON.stringify(reads)).toContain('"output":"brief"');
				// an administrator reads every output: describe of default names both
				const admin = compileAuthority(
					outputs,
					{ actor: member({ admin: true }).actor, admin: true, policies: [] },
					'a'
				);
				const y = yield* ctx({ authority: admin }, { manifest: outputs });
				expect(yield* shape(y, 'tasks')).toMatchObject({
					outputs: ['default', 'brief'],
					fields: { title: 'text', cost: 'int' }
				});
			})
	);
	it.effect("describe of a narrower holder shows the output it holds, never another's fields", () =>
		Effect.gen(function* () {
			const x = yield* ctx({ authority: viewer }, { manifest: outputs });
			expect(yield* shape(x, 'tasks')).toMatchObject({ fields: { title: 'text' } });
			expect(JSON.stringify(yield* shape(x, 'tasks'))).not.toContain('cost');
		})
	);
	it.effect("describe lists only the columns the caller's policies let it write", () =>
		Effect.gen(function* () {
			const narrow: EngineManifest = {
				...manifest,
				models: {
					tasks: {
						...manifest.models.tasks!,
						fields: { title: { kind: 'text' }, status: { kind: 'text', optional: true } }
					}
				},
				exposures: {
					tasks: {
						read: { tasks: { fields: 'all' } },
						create: { columns: { tasks: ['title', 'status'] } }
					}
				},
				policies: {
					clerk: {
						description: '',
						grants: { tasks: { read: true, create: { columns: { tasks: ['title'] } } } }
					}
				}
			};
			const clerk = compileAuthority(
				narrow,
				{ actor: member().actor, admin: false, policies: ['clerk'] },
				'k'
			);
			const x = yield* ctx({ authority: clerk }, { manifest: narrow });
			expect(yield* shape(x, 'tasks')).toMatchObject({
				writes: { 'tasks.create': { columns: { tasks: ['title'] } } }
			});
		})
	);
	it.effect(
		'describe names the policies whose check judges a write, never with an allowing arm held',
		() =>
			Effect.gen(function* () {
				const checked: EngineManifest = {
					...manifest,
					policies: {
						clerk: {
							description: '',
							grants: {
								tasks: { read: true, create: { columns: { tasks: ['title'] }, check: true } }
							}
						}
					}
				};
				const clerk = compileAuthority(
					checked,
					{ actor: member().actor, admin: false, policies: ['clerk'] },
					'k'
				);
				const x = yield* ctx({ authority: clerk }, { manifest: checked });
				expect(yield* shape(x, 'tasks')).toMatchObject({
					writes: { 'tasks.create': { checks: ['clerk'] } }
				});
				const admin = compileAuthority(
					checked,
					{ actor: member().actor, admin: true, policies: ['clerk'] },
					'k'
				);
				const y = yield* ctx({ authority: admin }, { manifest: checked });
				expect(JSON.stringify(yield* shape(y, 'tasks'))).not.toContain('"checks"');
			})
	);
	it.effect("describe names the columns each write takes and a create's required ones", () =>
		Effect.gen(function* () {
			const x = yield* ctx({});
			expect(yield* shape(x, 'tasks')).toMatchObject({
				writes: {
					'tasks.create': { columns: { tasks: expect.any(Array) }, required: ['title'] }
				}
			});
		})
	);
	it.effect(
		'describe names how a root is searched: its readable text fields and each index with its input format',
		() =>
			Effect.gen(function* () {
				const searched: EngineManifest = {
					...manifest,
					models: {
						tasks: {
							...manifest.models.tasks!,
							fields: { title: { kind: 'text' }, note: { kind: 'text' } },
							search: {
								text: ['title', 'note'],
								indexes: {
									colour: {
										description: 'Colour',
										dim: 3,
										metric: 'l2',
										input: {
											light: { kind: 'enum', values: ['D65', 'A'] },
											lab: { kind: 'custom', of: 'lab' }
										}
									}
								}
							}
						}
					},
					exposures: { tasks: { read: { tasks: { fields: ['title'] } } } },
					customFields: {
						lab: {
							description: 'L*a*b*',
							shape: { kind: 'object', fields: { l: { kind: 'number', min: 0, max: 100 } } }
						}
					}
				};
				const x = yield* ctx({}, { manifest: searched });
				expect(yield* shape(x, 'tasks')).toMatchObject({
					// `note` is outside the output read, so a search never matches it
					search: {
						text: { fields: ['title'] },
						colour: { input: { light: 'enum D65 | A', lab: { l: 'number 0..100' } } }
					}
				});
				// a model without an index says so: it is narrowed with where alone
				const { search: _search, ...unsearched } = manifest.models.tasks!;
				const y = yield* ctx({}, { manifest: { ...manifest, models: { tasks: unsearched } } });
				expect(yield* shape(y, 'tasks')).toMatchObject({ search: null });
			})
	);
	it.effect(
		"read is the client's read: its options and defaults, its page answered with its next cursor",
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const page = { tasks: { rows: [{ id: 'a', title: 'Fix the van' }], next: 'cursor' } };
				const x = yield* ctx(
					{},
					{
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [page];
							})
					}
				);
				expect(yield* result(x, 'read', { tasks: { search: '', after: 'c0' } })).toMatchObject({
					result: page
				});
				// no agent default limit and no dropped option: the request is lowered as the client's is
				const sent = JSON.stringify(reads);
				expect(sent).toContain('"limit":10000,"after":"c0"');
				const schema = JSON.stringify(toolSchema(yield* requiredTool(x, 'read')));
				for (const option of [
					'where',
					'fields',
					'orderBy',
					'limit',
					'after',
					'search',
					'aggregate',
					'asOf'
				])
					expect(schema).toContain(`"${option}"`);
			})
	);
	it.effect(
		'act takes one { callable, input } write: an { actions } list is refused and the error names callable',
		() =>
			Effect.gen(function* () {
				const writes: { key: string; input: Json }[] = [];
				const act: AgentEngine['act'] = (r) =>
					Effect.sync(() => {
						writes.push({ key: r.key, input: r.input });
						return {
							captured: [],
							v: 0,
							outcome: { kind: 'committed', output: null, records: [] }
						};
					});
				const x = yield* ctx({ inApp: false }, { act }),
					create = { callable: 'tasks.create', input: [{ title: 'a' }, { title: 'b' }] };
				const listed = yield* result(x, 'act', { actions: [create] });
				expect(JSON.stringify(listed)).toContain('Invalid parameters for tool');
				expect(JSON.stringify(listed)).toContain('callable');
				expect(JSON.stringify(listed)).not.toContain('anyOf');
				expect(writes).toEqual([]);
				const bare = yield* result(x, 'act', { input: [{ title: 'a' }] });
				expect(JSON.stringify(bare)).toContain('callable');
				// the rows reach the engine as one act under the call's key
				yield* result(x, 'act', create);
				expect(writes).toEqual([{ key: 'agent:t1:call', input: create.input }]);
			})
	);
	it.effect('an act that wrote nothing says so: the record already holds the supplied values', () =>
		Effect.gen(function* () {
			const act: AgentEngine['act'] = () =>
				Effect.succeed({
					captured: [],
					v: 0,
					outcome: {
						kind: 'committed',
						output: null,
						records: [],
						unchanged: [{ model: 'tasks', id: 't1' }]
					}
				});
			const x = yield* ctx({ inApp: false }, { act });
			expect(
				yield* result(x, 'act', { callable: 'tasks.create', input: [{ title: 'a' }] })
			).toMatchObject({
				result: {
					kind: 'committed',
					note: 'no change: tasks t1 already holds these values (a write callback may derive them)'
				}
			});
		})
	);
});
describe('approval decisions through act', () => {
	it.effect(
		'offered to staff when writes need approval; they decide as themselves, confirming first in the app',
		() =>
			Effect.gen(function* () {
				expect(
					yield* tool(yield* ctx({ authority: member({ external: true }) }), 'act')
				).toBeUndefined();
				const decided: Parameters<AgentEngine['approvals']['decide']>[0][] = [];
				const approvals: Partial<AgentEngine['approvals']> = {
					decide: (d) =>
						Effect.sync(() => {
							decided.push(d);
							return { kind: 'decided', requestId: d.requestId, status: 'Approved' };
						})
				};
				const input = {
					callable: 'approvals.decide',
					input: { requestId: 'r1', decision: 'approve', reason: 'ok' }
				};
				expect(
					yield* result(
						yield* ctx({ authority: member({ team: 'Leads' }) }, { approvals }),
						'act',
						input
					)
				).toEqual({ confirm: true });
				expect(
					yield* result(
						yield* ctx({ authority: member({ team: 'Leads' }), inApp: false }, { approvals }),
						'act',
						input
					)
				).toEqual({ result: { kind: 'decided', requestId: 'r1', status: 'Approved' } });
				expect(decided[0]).toMatchObject({
					requestId: 'r1',
					decision: 'approve',
					reason: 'ok',
					authority: { actor: { id: 'ann' } }
				});
			})
	);
});
describe('skill', () => {
	it.effect(
		'a large skill answers whole sections that fit and names the rest, never a clipped body',
		() =>
			Effect.gen(function* () {
				// each part a quarter of the result bound: the first ones fit, Part 5 never does
				const big = (n: number) =>
					`## Part ${n}\n${'word '.repeat(Math.ceil(BOUNDS.resultBytes / 20))}\n`;
				const text = `---\ndescription: How to author\n---\n${[1, 2, 3, 4, 5].map(big).join('')}`;
				const answer = yield* result(
					yield* ctx({ skills: { authoring: skillOf({ 'SKILL.md': text }) } }),
					'skill',
					{ name: 'authoring' }
				);
				const r = Schema.decodeUnknownSync(
					Schema.Struct({
						body: Schema.String,
						more: Schema.optionalKey(Schema.String),
						clipped: Schema.optionalKey(Schema.String)
					})
				)(Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(answer).result);
				expect(r.clipped).toBeUndefined();
				expect(r.body.startsWith('## Part 1')).toBe(true);
				expect(r.body).not.toContain('## Part 5');
				expect(r.more).toMatch(/^read each with section: .*Part 5$/);
				// the loop clips an answer the tool has not bounded itself
				expect(answer).toMatchObject({ bounded: true });
			})
	);
	it.effect('a reference stays readable by its path in the skill file list', () =>
		Effect.gen(function* () {
			const x = yield* ctx({
				skills: {
					authoring: skillOf({
						'SKILL.md': '---\ndescription: How to author\n---\n## Start\nRead the reference.\n',
						'references/repository-rebuild.md': '# Rebuild\nTrack every requirement.\n'
					})
				}
			});
			expect(
				yield* result(x, 'skill', { name: 'authoring', file: 'references/repository-rebuild.md' })
			).toMatchObject({
				result: {
					file: 'references/repository-rebuild.md',
					text: '# Rebuild\nTrack every requirement.\n'
				},
				bounded: true
			});
			expect(yield* result(x, 'skill', { name: 'authoring', file: 'missing.md' })).toMatchObject({
				result: { error: expect.stringContaining('No file') }
			});
		})
	);
});
describe('working-source tools', () => {
	const source: { [path: string]: string } = {
		'src/a.ts': 'x\nbolt.read(tasks)\nexport function total(a: number) {\nreturn a;\n}\n',
		'src/app/b.svelte': '<p>{bolt.READ}</p>'
	};
	const workspace: WorkspacePort = {
		files: async () => Object.keys(source),
		read: async (path) => source[path] ?? null
	};
	it.effect(
		'grep has a required pattern, regex/literal matching, a path scope and bounded results',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({ workspace, authority: member() });
				const search = yield* requiredTool(x, 'workspace_search');
				expect(toolSchema(search)).toMatchObject({ required: ['pattern'] });
				expect(Schema.is(search.parametersSchema)({})).toBe(false);
				expect(
					yield* result(x, 'workspace_search', { pattern: 'bolt\\.(read|READ)' })
				).toMatchObject({
					result: {
						hits: [
							{ path: 'src/a.ts', line: 2 },
							{ path: 'src/app/b.svelte', line: 1 }
						],
						truncated: false
					}
				});
				expect(
					yield* result(x, 'workspace_search', { pattern: 'bolt.read', literal: true })
				).toMatchObject({ result: { hits: [{ path: 'src/a.ts' }], truncated: false } });
				expect(
					yield* result(x, 'workspace_search', {
						pattern: 'BOLT.READ',
						literal: true,
						caseSensitive: false,
						path: 'src/app'
					})
				).toMatchObject({ result: { hits: [{ path: 'src/app/b.svelte' }] } });
				expect(yield* result(x, 'workspace_search', { pattern: '.', limit: 1 })).toMatchObject({
					result: { hits: [{ path: 'src/a.ts', line: 1 }], truncated: true }
				});
				expect(
					yield* result(x, 'workspace_search', { pattern: 'bolt.read', literal: true, path: '.' })
				).toMatchObject({ result: { hits: [{ path: 'src/a.ts' }], truncated: false } });
				expect(yield* result(x, 'workspace_search', { pattern: '[' })).toMatchObject({
					result: { error: expect.stringContaining('Invalid regular expression') }
				});
			})
	);
	it.effect('list is one string: the whole ASCII tree, noting each kind of file once', () =>
		Effect.gen(function* () {
			const files = [
				'README.md',
				'migrations/0001_initial.sql',
				'src/+workspace.ts',
				'src/automation/+a.automation.ts',
				'src/automation/+b.automation.ts',
				'src/data/model/orders/+model.ts',
				'src/data/model/orders/helpers.ts',
				'src/data/model/orders/lines/+model.ts',
				'src/lib/dates.ts'
			];
			const draft: WorkspacePort = { files: async () => files, read: async () => null };
			const x = yield* ctx({ workspace, draft, authority: member({ admin: true }) });
			expect(yield* result(x, 'workspace_list', {})).toMatchObject({
				result: [
					'/  <- cwd',
					'├── README.md',
					'├── migrations/  generated SQL history',
					'│   └── 0001_initial.sql',
					'└── src/  compiled source: + files are compiler roles, the rest ordinary modules',
					'    ├── +workspace.ts  zone, locale, connections',
					'    ├── automation/',
					'    │   ├── +a.automation.ts  job run with its own policies',
					'    │   └── +b.automation.ts',
					'    ├── data/',
					'    │   └── model/  one folder per model; a child model is a folder inside its owner',
					'    │       └── orders/',
					'    │           ├── +model.ts  fields, state, reads, writes',
					'    │           ├── helpers.ts',
					'    │           └── lines/',
					'    │               └── +model.ts',
					'    └── lib/',
					'        └── dates.ts'
				].join('\n'),
				bounded: true
			});
		})
	);
	it.effect(
		'read and list default to the current author tree without a draft flag; other staff read published source',
		() =>
			Effect.gen(function* () {
				let revision = 'first';
				const draft: WorkspacePort = {
					files: async () => ['src/current.ts'],
					read: async (path) => (path === 'src/current.ts' ? revision : null)
				};
				const x = yield* ctx({ workspace, draft, authority: member() });
				expect(yield* result(x, 'workspace_list', {})).toMatchObject({
					result: expect.stringContaining('current.ts')
				});
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts' })).toMatchObject({
					result: { lines: ['1: first'] }
				});
				// the same path spelling workspace_search accepts
				expect(yield* result(x, 'workspace_read', { path: './src/current.ts' })).toMatchObject({
					result: { path: 'src/current.ts', lines: ['1: first'] }
				});
				expect(yield* result(x, 'workspace_read', { path: '/src/current.ts' })).toMatchObject({
					result: { path: 'src/current.ts', lines: ['1: first'] }
				});
				revision = 'saved replacement';
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts' })).toMatchObject({
					result: { lines: ['1: saved replacement'] }
				});
				expect(
					yield* result(x, 'workspace_search', { pattern: 'saved replacement', literal: true })
				).toMatchObject({ result: { hits: [{ path: 'src/current.ts', line: 1 }] } });
				expect(
					yield* result(yield* ctx({ workspace, authority: member() }), 'workspace_read', {
						path: 'src/a.ts',
						from: 2,
						to: 2
					})
				).toMatchObject({ result: { lines: ['2: bolt.read(tasks)'] } });
				expect(yield* result(x, 'workspace_read', { path: '../elsewhere' })).toMatchObject({
					result: { error: expect.stringContaining('No such file') }
				});
				expect(
					yield* result(x, 'workspace_read', {
						path: 'node_modules/@norbital-ai/bolt/build/decl/runtime/agent.d.ts'
					})
				).toMatchObject({
					result: { error: expect.stringContaining('Installed packages are outside the workspace') }
				});
				expect(
					yield* tool(
						yield* ctx({ workspace, authority: member({ external: true }) }),
						'workspace_read'
					)
				).toBeUndefined();
			})
	);
});
describe('reading the source is every staff member’s; changing it is an administrator’s', () => {
	const source: { [path: string]: string } = {
		'src/data/model/tasks/+model.ts': "model('tasks', {})",
		'src/data/model/payroll/+model.ts': "model('payroll', {})",
		'src/access_control/team/+team.ts': 'export default {}'
	};
	const workspace: WorkspacePort = {
		files: async () => Object.keys(source),
		read: async (path) => source[path] ?? null
	};
	const host = (name: string, o: Partial<HostTool> = {}): HostTool => ({
		name,
		description: name,
		input: { type: 'object', properties: {} },
		call: async () => ({ ok: name }),
		...o
	});
	const hostTools = [
		host('workspace_lang', { readOnly: true, source: true }),
		host('workspace_write', { studio: 'preview' }),
		host('workspace_review', { readOnly: true, studio: 'logs' }),
		host('web_search', { readOnly: true })
	];
	it.effect(
		'a tool that starts a sandbox job reaches an administrator or a policy naming it, never anyone else',
		() =>
			Effect.gen(function* () {
				const offered = (authority: Authority) =>
					ctx({ workspace, hostTools: [host('reference')], authority }).pipe(Effect.flatMap(names));
				expect(yield* offered(member({ admin: true }))).toContain('reference');
				expect(yield* offered(member({ tools: ['reference'] }))).toContain('reference');
				expect(yield* offered(member())).not.toContain('reference');
				expect(yield* offered(member({ external: true, tools: ['reference'] }))).not.toContain(
					'reference'
				);
				const envoy: Authority = {
					...member({ admin: true, tools: ['reference'] }),
					actor: { kind: 'envoy', envoy: 'desk', instance: 'wa', sender: '+65', member: null }
				};
				expect(yield* offered(envoy)).not.toContain('reference');
			})
	);
	// a member whose policy reads tasks and nothing else
	const reader = compileAuthority(
		{
			...manifest,
			policies: { staff: { description: '', grants: { tasks: { read: true } } } }
		},
		{ actor: member().actor, policies: ['staff'], admin: false },
		'reader'
	);
	it.effect(
		'a member without admin reads the source of the models they read and the read-only source tools, never a mutating one',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({ workspace, hostTools, authority: reader });
				const offered = yield* names(x);
				expect(offered).toEqual(
					expect.arrayContaining(['workspace_search', 'workspace_list', 'workspace_lang'])
				);
				for (const mutating of ['workspace_write', 'workspace_review', 'web_search'])
					expect(offered).not.toContain(mutating);
				expect(yield* result(x, 'workspace_lang', {})).toMatchObject({
					result: { ok: 'workspace_lang' }
				});
				const listed = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(
					yield* result(x, 'workspace_list', {})
				).result;
				expect(listed).toContain('tasks/');
				expect(listed).not.toContain('payroll/');
				expect(
					yield* result(x, 'workspace_read', { path: 'src/data/model/payroll/+model.ts' })
				).toMatchObject({ result: { error: expect.stringContaining('No such file') } });
				expect(
					yield* result(x, 'workspace_search', { pattern: 'model(', literal: true })
				).toMatchObject({
					result: { hits: [{ path: 'src/data/model/tasks/+model.ts' }], truncated: false }
				});
				// an administrator holds every host tool and reads all of the source
				const admin = yield* ctx({ workspace, hostTools, authority: member({ admin: true }) });
				expect(yield* names(admin)).toEqual(
					expect.arrayContaining(['workspace_lang', 'workspace_write', 'workspace_review'])
				);
				expect(
					yield* result(admin, 'workspace_search', { pattern: 'model(', literal: true })
				).toMatchObject({
					result: {
						hits: [
							{ path: 'src/data/model/tasks/+model.ts' },
							{ path: 'src/data/model/payroll/+model.ts' }
						],
						truncated: false
					}
				});
				// a host tool that changes something is never a source tool, whatever it claims
				const claims = yield* ctx({
					workspace,
					hostTools: [host('workspace_merge', { source: true, studio: 'merge' })],
					authority: reader
				});
				expect(yield* names(claims)).not.toContain('workspace_merge');
			})
	);
	it.effect(
		'an administrator in no team reads the member directory, so a person a document names resolves',
		() =>
			Effect.gen(function* () {
				const holder = member({ admin: true }).actor;
				const admin = compileAuthority(manifest, { actor: holder, policies: [], admin: true }, 'a');
				const x = yield* ctx({ authority: admin });
				expect(workspaceSchema(manifest, admin)).toContain('sys_user');
				// other built-in models stay a grant's
				expect(workspaceSchema(manifest, admin)).not.toContain('sys_conversation');
				expect(yield* result(x, 'read', { sys_conversation: {} })).toEqual({
					result: { error: expect.stringContaining("You read no 'sys_conversation'") }
				});
			})
	);
});
describe('describe_workspace', () => {
	const lab: EngineManifest = {
		...manifest,
		workspace: { tz: 'Asia/Singapore', locale: 'en-SG', currency: 'SGD', apps: ['lab/trials'] },
		models: {
			trial: {
				description: 'a colour-matching attempt',
				label: 'code',
				fields: {
					code: { kind: 'text' },
					status: {
						kind: 'state',
						initial: 'draft',
						states: { draft: { to: ['approved'] }, approved: { edit: 'none' } }
					}
				}
			},
			trial_line: {
				description: 'one measured value',
				label: 'value',
				fields: { value: { kind: 'text' } }
			},
			secret: { description: 'hidden', label: 'x', fields: { x: { kind: 'text' } } }
		},
		relationships: { 'trial_line.trial': { to: 'trial', inverse: 'lines', owned: true } },
		exposures: {
			trial: {
				read: { trial: { fields: 'all' }, 'trial.lines': { fields: 'all' } },
				create: { columns: { trial: ['code'] } },
				effect: { created: true },
				notify: true,
				syncs: { import_csv: { with: 'file', parser: ['csv'] } }
			},
			secret: { read: { secret: { fields: 'all' } }, delete: {} }
		},
		policies: {
			matcher: {
				description: '',
				grants: { trial: { read: true, create: true } },
				automations: ['close_month'],
				capabilities: { apps: ['lab/trials'] }
			}
		},
		automations: {
			close_month: {
				description: 'closes the month',
				policies: ['matcher'],
				input: { month: { kind: 'date' } },
				on: { cron: '0 2 1 * *' },
				agent: 'confirm'
			},
			purge: { description: 'deletes everything', policies: ['matcher'] }
		},
		groups: { lab: { label: 'nav.lab', icon: 'lucide:flask', defaultChild: 'trials' } },
		apps: {
			'lab/trials': {
				title: 'app.trials.title',
				description: 'app.trials.description',
				icon: 'lucide:flask',
				pages: { list: { title: 'page.list' }, kiosk: { title: 'page.kiosk', portal: true } }
			}
		}
	};
	const messages = messageCatalogue(
		"export default messages({\n\t'app.trials.title': 'Trials',\n\t'app.trials.description': 'Colour matching',\n\t'nav.lab': 'Lab',\n\t'page.list': 'All trials'\n});"
	);
	const matcher = compileAuthority(
		lab,
		{ actor: member().actor, admin: false, policies: ['matcher'] },
		'm'
	);
	it('maps what the caller reaches, and nothing it cannot', () => {
		const map = describeWorkspace(lab, matcher, messages);
		expect(map).toContain('# Workspace tz Asia/Singapore · locale en-SG · currency SGD');
		expect(map).toContain('lab "Lab" ▸ lab/trials "Trials": Colour matching');
		expect(map).toContain('  ├ /app/lab/trials/list "All trials"');
		expect(map).toContain('  ├ /app/lab/trials/kiosk "page.kiosk" portal');
		expect(map).toContain('trial "a colour-matching attempt"');
		expect(map).toContain('  writes create');
		expect(map).toContain('  links lines (many trial_line)');
		expect(map).toContain('  state status: draft | approved');
		expect(map).toContain('  effects created');
		expect(map).toContain('  syncs import_csv (file)');
		expect(map).toContain(
			'close_month(month: date) "closes the month" · cron 0 2 1 * * · agent confirm'
		);
		expect(map).not.toContain('secret');
		expect(map).not.toContain('purge');
		// an administrator sees the model the matcher cannot
		const admin = compileAuthority(
			lab,
			{ actor: member({ admin: true }).actor, admin: true, policies: [] },
			'a'
		);
		expect(describeWorkspace(lab, admin, messages)).toContain('secret "hidden"');
	});
	it('gives an administrator the native write schema without granting a system data read', () => {
		const all = layered(lab);
		const admin = compileAuthority(
			all,
			{ actor: member({ admin: true }).actor, admin: true, policies: [] },
			'a'
		);
		const text = describeWorkspace(all, admin, messages, ['sys_envoy']);
		const shape = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					fields: Schema.Record(Schema.String, Schema.String),
					writes: Schema.Struct({
						'sys_envoy.create': Schema.Struct({
							columns: Schema.Record(Schema.String, Schema.Array(Schema.String))
						})
					})
				})
			)
		)(text.split('\n').at(-1) ?? '');
		expect(shape.fields['audience']).toContain('enum');
		expect(shape.writes['sys_envoy.create'].columns['sys_envoy']).toEqual(
			expect.arrayContaining(['name', 'policies', 'audience'])
		);
		expect(workspaceSchema(all, admin)).not.toContain('sys_envoy');
		expect(describeWorkspace(all, matcher, messages, ['sys_envoy'])).toBe(
			'Nothing named sys_envoy that you can reach.'
		);
	});
	it('stays within the cap, naming the rest for a call with names', () => {
		const many = Object.fromEntries(
			Array.from({ length: 400 }, (_, n) => [
				`model_${n}`,
				{
					description: `the ${n}th model of a large workspace`,
					label: 'x',
					fields: { x: { kind: 'text' as const } }
				}
			])
		);
		const big: EngineManifest = {
			...lab,
			models: { ...lab.models, ...many },
			exposures: {
				...lab.exposures,
				...Object.fromEntries(
					Object.keys(many).map((n) => [n, { read: { [n]: { fields: 'all' as const } } }])
				)
			}
		};
		const admin = compileAuthority(
			big,
			{ actor: member({ admin: true }).actor, admin: true, policies: [] },
			'a'
		);
		const map = describeWorkspace(big, admin, messages);
		expect(new TextEncoder().encode(map).byteLength).toBeLessThanOrEqual(OVERVIEW_BYTES);
		expect(map).toMatch(/Also \(describe_workspace \{ names \}\): .*model_\d+.* more/);
	});
	it.effect('names answer each item in full, through the tool', () =>
		Effect.gen(function* () {
			const x = yield* ctx({ authority: matcher, inApp: false }, { manifest: lab });
			expect(yield* result(x, 'describe_workspace', { names: ['trial'] })).toEqual({
				result: expect.stringContaining(
					[
						'trial "a colour-matching attempt"',
						'  reads default',
						'  writes create',
						'  links lines (many trial_line)',
						'  state status: draft | approved',
						'  effects created',
						'  syncs import_csv (file)',
						'  notices on its write and approval events'
					].join('\n')
				)
			});
			expect(yield* shape(x, 'trial')).toMatchObject({
				model: 'trial',
				layers: { 'trial.lines': 'trial_line' },
				writes: { 'trial.create': { columns: { trial: ['code'] } } }
			});
			expect(yield* shape(x, 'trial.lines')).toMatchObject({ model: 'trial_line' });
			expect(yield* result(x, 'describe_workspace', { names: ['secret'] })).toEqual({
				result: 'Nothing named secret that you can reach.'
			});
			expect(yield* result(x, 'describe_workspace', { names: ['close_month'] })).toEqual({
				result: 'close_month(month: date) "closes the month" · cron 0 2 1 * * · agent confirm'
			});
			expect(yield* result(x, 'describe_workspace', { names: ['lab/trials'] })).toEqual({
				result: expect.stringContaining('lab/trials "app.trials.title"')
			});
			// several names, each answered
			expect(yield* result(x, 'describe_workspace', { names: ['close_month', 'purge'] })).toEqual({
				result: expect.stringContaining('Nothing named purge that you can reach.')
			});
		})
	);
});
it.effect(
	'system discovery maps native setup targets and restricts them to an in-app administrator',
	() =>
		Effect.gen(function* () {
			const x = yield* ctx();
			expect(yield* result(x, 'describe_workspace', { names: ['system'] })).toMatchObject({
				result: {
					capabilities: expect.arrayContaining([
						{
							capability: 'api_key.create',
							path: '/settings/integrations',
							tab: 'keys',
							followUp: expect.any(String)
						}
					])
				}
			});
			expect(
				yield* result(x, 'page', {
					path: '/settings/integrations',
					configure: { capability: 'api_key.create' }
				})
			).toEqual({
				result: { navigation: '/settings/integrations?setup=api_key.create', requested: true }
			});
			expect(
				yield* result(x, 'page', {
					path: '/settings/secrets',
					configure: { capability: 'secret.set', record: 'UNKNOWN' }
				})
			).toMatchObject({ result: { error: expect.any(String) } });
			const ordinary = yield* ctx({ authority: member() });
			expect(yield* result(ordinary, 'describe_workspace', { names: ['system'] })).toEqual({
				result: { capabilities: [] }
			});
			expect(
				yield* result(ordinary, 'page', {
					path: '/',
					configure: { capability: 'api_key.create' }
				})
			).toMatchObject({ result: { error: expect.any(String) } });
		})
);

describe('read_file parses a file: filed in the outputs, read in windows', () => {
	const HTML = [
		'<h1>Cover</h1>',
		'<p>Tender for site works</p>',
		'<h2>Pricing</h2>',
		'<table>',
		'<tr><td>Lot</td><td>Rate</td></tr>',
		'<tr><td>7</td><td>12.50</td></tr>',
		'</table>',
		'<p><img src="image-1.png" alt="site plan"></p>',
		'<p>End</p>'
	].join('\n');
	const PNG = encodePng({
		width: 2,
		height: 1,
		channels: 4,
		depth: 8,
		data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255])
	});
	const tender: Ingested = {
		kind: 'document',
		html: HTML,
		images: [{ name: 'image-1.png', mime: 'image/png', bytes: PNG }],
		meta: { stats: { pages: 2, bytes: 100, cpuMs: 40, wallMs: 90 } }
	};
	/** A conversation `conversation` holding one uploaded file as its input; its context reads it. */
	const holding = (
		conversation: string,
		file: { name: string; mime: string; bytes: Uint8Array },
		over: Parameters<typeof ctx>[0] = {}
	) =>
		Effect.gen(function* () {
			const x = yield* ctx({
				attachments: { read: () => Effect.die('read through ingest') },
				...over
			});
			x.conv = { ...x.conv, id: conversation };
			const files = x.engine.files!;
			const blob = yield* files.put(file.bytes, file);
			const id = randomUUID();
			yield* x.engine.db.write({
				text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,'sys_conversation.inputs',now(),'ann')`,
				params: [id, file.name, file.mime, file.bytes.length, blob.key, blob.sha256]
			});
			yield* x.engine.db.write({
				text: `INSERT INTO sys_conversation (id, owner, inputs) VALUES ($1, 'ann', $2::jsonb)`,
				params: [conversation, JSON.stringify([{ id, name: file.name, mime: file.mime }])]
			});
			return { x, id };
		});
	const outputs = (x: ToolContext) =>
		Effect.map(
			x.engine.db.read([
				{ text: 'SELECT outputs FROM sys_conversation WHERE id = $1', params: [x.conv.id] }
			]),
			([r]) => r?.rows[0]?.['outputs']
		);
	it.effect(
		'a data ingest stores data.json and its images, no HTML; read_file answers its summary',
		() =>
			Effect.gen(function* () {
				const bytes = new TextEncoder().encode(`rates ${randomUUID()}`);
				const json = {
					sheets: [
						{
							name: 'Rates',
							columns: ['Item', 'Rate'],
							rows: [
								['Labour', 42.5],
								['Plant', 80]
							],
							images: [{ name: 'image-1.png', row: 0, col: 1 }]
						}
					]
				};
				const { x, id } = yield* holding(
					`c-${randomUUID()}`,
					{
						name: 'rates.xlsx',
						mime: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
						bytes
					},
					{
						ingest: () =>
							Effect.succeed({
								kind: 'data',
								json,
								images: [{ name: 'image-1.png', mime: 'image/png', bytes: PNG }],
								meta: { stats: { pages: null, bytes: 50, cpuMs: 2, wallMs: 3 } }
							})
					}
				);
				const answer = yield* result(x, 'read_file', { id });
				const listed = yield* outputs(x);
				const entry = Array.isArray(listed) ? listed[0] : undefined;
				const data =
					Predicate.isObject(entry) && Array.isArray(entry['files'])
						? entry['files'].find((f) => Predicate.isObject(f) && f['name'] === 'data.json')
						: undefined;
				const dataId = Predicate.isObject(data) ? String(data['id']) : '';
				expect(entry).toEqual({
					id: dataId,
					name: 'rates.xlsx (data)',
					mime: 'application/json',
					size: JSON.stringify(json).length,
					files: [
						expect.objectContaining({ name: 'images/image-1.png', mime: 'image/png' }),
						expect.objectContaining({ name: 'data.json', mime: 'application/json' })
					],
					ingest: expect.objectContaining({
						output: 'o1',
						source: id,
						status: 'ready',
						job: expect.any(String)
					})
				});
				const parsed = {
					output: 'o1',
					file: 'rates.xlsx (data)',
					data: [
						{
							name: 'Rates',
							columns: ['Item', 'Rate'],
							rows: 2,
							first: json.sheets[0]!.rows,
							images: [{ name: 'image-1.png', row: 0, col: 1 }]
						}
					],
					note: `compute from data.json, never retype: run_js { files: [{ id: '${dataId}' }] }; its images: read_file { id: o1, image: n }`
				};
				expect(answer).toEqual({
					result: {
						...parsed,
						about: [
							'  Rates (2 rows)',
							`  Compute from it with run_js, never retype: data.json ${dataId} — run_js { files: [{ id }] }`
						]
					}
				});
				// read_file collected the job: no steering line follows
				expect(x.jobs.take()).toEqual([]);
				expect(yield* result(x, 'read_file', { id: 'o1' })).toEqual({ result: parsed });
				expect(yield* result(x, 'read_file', { id: 'o1', text: 'Labour' })).toEqual({
					result: { error: expect.stringContaining('o1 is data, not lines: find it with run_js') }
				});
				expect(yield* result(x, 'read_file', { id: 'o1', image: 1 })).toMatchObject({
					result: { image: 'image-1.png' }
				});
				// a page image comes with its four overlapping quarters
				expect(x.files.map((f) => f.mime)).toEqual([
					'image/png',
					'image/jpeg',
					'image/jpeg',
					'image/jpeg',
					'image/jpeg'
				]);
				const crops = [[0, 0, 0.5, 1]];
				expect(yield* result(x, 'read_file', { id: 'o1', image: 1, crops })).toMatchObject({
					result: { image: 'image-1.png', crops: 1 }
				});
				expect(x.files).toHaveLength(6);
				expect(x.files[5]?.id).toContain('#crop:');
				// a lone image needs no number; a document takes three zoom calls a turn
				expect(yield* result(x, 'read_file', { id: 'o1', crops })).toMatchObject({
					result: { image: 'image-1.png', crops: 1 }
				});
				yield* result(x, 'read_file', { id: 'o1', crops });
				expect(yield* result(x, 'read_file', { id: 'o1', crops })).toEqual({
					result: { error: expect.stringContaining('o1 has had its 3 zooms this turn') }
				});
				expect(
					kitLogs
						.get(x)
						?.filter((r) => r.event === 'ingest.convert' && r.conversation === x.conv.id)
						.map((r) => r.attributes)
				).toEqual([
					expect.objectContaining({ kind: 'data', cached: false, bytes: 50, cpuMs: 2, wallMs: 3 })
				]);
			})
	);
	it.effect('crops name their image when an ingest holds several', () =>
		Effect.gen(function* () {
			const { x, id } = yield* holding(
				`c-${randomUUID()}`,
				{
					name: 'plans.pdf',
					mime: 'application/pdf',
					bytes: new TextEncoder().encode(`%PDF plans ${randomUUID()}`)
				},
				{
					ingest: () =>
						Effect.succeed({
							...tender,
							images: [
								{ name: 'image-1.png', mime: 'image/png', bytes: PNG },
								{ name: 'image-2.png', mime: 'image/png', bytes: PNG }
							]
						})
				}
			);
			yield* result(x, 'read_file', { id, from: 1, to: 1 });
			expect(yield* result(x, 'read_file', { id: 'o1', crops: [[0, 0, 1, 1]] })).toEqual({
				result: { error: 'o1 has 2 images: give image, the 1-based one to crop.' }
			});
		})
	);
	it.effect(
		'parses a document inside the inline wall and answers its window; the entry is grouped; windows read it',
		() =>
			Effect.gen(function* () {
				const bytes = new TextEncoder().encode(`%PDF tender ${randomUUID()}`);
				let calls = 0;
				const { x, id } = yield* holding(
					`c-${randomUUID()}`,
					{ name: 'tender.pdf', mime: 'application/pdf', bytes },
					{ ingest: () => Effect.sync(() => (calls++, tender)) }
				);
				// a window inside the table reads the table whole, and none of its images
				expect(yield* result(x, 'read_file', { id, from: 5, to: 5 })).toEqual({
					result: {
						id: 'o1',
						file: 'tender.pdf (ingested)',
						lines: [
							'4: <table>',
							'5: <tr><td>Lot</td><td>Rate</td></tr>',
							'6: <tr><td>7</td><td>12.50</td></tr>',
							'7: </table>'
						],
						at: 'lines 4–7 of 9 · read_file { id: o1, from: 8 }',
						about: ['  9 lines · 1 images · 1 tables', '  Map: L1–9 Cover (Pricing L3–9)']
					},
					bounded: true
				});
				expect(x.jobs.take()).toEqual([]);
				expect(calls).toBe(1);
				// one grouped entry: the HTML is its file; the index and images ride under it
				expect(yield* outputs(x)).toEqual([
					{
						id: expect.any(String),
						name: 'tender.pdf (ingested)',
						mime: 'text/html',
						size: HTML.length,
						files: [
							expect.objectContaining({ name: 'tender.html', mime: 'text/html' }),
							expect.objectContaining({ name: 'images/image-1.png', mime: 'image/png' }),
							expect.objectContaining({ name: 'index.json', mime: 'application/json' })
						],
						ingest: expect.objectContaining({
							output: 'o1',
							source: id,
							status: 'ready',
							job: expect.any(String),
							lines: 9
						})
					}
				]);
				expect(
					kitLogs
						.get(x)
						?.filter((r) => r.event === 'ingest.convert' && r.conversation === x.conv.id)
				).toEqual([
					expect.objectContaining({
						turn: 't1',
						attributes: expect.objectContaining({
							kind: 'document',
							cached: false,
							pages: 2,
							bytes: 100,
							cpuMs: 40,
							wallMs: 90
						})
					})
				]);
				expect(x.files).toEqual([]);
				expect(yield* result(x, 'read_file', { id: 'o1', from: 4, to: 7 })).toMatchObject({
					result: { note: expect.stringContaining('already above') }
				});
				expect(yield* result(x, 'read_file', { id, from: 8 })).toMatchObject({
					result: {
						lines: ['8: <p><img src="image-1.png" alt="site plan"></p>', '9: <p>End</p>'],
						images: ['image-1.png'],
						at: 'lines 8–9 of 9'
					}
				});
				expect(x.files.map((f) => f.mime)).toEqual([
					'image/png',
					'image/jpeg',
					'image/jpeg',
					'image/jpeg',
					'image/jpeg'
				]);
				expect(yield* result(x, 'read_file', { id: 'o1', text: '12.50' })).toMatchObject({
					result: {
						total: 1,
						hits: [{ from: 4, to: 7, text: '<tr><td>7</td><td>12.50</td></tr>' }]
					}
				});
				expect(yield* result(x, 'read_file', { id: 'o1', image: 1 })).toMatchObject({
					result: { image: 'image-1.png' }
				});
				// the same file again is the same output
				expect(yield* result(x, 'read_file', { id })).toMatchObject({ result: { id: 'o1' } });
				expect(calls).toBe(1);
			})
	);
	it.live('past the inline wall the parse is a job, and its end steers the next step once', () =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const { x, id } = yield* holding(
				`c-${randomUUID()}`,
				{
					name: 'tender.pdf',
					mime: 'application/pdf',
					bytes: new TextEncoder().encode(`%PDF tender ${randomUUID()}`)
				},
				{ inlineMs: 1, ingest: () => Effect.as(Deferred.await(gate), tender) }
			);
			expect(yield* result(x, 'read_file', { id })).toEqual({
				result: { reading: 'tender.pdf', note: 'it arrives at your next step' }
			});
			const j = first(x.jobs.pending()).job;
			yield* Deferred.succeed(gate, undefined);
			expect(yield* x.jobs.settled(10_000)).toBe(true);
			expect(x.jobs.take()).toEqual([
				[
					`[job ${j} done] ingest of tender.pdf: read_file { id: o1 } "tender.pdf (ingested)"`,
					'  9 lines · 1 images · 1 tables',
					'  Map: L1–9 Cover (Pricing L3–9)'
				].join('\n')
			]);
			expect(x.jobs.take()).toEqual([]);
		})
	);
	it.effect(
		'a cache hit in another conversation converts nothing and still files its own output',
		() =>
			Effect.gen(function* () {
				const bytes = new TextEncoder().encode(`%PDF shared ${randomUUID()}`);
				let calls = 0;
				const port = { ingest: () => Effect.sync(() => (calls++, tender)) };
				const first = yield* holding(
					`c-${randomUUID()}`,
					{ name: 'a.pdf', mime: 'application/pdf', bytes },
					port
				);
				yield* result(first.x, 'read_file', { id: first.id });
				const other = yield* holding(
					`c-${randomUUID()}`,
					{ name: 'b.pdf', mime: 'application/pdf', bytes },
					port
				);
				const answer = yield* result(other.x, 'read_file', { id: other.id, from: 1, to: 2 });
				expect(calls).toBe(1);
				expect(
					kitLogs
						.get(other.x)
						?.filter((r) => r.event === 'ingest.convert' && r.conversation === other.x.conv.id)
						.map((r) => r.attributes)
				).toEqual([expect.objectContaining({ cached: true })]);
				expect(answer).toMatchObject({
					result: { id: 'o1', lines: ['1: <h1>Cover</h1>', '2: <p>Tender for site works</p>'] }
				});
			})
	);
	it.live('a failed job says so once; reading it while it runs says it is still ingesting', () =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			const { x, id } = yield* holding(
				`c-${randomUUID()}`,
				{ name: 'bad.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode(randomUUID()) },
				{
					inlineMs: 1,
					ingest: () =>
						Deferred.await(gate).pipe(
							Effect.andThen(
								Effect.fail(
									new FacilityFailure({ kind: 'upstream', message: 'the PDF is encrypted' })
								)
							)
						)
				}
			);
			expect(yield* result(x, 'read_file', { id })).toEqual({
				result: { reading: 'bad.pdf', note: 'it arrives at your next step' }
			});
			const j = first(x.jobs.pending()).job;
			expect(yield* result(x, 'read_file', { id: 'o1' })).toEqual({
				result: { note: `still ingesting: ${j}` }
			});
			yield* Deferred.succeed(gate, undefined);
			yield* x.jobs.settled(10_000);
			expect(x.jobs.take()).toEqual([
				`[job ${j} failed] reading bad.pdf: the PDF is encrypted; tell the person`
			]);
		})
	);
	it.effect('a failed parse answers why, inline and when its output is read again', () =>
		Effect.gen(function* () {
			const { x, id } = yield* holding(
				`c-${randomUUID()}`,
				{ name: 'bad.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode(randomUUID()) },
				{
					ingest: () =>
						Effect.fail(new FacilityFailure({ kind: 'upstream', message: 'the PDF is encrypted' }))
				}
			);
			expect(yield* result(x, 'read_file', { id })).toMatchObject({
				result: { error: expect.stringContaining('the PDF is encrypted') }
			});
			expect(yield* result(x, 'read_file', { id: 'o1' })).toMatchObject({
				result: { error: expect.stringContaining('the PDF is encrypted') }
			});
		})
	);
	it.effect(
		"audio is Convert's speaker sections, its transcript derived, its model calls an ai.call observation",
		() =>
			Effect.gen(function* () {
				const html = [
					'<section data-speaker="S1" data-start="1" data-end="3"><time>00:00:01</time> Pour on Friday?</section>',
					'<section data-speaker="S2" data-start="4" data-end="65"><time>00:00:04</time> Agreed.</section>'
				].join('\n');
				const { x, id } = yield* holding(
					`c-${randomUUID()}`,
					{
						name: 'site-meeting.m4a',
						mime: 'audio/mp4',
						bytes: new TextEncoder().encode(randomUUID())
					},
					{
						ingest: () =>
							Effect.succeed({
								kind: 'document',
								html,
								images: [],
								meta: {
									usage: {
										calls: ['gen-1'],
										model: 'gemini-x',
										input: 900,
										output: 40,
										cost: 0.002
									},
									stats: { pages: null, bytes: 36, cpuMs: 0, wallMs: 900 }
								}
							})
					}
				);
				expect(yield* result(x, 'read_file', { id })).toMatchObject({
					result: {
						file: 'site-meeting.m4a (transcript)',
						lines: html.split('\n').map((l, i) => `${i + 1}: ${l}`),
						about: [
							'  00:01:05 · 2 speakers · 2 lines',
							'  Map: L1–1 S1 00:00:01 · L2–2 S2 00:00:04',
							expect.stringMatching(/^ {2}Typed JSON for run_js .*: transcript\.json \S+ — run_js/)
						]
					}
				});
				const listed = yield* outputs(x);
				const entry = Array.isArray(listed) ? listed[0] : undefined;
				const stored =
					Predicate.isObject(entry) && Array.isArray(entry['files'])
						? entry['files'].find((f) => Predicate.isObject(f) && f['name'] === 'transcript.json')
						: undefined;
				const [read] = yield* x.engine.db.read([
					{
						text: 'SELECT key, size FROM sys_file WHERE id = $1',
						params: [Predicate.isObject(stored) ? String(stored['id']) : '']
					}
				]);
				const key = read?.rows[0]?.['key'],
					size = read?.rows[0]?.['size'];
				if (typeof key !== 'string' || typeof size !== 'number')
					throw new Error('no transcript.json');
				expect(JSON.parse(new TextDecoder().decode(yield* x.engine.files!.get(key, size)))).toEqual(
					{
						durationMs: 65_000,
						speakers: ['S1', 'S2'],
						segments: [
							{ speaker: 'S1', start: 1, end: 3, text: 'Pour on Friday?' },
							{ speaker: 'S2', start: 4, end: 65, text: 'Agreed.' }
						]
					}
				);
				expect(
					kitLogs.get(x)?.find((r) => r.event === 'ai.call' && r.conversation === x.conv.id)
				).toMatchObject({
					turn: 't1',
					attributes: {
						calls: ['gen-1'],
						model: 'gemini-x',
						cost: 0.002,
						facility: 'convert.ingest',
						settlement: 'pending'
					}
				});
			})
	);
	it.effect('no parser, and no converter, are immediate answers', () =>
		Effect.gen(function* () {
			const video = yield* holding(`c-${randomUUID()}`, {
				name: 'site.mp4',
				mime: 'video/mp4',
				bytes: new Uint8Array([1])
			});
			expect(yield* result(video.x, 'read_file', { id: video.id, from: 1 })).toEqual({
				result: {
					error: expect.stringContaining('no parser: build a tool for it with your workspace tools')
				}
			});
			const pdf = yield* holding(`c-${randomUUID()}`, {
				name: 'a.pdf',
				mime: 'application/pdf',
				bytes: new Uint8Array([2])
			});
			expect(yield* result(pdf.x, 'read_file', { id: pdf.id })).toEqual({
				result: { error: 'This host cannot parse files.' }
			});
			expect(yield* result(pdf.x, 'read_file', { id: pdf.id, from: 1 })).toEqual({
				result: { error: 'This host cannot parse files.' }
			});
		})
	);
	it.effect('a file with no parser says so when read whole, never that read_file parses it', () =>
		Effect.gen(function* () {
			const video = yield* holding(`c-${randomUUID()}`, {
				name: 'site.mp4',
				mime: 'video/mp4',
				bytes: new Uint8Array([1])
			});
			const { db, files, images } = video.x.engine;
			if (files === undefined || images === undefined) throw new Error('the kit stores files');
			video.x.attachments = fileAttachments(db, files, images);
			expect(yield* result(video.x, 'read_file', { id: video.id })).toEqual({
				result: {
					error: expect.stringContaining('no parser: build a tool for it with your workspace tools')
				}
			});
		})
	);
});
describe('act starts automations', () => {
	it.effect("act starts an automation or the model's named file and remote syncs", () =>
		Effect.gen(function* () {
			const started: Parameters<AgentEngine['calls']['start']>[0][] = [];
			const m: EngineManifest = {
				...manifest,
				policies: {},
				exposures: {
					tasks: {
						read: { tasks: { fields: 'all' } },
						syncs: { sheet: { with: 'file', parser: ['json'], schema: { a: { kind: 'int' } } } }
					}
				},
				automations: {
					tidy: {
						description: '',
						policies: ['staff'],
						input: { day: { kind: 'date', optional: true } }
					}
				}
			};
			const calls: Partial<AgentEngine['calls']> = {
				start: (s) =>
					Effect.sync(() => {
						started.push(s);
						return { kind: 'committed', output: { kind: 'queued' }, records: [] };
					})
			};
			let active: string | null = null;
			const db: Partial<RawDb> = {
				read: () =>
					Effect.sync(() => [{ rows: active === null ? [] : [{ id: active }], affected: 0 }])
			};
			const authority = { ...member({ admin: true }), automations: ['tidy'] };
			const x = yield* ctx({ authority, inApp: false }, { manifest: m, calls, db });
			// act's text is static: the caller's automations are describe_workspace's and a wrong name's error
			expect((yield* requiredTool(x, 'act')).description).not.toContain('tidy');
			expect(describeWorkspace(m, authority, new Map())).toContain('tidy(day?: date)');
			expect(
				yield* result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })
			).toMatchObject({ result: { outcome: { output: { kind: 'queued' } } } });
			expect(started[0]).toMatchObject({
				automation: 'tidy',
				runs: [{ input: { day: '2026-09-01' } }]
			});
			expect(yield* result(x, 'act', { callable: 'automation.purge' })).toEqual({
				result: {
					error: "You may not run 'automation.purge'. Yours: automation.tidy, tasks.sync.sheet"
				}
			});
			expect((yield* requiredTool(x, 'act')).description).toContain('"<model>.sync.<sync>"');
			expect(
				yield* result(x, 'act', {
					callable: 'automation.tasks.sync.sheet',
					input: { mode: 'import' }
				})
			).toEqual({
				result: {
					error:
						"You may not run 'automation.tasks.sync.sheet'. Yours: automation.tidy, tasks.sync.sheet"
				}
			});
			yield* result(x, 'act', {
				callable: 'tasks.sync.sheet',
				input: { mode: 'import', file: 'f1' }
			});
			expect(started[1]).toMatchObject({
				automation: 'tasks.sync.sheet',
				runs: [{ input: { mode: 'import', file: 'f1' } }]
			});
			yield* result(x, 'act', {
				callable: 'tasks.sync.sheet',
				input: { mode: 'export', to: 'json' }
			});
			expect(started[2]).toMatchObject({ runs: [{ input: { mode: 'export', to: 'json' } }] });
			started.pop();
			const big = { mode: 'import', file: 'uploaded-sheet', context: { company: 'demo' } };
			const withFiles = yield* ctx(
				{ authority, inApp: false },
				{
					manifest: m,
					calls,
					db: {
						read: (statements) =>
							Effect.sync(() => {
								const statement = first(statements);
								return [
									{
										rows:
											statement.params[1] === 'ann' && statement.params[0] === 'f-json'
												? [{ key: 'k1', size: 20 }]
												: [],
										affected: 0
									}
								];
							})
					},
					files: { get: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(big))) }
				}
			);
			yield* result(withFiles, 'act', { callable: 'tasks.sync.sheet', inputFile: 'f-json' });
			expect(started[2]).toMatchObject({
				automation: 'tasks.sync.sheet',
				runs: [{ input: big }]
			});
			started.pop();
			expect(
				yield* result(withFiles, 'act', {
					callable: 'tasks.sync.sheet',
					inputFile: 'someone-else'
				})
			).toMatchObject({
				result: { error: expect.stringContaining('No file someone-else of yours') }
			});
			const synced = yield* ctx(
				{ authority: { ...member(), automations: ['tidy', 'tasks.sync.erp'] }, inApp: false },
				{
					manifest: {
						...m,
						exposures: {
							tasks: {
								...m.exposures['tasks'],
								read: { tasks: { fields: 'all' } },
								syncs: { erp: { with: 'erp', read: true, every: '1min' } }
							}
						},
						integrations: {
							erp: {
								description: 'An ERP',
								driver: 'http',
								http: { baseUrl: 'https://erp.example' }
							}
						}
					},
					calls,
					db
				}
			);
			expect((yield* requiredTool(synced, 'act')).description).not.toContain('tasks.sync.erp');
			yield* result(synced, 'act', { callable: 'tasks.sync.erp', input: {} });
			expect(started.at(-1)).toMatchObject({
				automation: 'tasks.sync.erp',
				runs: [{ input: {} }]
			});
			started.pop();
			expect(
				yield* result(synced, 'act', { callable: 'automation.tasks.sync.erp', input: {} })
			).toEqual({
				result: {
					error:
						"You may not run 'automation.tasks.sync.erp'. Yours: automation.tidy, tasks.sync.erp"
				}
			});
			active = 'run-1';
			expect(
				yield* result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })
				// the active run is still the one whose end the agent hears: a job
			).toEqual({
				result: {
					job: expect.any(String),
					run: 'run-1',
					alreadyActive: true,
					note: expect.any(String)
				}
			});
			expect(started).toHaveLength(2);
		})
	);
});
describe('wait', () => {
	it.effect(
		'follows an automation run act started until it ends, and says when there is no such run',
		() =>
			Effect.gen(function* () {
				let state = 'running';
				const read = yield* Deferred.make<void>();
				const db: Partial<RawDb> = {
					read: (statements) =>
						Effect.gen(function* () {
							const parameter = first(statements).params[0];
							if (typeof parameter !== 'string')
								return yield* Effect.fail(
									new DbError({ message: 'malformed array literal', sqlstate: '22P02' })
								);
							const ids = yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(Schema.Array(Schema.String))
							)(parameter).pipe(
								Effect.mapError(
									(error) => new DbError({ message: error.message, sqlstate: '22P02' })
								)
							);
							yield* Deferred.succeed(read, undefined);
							return [
								{
									affected: 0,
									rows: ids.includes('run-1')
										? [
												{
													id: 'run-1',
													automation: 'tidy',
													cause: 'start',
													state,
													due_at: 'd',
													started: 's',
													progress: null,
													output: state === 'succeeded' ? { ok: true } : null,
													error: null,
													attempts: 1,
													results: [],
													input: {},
													actor: null,
													starter: null,
													trigger: null,
													trigger_name: null
												}
											]
										: []
								}
							];
						})
				};
				const x = yield* ctx({}, { db });
				const waiting = yield* Effect.forkChild(
					result(x, 'wait', { jobs: ['run-1'], seconds: 10 })
				);
				yield* Deferred.await(read);
				state = 'succeeded';
				yield* TestClock.adjust('3 seconds');
				expect(yield* Fiber.join(waiting)).toMatchObject({
					result: { settled: { id: 'run-1', status: 'succeeded', result: { ok: true } } }
				});
				expect(yield* result(x, 'wait', { jobs: ['nope'] })).toEqual({
					result: { error: 'No job or automation run nope.' }
				});
			})
	);
	it.effect('says there is nothing to wait for instead of answering as if the time passed', () =>
		Effect.gen(function* () {
			const x = yield* ctx(),
				started = yield* Clock.currentTimeMillis;
			expect(yield* result(x, 'wait', { seconds: 30 })).toMatchObject({
				result: {
					settled: null,
					pending: [],
					waited: 0,
					note: expect.stringContaining('pass its run id')
				}
			});
			expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
		})
	);
});
describe('document', () => {
	it.effect('converts the markdown it is given and stores the file for the person', () =>
		Effect.gen(function* () {
			const asked: string[] = [];
			const x = yield* ctx(
				{},
				{
					convert: {
						targets: ['pdf', 'pptx'],
						convert: (source, to) =>
							Effect.sync(() => {
								asked.push(`${to}:${'markdown' in source ? source.markdown : ''}`);
								return new Uint8Array([37, 80, 68, 70]);
							})
					}
				}
			);
			expect(
				yield* result(x, 'document', { to: 'pdf', name: 'Report.pdf', markdown: '# Hi' })
			).toMatchObject({
				result: { files: [{ name: 'Report.pdf', mime: 'application/pdf', size: 4 }] }
			});
			expect(asked).toEqual(['pdf:# Hi']);
			expect(
				yield* result(x, 'document', { to: 'pdf', name: 'x.pdf', markdown: ' ' })
			).toMatchObject({
				result: { error: expect.stringContaining('markdown') }
			});
		})
	);
});
describe('download', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	it.effect("keeps a media URL as the person's output file, with the host's key and sha256", () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			kitOrigins.get(x)?.set('https://law.example/seal.png?v=2', png);
			const answer = yield* result(x, 'download', { url: 'https://law.example/seal.png?v=2' });
			expect(answer).toMatchObject({
				result: {
					saved: 'seal.png',
					mime: 'image/png',
					bytes: png.byteLength,
					file: { name: 'seal.png', mime: 'image/png', size: png.byteLength }
				}
			});
			const file = Schema.decodeUnknownSync(
				Schema.Struct({ result: Schema.Struct({ file: Schema.Struct({ id: Schema.String }) }) })
			)(answer).result.file;
			const row = first(
				yield* x.engine.db.rows(
					Schema.Struct({ key: Schema.String, sha256: Schema.String, field: Schema.String }),
					{ text: 'SELECT key, sha256, field FROM sys_file WHERE id = $1', params: [file.id] }
				)
			);
			expect(row).toMatchObject({
				sha256: createHash('sha256').update(png).digest('hex'),
				field: 'sys_conversation.outputs'
			});
			// the row names the blob the host stored: the engine never held the bytes
			const files = x.engine.files;
			if (files === undefined) throw new Error('the kit stores files');
			expect([...(yield* files.get(row.key, 100))]).toEqual([...png]);
		})
	);
	it.effect("answers the host's refusal as the tool's error, and stores nothing", () =>
		Effect.gen(function* () {
			const x = yield* ctx(),
				stored = () =>
					x.engine.db.rows(Schema.Struct({ id: Schema.String }), {
						text: 'SELECT id FROM sys_file',
						params: []
					});
			const before = yield* stored();
			kitOrigins.get(x)?.set('https://law.example/index.ts', new TextEncoder().encode('export {}'));
			expect(yield* result(x, 'download', { url: 'https://law.example/index.ts' })).toEqual({
				result: { error: expect.stringContaining('not media') }
			});
			expect(yield* result(x, 'download', { url: 'https://law.example/gone.png' })).toEqual({
				result: { error: 'The URL answered 404.' }
			});
			expect(yield* stored()).toEqual(before);
		})
	);
	it.effect('is offered only to a person in the app', () =>
		Effect.gen(function* () {
			expect(yield* names(yield* ctx())).toContain('download');
			expect(yield* names(yield* ctx({ inApp: false }))).not.toContain('download');
			expect(
				yield* names(
					yield* ctx({
						authority: {
							...member({ admin: true }),
							actor: { kind: 'system', run: 'r1', by: { automation: 'drift' } }
						}
					})
				)
			).not.toContain('download');
		})
	);
	it.effect("a turn with a browser downloads through it, with its sign-ins", () =>
		Effect.gen(function* () {
			const hostTools = browserTools(yield* Browser);
			expect(yield* names(yield* ctx({ hostTools }))).not.toContain('download');
		}).pipe(Effect.provide(Browser.fromAbi(off)))
	);
});
describe('run_js', () => {
	const rows = Array.from({ length: 3 }, (_, i) => ({
		sku: `s${i}`,
		qty: i % 7,
		price: i * 1.5
	}));
	const run = (x: ToolContext, input: Json) => result(x, 'run_js', input);
	/** A local test origin: the engine's `Http`, answering one API path and recording every request. */
	const origin = () => {
		const asked: (readonly [HttpRequest, HttpFetchOptions])[] = [];
		const stock: HttpResponse = {
			status: 200,
			headers: [['content-type', 'application/json']],
			body: new TextEncoder().encode(JSON.stringify(rows))
		};
		const http: Http['Service'] = {
			fetch: (request, options) =>
				Effect.sync(() => {
					asked.push([request, options]);
					return stock;
				})
		};
		return { asked, http };
	};
	it.live('calls an API through the engine over http: no redirects, at most 4 MiB', () =>
		Effect.gen(function* () {
			const { asked, http } = origin();
			const x = yield* ctx({}, { http });
			expect(
				yield* run(x, {
					http: true,
					code:
						"const r = await http({ url: 'https://api.test/stock', headers: { accept: 'application/json' } });\n" +
						'const rows = JSON.parse(r.text);\n' +
						"return { status: r.status, type: r.headers['content-type'], lines: rows.length, value: rows.reduce((a, x) => a + x.qty * x.price, 0) };"
				})
			).toEqual({
				result: {
					answer: {
						status: 200,
						type: 'application/json',
						lines: 3,
						value: rows.reduce((a, r) => a + r.qty * r.price, 0)
					}
				}
			});
			expect(asked).toEqual([
				[
					{
						method: 'GET',
						url: 'https://api.test/stock',
						headers: [['accept', 'application/json']]
					},
					{ redirects: 0, maxBytes: 4 * 1024 * 1024 }
				]
			]);
		})
	);
	it.live('transforms its input rows, its console lines beside the answer', () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			const totals: Record<string, number> = {};
			for (const r of rows) totals[r.qty] = (totals[r.qty] ?? 0) + r.price;
			expect(
				yield* run(x, {
					input: rows,
					code:
						'const by = {};\n' +
						'for (const r of input) by[r.qty] = (by[r.qty] ?? 0) + r.price;\n' +
						"console.log(input.length, 'rows');\n" +
						'return by;'
				})
			).toEqual({ result: { answer: totals, console: ['3 rows'] } });
		})
	);
	it.live("keeps a returned CSV and PNG as the person's outputs and refuses an ELF", () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
			const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]);
			const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
			const answer = yield* run(x, {
				input: [
					{ name: 'totals.csv', text: 'sku,qty\ns1,2\n' },
					{ name: 'dot.png', base64: base64(png) },
					{ name: 'tool', base64: base64(elf) }
				],
				code: "return { note: 'done', files: input };"
			});
			expect(answer).toEqual({
				result: {
					answer: {
						note: 'done',
						files: [
							{ id: expect.any(String), name: 'totals.csv', mime: 'text/csv', size: 13 },
							{ id: expect.any(String), name: 'dot.png', mime: 'image/png', size: png.byteLength }
						]
					},
					refused: [{ name: 'tool', reason: 'an executable' }]
				}
			});
			expect(
				yield* x.engine.db.rows(
					Schema.Struct({ name: Schema.String, mime: Schema.String, field: Schema.String }),
					{
						text: `SELECT name, mime, field FROM sys_file WHERE name IN ('totals.csv', 'dot.png', 'tool') ORDER BY name`,
						params: []
					}
				)
			).toEqual([
				{ name: 'dot.png', mime: 'image/png', field: 'sys_conversation.outputs' },
				{ name: 'totals.csv', mime: 'text/csv', field: 'sys_conversation.outputs' }
			]);
		})
	);
	it.live('has no require, process, fetch, delayed timers or http', () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			expect(
				yield* run(x, {
					code:
						'let delayed;\n' +
						"try { setTimeout(() => {}, 10); delayed = 'ran'; } catch (e) { delayed = e.message; }\n" +
						'return { require: typeof require, process: typeof process, fetch: typeof fetch, setInterval: typeof setInterval, http: typeof http, delayed };'
				})
			).toEqual({
				result: {
					answer: {
						require: 'undefined',
						process: 'undefined',
						fetch: 'undefined',
						setInterval: 'undefined',
						http: 'undefined',
						delayed: expect.stringContaining('no clock')
					}
				}
			});
		})
	);
	it.live("an answer's own `files` data is data; only the person's file shape is kept", () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			expect(
				yield* run(x, { code: "return { title: 'x', files: [{ name: 'a.mp4', size: '5' }] };" })
			).toEqual({ result: { answer: { title: 'x', files: [{ name: 'a.mp4', size: '5' }] } } });
		})
	);
	it.live("reports a throw and a syntax error at the script's line", () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			expect(yield* run(x, { code: "const a = 1;\nthrow new Error('boom ' + a);" })).toEqual({
				result: { error: 'Error: boom 1 (line 2:7)' }
			});
			expect(yield* run(x, { code: 'const x = ;' })).toEqual({
				result: { error: "SyntaxError: Unexpected token ';' (line 1:11)" }
			});
		})
	);
	it.live('has http only when asked for and granted', () =>
		Effect.gen(function* () {
			const { asked, http } = origin();
			const x = yield* ctx({ authority: member() }, { http });
			expect(yield* run(x, { http: true, code: 'return 1;' })).toEqual({
				result: { error: expect.stringContaining('do not grant') }
			});
			// the bridge itself answers no http to a script that reaches past the missing global
			expect(
				yield* run(x, {
					code:
						"try { await globalThis[Symbol.for('norbital.bolt.call')]('http', [{ url: 'https://api.test/stock' }]); return 'reached'; }\n" +
						'catch (e) { return e.message; }'
				})
			).toEqual({ result: { answer: 'this run has no http' } });
			expect(asked).toEqual([]);
			const granted = yield* ctx({ authority: member({ tools: ['http'] }) }, { http });
			expect(yield* run(granted, { code: 'return typeof http;' })).toEqual({
				result: { answer: 'undefined' }
			});
			expect(yield* run(granted, { http: true, code: 'return typeof http;' })).toEqual({
				result: { answer: 'function' }
			});
		})
	);
});
describe('run_js over a repository reference', () => {
	const COMMIT = '446c7ac5b0b7d74ae03e546ef2ab3f3a0844f04b',
		NAME = `calc@${COMMIT.slice(0, 12)}`;
	const tree = filesOf({
		'src/main.js':
			"const { add } = require('./lib/add');\nconsole.log(JSON.stringify({ sum: add(2, 3), fetch: typeof fetch }));\n",
		'src/lib/add.js': 'module.exports.add = (a, b) => a + b;\n'
	});
	it.live("runs a reference's file from its index's tree: no fetch, http refused", () =>
		Effect.gen(function* () {
			const asked: HttpRequest[] = [];
			const http: Http['Service'] = {
				fetch: (request) =>
					Effect.sync(() => {
						asked.push(request);
						return { status: 200, headers: [], body: new Uint8Array() };
					})
			};
			// the host's reference tool as Colony's keeps one: each file by its address, the index as the person's file
			let store: Files['Service'] | undefined;
			const reference: HostTool = {
				name: 'reference',
				description: 'a repository reference',
				input: { type: 'object', properties: {} },
				call: (_input, context) =>
					Effect.runPromise(
						Effect.gen(function* () {
							yield* Effect.sleep('20 millis');
							const files = store;
							if (files === undefined) return yield* Effect.die(new Error('no files'));
							const listed = yield* Effect.forEach(tree, ([path, bytes]) =>
								Effect.map(files.put(bytes, { name: path, mime: 'text/plain' }), (blob) => ({
									path,
									key: blob.key,
									bytes: blob.bytes
								}))
							);
							const index = {
								repository: 'https://github.com/acme/calc',
								commit: COMMIT,
								digest: treeDigest(tree),
								files: listed
							};
							const blob = yield* files.put(new TextEncoder().encode(JSON.stringify(index)), {
								name: NAME,
								mime: REFERENCE.mime
							});
							context.keep?.({ ...blob, name: NAME });
							return { reference: NAME };
						})
					)
			};
			// the bundler stands in: what it is handed is the reference's tree, at the asked entry
			const bundled: { entry: string; paths: string[] }[] = [];
			const service: Bundler['Service'] = {
				bundle: (request) =>
					Effect.sync(() => {
						bundled.push({ entry: request.entry, paths: request.files.map(([path]) => path) });
						return { errors: [] };
					})
			};
			const x = yield* ctx({ hostTools: [reference], inlineMs: 1 }, { bundler: service, http });
			store = x.engine.files;
			yield* result(x, 'reference', {});
			// past the inline wall the file is still recorded, and `wait` hands it over
			expect(yield* result(x, 'wait', { jobs: [first(x.jobs.pending()).job] })).toMatchObject({
				result: {
					settled: { result: { reference: NAME, files: [{ name: NAME, mime: REFERENCE.mime }] } }
				}
			});
			const listing = (input: Json) => result(x, 'read_file', input);
			expect(yield* listing({ id: `${NAME}/src/lib` })).toMatchObject({
				result: expect.stringContaining('src/lib/add.js')
			});
			expect(yield* listing({ id: `${NAME}/src/lib/`, text: 'a + b' })).toMatchObject({
				result: 'src/lib/add.js:1: module.exports.add = (a, b) => a + b;'
			});
			expect(yield* listing({ id: `${NAME}/tests` })).toEqual({
				result: { error: `${NAME} has no file 'tests'.` }
			});
			const run = (input: Json) => result(x, 'run_js', input);
			yield* run({ file: `${NAME}/src/main.js` });
			expect(bundled).toEqual([{ entry: 'src/main.js', paths: tree.map(([path]) => path) }]);
			expect(yield* run({ file: `${NAME}/src/main.js`, http: true })).toEqual({
				result: {
					error: "A repository reference's file runs without fetch: run it without http."
				}
			});
			expect(yield* run({ file: `${NAME}/src/none.js` })).toEqual({
				result: { error: `The reference ${NAME} has no text file 'src/none.js'.` }
			});
			expect(yield* run({ file: 'other@0123456789ab/src/main.js' })).toEqual({
				result: {
					error:
						"No repository reference 'other@0123456789ab' is yours: bring it in with reference first."
				}
			});
			expect(asked).toEqual([]);
		})
	);
});
describe('a sub-agent', () => {
	it.effect('keeps its checklist but has no plan or sub-agents of its own: one level deep', () =>
		Effect.gen(function* () {
			// update_plan is a plan-mode tool, subagent an agent-mode one; goals is in both
			expect(yield* names(yield* ctx({ mode: 'plan' }))).toEqual(
				expect.arrayContaining(['update_plan', 'goals'])
			);
			expect(yield* names(yield* ctx({ delegation: true, agents: ['workspace'] }))).toEqual(
				expect.arrayContaining(['goals', 'subagent'])
			);
			const child = [
				...(yield* names(yield* ctx({ mode: 'plan', child: true }))),
				...(yield* names(yield* ctx({ child: true })))
			];
			for (const n of ['update_plan', 'subagent']) expect(child).not.toContain(n);
			expect(child).toEqual(expect.arrayContaining(['read', 'act', 'wait', 'goals', 'ask_parent']));
			expect(yield* names(yield* ctx({ delegation: true, agents: ['workspace'] }))).not.toContain(
				'ask_parent'
			);
		})
	);
});
describe('runs and logs', () => {
	const runs = (x: ToolContext) =>
		x.engine.db.write({
			text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts, results, error, actor, finished_at) VALUES
			('r1', 'billing.invoice', '{"month":"09"}', '2026-09-20T01:00:00Z', 'schedule', 0, 'succeeded', 1, '[]', NULL, NULL, '2026-09-20T01:00:05Z'),
			('r2', 'billing.invoice', '{"month":"10"}', '2026-09-21T01:00:00Z', 'schedule', 0, 'failed', 2, '[{"attempt":1,"at":"2026-09-21T01:00:04Z","state":"failed","error":{"code":"timeout"}},{"attempt":2,"at":"2026-09-21T01:00:09Z","state":"failed","error":{"code":"guest","message":"boom"}}]', '{"code":"guest","message":"boom"}', NULL, '2026-09-21T01:00:09Z'),
			('r3', 'billing.dunning', '{}', '2026-09-22T01:00:00Z', 'start', 0, 'queued', 0, '[]', NULL, NULL, NULL),
			('r4', 'tidy', '{"secret":1}', '2026-09-23T01:00:00Z', 'start', 0, 'stopped', 1, '[]', '{"code":"stopped","message":"The run was stopped."}', $1, '2026-09-23T01:00:01Z'),
			('r5', 'tidy', '{}', '2026-09-24T01:00:00Z', 'start', 0, 'succeeded', 1, '[]', NULL, 'member:someone-else', NULL)
		ON CONFLICT (id) DO NOTHING`,
			params: [actorRef(member().actor)]
		});
	const ids = (answer: unknown) =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				result: Schema.Struct({
					runs: Schema.Array(Schema.Struct({ id: Schema.String })),
					next: Schema.optionalKey(Schema.String)
				})
			})
		)(answer).result;
	it.effect(
		'lists runs by automation, status and time, pages with the cursor, and hides what the actor may not read',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx();
				yield* runs(x);
				const all = ids(yield* result(x, 'runs', {}));
				expect(all.runs.map((r) => r.id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
				expect(
					ids(yield* result(x, 'runs', { automation: 'billing.*' })).runs.map((r) => r.id)
				).toEqual(['r3', 'r2', 'r1']);
				expect(ids(yield* result(x, 'runs', { automation: 'billing' })).runs).toEqual([]);
				expect(ids(yield* result(x, 'runs', { status: 'failed' })).runs.map((r) => r.id)).toEqual([
					'r2'
				]);
				expect(
					ids(yield* result(x, 'runs', { status: 'cancelled' })).runs.map((r) => r.id)
				).toEqual(['r4']);
				expect(
					ids(
						yield* result(x, 'runs', {
							since: '2026-09-21T00:00:00Z',
							until: '2026-09-23T00:00:00Z'
						})
					).runs.map((r) => r.id)
				).toEqual(['r3', 'r2']);
				const one = ids(yield* result(x, 'runs', { limit: 2 }));
				expect([one.runs.map((r) => r.id), one.next !== undefined]).toEqual([['r5', 'r4'], true]);
				const two = ids(yield* result(x, 'runs', { limit: 2, cursor: one.next ?? '' }));
				const three = ids(yield* result(x, 'runs', { limit: 2, cursor: two.next ?? '' }));
				expect([two.runs.map((r) => r.id), three.runs.map((r) => r.id), three.next]).toEqual([
					['r3', 'r2'],
					['r1'],
					undefined
				]);
				expect(yield* result(x, 'runs', { status: 'failed' })).toMatchObject({
					result: {
						runs: [
							{
								id: 'r2',
								status: 'failed',
								attempt_count: 2,
								error: { code: 'guest', message: 'boom' },
								finished: expect.stringContaining('2026-09-21')
							}
						]
					}
				});
				// one run in detail: input, result, every attempt and its log lines from the host's log
				logRows(x, [
					{
						at: '2026-09-21T01:00:00.000Z',
						severity: 'error',
						event: 'console',
						invocation: 'r2:2',
						run: 'r2',
						attributes: { automation: 'billing.invoice', level: 'error', line: 'boom' }
					},
					{
						at: '2026-09-21T01:00:00.000Z',
						severity: 'info',
						event: 'console',
						invocation: 'r1:1',
						run: 'r1',
						attributes: {}
					}
				]);
				expect(yield* result(x, 'runs', { id: 'r2' })).toMatchObject({
					result: {
						id: 'r2',
						input: { month: '10' },
						attempts: [{ error: { code: 'timeout' } }, { error: { code: 'guest' } }],
						logs: [{ event: 'console', severity: 'error', attributes: { line: 'boom' } }]
					}
				});
				expect(yield* result(x, 'runs', { cursor: 'nope' })).toEqual({
					result: { error: 'That cursor is not one a page answered.' }
				});
				// a member holding billing.invoice: its runs in full, a run they started with its result, nobody else's
				const holder = yield* ctx({ authority: { ...member(), automations: ['billing.invoice'] } });
				yield* runs(holder);
				expect(ids(yield* result(holder, 'runs', {})).runs.map((r) => r.id)).toEqual([
					'r4',
					'r2',
					'r1'
				]);
				expect(yield* result(holder, 'runs', { id: 'r1' })).toMatchObject({
					result: { input: { month: '09' } }
				});
				expect(yield* result(holder, 'runs', { id: 'r4' })).toMatchObject({
					result: { status: 'cancelled', error: { code: 'stopped' }, input: { secret: 1 } }
				});
				expect(yield* result(holder, 'runs', { id: 'r5' })).toEqual({
					result: { error: 'No automation run r5 you may read.' }
				});
			})
	);
	it.effect(
		"a run's clipped values name read_file's call id, and the whole run stays for it",
		() =>
			Effect.gen(function* () {
				const x = yield* ctx();
				const big = { text: 'x'.repeat(6_000) };
				yield* x.engine.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts, results, error, actor, finished_at)
				VALUES ('rb', 'billing.invoice', $1::jsonb, '2026-09-25T01:00:00Z', 'start', 0, 'succeeded', 1, '[]', NULL, NULL, NULL)`,
					params: [JSON.stringify(big)]
				});
				const answer = Schema.decodeUnknownSync(
					Schema.Struct({
						result: Schema.Struct({ input: Schema.String }),
						full: Schema.Struct({ input: Schema.Struct({ text: Schema.String }) }),
						bounded: Schema.Literal(true)
					})
				)(yield* result(x, 'runs', { id: 'rb' }));
				expect(answer.result.input).toMatch(
					/\.\.\. \[clipped, \d+ bytes; read_file \{ call: 'call' \} reads it whole\]$/
				);
				expect(answer.full.input.text).toBe(big.text);
			})
	);
	it.effect(
		'reads the runtime log by level, text, run and time, newest first, for administrators only',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx();
				yield* runs(x);
				logRows(x, [
					{
						at: '2026-09-21T01:00:01.000Z',
						severity: 'info',
						event: 'console',
						invocation: 'r2:1',
						run: 'r2',
						attributes: { automation: 'billing.invoice', line: 'starting' }
					},
					{
						at: '2026-09-21T01:00:02.000Z',
						severity: 'warn',
						event: 'facility.failed',
						invocation: 'r2:1',
						run: 'r2',
						attributes: { facility: 'http', automation: 'billing.invoice' }
					},
					{
						at: '2026-09-21T01:00:03.000Z',
						severity: 'error',
						event: 'console',
						invocation: 'r2:2',
						run: 'r2',
						attributes: { automation: 'billing.invoice', line: 'y'.repeat(3000) }
					},
					{
						at: '2026-09-22T01:00:00.000Z',
						severity: 'info',
						event: 'act.settled',
						invocation: 'a1',
						attributes: {}
					}
				]);
				const events = (input: Json) =>
					Effect.map(
						result(x, 'logs', input),
						(answer) =>
							Schema.decodeUnknownSync(
								Schema.Struct({
									result: Schema.Struct({
										lines: Schema.Array(
											Schema.Struct({
												id: Schema.String,
												event: Schema.String,
												level: Schema.String,
												attributes: Schema.Json
											})
										),
										next: Schema.optionalKey(Schema.String)
									})
								})
							)(answer).result
					);
				expect((yield* events({ level: 'warn' })).lines.map((l) => l.level)).toEqual([
					'error',
					'warn'
				]);
				expect((yield* events({ text: 'STARTING' })).lines.map((l) => l.event)).toEqual([
					'console'
				]);
				expect((yield* events({ run: 'r2' })).lines).toHaveLength(3);
				expect((yield* events({ automation: 'billing.invoice' })).lines).toHaveLength(3);
				expect(
					(yield* events({
						since: '2026-09-21T01:00:02Z',
						until: '2026-09-22T00:00:00Z'
					})).lines.map((l) => l.level)
				).toEqual(['error', 'warn']);
				const newest = (yield* events({ run: 'r2' })).lines[0];
				expect(typeof newest?.attributes).toBe('string');
				const page = yield* events({ run: 'r2', limit: 2 });
				expect(
					(yield* events({ run: 'r2', cursor: page.next ?? '' })).lines.map((l) => l.event)
				).toEqual(['console']);
				expect(yield* tool(yield* ctx({ authority: member() }), 'logs')).toBeUndefined();
			})
	);
});

describe('host web search', () => {
	const seen: HostToolContext[] = [];
	const host = (name: string): HostTool => ({
		name,
		description: name,
		input: { type: 'object', properties: {} },
		readOnly: true,
		call: async (_input, context) => {
			seen.push(context);
			return { ok: name };
		}
	});
	const hostTools = [host('web_search'), host('browser')];
	it.effect('a workspace MCP tool named web_search hides only the host web_search', () =>
		Effect.gen(function* () {
			const plain = yield* names(yield* ctx({ hostTools }));
			expect(plain).toEqual(expect.arrayContaining(['web_search', 'browser']));
			// every tool is offered directly: there is no tool for discovering or loading tools
			expect(plain).not.toContain('tools');
			const own = yield* names(
				yield* ctx({
					hostTools,
					mcpTools: [
						{ server: 'kagi', name: 'web_search', description: 'Kagi', input: { type: 'object' } },
						{ server: 'kagi', name: 'browser', description: 'x', input: { type: 'object' } }
					]
				})
			);
			expect(own).toEqual(expect.arrayContaining(['mcp__kagi__web_search', 'browser']));
			expect(own).not.toContain('web_search');
		})
	);
	it.effect('the host call carries the turn question', () =>
		Effect.gen(function* () {
			seen.length = 0;
			yield* result(yield* ctx({ hostTools, question: 'who won?' }), 'web_search', {});
			expect(seen.map((c) => c.question)).toEqual(['who won?']);
		})
	);
});

describe('the catalogue', () => {
	it.effect(
		'for an administrator with no MCP stays under 16,000 characters and names no model of the workspace',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx(
					{
						workspace: { files: async () => [], read: async () => null },
						delegation: true,
						skills: { authoring: skillOf({ 'SKILL.md': '---\ndescription: x\n---\n' }) },
						geocoder: { search: () => Effect.succeed([]), reverse: () => Effect.succeed(null) },
						hostTools: browserTools(yield* Browser)
					},
					{ convert: { targets: ['pdf'], convert: () => Effect.succeed(new Uint8Array()) } }
				);
				const texts = Object.values((yield* catalogue(x)).toolkit.tools).map(
					(t) => `${t.description ?? ''}${JSON.stringify(toolSchema(t))}`
				);
				expect(texts.join('').length).toBeLessThan(16_000);
				for (const model of Object.keys(manifest.models))
					for (const text of texts) expect(text).not.toContain(model);
			}).pipe(Effect.provide(Browser.fromAbi(off)))
	);
});

describe('the checklist', () => {
	it.effect('keeps a done goal omitted from the next list, and never rewrites it', () =>
		Effect.gen(function* () {
			let captured: Parameters<ToolContext['setGoals']>[0] | undefined;
			const base = yield* ctx();
			const x = yield* ctx({
				conv: {
					...base.conv,
					goals: [{ id: 'read', text: 'Read the source', status: 'done' }]
				},
				setGoals: (goals) => Effect.sync(() => void (captured = goals))
			});
			const answer = yield* result(x, 'goals', {
				items: [
					{ id: 'build', text: 'Build the change', status: 'doing' },
					{ id: 'read', text: 'Something else', status: 'pending' }
				]
			});
			expect(answer).toMatchObject({
				result: {
					saved: true,
					goals: [
						{ id: 'build', status: 'doing' },
						{ id: 'read', text: 'Read the source', status: 'done' }
					]
				}
			});
			expect(captured).toEqual([
				{ id: 'build', text: 'Build the change', status: 'doing' },
				{ id: 'read', text: 'Read the source', status: 'done' }
			]);
		})
	);
});
