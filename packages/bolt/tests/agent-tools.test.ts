// The agent catalogue over typed native ports: atomic writes, approvals, workspace search and run waits.
import { memberCap, SYSTEM_AGENTS } from '../src/engine/agent/settings.ts';
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
	Option,
	Predicate,
	PubSub,
	Schema,
	Scope
} from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import {
	DbError,
	FacilityFailure,
	type HostTool,
	type HostToolContext,
	type HttpFetchOptions,
	type HttpRequest,
	type HttpResponse,
	type Ingested,
	type LogRow,
	off,
	Port,
	type RawDb,
	REFERENCE,
	type WorkspacePort
} from '@norbital-ai/host-api';
import type { Authority } from '../src/engine/contracts.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { AgentEngine } from '../src/engine/agent/index.ts';
import {
	catalogue,
	jobs,
	type ToolContext,
	catalogueNote,
	describeWorkspace,
	fixedTools,
	readPaths,
	messageCatalogue,
	OVERVIEW_BYTES,
	runJob,
	sweeping,
	TOOLS_PER_REQUEST
} from '../src/engine/agent/tools.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { layered, type EngineManifest } from '../src/engine/manifest.ts';
import { Browser, Bundler, Files, GuestIsolates, Http, Images, Logs } from '../src/engine/ports.ts';
import { browserTools } from '../src/engine/agent/browser.ts';
import { approvedPageSession } from '../src/engine/agent/index.ts';
import { files_of, skill_of } from './support/run-file-trees.ts';
import { BOUNDS } from '../src/engine/agent/context.ts';
import { tree_digest } from '@norbital-ai/host-api';
import { Approvals, Automations, Callables, Live, Reads } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/effect.ts';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { audit_shape } from '../src/engine/audit.ts';
import { memory_audit } from '../../bolt-cli/src/test/audit.ts';
import { storable, transcriptRow } from '../src/engine/agent/schema.ts';
import { file_attachments } from '../src/engine/agent/attachments.ts';
import { seed_accounts } from './support/accounts.ts';
import type { ToolAnswer } from '../src/engine/agent/ai.ts';
import { randomUUID } from 'node:crypto';
import { actor_ref } from '../src/engine/access/actor.ts';

const required = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const member = (
	o: { external?: boolean; admin?: boolean; tools?: readonly string[]; team?: string; id?: string } = {}
): Authority => ({
	key: 'k',
	actor: {
		kind: 'member',
		id: o.id ?? 'ann',
		email: null,
		phone: null,
		external: o.external ?? false,
		admin: o.admin ?? false,
		party: null,
		teams: o.team === undefined ? [] : [o.team],
		team_path: o.team === undefined ? [] : [o.team]
	},
	admin: o.admin ?? false,
	policies: [],
	// an administrator reads every output of every workspace model, as `compile_authority` grants it
	models:
		o.admin === true
			? Effect.runSync(
					compile_authority(
						manifest,
						{
							actor: { kind: 'system', run: 'r', by: { platform: 'test' } },
							admin: true,
							policies: []
						},
						'k'
					)
				).models
			: {},
	automations: [],
	capabilities: { apps: [], tools: o.tools ?? [], mcp: [], syncs: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	exposures: {
		tasks: {
			outputs: { default: { tasks: { fields: 'all' } } },
			create: { columns: { tasks: ['title'] } }
		}
	},
	models: {
		tasks: {
			description: 'A task',
			record_label: 'record.title',
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
			grants: { tasks: { create: { verdict: true } } }
		}
	},
	teams: { Leads: { policies: [] } },
	automations: {},

	mcp: {},
	apps: {},
	custom_fields: {}
};
type EngineOverrides = Omit<Partial<AgentEngine>, 'db' | 'calls' | 'approvals' | 'files'> & {
	db?: Partial<RawDb>;
	calls?: Partial<AgentEngine['calls']>;
	acts?: AgentEngine['calls']['acts'];
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
				calls: {
					...calls,
					...engine.calls,
					...(engine.acts === undefined ? {} : { acts: engine.acts })
				},
				automations: engine.automations ?? Context.get(native, Automations),
				read: Context.get(native, Reads).run,
				approvals: { ...approvals, ...engine.approvals },
				files: { ...files, ...engine.files },
				images: engine.images ?? Context.get(native, Images),
				...(engine.read === undefined ? {} : { read: engine.read }),
				...(engine.convert === undefined ? {} : { convert: engine.convert }),
				guest: engine.guest ?? Context.get(native, GuestIsolates),
				...(engine.http === undefined ? {} : { http: engine.http }),
				...(engine.bundler === undefined ? {} : { bundler: engine.bundler }),
				...(engine.audit === undefined ? {} : { audit: engine.audit }),
				...(engine.credentials === undefined ? {} : { credentials: engine.credentials }),
				...(engine.runEnds === undefined ? {} : { runEnds: engine.runEnds })
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
				kind: null,
				parent: null,
				status: 'idle',
				model: 'default',
				plan: null
			},
			mode: 'agent',
			inApp: true,
			approved: () => false,
			delegation: false,
			child: false,
			skills: {},
			agents: [],
			mcp: { tools: () => Effect.succeed([]), call: () => Port.unavailable('mcp') },
			logs: Context.get(native, Logs),
			mcpTools: [],
			host_tools: [],
			browser_tools: [],
			receipts: [],
			audience: 'staff',
			zooms: new Map(),
			reading: new Set(),
			validators: new WeakMap(),
			files: [],
			jobs: yield* jobs(),
			setPlan: () => Effect.void,
			ask: () => true,
			messages: () => Effect.succeed([]),
			output: () => Effect.succeed(undefined),
			history: () => Effect.succeed([]),
			heard: Effect.never,
			subagent: {
				task: () => Effect.succeed({ id: 'child', running: false }),
				read: () => Effect.succeed(null),
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
/** The native catalogue exposes fixed model tools and the operations this actor can discover. */
const names = (x: ToolContext) => Effect.map(catalogue(x), (c) => c.available.map((t) => t.name));
const tool = (x: ToolContext, name: string) =>
	Effect.map(catalogue(x), (c) => c.available.find((tool) => tool.name === name));
const requiredTool = (x: ToolContext, name: string) =>
	Effect.flatMap(tool(x, name), (t) =>
		t === undefined ? Effect.die(new Error(`missing tool ${name}`)) : Effect.succeed(t)
	);
const result = (x: ToolContext, name: string, input: Json) =>
	Effect.flatMap(catalogue(x), (c) => c.run(name, input, 'call'));
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
describe('native question and browser boundaries', () => {
	it.effect(
		'admits one structured question with clean choices and leaves its wording on the card',
		() =>
			Effect.gen(function* () {
				const questions: Parameters<ToolContext['ask']>[0][] = [];
				const x = yield* ctx({
					ask: (question) => {
						if (questions.length > 0) return false;
						questions.push(question);
						return true;
					}
				});
				expect(
					yield* result(x, 'ask', {
						question: '  Which account?  ',
						options: [' Singapore ', '', 'Malaysia', 'Singapore']
					})
				).toEqual({
					result: { asked: true, to: 'the person' }
				});
				expect(questions).toEqual([
					{ question: 'Which account?', options: ['Singapore', 'Malaysia'] }
				]);
				expect(yield* result(x, 'ask', { question: 'A second question?' })).toEqual({
					result: { error: 'One question is already waiting in this step.' }
				});
				expect(questions).toHaveLength(1);
			})
	);
	it.effect(
		'offers user-tab navigation only to the web root while fleet browsing stays separate',
		() =>
			Effect.gen(function* () {
				const fleet: HostTool = {
					name: 'browser',
					description: 'Fleet browser',
					input: { type: 'object' },
					behavior: {},
					read_only: true,
					call: async () => ({ ok: true })
				};
				const base = yield* ctx({ browser_tools: [fleet] });
				expect(yield* names(base)).toEqual(expect.arrayContaining(['page', 'browser']));
				expect(yield* names({ ...base, authority: { ...base.authority, preview: { by: 'admin', team: null, impersonate: true } } })).not.toContain('browser');
				for (const over of [
					{ inApp: false },
					{ child: true },
					{ conv: { ...base.conv, run: 'daily-report' } },
					{ conv: { ...base.conv, owner: null, envoy: 'desk-envoy', integration: 'desk' } }
				]) {
					const available = yield* names(yield* ctx({ browser_tools: [fleet], ...over }));
					expect(available).not.toContain('page');
					expect(available).toContain('browser');
				}
			})
	);
});
describe('job waits', () => {
	it.effect('retains a host preview role when its job is collected later', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const list = yield* jobs();
				const id = yield* list.add(
					'workspace_preview',
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
it.effect('a host without source or delegation never advertises those tools', () => Effect.gen(function* () {
	const plain = yield* ctx({ workspace: undefined, delegation: false });
	const authority = yield* compile_authority(manifest, { actor: member().actor, admin: false, policies: ['staff'] }, 'writer');
	expect((yield* catalogue(yield* ctx({ authority }))).index['model:tasks']).toContain('reads none');
	const offered = (yield* catalogue(plain)).fixed.map(tool => tool.name);
	for (const name of ['workspace_read', 'workspace_grep', 'workspace_glob', 'workspace_list_dir', 'task']) expect(offered).not.toContain(name);
	for (const retired of ['task_read', 'task_stop']) expect(offered).not.toContain(retired);
}));

describe('job steering lines', () => {
	it.effect('a finished job leaves one line for the next step; wait collects it instead', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const list = yield* jobs();
				const a = yield* list.add('first', Effect.succeed({ ok: true }));
				const b = yield* list.add(
					'second',
					Effect.fail(BoltError.make('invalid_input', 'decode', 'bad input'))
				);
				const c = yield* list.add('third', Effect.succeed(3), {
					done: (id) => `[job ${id} done] custom`
				});
				expect(yield* list.settled(10_000)).toBe(true);
				expect(yield* list.wait([c], 1000)).toMatchObject({ job: c, result: 3 });
				expect(list.take()).toEqual([
					`[job ${a} done] first: {"ok":true}`,
					`[job ${b} failed] second: bad input`
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
describe('jobs cut short', () => {
	it.effect(
		'a turn job its turn ends early still ends in one line; a run job leaves its end to the run',
		() =>
			Effect.gen(function* () {
				const late: string[] = [];
				const watched = new Set<string>();
				const detached = yield* FiberSet.make<unknown, never>();
				let id = '';
				yield* Effect.scoped(
					Effect.gen(function* () {
						const list = yield* jobs({
							detached,
							watched,
							late: (lines) => Effect.sync(() => late.push(...lines))
						});
						id = yield* list.add('workspace_test', Effect.never);
						yield* list.add('automation quotes_mark', Effect.never, {
							detach: true,
							alias: 'run-1'
						});
						// the host carries this one on and reports its end itself
						expect(yield* list.add('studio_build', Effect.never, { id: 'host-job', reported: true })).toBe('host-job');
						expect([...watched]).toEqual(['run-1']);
					})
				);
				expect(late).toEqual([`[job ${id} stopped] workspace_test: cut short before it finished`]);
				yield* FiberSet.clear(detached);
				// the run's watcher stopped: its end now reaches the conversation by itself, and no line repeats it
				expect(late).toHaveLength(1);
				expect(watched.size).toBe(0);
			}).pipe(Effect.scoped)
	);
});
describe('spending caps', () => {
	it('a member gets the most generous cap among their policies, else the default', () => {
		const s = { monthly: null, member: 5, policies: { rep: 2, lead: 20 }, models: [], system1: null, system2: null, system: SYSTEM_AGENTS };
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
					...(yield* catalogue(yield* ctx({ inApp: false, audience: 'channel' }))).fixed,
					...(yield* catalogue(yield* ctx({ inApp: false, audience: 'channel' }))).available,
					...(yield* catalogue(yield* ctx({ workspace, authority: member() }))).fixed,
					...(yield* catalogue(yield* ctx({ workspace, authority: member() }))).available
				];
				expect(tools.map((t) => t.name)).toEqual(
					expect.arrayContaining(['read', 'act', 'workspace_grep', 'workspace_glob'])
				);
				// the JSON Schema each tool is offered with, its definitions included
				for (const t of tools) {
					const schema = t.input;
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
							record_label: 'record.value',
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
							outputs: { default: { tasks: { fields: 'all' }, 'tasks.lines': { fields: 'all' } } },
							create: { columns: { tasks: ['title'], 'tasks.lines': ['value', 'member'] } }
						},
						task_lines: { outputs: { default: { task_lines: { fields: 'all' } } } }
					}
				};
				const task = '01950000-0000-7000-8000-000000000001',
					line = '01950000-0000-7000-8000-000000000002';
				const child = { id: line, value: 'Known source', task, member: 'ann' };
				const x = yield* ctx(
					{},
					{
						manifest: model,
						acts: () =>
							Effect.succeed({
								v: 1,
								captured: [
									{
										model: 'tasks',
										id: task,
										op: 'create',
										revision: 1,
										transaction: '1',
										old: null,
										new: { id: task, title: 'Source', owner: 'ann' },
										cause: 'direct'
									},
									{
										model: 'task_lines',
										id: line,
										op: 'create',
										revision: 1,
										transaction: '1',
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
						acts: {
							'tasks.create': [
								{ title: 'Source', lines: [{ value: 'Known source', member: 'ann' }] }
							]
						}
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
					yield* result(x, 'read', { request: { tasks: { where: { id: { eq: id } }, limit: 5 } } })
				).toMatchObject({ result: answer });
				expect(reads).toHaveLength(1);
				const native = yield* catalogue(x);
				expect(yield* native.run('read', { tasks: {} }, 'bare-read')).toMatchObject({
					result: { error: expect.stringContaining("Invalid parameters for tool 'read'") }
				});
				expect(reads).toHaveLength(1);
				// an unreadable root is the handler's refusal, naming what the caller reads
				expect(yield* result(x, 'read', { request: { tasks: {}, secrets: {} } })).toEqual({
					result: { error: expect.stringMatching(/^You read no 'secrets'\. Models: .*tasks/) }
				});
				// a second look at a model under an invented root says how to take it
				expect(yield* result(x, 'read', { request: { tasks: {}, tasks_done: {} } })).toEqual({
					result: {
						error:
							"You read no 'tasks_done'. A request reads 'tasks' once: aggregate.by groups its counts, and another read call in the same step reads it again."
					}
				});
				// options beside the request instead of inside it: a wrong call
				expect(
					yield* result(x, 'read', { request: { tasks: {} }, fields: ['title'], limit: 5 })
				).toEqual({
					result: { error: expect.stringContaining("Invalid parameters for tool 'read'") }
				});
				// the schema is static: no caller's model is a property of it
				const read = yield* requiredTool(x, 'read');
				expect(JSON.stringify(read.input)).not.toContain('"tasks"');
				expect(reads).toHaveLength(1);
				// a request reaches the engine as it was sent: an aggregate answers its measures, as in ctx.query
				yield* result(x, 'read', { request: { tasks: { limit: 5, aggregate: { count: true } } } });
				expect(reads).toHaveLength(2);
				expect(JSON.stringify(reads.at(-1))).toContain('aggregate');
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
							...required(manifest.models.tasks),
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
					request: {
						tasks: {
							where: {
								title: { eq: { var: 'actor.id' } },
								due: { gte: { var: 'today - days(7)' }, lte: { var: 'today' } },
								seen: { lt: { var: 'now + hours(1)' } }
							}
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
						request: {
							tasks: { where: { due: { eq: { var: 'today - hours(1)' } } } }
						}
					})
				).toMatchObject({ result: { error: expect.stringContaining('whole days') } });
				expect(reads).toHaveLength(1);
			})
	);
	it.effect("describe_workspace answers a name's declared shape, and reads nothing for it", () =>
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
			// read takes no describe: a nested key is a relation, so the read refuses it, and nothing is read
			expect(yield* result(x, 'read', { request: { tasks: { describe: true } } })).toMatchObject({
				result: { error: expect.stringContaining('tasks.describe: expected a read node') }
			});
			expect(reads).toHaveLength(0);
		})
	);
	const outputs: EngineManifest = {
		...manifest,
		models: {
			tasks: {
				...required(manifest.models.tasks),
				fields: { title: { kind: 'text' }, cost: { kind: 'int' } }
			}
		},
		exposures: {
			tasks: {
				outputs: { default: { tasks: { fields: 'all' } }, brief: { tasks: { fields: ['title'] } } }
			}
		},
		policies: {
			viewer: { description: '', grants: { tasks: { outputs: { brief: {} } } } }
		}
	};
	const viewer = Effect.runSync(
		compile_authority(outputs, { actor: member().actor, admin: false, policies: ['viewer'] }, 'v')
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
				// the catalogue note gives each model's fields in the output the caller holds, never another's
				const line = (yield* catalogue(x)).index['model:tasks'] ?? '';
				expect(line).toContain('title: text');
				expect(line).toContain('reads brief');
				expect(line).not.toContain('cost');
				// the read names its output; the engine reads it
				yield* result(x, 'read', { request: { tasks: { output: 'brief' } } });
				expect(JSON.stringify(reads)).toContain('"output":"brief"');
				// a root that names none reads default, as ctx.query does
				reads.length = 0;
				yield* result(x, 'read', { request: { tasks: {} } });
				expect(JSON.stringify(reads)).not.toContain('"output":"brief"');
				// an administrator reads every output: describe of default names both
				const admin = yield* compile_authority(
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
						...required(manifest.models.tasks),
						fields: { title: { kind: 'text' }, status: { kind: 'text', optional: true } }
					}
				},
				exposures: {
					tasks: {
						outputs: { default: { tasks: { fields: 'all' } } },
						create: { columns: { tasks: ['title', 'status'] } }
					}
				},
				policies: {
					clerk: {
						description: '',
						grants: {
							tasks: { outputs: { default: {} }, create: { columns: { tasks: ['title'] } } }
						}
					}
				}
			};
			const clerk = yield* compile_authority(
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
								tasks: {
									outputs: { default: {} },
									create: { columns: { tasks: ['title'] }, verdict: true }
								}
							}
						}
					}
				};
				const clerk = yield* compile_authority(
					checked,
					{ actor: member().actor, admin: false, policies: ['clerk'] },
					'k'
				);
				const x = yield* ctx({ authority: clerk }, { manifest: checked });
				expect(yield* shape(x, 'tasks')).toMatchObject({
					writes: { 'tasks.create': { checks: ['clerk'] } }
				});
				const admin = yield* compile_authority(
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
							...required(manifest.models.tasks),
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
					exposures: { tasks: { outputs: { default: { tasks: { fields: ['title'] } } } } },
					custom_fields: {
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
				const { search: _search, ...unsearched } = required(manifest.models.tasks);
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
				expect(
					yield* result(x, 'read', { request: { tasks: { search: '', after: 'c0' } } })
				).toMatchObject({
					result: page
				});
				// no agent default limit and no dropped option: the request is lowered as the client's is
				const sent = JSON.stringify(reads);
				expect(sent).toContain('"limit":10000,"after":"c0"');
				const schema = JSON.stringify((yield* requiredTool(x, 'read')).input);
				for (const option of [
					'where',
					'fields',
					'order_by',
					'limit',
					'after',
					'search',
					'aggregate',
					'as_of'
				])
					expect(schema).toContain(`"${option}"`);
			})
	);
	it.effect(
		'act submits the complete map through one native request and reuses only an explicit operation key',
		() =>
			Effect.gen(function* () {
				const writes: { key: string; input: Json }[] = [];
				const act: AgentEngine['calls']['acts'] = (r) =>
					Effect.sync(() => {
						writes.push(...r.acts.map(({ input }) => ({ key: r.key, input })));
						return {
							captured: [],
							v: 0,
							outcome: { kind: 'committed', output: null, records: [] }
						};
					});
				const x = yield* ctx({ inApp: false }, { acts: act }),
					create = { acts: { 'tasks.create': [{ title: 'a' }, { title: 'b' }] } };
				yield* result(x, 'act', { ...create, key: 'operation-one' });
				yield* result({ ...x, turn: 'retry' }, 'act', { ...create, key: 'operation-one' });
				yield* result(x, 'act', { ...create, key: 'operation-two' });
				expect(writes.map(({ input }) => input)).toEqual([
					create.acts['tasks.create'],
					create.acts['tasks.create'],
					create.acts['tasks.create']
				]);
				expect(writes[0]?.key).toBe(writes[1]?.key);
				expect(writes[0]?.key).not.toBe(writes[2]?.key);
			})
	);
	it.effect(
		'reports read-back and queue lookup failures without losing the committed write receipt',
		() =>
			Effect.gen(function* () {
				const records = [
					{ model: 'tasks', id: '0199a000-0000-7000-8000-000000000001', revision: 1 }
				];
				const act: AgentEngine['calls']['acts'] = () =>
					Effect.succeed({
						captured: [],
						v: 0,
						outcome: { kind: 'committed', output: null, records }
					});
				const x = yield* ctx(
					{ inApp: false },
					{
						acts: act,
						read: () => Effect.fail(BoltError.make('internal', 'decode', 'read-back unavailable')),
						db: { read: () => Effect.fail(DbError.make('XX000', 'queue unavailable')) }
					}
				);
				const answer = yield* result(x, 'act', { acts: { 'tasks.create': [{ title: 'A' }] } });
				expect(answer).toMatchObject({
					result: {
						kind: 'committed',
						records,
						read_back_error: expect.stringContaining('read-back unavailable'),
						runs_lookup_error: expect.stringContaining('queue unavailable')
					}
				});
				expect(answer).not.toHaveProperty('result.stored');
			})
	);

	it.effect('an act that wrote nothing says so: the record already holds the supplied values', () =>
		Effect.gen(function* () {
			const act: AgentEngine['calls']['acts'] = () =>
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
			const x = yield* ctx({ inApp: false }, { acts: act });
			expect(yield* result(x, 'act', { acts: { 'tasks.create': [{ title: 'a' }] } })).toMatchObject(
				{
				result: {
					kind: 'committed',
					note: 'no change: tasks t1 already holds these values (a write callback may derive them)'
				}
			}
			);
		})
	);
});
describe('approval decisions', () => {
	it.effect(
		'offered to staff when writes need approval; they decide as themselves, confirming first in the app',
		() =>
			Effect.gen(function* () {
				expect(
					yield* tool(yield* ctx({ authority: member({ external: true }) }), 'decide')
				).toBeUndefined();
				const decided: Parameters<AgentEngine['approvals']['decide']>[0][] = [];
				const approvals: Partial<AgentEngine['approvals']> = {
					decide: (d) =>
						Effect.sync(() => {
							decided.push(d);
							return { kind: 'decided', request_id: d.request_id, status: 'Approved' };
						})
				};
				const input = { request_id: 'r1', decision: 'approve', reason: 'ok' };
				expect(
					yield* result(
						yield* ctx({ authority: member({ team: 'Leads' }) }, { approvals }),
						'decide',
						input
					)
				).toEqual({ confirm: true });
				expect(
					yield* result(
						yield* ctx({ authority: member({ team: 'Leads' }), inApp: false }, { approvals }),
						'decide',
						input
					)
				).toEqual({ result: { kind: 'decided', request_id: 'r1', status: 'Approved' } });
				expect(decided[0]).toMatchObject({
					request_id: 'r1',
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
					yield* ctx({ skills: { authoring: skill_of({ 'SKILL.md': text }) } }),
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
					authoring: skill_of({
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
	it.effect(
		'skill loads multiple sections or multiple skills in one batched call and advertises reference files in the catalogue',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({
					skills: {
						authoring: skill_of({
							'SKILL.md':
								'---\ndescription: How to author\n---\n## Models\nModel rules.\n## Policies\nPolicy rules.\n',
							'references/models.md': '# Models ref\nDetail A.\n',
							'references/policies.md': '# Policies ref\nDetail B.\n'
						}),
						ui: skill_of({
							'SKILL.md': '---\ndescription: UI guide\n---\n## Tabs\nTab rules.\n',
							'references/radii.md': '# Radii\n4/6/10/12.\n'
						})
					}
				});
				const cat = yield* catalogue(x);
				expect(cat.index['skill:authoring']).toContain('[files: references/models.md, references/policies.md]');
				expect(
					yield* result(x, 'skill', { name: 'authoring', sections: ['Models', 'Policies'] })
				).toMatchObject({
					result: {
						skill: 'authoring',
						sections: ['Models', 'Policies'],
						text: expect.stringContaining('Model rules.')
					},
					bounded: true
				});
				const batched = yield* result(x, 'skill', {
					requests: [
						{ name: 'authoring', files: ['references/models.md', 'references/policies.md'] },
						{ name: 'ui', section: 'Tabs' },
						{ name: 'missing' }
					]
				});
				expect(batched).toMatchObject({
					result: {
						items: [
							{ skill: 'authoring', ok: true, files: ['references/models.md', 'references/policies.md'] },
							{ skill: 'ui', ok: true },
							{ skill: 'missing', error: expect.stringContaining("No skill 'missing'") }
						],
						text: expect.stringContaining('Detail A.')
					},
					bounded: true
				});
				expect(JSON.stringify(batched)).toContain('Tab rules.');
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
				const search = yield* requiredTool(x, 'workspace_grep');
				expect(search.input).toMatchObject({ required: ['pattern'] });
				expect(yield* result(x, 'workspace_grep', {})).toMatchObject({
					result: {
						error: expect.stringContaining("Invalid parameters for tool 'workspace_grep'")
					}
				});
				const grep = (input: Json) =>
					Effect.map(result(x, 'workspace_grep', input), (answer) =>
						String(Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(answer).result)
					);
				expect(yield* grep({ pattern: 'bolt\\.(read|READ)' })).toMatch(
					/^Found 2 matches\nsrc\/a\.ts:\n {2}Line 2: .*\n\nsrc\/app\/b\.svelte:\n {2}Line 1: /
				);
				expect(yield* grep({ pattern: 'bolt.read', literal: true })).toMatch(
					/^Found 1 matches\nsrc\/a\.ts:/
				);
				expect(
					yield* grep({
						pattern: 'BOLT.READ',
						literal: true,
						caseSensitive: false,
						path: 'src/app'
					})
				).toContain('src/app/b.svelte:');
				expect(yield* grep({ pattern: 'bolt', include: '*.svelte' })).not.toContain('src/a.ts');
				expect(yield* grep({ pattern: 'bolt', include: '*.{ts,svelte}' })).toContain('src/a.ts');
				expect(yield* grep({ pattern: 'nothing here at all' })).toBe('No matches found');
				const cut = yield* grep({ pattern: '.', limit: 1 });
				expect(cut).toContain('Showing 1 matching lines (more exist)');
				expect(yield* result(x, 'workspace_grep', { pattern: 'bolt', count: true, limit: 1 })).toMatchObject({ result: { matchingLines: 2, matchingFiles: 2 } });
				expect(cut).toContain('(Results are truncated: showing first 1 results.');
				expect(yield* grep({ pattern: 'bolt.read', literal: true, path: '.' })).toContain(
					'src/a.ts:'
				);
				expect(yield* result(x, 'workspace_grep', { pattern: '[' })).toMatchObject({
					result: { error: expect.stringContaining('Invalid regex pattern: ') }
				});
				expect(yield* result(x, 'workspace_grep', { pattern: 'x', path: 'nowhere' })).toMatchObject({
					result: { error: 'Search path does not exist: nowhere' }
				});
			})
	);
	it.effect(
		"list_dir shows the tree with its roles; read lists a directory and glob finds files, OpenCode's way",
		() =>
			Effect.gen(function* () {
				const files = [
					'.prettierrc',
					'README.md',
					'src/+workspace.ts',
					'src/agent/tool/plans/+tool.ts',
					'src/agent/tool/plans/run.ts',
					'src/app/board/+app.ts',
					'src/app/board/+board.page.svelte'
				];
				const draft: WorkspacePort = { files: async () => files, read: async () => 'x' };
				const x = yield* ctx({ workspace, draft, authority: member({ admin: true }) });
				const text = (tool: string, input: Json) =>
					Effect.map(result(x, tool, input), (answer) =>
						String(Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(answer).result)
					);
				const whole = yield* text('workspace_list_dir', {});
				expect(whole.split('\n')[0]).toBe('/  <- cwd');
				expect(whole).toContain('+board.page.svelte');
				const plans = yield* text('workspace_list_dir', { path: 'src/agent/tool' });
				expect(plans).toContain('run.ts');
				expect(plans).not.toContain('+app.ts');
				expect(yield* result(x, 'workspace_list_dir', { path: 'nowhere' })).toMatchObject({
					result: { error: expect.stringContaining('no such directory') }
				});
				expect(yield* text('workspace_read', { path: 'src/agent/tool/plans' })).toBe(
					'Read directory src/agent/tool/plans, entries 1-2\n+tool.ts\nrun.ts'
				);
				expect(yield* text('workspace_read', { path: '.', limit: 2 })).toBe(
					'Read directory ., entries 1-2\nsrc/\n.prettierrc\n[Output truncated. Continue reading with offset: 3]'
				);
				expect(yield* text('workspace_glob', { pattern: '*.svelte' })).toBe(
					'src/app/board/+board.page.svelte'
				);
				expect(yield* text('workspace_glob', { pattern: '**/+*.ts', path: 'src/agent' })).toBe(
					'src/agent/tool/plans/+tool.ts'
				);
				expect(yield* text('workspace_glob', { pattern: '*' })).not.toContain('.prettierrc');
				expect(yield* text('workspace_glob', { pattern: '*', hidden: true })).toContain('.prettierrc');
				expect(yield* text('workspace_glob', { pattern: '*.py' })).toBe('No files found');
				expect(yield* result(x, 'workspace_glob', { pattern: '*', path: 'README.md' })).toMatchObject({
					result: { error: 'Search path is not a directory: README.md' }
				});
			})
	);
	it.effect(
		'read and list default to the current author tree without a draft flag; other staff read published source',
		() =>
			Effect.gen(function* () {
				let revision = 'first';
				const draft: WorkspacePort = {
					files: async () => ['src/current.ts', 'migrations/physical.json'],
					read: async (path) => (path === 'src/current.ts' ? revision : '{}')
				};
				const x = yield* ctx({ workspace, draft, authority: member() });
				expect(
					yield* result(x, 'workspace_read', { path: 'migrations/physical.json' })
				).toMatchObject({
					result: 'Read file migrations/physical.json, lines 1-1\n1: {}'
				});
				expect(yield* result(x, 'workspace_list_dir', {})).toMatchObject({
					result: expect.stringContaining('current.ts')
				});
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts' })).toMatchObject({
					result: 'Read file src/current.ts, lines 1-1\n1: first'
				});
				// the same path spelling workspace_grep accepts
				expect(yield* result(x, 'workspace_read', { path: './src/current.ts' })).toMatchObject({
					result: 'Read file src/current.ts, lines 1-1\n1: first'
				});
				expect(yield* result(x, 'workspace_read', { path: '/src/current.ts' })).toMatchObject({
					result: 'Read file src/current.ts, lines 1-1\n1: first'
				});
				expect(yield* result(x, 'workspace_read', { path: 'src/old/../current.ts' })).toMatchObject(
					{
						result: 'Read file src/current.ts, lines 1-1\n1: first'
					}
				);
				revision = 'saved replacement';
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts' })).toMatchObject({
					result: 'Read file src/current.ts, lines 1-1\n1: saved replacement'
				});
				expect(
					yield* result(x, 'workspace_grep', { pattern: 'saved replacement', literal: true })
				).toMatchObject({ result: expect.stringContaining('src/current.ts:\n  Line 1: saved') });
				expect(
					yield* result(yield* ctx({ workspace, authority: member() }), 'workspace_read', {
						path: 'src/a.ts',
						offset: 2,
						limit: 1
					})
				).toMatchObject({ result: expect.stringContaining('\n2: bolt.read(tasks)') });
				expect(yield* result(x, 'workspace_read', { path: '../elsewhere' })).toMatchObject({
					result: { error: 'File not found: ../elsewhere' }
				});
				// installed packages and what the build writes are no source: not found, with no advice
				for (const path of [
					'node_modules/@norbital-ai/bolt/build/decl/runtime/agent.d.ts',
					'.norbital/names.ts'
				])
					expect(yield* result(x, 'workspace_read', { path })).toMatchObject({
						result: { error: `File not found: ${path}` }
					});
				// OpenCode's pages: past the end is the tail, a negative offset counts from the end
				revision = 'a\nb\nc\n';
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts', offset: 9 })).toMatchObject({
					result:
						'Read file src/current.ts, lines 1-3 (offset 9 is past the end; the file has 3 lines)\n1: a\n2: b\n3: c'
				});
				expect(yield* result(x, 'workspace_read', { path: 'src/current.ts', offset: -1 })).toMatchObject({
					result: 'Read file src/current.ts, lines 3-3\n3: c'
				});
				expect(
					yield* result(x, 'workspace_read', { path: 'src/current.ts', offset: 1, limit: 2 })
				).toMatchObject({
					result: 'Read file src/current.ts, lines 1-2\n1: a\n2: b\n[Output truncated. Continue reading with offset: 3]'
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
		'src/data/model/tasks/+model.ts': 'model({})',
		'src/data/model/payroll/+model.ts': 'model({})',
		'src/access_control/team/+team.ts': 'export default {}'
	};
	const workspace: WorkspacePort = {
		files: async () => Object.keys(source),
		read: async (path) => source[path] ?? null
	};
	const host = (name: string, o: Partial<HostTool> = {}): HostTool => ({
		name,
		description: name,
		behavior: {},
		input: { type: 'object', properties: {} },
		call: async () => ({ ok: name }),
		...o
	});
	const host_tools = [
		host('workspace_lang', { read_only: true, source: true }),
		host('workspace_write'),
		host('workspace_preview', { studio: 'preview' }),
		host('workspace_review', { read_only: true, studio: 'logs' }),
		host('web_search', { read_only: true })
	];
	it.effect(
		'a tool that starts a sandbox job reaches an administrator or a policy naming it, never anyone else',
		() =>
			Effect.gen(function* () {
				const offered = (authority: Authority) =>
					ctx({ workspace, host_tools: [host('reference')], authority }).pipe(
						Effect.flatMap(names)
					);
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
	const reader = Effect.runSync(
		compile_authority(
			{
				...manifest,
				policies: { staff: { description: '', grants: { tasks: { outputs: { default: {} } } } } }
			},
			{ actor: member().actor, policies: ['staff'], admin: false },
			'reader'
		)
	);
	it.effect(
		'a member without admin reads the source of the models they read and the read-only source tools, never a mutating one',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({ workspace, host_tools, authority: reader });
				const offered = yield* names(x);
				expect(offered).toEqual(
					expect.arrayContaining([
						'workspace_grep',
						'workspace_glob',
						'workspace_list_dir',
						'workspace_lang'
					])
				);
				for (const mutating of [
					'workspace_write',
					'workspace_preview',
					'workspace_review',
					'web_search'
				])
					expect(offered).not.toContain(mutating);
				expect(yield* result(x, 'workspace_lang', {})).toMatchObject({
					result: { ok: 'workspace_lang' }
				});
				const listed = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(
					yield* result(x, 'workspace_list_dir', {})
				).result;
				expect(listed).toContain('tasks/');
				expect(listed).not.toContain('payroll/');
				expect(
					yield* result(x, 'workspace_read', { path: 'src/data/model/payroll/+model.ts' })
				).toMatchObject({ result: { error: 'File not found: src/data/model/payroll/+model.ts' } });
				expect(
					yield* result(x, 'workspace_read', { path: 'src/access_control/team/+team.ts' })
				).toMatchObject({ result: { error: 'File not found: src/access_control/team/+team.ts' } });
				expect(
					yield* result(x, 'workspace_grep', { pattern: 'model(', literal: true })
				).toMatchObject({
					result: expect.stringContaining('src/data/model/tasks/+model.ts:')
				});
				// an administrator holds every host tool and reads all of the source
				const admin = yield* ctx({ workspace, host_tools, authority: member({ admin: true }) });
				expect(yield* names(admin)).toEqual(
					expect.arrayContaining(['workspace_lang', 'workspace_write', 'workspace_review'])
				);
				expect(
					yield* result(admin, 'workspace_grep', { pattern: 'model(', literal: true })
				).toMatchObject({
					result: expect.stringContaining('src/data/model/payroll/+model.ts:')
				});
				// a host tool that changes something is never a source tool, whatever it claims
				const claims = yield* ctx({
					workspace,
					host_tools: [host('workspace_merge', { source: true, studio: 'merge' })],
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
				const admin = yield* compile_authority(
					manifest,
					{ actor: holder, policies: [], admin: true },
					'a'
				);
				const x = yield* ctx({ authority: admin });
				expect(readPaths(manifest, admin)).toContain('sys_user');
				// other built-in models stay a grant's
				expect(readPaths(manifest, admin)).not.toContain('sys_conversation');
				expect(yield* result(x, 'read', { request: { sys_conversation: {} } })).toEqual({
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
				record_label: 'record.code',
				fields: {
					code: { kind: 'text' },
					status: {
						kind: 'state',
						initial: 'draft',
						states: { draft: { to: ['approved'] }, approved: {} }
					}
				}
			},
			trial_line: {
				description: 'one measured value',
				record_label: 'record.value',
				fields: { value: { kind: 'text' } }
			},
			secret: { description: 'hidden', record_label: 'record.x', fields: { x: { kind: 'text' } } }
		},
		relationships: { 'trial_line.trial': { to: 'trial', inverse: 'lines', owned: true } },
		exposures: {
			trial: {
				outputs: { default: { trial: { fields: 'all' }, 'trial.lines': { fields: 'all' } } },
				create: { columns: { trial: ['code'] }, effect: true },
				syncs: { import_csv: { with: 'file', parser: ['csv'] } }
			},
			secret: { outputs: { default: { secret: { fields: 'all' } } }, delete: {} }
		},
		policies: {
			matcher: {
				description: '',
				grants: { trial: { outputs: { default: {} }, create: {} } },
				capabilities: { apps: ['lab/trials'], automations: ['close_month'] }
			}
		},
		automations: {
			close_month: {
				description: 'closes the month',
				policies: ['matcher'],
				input: { month: { kind: 'date' } },
				on: [{ cron: '0 2 1 * *' }],
				agent: 'confirm'
			},
			purge: { description: 'deletes everything', policies: ['matcher'] }
		},
		groups: { lab: { title: 'nav.lab', icon: 'lucide:flask', default_child: 'trials' } },
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
	const matcher = Effect.runSync(
		compile_authority(lab, { actor: member().actor, admin: false, policies: ['matcher'] }, 'm')
	);
	it.effect('maps what the caller reaches, and nothing it cannot', () =>
		Effect.gen(function* () {
			const map = describeWorkspace(lab, matcher, messages);
			expect(map).toContain('# Workspace tz Asia/Singapore · locale en-SG · currency SGD');
			expect(map).toContain('lab "Lab" ▸ lab/trials "Trials": Colour matching');
			expect(map).toContain('  ├ /app/lab/trials/list "All trials"');
			expect(map).toContain('  ├ /app/lab/trials/kiosk "page.kiosk" portal');
			expect(map).toContain('trial "a colour-matching attempt"');
			expect(map).toMatch(/\n {2}fields code \S+.* · status /);
			expect(describeWorkspace(lab, matcher, messages, [], new Map([['trial', 3]]))).toContain(
				'trial "a colour-matching attempt" · 3 rows'
			);
			expect(map).toContain('  writes create');
			expect(map).toContain('  links lines (many trial_line)');
			expect(map).toContain('  state status: draft | approved');
			expect(map).toContain('  effects create');
			expect(map).toContain('  syncs import_csv (file)');
			expect(map).toContain(
				'close_month(month: date) "closes the month" · cron 0 2 1 * * · agent confirm'
			);
			expect(map).not.toContain('secret');
			expect(map).not.toContain('purge');
			// an administrator sees the model the matcher cannot
			const admin = yield* compile_authority(
				lab,
				{ actor: member({ admin: true }).actor, admin: true, policies: [] },
				'a'
			);
			expect(describeWorkspace(lab, admin, messages)).toContain('secret "hidden"');
		})
	);
	it.effect(
		'gives an administrator the native write schema without granting a system data read',
		() =>
			Effect.gen(function* () {
				const all = layered(lab);
				const admin = yield* compile_authority(
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
				expect(readPaths(all, admin)).not.toContain('sys_envoy');
				expect(describeWorkspace(all, matcher, messages, ['sys_envoy'])).toBe(
					'Nothing named sys_envoy that you can reach.'
				);
			})
	);
	it.effect('stays within the cap, naming the rest for a call with names', () =>
		Effect.gen(function* () {
			const many = Object.fromEntries(
				Array.from({ length: 400 }, (_, n) => [
					`model_${n}`,
					{
						description: `the ${n}th model of a large workspace`,
						record_label: 'record.x',
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
						Object.keys(many).map((n) => [
							n,
							{ outputs: { default: { [n]: { fields: 'all' as const } } } }
						])
					)
				}
			};
			const admin = yield* compile_authority(
				big,
				{ actor: member({ admin: true }).actor, admin: true, policies: [] },
				'a'
			);
			const map = describeWorkspace(big, admin, messages);
			expect(new TextEncoder().encode(map).byteLength).toBeLessThanOrEqual(OVERVIEW_BYTES);
			expect(map).toMatch(/Also \(describe_workspace \{ names \}\): .*model_\d+.* more/);
		})
	);
	it.effect('the plain map counts each readable model in one read', () =>
		Effect.gen(function* () {
			const map = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(
				yield* result(yield* ctx(), 'describe_workspace', {})
			).result;
			expect(map).toMatch(/\n\w+ ".*" · \d+ rows?\n/);
		})
	);
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
						'  effects create',
						'  syncs import_csv (file)'
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
			// the setup answers as text, like every describe answer
			expect((yield* catalogue(x)).index['page:paths']).toContain('/settings/integrations');
			expect(yield* result(x, 'describe_workspace', { names: ['system'] })).toEqual({
				result: expect.stringContaining('envoys: []')
			});
			expect(yield* result(x, 'describe_workspace', { names: ['system'] })).toEqual({
				result: expect.stringContaining('api_key.create {"path":"/settings/integrations","tab":"keys"')
			});
			expect(
				yield* result(x, 'page', {
					path: '/settings/integrations',
					configure: { capability: 'api_key.create' }
				})
			).toEqual({ confirm: true });
			const approvedPage = yield* ctx({ approved: (name) => name === 'page' });
			expect(
				yield* result(approvedPage, 'page', {
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
			expect((yield* catalogue(ordinary)).index['page:paths']).not.toContain('/settings');
			expect(yield* result(ordinary, 'describe_workspace', { names: ['system'] })).toEqual({
				result: 'system: nothing you may set up.'
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
			const files = required(x.engine.files);
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
	it.effect('repeated attachments keep their exact file identity for reads and scripts', () =>
		Effect.gen(function* () {
			const text = `observation ${randomUUID()}`;
			const { x, id } = yield* holding(`c-${randomUUID()}`, {
				name: 'observation.txt',
				mime: 'text/plain',
				bytes: new TextEncoder().encode(text)
			});
			yield* x.engine.db.write({
				text: 'UPDATE sys_conversation SET inputs = inputs || inputs WHERE id = $1',
				params: [x.conv.id]
			});
			expect(yield* result(x, 'read_file', { id, offset: 1 })).toMatchObject({
				result: expect.stringContaining(text)
			});
			expect(
				yield* result(x, 'run_js', {
					files: [{ id }],
					code: 'return new TextDecoder().decode(input.files[0].bytes);'
				})
			).toMatchObject({ result: { answer: text } });
			const other = {
				id: id.slice(0, 8) + randomUUID().slice(8),
				name: 'other.txt',
				mime: 'text/plain'
			};
			yield* x.engine.db.write({
				text: 'UPDATE sys_conversation SET inputs = inputs || $2::jsonb WHERE id = $1',
				params: [x.conv.id, JSON.stringify([other])]
			});
			expect(yield* result(x, 'read_file', { id, offset: 1 })).toMatchObject({
				result: expect.stringContaining(text)
			});
			expect(yield* result(x, 'read_file', { id: id.slice(0, 8), offset: 1 })).toMatchObject({
				result: { error: expect.stringContaining(other.id) }
			});
		})
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
							first: first(json.sheets).rows,
							images: [{ name: 'image-1.png', row: 0, col: 1 }]
						}
					],
					note: `its data: run_js { files: [{ id: '${dataId}' }] }; its images: read_file { id: o1, image: n }`
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
					result: { error: 'o1 has had its 3 zooms this turn.' }
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
	it.effect('read_file({ id }) opens a standalone image attachment directly', () =>
		Effect.gen(function* () {
			const { x: imgX, id: imgId } = yield* holding(
				`c-${randomUUID()}`,
				{ name: 'shot.png', mime: 'image/png', bytes: PNG },
				{ attachments: { read: () => Effect.succeed({ mime: 'image/png', bytes: PNG }) } }
			);
			expect(yield* result(imgX, 'read_file', { id: imgId })).toEqual({
				result: { attached: 'shown on your next step only' }
			});
			expect(imgX.files[0]?.mime).toBe('image/png');
		})
	);
	const scan = () =>
		holding(
			`c-${randomUUID()}`,
			{
				name: 'form.pdf',
				mime: 'application/pdf',
				bytes: new TextEncoder().encode(`%PDF form ${randomUUID()}`)
			},
			{
				ingest: () =>
					Effect.succeed({
						...tender,
						html: '<section data-page="1" data-read>\n<img src="image-1.png" alt="">\n<p>Plates: 15</p>\n</section>',
						images: [{ name: 'image-1.png', mime: 'image/png', bytes: PNG }]
					})
			}
		);
	it.live(
		'a read answers its lines every time: nothing is withheld as already read',
		() =>
			Effect.gen(function* () {
				const { x, id } = yield* scan();
				const count = {
					code: `const r = await tool('read_file', { id: '${id}', offset: 1, limit: 4 }); return r.split('\\n').filter((l) => /^\\d+: /.test(l)).length;`
				};
				expect(yield* result(x, 'run_js', count)).toEqual({ result: { answer: 4 } });
				for (let again = 0; again < 2; again++)
					expect(yield* result(x, 'read_file', { id: 'o1', offset: 1, limit: 4 })).toMatchObject({
						result: expect.stringContaining('\n3: Plates: 15\n')
					});
				expect(yield* result(x, 'run_js', count)).toEqual({ result: { answer: 4 } });
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
			yield* result(x, 'read_file', { id, offset: 1, limit: 1 });
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
				expect(yield* result(x, 'read_file', { id, offset: 5, limit: 1 })).toEqual({
					result: [
						'9 lines · 1 images · 1 tables',
						'Map: L1–9 Cover (Pricing L3–9)',
						'Read tender.pdf (ingested) (o1), lines 4-7 of 9',
						'4: <table>',
						'5: <tr><td>Lot</td><td>Rate</td></tr>',
						'6: <tr><td>7</td><td>12.50</td></tr>',
						'7: </table>',
						'[Output truncated. Continue reading with offset: 8]'
					].join('\n'),
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
				expect(yield* result(x, 'read_file', { id: 'o1', offset: 4, limit: 4 })).toMatchObject({
					result: expect.stringContaining('\n4: <table>\n')
				});
				expect(yield* result(x, 'read_file', { id, offset: 8 })).toEqual({
					result: [
						'Read tender.pdf (ingested) (o1), lines 8-9 of 9',
						'8: <p><img src="image-1.png" alt="site plan"></p>',
						'9: End',
						'Shown on your next step only (extract all visible fields/values now before unrelated lookups): image-1.png'
					].join('\n'),
					bounded: true
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
				expect(yield* result(x, 'read_file', { id })).toMatchObject({
					result: expect.stringContaining('(o1), lines 1-9 of 9')
				});
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
			expect(yield* result(x, 'read_file', { id })).toMatchObject({
				result: {
					reading: 'tender.pdf',
					job: expect.any(String),
					note: expect.stringContaining('wait { jobs:')
				}
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
				const scanned = {
					...tender,
					html: tender.html + '\n<section data-page="2">\n<p>No text on this page.</p>\n</section>'
				};
				const port = { ingest: () => Effect.sync(() => (calls++, scanned)) };
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
				const answer = yield* result(other.x, 'read_file', { id: other.id, offset: 1, limit: 2 });
				expect(calls).toBe(1);
				expect(
					kitLogs
						.get(other.x)
						?.filter((r) => r.event === 'ingest.convert' && r.conversation === other.x.conv.id)
						.map((r) => r.attributes)
				).toEqual([expect.objectContaining({ cached: true })]);
				expect(answer).toMatchObject({
					result: expect.stringMatching(/no text on pages 2[\s\S]*\(o1\), lines 1-2 of 12\n1: <h1>Cover<\/h1>\n2: Tender for site works\n/)
				});
			})
	);
	it.effect(
		'a password read is kept under its password: a reader without it converts again, one with it reuses it',
		() =>
			Effect.gen(function* () {
				const bytes = new TextEncoder().encode(`%PDF locked ${randomUUID()}`);
				const asked: (string | undefined)[] = [];
				const port = {
					ingest: (_: unknown, read?: { readonly password?: string }) =>
						Effect.sync(() => (asked.push(read?.password), tender))
				};
				const read = (password?: string) =>
					Effect.gen(function* () {
						const { x, id } = yield* holding(
							`c-${randomUUID()}`,
							{ name: 'locked.pdf', mime: 'application/pdf', bytes },
							port
						);
						return yield* result(x, 'read_file', {
							id,
							...(password === undefined ? {} : { password })
						});
					});
				expect(yield* read('pw')).toMatchObject({ result: expect.stringContaining('(o1)') });
				yield* read();
				yield* read('pw');
				expect(asked).toEqual(['pw', undefined]);
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
			expect(yield* result(x, 'read_file', { id })).toMatchObject({
				result: { reading: 'bad.pdf', job: expect.any(String) }
			});
			const j = first(x.jobs.pending()).job;
			expect(yield* result(x, 'read_file', { id: 'o1' })).toEqual({
				result: { note: expect.stringContaining('Still being read: wait { jobs:') }
			});
			yield* Deferred.succeed(gate, undefined);
			yield* x.jobs.settled(10_000);
			expect(x.jobs.take()).toEqual([`[job ${j} failed] reading bad.pdf: the PDF is encrypted`]);
		})
	);
	it.effect('a read a restart cut short starts over, and never stays reading', () =>
		Effect.gen(function* () {
			const { x, id } = yield* holding(
				`c-${randomUUID()}`,
				{
					name: 'long.pdf',
					mime: 'application/pdf',
					bytes: new TextEncoder().encode(randomUUID())
				},
				{
					ingest: () =>
						Effect.succeed({
							kind: 'document',
							html: '<p>Back again</p>',
							images: [],
							meta: { stats: { pages: 1, bytes: 1, cpuMs: 1, wallMs: 1 } }
						})
				}
			);
			// what the generation before this one left behind: an entry with no job running it
			yield* x.engine.db.write({
				text: 'UPDATE sys_conversation SET outputs = $2::jsonb WHERE id = $1',
				params: [
					x.conv.id,
					JSON.stringify([
						{
							name: 'long.pdf (ingested)',
							mime: 'text/html',
							ingest: { output: 'o1', source: id, sha256: 'a', status: 'ingesting', job: 'gone' }
						}
					])
				]
			});
			expect(yield* result(x, 'read_file', { id })).toMatchObject({
				result: expect.stringContaining('\n1: Back again')
			});
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
				const answer = yield* result(x, 'read_file', { id });
				const said = 'result' in answer && typeof answer.result === 'string' ? answer.result.split('\n') : [];
				expect(said.slice(0, 2)).toEqual([
					'00:01:05 · 2 speakers · 2 lines',
					'Map: L1–1 S1 00:00:01 · L2–2 S2 00:00:04'
				]);
				expect(said[2]).toMatch(/^Typed JSON for run_js .*: transcript\.json \S+ — run_js/);
				expect(said.slice(3)).toEqual([
					'Read site-meeting.m4a (transcript) (o1), lines 1-2 of 2',
					...html.split('\n').map((l, i) => `${i + 1}: ${l}`)
				]);
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
				expect(
					JSON.parse(new TextDecoder().decode(yield* required(x.engine.files).get(key, size)))
				).toEqual({
					duration_ms: 65_000,
					speakers: ['S1', 'S2'],
					segments: [
						{ speaker: 'S1', start: 1, end: 3, text: 'Pour on Friday?' },
						{ speaker: 'S2', start: 4, end: 65, text: 'Agreed.' }
					]
				});
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
			// what happened, and nothing about which other tool to reach for
			expect(yield* result(video.x, 'read_file', { id: video.id, offset: 1 })).toEqual({
				result: { error: 'site.mp4 (video/mp4, 1 bytes): binary; no parser for this format.' }
			});
			const pdf = yield* holding(`c-${randomUUID()}`, {
				name: 'a.pdf',
				mime: 'application/pdf',
				bytes: new Uint8Array([2])
			});
			expect(yield* result(pdf.x, 'read_file', { id: pdf.id })).toEqual({
				result: { error: 'This host cannot parse files.' }
			});
			expect(yield* result(pdf.x, 'read_file', { id: pdf.id, offset: 1 })).toEqual({
				result: { error: 'This host cannot parse files.' }
			});
		})
	);
	it.effect(
		'an archive lists its files; path reads one through the same ingest, under its own cache entry',
		() =>
			Effect.gen(function* () {
				const asked: (string | undefined)[] = [];
				const doc = (html: string): Ingested => ({
					kind: 'document',
					html,
					images: [],
					meta: { stats: { pages: null, bytes: 1, cpuMs: 1, wallMs: 1 } }
				});
				const { x, id } = yield* holding(
					`c-${randomUUID()}`,
					{
						name: 'repo.zip',
						mime: 'application/zip',
						bytes: new TextEncoder().encode(`PK ${randomUUID()}`)
					},
					{
					ingest: (_, read) =>
						Effect.sync(() => {
							asked.push(read?.entry);
							return read?.entry === undefined
								? doc('<pre>\nrepo/src/app.ts  19 bytes\nrepo/README.md  12 bytes\n</pre>')
								: doc('<pre>\nif (a &lt; b) {}\n</pre>');
						})
				}
				);
				expect(yield* result(x, 'read_file', { id })).toMatchObject({
				result: expect.stringContaining('\n1: repo/src/app.ts  19 bytes\n2: repo/README.md  12 bytes')
			});
				const entry = 'Read repo.zip/repo/src/app.ts (ingested) (o2), lines 1-1 of 1\n1: if (a < b) {}';
				expect(yield* result(x, 'read_file', { id, path: 'repo/src/app.ts' })).toMatchObject({
				result: expect.stringContaining(entry)
			});
				// the listing's output names the same archive; a read already made is read again, not converted
				expect(yield* result(x, 'read_file', { id: 'o1', path: '/repo/src/app.ts' })).toEqual({
					result: entry,
					bounded: true
				});
				expect(asked).toEqual([undefined, 'repo/src/app.ts']);
				const text = yield* holding(`c-${randomUUID()}`, {
				name: 'main.rs',
				mime: 'application/octet-stream',
				bytes: new TextEncoder().encode('fn main() {}')
			});
				// a type no reader knows is read as the text it is
				expect(yield* result(text.x, 'read_file', { id: text.id })).toMatchObject({
					result: expect.stringContaining('\n1: fn main() {}')
				});
				expect(yield* result(text.x, 'read_file', { id: text.id, path: 'a' })).toEqual({
					result: {
						error: 'main.rs is not an archive: path names a file inside a zip, tar or tar.gz.'
					}
				});
			})
	);
	it.live(
		'ten first reads of one entry at once convert it once, across conversations; the listing once',
		() =>
			Effect.gen(function* () {
				const asked: (string | undefined)[] = [];
				const bytes = new TextEncoder().encode(`PK ${randomUUID()}`);
				const doc = (html: string): Ingested => ({
					kind: 'document',
					html,
					images: [],
					meta: { stats: { pages: null, bytes: 1, cpuMs: 1, wallMs: 1 } }
				});
				const port = {
					ingest: (_: unknown, read?: { readonly entry?: string }) =>
						Effect.sleep(20).pipe(
							Effect.as(
								read?.entry === undefined
									? doc('<pre>\nsrc/a.ts  5 bytes\n</pre>')
									: doc('<pre>\nlet a\n</pre>')
							),
							Effect.tap(() => Effect.sync(() => asked.push(read?.entry)))
						)
				};
				const readers = yield* Effect.forEach(Array.from({ length: 10 }), () =>
				holding(`c-${randomUUID()}`, { name: 'repo.zip', mime: 'application/zip', bytes }, port)
			);
				const answers = yield* Effect.forEach(readers, ({ x, id }) => result(x, 'read_file', { id, path: 'src/a.ts' }), {
				concurrency: 'unbounded'
			});
				expect(
					answers.every(
						(answer) =>
							'result' in answer &&
							typeof answer.result === 'string' &&
							answer.result.includes('1: let a')
					)
				).toBe(true);
				yield* Effect.forEach(readers, ({ x, id }) => result(x, 'read_file', { id }), {
					concurrency: 'unbounded'
				});
				expect(asked).toEqual(['src/a.ts', undefined]);
			})
	);
	it.live(
		'run_js hands the named files over as input.files, one typed shape; a wrong read throws naming it',
		() =>
			Effect.gen(function* () {
				const { x, id } = yield* holding(`c-${randomUUID()}`, {
				name: 'notes.txt',
				mime: 'text/plain',
				bytes: new TextEncoder().encode('hello')
			});
				const run = (code: string) => result(x, 'run_js', { files: [{ id }], code });
				expect(
				yield* run('const [f] = input.files; return [f.id, f.name, f.type, f.size, new TextDecoder().decode(f.bytes), f.bytes instanceof Uint8Array];')
			).toEqual({ result: { answer: [id, 'notes.txt', 'text/plain', 5, 'hello', true] } });
				expect(yield* run('return input.files[0].data;')).toEqual({
					result: {
						error: expect.stringContaining("TypeError: input.files[0] has no 'data': each file is { id, name, type, size, bytes: Uint8Array }")
					}
				});
				expect(yield* run("return input.files['notes.txt'].bytes;")).toEqual({
					result: {
						error: expect.stringContaining("TypeError: input.files has no 'notes.txt': it is an array of 1 { id, name, type, size, bytes: Uint8Array }")
					}
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
			video.x.attachments = file_attachments(db, files, images);
			expect(yield* result(video.x, 'read_file', { id: video.id })).toEqual({
				result: { error: 'site.mp4 (video/mp4, 1 bytes): binary; no parser for this format.' }
			});
		})
	);
});
describe('native automation and sync controls', () => {
	it.effect(
		'identifies an automation request by actor, conversation, turn and call, never by equal inputs',
		() =>
			Effect.gen(function* () {
				const started: Parameters<AgentEngine['calls']['start']>[0][] = [];
				const engine: EngineOverrides = {
					manifest: {
						...manifest,
						automations: { tidy: { description: '', policies: ['staff'] } }
					},
					db: {
						read: () =>
							Effect.succeed([{ rows: [{ id: 'another-members-active-run' }], affected: 0 }])
					},
					calls: {
						start: (request) =>
							Effect.sync(() => {
								started.push(request);
								return { kind: 'committed', output: null, records: [] };
							})
					}
				};
				const x = yield* ctx(
					{
						inApp: false,
						authority: { ...member({ id: 'ann', admin: true }), automations: ['tidy'] }
					},
					engine
				);
				const c = yield* catalogue(x);
				const input = { automation: 'tidy', input: {} };
				yield* c.run('run', input, 'request-one');
				yield* c.run('run', input, 'request-one');
				yield* c.run('run', input, 'request-two');
				const other = yield* ctx(
					{
						inApp: false,
						authority: { ...member({ id: 'bea', admin: true }), automations: ['tidy'] }
					},
					engine
				);
				yield* (yield* catalogue(other)).run('run', input, 'request-one');
				yield* (yield* catalogue({ ...x, turn: 'next-turn' })).run('run', input, 'request-one');
				yield* (yield* catalogue({ ...x, conv: { ...x.conv, id: 'another-conversation' } })).run(
					'run',
					input,
					'request-one'
				);
				expect(started).toHaveLength(6);
				const ids = started.map((request) => first(request.runs).id);
				expect(ids[0]).toBe(ids[1]);
				expect(new Set(ids).size).toBe(5);
			})
	);
	it.effect('starts authored automations through run and file or remote refresh through sync', () =>
		Effect.gen(function* () {
			const started: Parameters<AgentEngine['calls']['start']>[0][] = [];
			const synced: Parameters<AgentEngine['calls']['sync_control']>[0][] = [];
			const m: EngineManifest = {
				...manifest,
				policies: {},
				exposures: {
					tasks: {
						outputs: { default: { tasks: { fields: 'all' } } },
						syncs: {
							sheet: { with: 'file', parser: ['json'], schema: { a: { kind: 'int' } } },
							erp: { with: 'erp', read: true, every: '1min' }
						}
					}
				},
				integrations: {
					erp: { description: 'An ERP', driver: 'http', http: { base_url: 'https://erp.example' } }
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
				start: (request) =>
					Effect.sync(() => {
						started.push(request);
						return { kind: 'committed', output: { kind: 'queued' }, records: [] };
					}),
				sync_control: (request) =>
					Effect.sync(() => {
						synced.push(request);
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
			expect((yield* requiredTool(x, 'run')).description).not.toContain('tidy');
			expect(describeWorkspace(m, authority, new Map())).toContain('tidy(day?: date)');
			expect(
				yield* result(x, 'run', { automation: 'tidy', input: { day: '2026-09-01' } })
			).toMatchObject({ result: { outcome: { output: { kind: 'queued' } } } });
			expect(started).toMatchObject([
				{ automation: 'tidy', runs: [{ input: { day: '2026-09-01' } }] }
			]);
			for (const automation of ['purge', 'tasks.sync.sheet', 'tasks.sync.erp'])
				expect(yield* result(x, 'run', { automation, input: {} })).toEqual({
					result: { error: `You may not run '${automation}'. Yours: tidy` }
				});
			for (const input of [
				{ mode: 'import', file: 'f1' },
				{ mode: 'export', to: 'json' },
				{ mode: 'template' }
			])
				yield* result(x, 'sync', { model: 'tasks', sync: 'sheet', input });
			yield* result(x, 'sync', { model: 'tasks', sync: 'erp', input: {} });
			expect(synced.map(({ model, sync, input }) => ({ model, sync, input }))).toEqual([
				{ model: 'tasks', sync: 'sheet', input: { mode: 'import', file: 'f1' } },
				{ model: 'tasks', sync: 'sheet', input: { mode: 'export', to: 'json' } },
				{ model: 'tasks', sync: 'sheet', input: { mode: 'template' } },
				{ model: 'tasks', sync: 'erp', input: {} }
			]);
			active = 'run-1';
			expect(
				yield* result(x, 'run', { automation: 'tidy', input: { day: '2026-09-01' } })
			).toMatchObject({ result: { outcome: { kind: 'committed' } } });
			expect(yield* result(x, 'sync', { model: 'tasks', sync: 'erp', input: {} })).toMatchObject({
				result: { outcome: { kind: 'committed' } }
			});
			expect(started).toHaveLength(2);
			expect(started[0]?.runs).toEqual(started[1]?.runs);
			expect(synced).toHaveLength(5);
			expect(synced[3]?.id).toBe(synced[4]?.id);
			const restricted: Authority = {
				...member(),
				models: authority.models,
				automations: ['tidy']
			};
			const denied = yield* ctx(
				{ authority: restricted, inApp: false },
				{ manifest: m, calls, db }
			);
			expect(
				yield* result(denied, 'sync', { model: 'tasks', sync: 'erp', input: {} })
			).toMatchObject({ result: { error: expect.stringContaining('You may not use this sync') } });
			const granted = yield* ctx(
				{
					authority: {
						...restricted,
						capabilities: { ...restricted.capabilities, syncs: ['tasks.erp'] }
					},
					inApp: false
				},
				{ manifest: m, calls, db }
			);
			expect(yield* result(granted, 'sync', { model: 'tasks', sync: 'erp' })).toMatchObject({
				result: { outcome: { kind: 'committed' } }
			});
		})
	);
	it.effect('reads act input only from a JSON file owned by the member', () =>
		Effect.gen(function* () {
			const started: Parameters<AgentEngine['calls']['start']>[0][] = [];
			const input = { day: '2026-09-01' };
			const x = yield* ctx(
				{ authority: { ...member({ admin: true }), automations: ['tidy'] }, inApp: false },
				{
					manifest: {
						...manifest,
						automations: {
							tidy: { description: '', policies: ['staff'], input: { day: { kind: 'date' } } }
						}
					},
					calls: {
						start: (request) =>
							Effect.sync(() => {
								started.push(request);
								return { kind: 'committed', output: null, records: [] };
							})
					},
					db: {
						read: (statements) =>
							Effect.sync(() => [
								{
									rows:
										first(statements).params[0] === 'f-json' &&
										first(statements).params[1] === 'ann'
											? [{ key: 'k1', size: 20 }]
											: [],
									affected: 0
								}
							])
					},
					files: { get: () => Effect.succeed(new TextEncoder().encode(JSON.stringify(input))) }
				}
			);
			yield* result(x, 'run', { automation: 'tidy', input_file: 'f-json' });
			expect(started).toMatchObject([{ automation: 'tidy', runs: [{ input }] }]);
			expect(
				yield* result(x, 'run', { automation: 'tidy', input_file: 'someone-else' })
			).toMatchObject({
				result: { error: expect.stringContaining('No file someone-else of yours') }
			});
			expect(started).toHaveLength(1);
		})
	);
});
describe('wait', () => {
	it.effect('keeps a suspended run pending and follows its eventual result', () =>
		Effect.gen(function* () {
			let state = 'waiting';
			const read = yield* Deferred.make<void>();
			const runEnds = yield* PubSub.unbounded<readonly string[]>();
			const x = yield* ctx(
				{},
				{
					runEnds,
					db: {
						read: () =>
							Effect.gen(function* () {
								yield* Deferred.succeed(read, undefined);
								return [
									{
										affected: 0,
										rows: [
											{
												id: 'suspended-run',
												automation: 'tidy',
												cause: 'start',
												state,
												due_at: '2026-11-16T00:00:00Z',
												started: null,
												progress: null,
												output: state === 'succeeded' ? { completed: true } : null,
												error: null,
												attempts: 1,
												results: [],
												input: {},
												actor: 'member:ann',
												starter: null,
												trigger: null,
												trigger_name: null
											}
										]
									}
								];
							})
					}
				}
			);
			yield* runJob(x.jobs, x.engine, x.authority, 'automation.tidy', { run: 'suspended-run' });
			yield* Deferred.await(read);
			yield* TestClock.adjust(1);
			expect(x.jobs.pending()).toEqual([expect.objectContaining({ done: false })]);
			state = 'succeeded';
			yield* PubSub.publish(runEnds, ['suspended-run']);
			expect(yield* x.jobs.wait(['suspended-run'], 1000)).toMatchObject({
				result: { status: 'succeeded', result: { completed: true } }
			});
		})
	);
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
	it.effect('gives way to new input: the jobs keep running and the step ends', () =>
		Effect.gen(function* () {
			const x = yield* ctx({ heard: Effect.void });
			const job = yield* x.jobs.add('slow', Effect.never);
			expect(yield* result(x, 'wait', { jobs: [job], seconds: 120 })).toMatchObject({
				result: {
					settled: null,
					pending: [{ job, done: false }],
					note: expect.stringContaining('New input arrived')
				}
			});
		})
	);
	it.effect('surfaces a failed background operation and preserves its job identity', () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			const job = yield* x.jobs.add('workspace_diagnose', Effect.succeed({ error: 'check timed out' }));
			expect(yield* result(x, 'wait', { jobs: [job] })).toMatchObject({
				result: { error: 'check timed out', settled: { job, result: { error: 'check timed out' } } }
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
			const x = yield* ctx({ approved: () => true });
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
			const x = yield* ctx({ approved: () => true }),
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
	it.effect('a turn with a browser downloads through it, with its sign-ins', () =>
		Effect.gen(function* () {
			const host_tools = browserTools(yield* Browser);
			expect(yield* names(yield* ctx({ host_tools }))).not.toContain('download');
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
					{ redirects: 0, max_bytes: 4 * 1024 * 1024 }
				]
			]);
		})
	);
	it.live("a script's source read is the raw file, so read-modify-write keeps every byte", () =>
		Effect.gen(function* () {
			const text = '1: not a line number\r\n\tindented  \n\nlast line without newline';
			const draft: WorkspacePort = {
				files: async () => ['tests/a.test.ts'],
				read: async (path) => (path === 'tests/a.test.ts' ? text : null)
			};
			const x = yield* ctx({ draft, authority: member({ admin: true }) });
			expect(
				yield* run(x, {
					code: "const r = await tool('workspace_read', { path: 'tests/a.test.ts' }); return { ...r, same: r.content.replace(/x^/, '') };"
				})
			).toEqual({
				result: {
					answer: { path: 'tests/a.test.ts', content: text, lines: 4, same: text }
				}
			});
		})
	);
	it.live('a scripted read honors an explicit page and can list a source directory', () =>
		Effect.gen(function* () {
			const draft: WorkspacePort = {
				files: async () => ['src/example.ts'],
				read: async (path) => (path === 'src/example.ts' ? 'first\r\nsecond\nthird\n' : null)
			};
			const x = yield* ctx({ draft, authority: member({ admin: true }) });
			const code = "return await tool('workspace_read', input)";
			expect(yield* run(x, { code, input: { path: 'src/example.ts' } })).toMatchObject({
				result: { answer: { lines: 3, content: 'first\r\nsecond\nthird\n' } }
			});
			expect(yield* run(x, { code, input: { path: 'src/example.ts', offset: 2, limit: 1 } })).toEqual({
				result: { answer: 'Read file src/example.ts, lines 2-2\n2: second\n[Output truncated. Continue reading with offset: 3]' }
			});
			expect(yield* run(x, { code, input: { path: 'src' } })).toEqual({
				result: { answer: 'Read directory src, entries 1-1\nexample.ts' }
			});
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
	it.live("http: true only reads; a script that sends waits for the person's confirmation", () =>
		Effect.gen(function* () {
			const { asked, http } = origin();
			const x = yield* ctx({}, { http });
			const post = "const r = await http({ method: 'POST', url: 'https://api.test/stock', body: 'x' }); return r.status;";
			expect(yield* run(x, { http: true, code: post })).toEqual({
				result: { error: expect.stringContaining("needs http: 'send'") }
			});
			expect(asked).toEqual([]);
			expect(yield* run(x, { http: 'send', code: post })).toEqual({ confirm: true });
			expect(asked).toEqual([]);
			const approved = yield* ctx({ approved: () => true }, { http });
			expect(yield* run(approved, { http: 'send', code: post })).toEqual({
				result: { answer: 200 }
			});
			expect(asked.map(([request]) => request.method)).toEqual(['POST']);
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
describe('confirmation coverage', () => {
	const envoy: Authority = {
		...member(),
		actor: { kind: 'envoy', envoy: 'desk', instance: 'wa', sender: '6591234567', member: null }
	};
	it('a delete, a batch, a pruning import and a nested delete hold; one plain create or update does not', () => {
		expect(sweeping('jobs.delete', [{ target: { id: 'j1', revision: 1 } }])).toBe(true);
		expect(
			sweeping('jobs.update', [
				{ target: { id: 'j1' }, set: {} },
				{ target: { id: 'j2' }, set: {} }
			])
		).toBe(true);
		expect(
			sweeping('jobs.update', [
				{ target: { id: 'j1' }, set: { lines: { delete: [{ id: 'l1' }] } } }
			])
		).toBe(true);
		for (const rows of [[], [{}]]) {
			const input = { rows, on_conflict: 'update', prune: { title: { like: '%' } } };
			expect(sweeping('jobs.import', input)).toBe(true);
			expect(sweeping('jobs.import', { ...input, dry_run: true })).toBe(false);
		}
		expect(sweeping('jobs.import', { rows: [{}, {}], on_conflict: 'update', dry_run: true })).toBe(false);
		expect(sweeping('jobs.create', [{ title: 'one' }])).toBe(false);
		expect(sweeping('jobs.update', [{ target: { id: 'j1' }, set: { status: 'done' } }])).toBe(false);
	});
	it('Moli browser tool runs without confirmation; page control confirms once per conversation and run_js files surface on transcript rows', () => {
		const stubBrowser: Browser['Service'] = {
			navigate: () => Effect.succeed({ url: 'https://a.test', title: 'A', text: 'ok', lines: 1 }),
			snapshot: () => Effect.succeed({ url: 'https://a.test', title: 'A', text: 'ok', lines: 1 }),
			act: () => Effect.succeed({ url: 'https://a.test', title: 'A', text: 'ok', lines: 1 }),
			evaluate: () => Effect.succeed({ value: 'ok' }),
			download: () => Effect.succeed({ id: 'f1', name: 'f.pdf', mime: 'application/pdf', bytes: 4, key: 'k', sha256: 's' }),
			screenshot: () => Effect.succeed(new Uint8Array([1])),
			close: () => Effect.void,
			scoped: () => Effect.die('unused')
		};
		const [fleet] = browserTools(stubBrowser);
		expect(fleet?.confirm).toBeUndefined();

		expect(approvedPageSession([])).toBe(false);
		expect(
			approvedPageSession([
				{
					id: 'm1',
					conversation: 'c1',
					seq: 1,
					role: 'tool',
					state: null,
					text: null,
					turn: 't1',
					as: null,
					mode: null,
					author: null,
					about: null,
					supersedes: null,
					copied_from: null,
					content: { id: 'call-1', assistant: 'a1', name: 'page', result: { approved: true } },
					meta: { tag: 'confirm', call: { id: 'call-1', name: 'page', input: { path: '/inbox' } } }
				}
			])
		).toBe(true);

		const row = transcriptRow(
			{
				id: 'm2',
				conversation: 'c1',
				seq: 2,
				role: 'tool',
				state: null,
				text: null,
				turn: 't1',
				as: null,
				mode: null,
				author: null,
				about: null,
				supersedes: null,
				copied_from: null,
				content: {
					id: 'call-2',
					assistant: 'a2',
					name: 'run_js',
					result: {
						answer: {
							rows: 530,
							files: [{ id: 'f-csv', name: 'leads.csv', mime: 'text/csv', size: 1024 }]
						}
					}
				},
				meta: null
			},
			true,
			false
		);
		expect(row?.files).toEqual([{ id: 'f-csv', name: 'leads.csv', mime: 'text/csv' }]);
	});
	const mcp = (calls: Json[]): ToolContext['mcp'] => ({
		tools: () => Effect.succeed([]),
		call: (_server: string, _tool: string, input: Json) =>
			Effect.sync(() => {
				calls.push(input);
				return { ok: true };
			})
	});
	const mcpTools = [
		{ server: 'kagi', name: 'web_search', description: 'Kagi', input: { type: 'object' } }
	];
	it.effect("an MCP call holds for the person's card, runs once approved and is refused to an envoy", () =>
		Effect.gen(function* () {
			const calls: Json[] = [];
			expect(yield* result(yield* ctx({ mcpTools, mcp: mcp(calls) }), 'kagi__web_search', { q: 'x' })).toEqual({ confirm: true });
			expect(calls).toEqual([]);
			expect(
				yield* result(yield* ctx({ mcpTools, mcp: mcp(calls), approved: () => true }), 'kagi__web_search', { q: 'x' })
			).toEqual({ result: { ok: true } });
			expect(calls).toEqual([{ q: 'x' }]);
			expect(
				yield* result(yield* ctx({ mcpTools, mcp: mcp(calls), authority: envoy, inApp: false }), 'kagi__web_search', { q: 'y' })
			).toEqual({ result: { error: expect.stringContaining('An envoy cannot') } });
			expect(calls).toEqual([{ q: 'x' }]);
		})
	);
	it.effect('a host tool that declares confirm holds; download holds too', () =>
		Effect.gen(function* () {
			let ran = 0;
			const commit: HostTool = {
				name: 'workspace_commit',
				description: 'commit',
				behavior: {},
				input: { type: 'object', properties: {} },
				confirm: () => true,
				call: async () => {
					ran++;
					return { ok: true };
				}
			};
			expect(yield* result(yield* ctx({ host_tools: [commit] }), 'workspace_commit', {})).toEqual({
				confirm: true
			});
			expect(ran).toBe(0);
			expect(yield* result(yield* ctx(), 'download', { url: 'https://law.example/seal.png' })).toEqual({ confirm: true });
		})
	);
});
describe('run_js over a repository reference', () => {
	const COMMIT = '446c7ac5b0b7d74ae03e546ef2ab3f3a0844f04b',
		NAME = `calc@${COMMIT.slice(0, 12)}`;
	const tree = files_of({
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
				behavior: {},
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
								digest: tree_digest(tree),
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
			const x = yield* ctx({ host_tools: [reference], inlineMs: 1 }, { bundler: service, http });
			store = x.engine.files;
			yield* result(x, 'reference', {});
			// past the inline wall the file is still recorded, and `wait` hands it over
			const waited = yield* result(x, 'wait', { jobs: [first(x.jobs.pending()).job] });
			expect(waited).toMatchObject({
				result: {
					settled: { result: { reference: NAME, files: [{ name: NAME, mime: REFERENCE.mime }] } }
				}
			});
			const listing = (input: Json) => result(x, 'read_file', input);
			// the index's own file id reads as its name: the tree
			const kept = Schema.decodeUnknownSync(
				Schema.Struct({
					result: Schema.Struct({
						settled: Schema.Struct({
							result: Schema.Struct({ files: Schema.Array(Schema.Struct({ id: Schema.String })) })
						})
					})
				})
			)(waited);
			expect(yield* listing({ id: first(kept.result.settled.result.files).id })).toMatchObject({
				result: expect.stringContaining('src/lib/add.js')
			});
			expect(yield* listing({ id: `${NAME}/src/lib` })).toMatchObject({
				result: expect.stringContaining('src/lib/add.js')
			});
			expect(yield* listing({ id: `${NAME}/src/lib/`, text: 'a + b' })).toMatchObject({
				result: 'src/lib/add.js:1: module.exports.add = (a, b) => a + b;'
			});
			// Searching a second page advances by matching lines, even when one line contains the term twice.
			expect(yield* listing({ id: NAME, path: 'src/main.js', text: 'add', limit: 1 })).toMatchObject({
				result: expect.stringContaining('Continue with offset: 2')
			});
			expect(yield* listing({ id: NAME, path: 'src/main.js', text: 'add', offset: 2 })).toMatchObject({
				result: expect.stringMatching(/^src\/main\.js:2: console\.log/)
			});
			// Attachments and repository references share the id + path form.
			for (const id of [NAME, first(kept.result.settled.result.files).id]) {
				expect(yield* listing({ id, path: 'src/main.js', text: 'console.log' })).toMatchObject({
					result: expect.stringMatching(/^src\/main\.js:2: console\.log/)
				});
				expect(yield* listing({ id, path: 'absent.txt' })).toEqual({
					result: { error: `${NAME} has no file 'absent.txt'.` }
				});
			}
			// The same paging and filtering controls apply to a repository's folders and individual files.
			expect(yield* listing({ id: NAME, limit: 1 })).toMatchObject({
				result: expect.stringContaining('Continue reading with offset: 2')
			});
			expect(yield* listing({ id: NAME, offset: 2, limit: 1 })).toMatchObject({
				result: expect.not.stringContaining('src/main.js')
			});
			expect(yield* listing({ id: `${NAME}/src/main.js`, text: 'console.log' })).toMatchObject({
				result: expect.stringMatching(/^src\/main\.js:2: console\.log/)
			});
			expect(yield* listing({ id: `${NAME}/src/main.js`, text: 'missing' })).toMatchObject({
				result: `Nothing in ${NAME}/src/main.js holds 'missing'.`
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
	it.effect(
		'has no plan or sub-agents of its own: one level deep, and its question goes to its delegating agent',
		() =>
			Effect.gen(function* () {
				expect(yield* names(yield* ctx({ mode: 'plan' }))).toContain('update_plan');
				const parent = yield* ctx({ delegation: true, agents: ['general', 'envoy-1'] });
				expect(yield* names(parent)).toContain('task');
				expect(yield* names(parent)).not.toContain('task_read');
				expect(yield* names(parent)).not.toContain('task_stop');
				// a guessed type is refused with the real list; a task answers at once with its id
				expect(
					yield* result(parent, 'task', {
						description: 'Check',
						prompt: 'Check it',
						subagent_type: 'explore'
					})
				).toMatchObject({
				result: {
					error: expect.stringContaining('Unknown agent type: explore is not a valid agent type. Agent types: general, envoy-1')
				}
			});
				expect(
					yield* result(parent, 'task', {
						description: 'Check',
						prompt: 'Check it',
						subagent_type: 'general'
					})
				).toMatchObject({
				result: expect.stringMatching(/^<task id="child" state="running">\n<summary>Background task started<\/summary>/)
			});
				expect(yield* result(parent, 'task', { action: 'read', task_id: 'child' })).toMatchObject({
					result: expect.any(Object)
				});
				expect(yield* result(parent, 'task', { action: 'stop', task_id: 'child' })).toMatchObject({
					result: expect.any(Object)
				});
				expect(yield* result(parent, 'task', { action: 'read' })).toMatchObject({
					result: { error: expect.stringContaining('task_id') }
				});
				expect(yield* result(parent, 'task', { action: 'stop' })).toMatchObject({
					result: { error: expect.stringContaining('task_id') }
				});
				const child = [
				...(yield* names(yield* ctx({ mode: 'plan', child: true }))),
				...(yield* names(yield* ctx({ child: true })))
			];
				for (const n of [
					'update_plan',
					'task',
					'act',
					'run',
					'decide',
					'invite',
					'page',
					'connect',
					'download'
				])
					expect(child).not.toContain(n);
				expect(child).toEqual(expect.arrayContaining(['read', 'wait', 'ask']));
				const childHost = yield* names(
					yield* ctx({
						child: true,
						mcpTools: [{ server: 'ext', name: 'send', description: 'send', input: { type: 'object' } }],
						host_tools: [
							{
								name: 'workspace_merge',
								description: 'merge',
								studio: 'merge',
								behavior: {},
								input: { type: 'object', properties: {} },
								call: async () => ({ ok: true })
							},
							{
								name: 'confirmed_tool',
								description: 'confirmed',
								behavior: {},
								input: { type: 'object', properties: {} },
								confirm: () => true,
								call: async () => ({ ok: true })
							}
						]
					})
				);
				for (const n of ['ext__send', 'workspace_merge', 'confirmed_tool'])
					expect(childHost).not.toContain(n);
				expect(yield* result(yield* ctx({ child: true }), 'ask', { question: 'Which one?' })).toEqual({
				result: { asked: true, to: 'the delegating agent' }
			});
				// a child's fixed list leaves the delegation, planning and approval-gated tools out
				const fixed = (yield* catalogue(yield* ctx({ child: true }))).fixed.map((t) => t.name);
				for (const n of [
					'task',
					'update_plan',
					'act',
					'run',
					'decide',
					'invite',
					'page',
					'connect',
					'download'
				])
					expect(fixed).not.toContain(n);
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
			params: [actor_ref(member().actor)]
		});
	const ids = (answer: unknown) =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				result: Schema.Struct({
					rows: Schema.Array(Schema.Struct({ id: Schema.String })),
					next: Schema.NullOr(Schema.String)
				})
			})
		)(answer).result;
	/** `read`'s `$runs` root: answered alone, as itself. */
	const $runs = (x: ToolContext, node: Json) => result(x, 'read', { request: { $runs: node } });
	it.effect(
		'lists runs by automation, status and time, pages with the cursor, and hides what the actor may not read',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx();
				yield* runs(x);
				const all = ids(yield* $runs(x, {}));
				expect(all.rows.map((r) => r.id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
				expect(
					ids(yield* $runs(x, { automation: 'billing.*' })).rows.map((r) => r.id)
				).toEqual([
					'r3',
					'r2',
					'r1'
				]);
				expect(ids(yield* $runs(x, { automation: 'billing' })).rows).toEqual([]);
				expect(ids(yield* $runs(x, { status: 'failed' })).rows.map((r) => r.id)).toEqual(['r2']);
				expect(
					ids(yield* $runs(x, { status: 'cancelled' })).rows.map((r) => r.id)
				).toEqual(['r4']);
				expect(
					ids(
						yield* $runs(x, {
							since: '2026-09-21T00:00:00Z',
							until: '2026-09-23T00:00:00Z'
						})
					).rows.map((r) => r.id)
				).toEqual(['r3', 'r2']);
				const one = ids(yield* $runs(x, { limit: 2 }));
				expect([one.rows.map((r) => r.id), one.next !== null]).toEqual([['r5', 'r4'], true]);
				const two = ids(yield* $runs(x, { limit: 2, after: one.next ?? '' }));
				const three = ids(yield* $runs(x, { limit: 2, after: two.next ?? '' }));
				expect([two.rows.map((r) => r.id), three.rows.map((r) => r.id), three.next]).toEqual([
					['r3', 'r2'],
					['r1'],
					null
				]);
				expect(yield* $runs(x, { status: 'failed' })).toMatchObject({
					result: {
						rows: [
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
				expect(yield* $runs(x, { id: 'r2' })).toMatchObject({
					result: {
						rows: [
							{
							id: 'r2',
							input: { month: '10' },
							attempts: [{ error: { code: 'timeout' } }, { error: { code: 'guest' } }],
							logs: [{ event: 'console', severity: 'error', attributes: { line: 'boom' } }]
						}
						],
						next: null
					}
				});
				expect(yield* $runs(x, { after: 'nope' })).toEqual({
					result: { error: '$runs: after is a next a page answered.' }
				});
				// a model and a ledger in one read: each answers under its own name
				expect(yield* result(x, 'read', { request: { tasks: { limit: 1 }, $runs: { id: 'r2' } } })).toMatchObject({
					result: { tasks: { rows: expect.any(Array) }, $runs: { rows: [{ id: 'r2' }] } }
				});
				// a member holding billing.invoice: its runs in full, a run they started with its result, nobody else's
				const holder = yield* ctx({ authority: { ...member(), automations: ['billing.invoice'] } });
				yield* runs(holder);
				expect(ids(yield* $runs(holder, {})).rows.map((r) => r.id)).toEqual(['r4', 'r2', 'r1']);
				expect(yield* $runs(holder, { id: 'r1' })).toMatchObject({
					result: { rows: [{ input: { month: '09' } }] }
				});
				expect(yield* $runs(holder, { id: 'r4' })).toMatchObject({
					result: {
						rows: [{ status: 'cancelled', error: { code: 'stopped' }, input: { secret: 1 } }]
					}
				});
				expect(yield* $runs(holder, { id: 'r5' })).toEqual({
					result: { error: '$runs: no automation run r5 you may read.' }
				});
			})
	);
	it.effect(
		"a run's clipped values name read_output's call id, and the whole run stays for it",
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
						result: Schema.Struct({
							rows: Schema.Tuple([Schema.Struct({ input: Schema.String })])
						}),
						full: Schema.Struct({
							rows: Schema.Tuple([Schema.Struct({ input: Schema.Struct({ text: Schema.String }) })])
						}),
						bounded: Schema.Literal(true)
					})
				)(yield* $runs(x, { id: 'rb' }));
				expect(answer.result.rows[0].input).toMatch(
				/\.\.\. \[clipped, \d+ bytes; read_output \{ call: 'call' \} reads it whole\]$/
			);
				expect(answer.full.rows[0].input.text).toBe(big.text);
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
						result(x, 'read', { request: { $logs: input } }),
						(answer) =>
							Schema.decodeUnknownSync(
								Schema.Struct({
									result: Schema.Struct({
										rows: Schema.Array(
											Schema.Struct({
												id: Schema.String,
												event: Schema.String,
												level: Schema.String,
												attributes: Schema.Json
											})
										),
										next: Schema.NullOr(Schema.String)
									})
								})
							)(answer).result
					);
				expect((yield* events({ level: 'warn' })).rows.map((l) => l.level)).toEqual([
					'error',
					'warn'
				]);
				expect((yield* events({ text: 'STARTING' })).rows.map((l) => l.event)).toEqual(['console']);
				expect((yield* events({ run: 'r2' })).rows).toHaveLength(3);
				expect((yield* events({ automation: 'billing.invoice' })).rows).toHaveLength(3);
				expect(
					(yield* events({
						since: '2026-09-21T01:00:02Z',
						until: '2026-09-22T00:00:00Z'
					})).rows.map((l) => l.level)
				).toEqual(['error', 'warn']);
				const newest = (yield* events({ run: 'r2' })).rows[0];
				expect(typeof newest?.attributes).toBe('string');
				const page = yield* events({ run: 'r2', limit: 2 });
				expect(
					(yield* events({ run: 'r2', after: page.next ?? '' })).rows.map((l) => l.event)
				).toEqual(['console']);
				expect(yield* result(yield* ctx({ authority: member() }), 'read', { request: { $logs: {} } })).toEqual({
					result: { error: "No '$logs' you may read. Ledgers: $runs, $approvals" }
				});
			})
	);
});

describe('host web search', () => {
	const seen: HostToolContext[] = [];
	const host = (name: string): HostTool => ({
		name,
		description: name,
		behavior: {},
		input: { type: 'object', properties: {} },
		read_only: true,
		call: async (_input, context) => {
			seen.push(context);
			return { ok: name };
		}
	});
	const host_tools = [host('web_search'), host('browser')];
	it.effect('a workspace MCP tool named like a host tool sits beside it, under its server', () =>
		Effect.gen(function* () {
			const own = yield* names(
				yield* ctx({
					host_tools,
					mcpTools: [
						{ server: 'kagi', name: 'web_search', description: 'Kagi', input: { type: 'object' } }
					]
				})
			);
			expect(own).toEqual(expect.arrayContaining(['kagi__web_search', 'web_search', 'browser']));
		})
	);
	it.effect('a schema the validator cannot follow never ends the turn', () =>
		Effect.gen(function* () {
			const dangling: HostTool = {
				...host('dangling'),
				input: { type: 'object', properties: { x: { $ref: '#/$defs/Gone' } } }
			};
			expect(
				yield* result(yield* ctx({ host_tools: [dangling] }), 'dangling', { x: 1 })
			).toEqual({
				result: { ok: 'dangling' }
			});
		})
	);
	it.live('a script calls a host tool by its own name; a tool that steers the turn throws', () =>
		Effect.gen(function* () {
			const x = yield* ctx({ host_tools });
			expect(
				yield* result(x, 'run_js', {
					code: "const found = await tool('web_search', {}); let asked; try { await tool('ask', { question: 'x' }) } catch (e) { asked = e.message } return { found, asked };"
				})
			).toMatchObject({
				result: {
					answer: {
						found: { ok: 'web_search' },
						asked: expect.stringContaining("cannot call 'ask'")
					}
				}
			});
		})
	);
	it.effect('the host call carries the turn question', () =>
		Effect.gen(function* () {
			seen.length = 0;
			yield* result(yield* ctx({ host_tools, question: 'who won?' }), 'web_search', {});
			expect(seen.map((c) => c.question)).toEqual(['who won?']);
		})
	);
	it.effect(
		"a host tool requests through the actor's connection, signed host-side: it never reads the token, and the connection's allow binds it",
		() =>
			Effect.gen(function* () {
				const native = yield* workspace;
				const db = Context.get(native, TenantDb);
				const sealed = yield* credentials(db, Context.get(native, Secrets)).pipe(Effect.provide(NodeCrypto.layer));
				const instance = randomUUID(),
					TOKEN = 'github_pat_TEST_0000000000000000000000';
				yield* db.write({
					text: `INSERT INTO sys_integration (id, integration, name, active) VALUES ($1, 'github', 'GitHub', true)`,
					params: [instance]
				});
				yield* sealed.write(instance, null, new Map([['credential', { token: TOKEN }]]));
				const sent: HttpRequest[] = [];
				const http: Http['Service'] = {
					fetch: (request) =>
						Effect.sync(() => {
							sent.push(request);
							return { status: 200, headers: [], body: new Uint8Array([0x1f, 0x8b]) };
						})
				};
				const attempt = (
					context: HostToolContext,
					integration: string,
					method: string,
					path: string
				) =>
					context.request === undefined
						? Promise.resolve('no request')
						: context
								.request(integration, { method, path, max_bytes: 1024 }, new AbortController().signal)
								.then(
									(response) => (response === undefined ? 'not connected' : response.status),
									(error: unknown) => (error instanceof Error ? error.message : 'refused')
								);
				const probe: HostTool = {
					...host('probe'),
					call: async (_, context) => ({
						keys: Object.keys(context).toSorted(),
						tarball: await attempt(context, 'github', 'GET', '/repos/acme/calc/tarball/main'),
						post: await attempt(context, 'github', 'POST', '/repos/acme/calc/issues'),
						issues: await attempt(context, 'github', 'GET', '/repos/acme/calc/issues'),
						escape: await attempt(context, 'github', 'GET', '../user/repos'),
						gitlab: await attempt(context, 'gitlab', 'GET', '/')
					})
				};
				const x = yield* ctx({ host_tools: [probe] }, { credentials: sealed, http });
				const answer = yield* result(x, 'probe', {});
				expect(answer).toMatchObject({
					result: {
						tarball: 200,
						post: expect.stringContaining('does not allow POST /repos/acme/calc/issues'),
						issues: expect.stringContaining('does not allow GET /repos/acme/calc/issues'),
						escape: expect.stringContaining("leaves the integration's base URL"),
						gitlab: 'not connected'
					}
				});
				// the tool's context holds no credential, and nothing it answered names the token
				expect(JSON.stringify(answer)).not.toContain('"credential"');
				expect(JSON.stringify(answer)).not.toContain(TOKEN);
				// only the allowed request reached the network, signed there
				expect(sent.map((r) => [r.method, r.url, Object.fromEntries(r.headers)['authorization']])).toEqual([
					['GET', 'https://api.github.com/repos/acme/calc/tarball/main', `Bearer ${TOKEN}`]
				]);
				// a paused connection holds nothing
				yield* db.write({
					text: 'UPDATE sys_integration SET active = false WHERE id = $1',
					params: [instance]
				});
				expect(yield* result(x, 'probe', {})).toMatchObject({
					result: { tarball: 'not connected' }
				});
				// a workspace connection lends its token to an administrator's host tools alone, unless its definition lends it
				yield* db.write({
					text: 'UPDATE sys_integration SET active = true WHERE id = $1',
					params: [instance]
				});
				const plain = yield* ctx({ host_tools: [probe], authority: member({ tools: ['probe'] }) }, { credentials: sealed, http });
				expect(yield* result(plain, 'probe', {})).toMatchObject({
					result: { tarball: 'not connected' }
				});
				expect(sent).toHaveLength(1);
				yield* db.write({ text: 'DELETE FROM sys_integration WHERE id = $1', params: [instance] });
			})
	);
});

describe('approvals, record history and the audit trail', () => {
	const created = Effect.fnUntraced(function* (x: ToolContext) {
		const answer = Schema.decodeUnknownSync(
			Schema.Struct({
				result: Schema.Struct({
					stored: Schema.Struct({
						tasks: Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
					})
				})
			})
		)(yield* result(x, 'act', { acts: { 'tasks.create': [{ title: 'audited' }] } }));
		return first(answer.result.stored.tasks.rows).id;
	});
	it.effect(
		'record history names who changed a record by their label to a reader, and refuses one who cannot read it',
		() =>
			Effect.gen(function* () {
				const ada = '0199a000-0000-4000-8000-00000000ada1';
				// its own turn: an invocation's ids derive from it, so this create is not a replay of another test's
				const admin = yield* ctx({ turn: 'ada', authority: member({ admin: true, id: ada }) });
				yield* admin.engine.db.write({
				text: "INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@example.test', 'Ada Lovelace', 'staff', true) ON CONFLICT DO NOTHING",
				params: [ada]
			});
				const id = yield* created(admin);
				const history = yield* result(admin, 'read', {
					request: { tasks: { where: { id: { eq: id } }, history: true } }
				});
				// the writer reads as the person, never as an account id
				expect(history).toMatchObject({
					result: { tasks: { rows: [{ id, $history: [{ revision: 1, by: 'Ada Lovelace' }] }] } }
				});
				expect(history).not.toMatchObject({
					result: { tasks: { rows: [{ $history: [{ actor: expect.anything() }] }] } }
				});
				// staff may create tasks but read none: no history either
				const staff = yield* ctx({
					authority: Effect.runSync(compile_authority(manifest, { actor: member().actor, admin: false, policies: ['staff'] }, 's'))
				});
				expect(yield* result(staff, 'read', { request: { tasks: { history: true } } })).toEqual({
				result: { error: expect.stringContaining("You read no 'tasks'") }
			});
			})
	);
	it.effect(
		'approvals are judged by whether the person reads the record, as their own screens are',
		() =>
			Effect.gen(function* () {
				const id = yield* created(yield* ctx());
				const seen: boolean[] = [];
				const approvals: Partial<AgentEngine['approvals']> = {
				list: (_filter, _authority, readable) =>
					Effect.map(readable('tasks', id), (can) => {
						seen.push(can);
						return [];
					}),
				view: () => Effect.succeed(Option.none())
			};
				const staff = Effect.runSync(compile_authority(manifest, { actor: member().actor, admin: false, policies: ['staff'] }, 's'));
				for (const authority of [member({ admin: true }), staff])
					expect(
						yield* result(yield* ctx({ authority }, { approvals }), 'read', {
							request: { $approvals: {} }
						})
					).toEqual({
						result: { rows: [], next: null }
					});
				expect(seen).toEqual([true, false]);
				// a row's own requests ride on it
				expect(
					yield* result(yield* ctx({}, { approvals }), 'read', {
						request: { tasks: { where: { id: { eq: id } }, approvals: true } }
					})
				).toMatchObject({ result: { tasks: { rows: [{ id, $approvals: [] }] } } });
			})
	);
	it.effect('read takes the shapes its description states: order_by keyed by the field, $approvals without a page size', () =>
		Effect.gen(function* () {
			const x = yield* ctx();
			const described = (yield* requiredTool(x, 'read')).description;
			expect(described).toContain('{ "<field>": "asc"|"desc" } (one key, the field\'s name)');
			expect(described).toContain('"$approvals": { model, ids, all }');
			expect(described).toContain('(no limit or after)');
			expect(
				yield* result(x, 'read', { request: { tasks: { order_by: [{ title: 'desc' }] } } })
			).toMatchObject({ result: { tasks: { rows: expect.any(Array) } } });
			// `field` is no field's name: the field names the key
			expect(
				yield* result(x, 'read', { request: { tasks: { order_by: [{ field: 'title' }] } } })
			).toMatchObject({ result: { error: expect.stringContaining("'field' is asc or desc") } });
			expect(yield* result(x, 'read', { request: { $approvals: { model: 'tasks', all: true } } })).toEqual({
				result: { rows: expect.any(Array), next: null }
			});
			expect(yield* result(x, 'read', { request: { $approvals: { limit: 5 } } })).toMatchObject({
				result: { error: expect.stringContaining('limit') }
			});
		})
	);
	it.effect('only an administrator reads the audit trail', () =>
		Effect.gen(function* () {
			const audit = yield* audit_shape(memory_audit().port).pipe(Effect.provide(NodeCrypto.layer));
			const admin = yield* ctx({}, { audit });
			const trail = (x: ToolContext) => result(x, 'read', { request: { $audit: { limit: 5 } } });
			expect(yield* trail(admin)).toEqual({ result: { rows: [], next: null } });
			for (const x of [
				yield* ctx({ authority: member() }, { audit }),
				yield* ctx({ authority: member({ admin: true, external: true }) }, { audit }),
				yield* ctx()
			])
				expect(yield* trail(x)).toEqual({
					result: { error: expect.stringContaining("No '$audit' you may read.") }
				});
		})
	);
});

describe('a transcript row', () => {
	it('holds no NUL, and keeps a backslash that only reads like one', () => {
		expect(storable({ text: 'AC\0\0', code: '\\u0000', [`k\0`]: 1 })).toEqual({
			text: 'AC\ufffd\ufffd',
			code: '\\u0000',
			'k\ufffd': 1
		});
		const clean = { text: 'plain' };
		expect(storable(clean)).toBe(clean);
	});
});

describe('the catalogue', () => {
	it.effect(
		'lists host tools by name for the roles holding them; MCP tools are native by a provider-safe name',
		() =>
			Effect.gen(function* () {
				const host_calls: HostToolContext[] = [];
				const mcp_calls: { server: string; tool: string; input: Json }[] = [];
				const operation: HostTool = {
					name: 'workspace_lang',
					description: 'Read exported types',
					input: { type: 'object' },
					behavior: {},
					read_only: true,
					source: true,
					call: async (_input, context) => {
						host_calls.push(context);
						return { ok: true };
					}
				};
				const external = {
					server: 'search',
					name: 'web_search',
					description: 'Search',
					input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
				};
				const x = yield* ctx({
					host_tools: [operation],
					mcpTools: [external],
					// each MCP call holds for the person's card; these run as approved
					approved: () => true,
					mcp: {
						tools: () => Effect.succeed([external]),
						call: (server, tool, input) =>
							Effect.sync(() => {
								mcp_calls.push({ server, tool, input });
								return { ok: true };
							})
					}
				});
				const offered = yield* catalogue(x);
				const ordinary = yield* catalogue(yield* ctx({ authority: member() }));
				const listed = (c: typeof offered) => [...c.fixed, ...c.host].map(({ name }) => name);
				expect(listed(offered)).toEqual([...listed(ordinary), 'workspace_lang']);
				expect(listed(offered)).toEqual(expect.arrayContaining(['run_tool', 'read', 'act']));
				expect(offered.mcp).toEqual([
					{ name: 'search__web_search', description: 'Search', input: external.input, behavior: {} }
				]);
				// planning binds only read-only host tools, yet the list stays the same
				const planning = yield* catalogue(yield* ctx({ host_tools: [{ ...operation, read_only: false }], mode: 'plan' }));
				expect(listed(planning)).toContain('workspace_lang');
				expect(offered.index['tool:search__web_search']).toBe('search__web_search(q: string) — Search');
				expect(yield* offered.run('run_tool', { name: 'workspace_lang', input: {} }, 'direct')).toMatchObject({
					result: { error: expect.stringContaining('call it by its own name') }
				});
				expect(host_calls).toEqual([]);
				expect(yield* offered.run('workspace_lang', {}, 'host-call')).toEqual({
					result: { ok: true }
				});
				expect(host_calls).toMatchObject([{ call_id: 'host-call', conversation: x.conv.id }]);
				// by its own name when native, through run_tool when a merge added it later
				expect(yield* offered.run('search__web_search', { q: 'news' }, 'mcp-call')).toEqual({
					result: { ok: true }
				});
				expect(
					yield* offered.run('run_tool', { name: 'search__web_search', input: { q: 'more' } }, 'mcp-later')
				).toEqual({ result: { ok: true } });
				expect(mcp_calls).toEqual([
					{ server: 'search', tool: 'web_search', input: { q: 'news' } },
					{ server: 'search', tool: 'web_search', input: { q: 'more' } }
				]);
			})
	);
	it.effect(
		'fixes each audience its own tool list: a channel never sees the source, the tab or download',
		() =>
			Effect.gen(function* () {
				const listOf = (audience: 'staff' | 'member' | 'channel') =>
				Effect.flatMap(ctx({ audience, workspace: { files: async () => [], read: async () => null } }), (x) => Effect.map(catalogue(x), (c) => c.fixed.map((t) => t.name)));
				const channel = yield* listOf('channel'),
				staff = yield* listOf('staff'),
				external = yield* listOf('member');
				for (const hidden of [
					'workspace_read',
					'workspace_grep',
					'workspace_glob',
					'workspace_list_dir',
					'page',
					'download'
				])
					expect(channel).not.toContain(hidden);
				expect(channel).toContain('read_messages');
				expect(staff).toEqual(expect.arrayContaining(['page', 'workspace_read', 'update_plan']));
				expect(staff).not.toContain('read_messages');
				expect(external).not.toContain('workspace_read');
				// the list is the audience's, whatever the step's mode or authority
				expect((yield* catalogue(yield* ctx({ mode: 'plan' }))).fixed).toEqual((yield* catalogue(yield* ctx())).fixed);
				expect((yield* catalogue(yield* ctx({ authority: member() }))).fixed).toEqual((yield* catalogue(yield* ctx())).fixed);
			})
	);
	it('a merge appends only what changed: added or changed lines and removed names, counts past ten', () => {
		const base = {
			'skill:pricing': 'pricing — How we price',
			'model:tasks': 'tasks(title: text) writes create',
			'tool:search__web_search': 'search__web_search(q: string) — Search'
		};
		// the first note lists everything but the native tools
		expect(catalogueNote(base, undefined)).toBe(
			'[Catalogue]\nSkills (skill reads one or several via requests):\n- pricing — How we price\nModels (fields; reads and writes beyond the default):\n- tasks(title: text) writes create'
		);
		expect(catalogueNote(base, base)).toBeUndefined();
		const merged = {
			'skill:pricing': 'pricing — How we price now',
			'model:tasks': 'tasks(title: text) writes create',
			'tool:search__news': 'search__news(q: string) — News'
		};
		expect(catalogueNote(merged, base)).toBe(
			'[Catalogue changed by a merge]\nSkills (skill reads one or several via requests):\n- pricing — How we price now\nTools (run_tool { name, input }):\n- search__news(q: string) — News\nRemoved: search__web_search'
		);
		const many = Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`skill:s${n}`, `s${n} — x`]));
		expect(catalogueNote(many, base)).toBe(
			'[Catalogue changed by a merge] 11 added, 0 changed, 3 removed: describe_workspace and skill read them.'
		);
	});
	it.effect(
		'for an administrator with no MCP stays under 18,000 characters and names no model of the workspace',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx(
					{
						workspace: { files: async () => [], read: async () => null },
						delegation: true,
						skills: { authoring: skill_of({ 'SKILL.md': '---\ndescription: x\n---\n' }) },
						geocoder: { search: () => Effect.succeed([]), reverse: () => Effect.succeed(null) },
						host_tools: browserTools(yield* Browser)
					},
					{ convert: { targets: ['pdf'], convert: () => Effect.succeed(new Uint8Array()) } }
				);
				// the host's own tools (here the browser) are the host's budget
				const texts = (yield* catalogue(x)).fixed
					.filter((t) => !x.host_tools.some((host) => host.name === t.name))
					.map((t) => `${t.description ?? ''}${JSON.stringify(t.input)}`);
				expect(texts.join('').length).toBeLessThan(18_000);
				for (const model of Object.keys(manifest.models))
					for (const text of texts) expect(text).not.toContain(model);
			}).pipe(Effect.provide(Browser.fromAbi(off)))
	);
});

describe('connect: the agent makes the connection, the person pairs it on a card', () => {
	const Held = Schema.Struct({
		confirm: Schema.Literal(true),
		input: Schema.Struct({ instance: Schema.String, integration: Schema.String })
	});
	const row = (x: ToolContext, id: string) =>
		x.engine.db.rows(
			Schema.Struct({
				integration: Schema.String,
				owner: Schema.NullOr(Schema.String),
				envoy: Schema.NullOr(Schema.String)
			}),
			{ text: 'SELECT integration, owner, envoy FROM sys_integration WHERE id = $1', params: [id] }
		);
	const user = (x: ToolContext, id: string, email: string, admin = false) =>
		x.engine.db.write({
			text: "INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, $2, $2, 'staff', $3) ON CONFLICT DO NOTHING",
			params: [id, email, admin]
		});
	it.effect(
		'creates a workspace GitHub connection through the guarded write and holds a card; no credential in the answer',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({ turn: 'connect-github' }, { manifest: layered(manifest) });
				const answer = yield* result(x, 'connect', {
					integration: 'github',
					owner: 'workspace',
					name: 'Org GitHub'
				});
				const held = Schema.decodeUnknownSync(Held)(answer);
				expect(held.input.integration).toBe('github');
				expect(yield* row(x, held.input.instance)).toEqual([
					{ integration: 'github', owner: null, envoy: null }
				]);
				expect(JSON.stringify(answer)).not.toMatch(/credential|token|secret/i);
				// a channel sender never gets the tool; nor does a turn with no card to show
				expect(fixedTools('channel', false, { source: true, delegation: true }).map((t) => t.name)).not.toContain('connect');
				expect(yield* names(yield* ctx({ inApp: false }, { manifest: layered(manifest) }))).not.toContain('connect');
			})
	);
	it.effect(
		'a workspace-declared integration connects the same way, and describe_workspace lists it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const declared: EngineManifest = {
					...manifest,
					integrations: {
						crm: {
							description: 'The CRM account.',
							driver: 'http',
							http: { base_url: 'https://api.crm.example', auth: { bearer: 'api_key' } },
							credential: { api_key: { kind: 'text' } }
						}
					}
				};
					const native = yield* Layer.build(TestWorkspace.layer({ manifest: declared }));
					const x = yield* ctx(
						{ turn: 'connect-crm' },
						{
							manifest: layered(declared),
							db: Context.get(native, TenantDb),
							calls: Context.get(native, Callables)
						}
					);
					const held = Schema.decodeUnknownSync(Held)(
						yield* result(x, 'connect', {
							integration: 'crm',
							owner: 'workspace',
							configuration: {}
						})
					);
					expect(yield* row(x, held.input.instance)).toEqual([
						{ integration: 'crm', owner: null, envoy: null }
					]);
					expect(yield* result(x, 'describe_workspace', {})).toEqual({
					result: expect.stringContaining('crm "The CRM account."')
				});
					expect(yield* result(x, 'connect', { integration: 'nope', owner: 'workspace' })).toEqual({
					result: { error: expect.stringContaining('crm') }
				});
				})
			)
	);
	it.effect('a personal connection is the caller own: owner me, never a colleague', () =>
		Effect.gen(function* () {
			const una = '0199a000-0000-4000-8000-0000000c0a01';
			const x = yield* ctx({ turn: 'connect-mine', authority: member({ admin: true, id: una }) }, { manifest: layered(manifest) });
			yield* user(x, una, 'una@example.test', true);
			const held = Schema.decodeUnknownSync(Held)(yield* result(x, 'connect', { integration: 'email', owner: 'me' }));
			expect(yield* row(x, held.input.instance)).toEqual([
				{ integration: 'email', owner: una, envoy: null }
			]);
			// there is no way to name someone else as the owner
			expect(
				yield* result(x, 'connect', {
					integration: 'email',
					owner: '0199a000-0000-4000-8000-0000000c0a02'
				})
			).toEqual({
				result: { error: expect.stringContaining('Invalid parameters') }
			});
			// a colleague's personal connection is theirs to pair
			const colleague = '0199a000-0000-4000-8000-0000000c0a03';
			const other = yield* ctx({ turn: 'connect-theirs', authority: member({ admin: true, id: colleague }) }, { manifest: layered(manifest) });
			expect(yield* result(other, 'connect', { instance: held.input.instance })).toEqual({
				result: { error: 'Only its owner pairs a personal connection.' }
			});
		})
	);
	it.effect('a caller without the write grant is refused and nothing is created', () =>
		Effect.gen(function* () {
			const x = yield* ctx({ turn: 'connect-refused', authority: member() }, { manifest: layered(manifest) });
			const before = yield* x.engine.db.rows(Schema.Struct({ n: Schema.Number }), {
				text: 'SELECT count(*)::int AS n FROM sys_integration',
				params: []
			});
			const answer = yield* result(x, 'connect', { integration: 'github', owner: 'workspace' });
			expect(Schema.is(Held)(answer)).toBe(false);
			expect(
				yield* x.engine.db.rows(Schema.Struct({ n: Schema.Number }), {
					text: 'SELECT count(*)::int AS n FROM sys_integration',
					params: []
				})
			).toEqual(before);
		})
	);
	it.effect("an envoy's unpaired channel is paired in place: a card, no second row", () =>
		Effect.gen(function* () {
			const x = yield* ctx({ turn: 'connect-envoy' }, { manifest: layered(manifest) });
			const envoy = '0199a000-0000-7000-8000-0000000c0e01';
			yield* x.engine.db.write({
				text: "INSERT INTO sys_envoy (id, name) VALUES ($1, 'Desk') ON CONFLICT DO NOTHING",
				params: [envoy]
			});
			yield* seed_accounts(x.engine.db, [{ id: 'connect-desk', integration: 'whatsapp', envoy }]);
			expect(yield* result(x, 'connect', { integration: 'whatsapp', envoy })).toEqual({
				confirm: true,
				input: { instance: 'connect-desk', integration: 'whatsapp' }
			});
			// once the host reports it connected, the call answers the fact, without a card
			yield* x.engine.db.write({
				text: `UPDATE sys_integration SET status = '{"state":"connected"}'::jsonb WHERE id = 'connect-desk'`,
				params: []
			});
			expect(yield* result(x, 'connect', { instance: 'connect-desk' })).toEqual({
				result: {
					instance: 'connect-desk',
					integration: 'whatsapp',
					owner: 'workspace',
					state: 'connected'
				}
			});
		})
	);
});

describe('capability identity: one advertised name, one operation', () => {
	const hostTool = (name: string, calls: string[]): HostTool => ({
		name,
		description: name,
		behavior: {},
		input: { type: 'object', properties: {} },
		call: async () => {
			calls.push(name);
			return { host: name };
		}
	});
	const mcpTool = (server: string, name: string) => ({
		server,
		name,
		description: name,
		input: { type: 'object' }
	});
	type McpCall = { server: string; tool: string };
	const recording = (calls: McpCall[]): ToolContext['mcp'] => ({
		tools: () => Effect.succeed([]),
		call: (server: string, tool: string) =>
			Effect.sync(() => {
				calls.push({ server, tool });
				return { server, tool };
			})
	});
	const unavailable = (name: string) => ({
		result: { error: expect.stringContaining(`Tool '${name}' is not available`) }
	});
	const HAS = { source: true, delegation: true };
	it('each audience lists every native tool once, and the tab only to staff', () => {
		for (const audience of ['staff', 'member', 'channel'] as const) {
			const listed = fixedTools(audience, false, HAS).map((t) => t.name);
			expect(new Set(listed).size).toBe(listed.length);
		}
		expect(fixedTools('member', false, HAS).map((t) => t.name)).not.toContain('page');
	});
	it.effect('a host tool named like a native, or a name providers refuse, is offered nowhere and never runs', () =>
		Effect.gen(function* () {
			const calls: string[] = [];
			const offered = yield* catalogue(
				yield* ctx({
					host_tools: [
						hostTool('act', calls),
						hostTool('read', calls),
						hostTool('web.search', calls),
						hostTool('x'.repeat(65), calls)
					],
					browser_tools: [hostTool('page', calls)]
				})
			);
			expect(offered.host).toEqual([]);
			expect([...offered.fixed, ...offered.host].filter((t) => t.name === 'act')).toHaveLength(1);
			// `act` stays the native atomic write and `page` the person's tab: their own answers, never a host call
			expect(yield* offered.run('act', { acts: {} }, 'c1')).toEqual({
				result: { error: 'An act needs a non-empty map of generated writes.' }
			});
			expect(yield* offered.run('page', { path: '/nowhere' }, 'c2')).toMatchObject({
				result: { error: expect.stringContaining('No page /nowhere') }
			});
			expect(yield* offered.run('web.search', {}, 'c3')).toMatchObject(unavailable('web.search'));
			expect(calls).toEqual([]);
		})
	);
	it.effect('contributions sharing a name are all refused, whatever order or source they come from', () =>
		Effect.gen(function* () {
			const calls: string[] = [],
				mcpCalls: McpCall[] = [];
			const fleet = hostTool('lookup', calls),
				studio = hostTool('lookup', calls),
				notes = hostTool('notes', calls);
			for (const over of [
				{ browser_tools: [fleet], host_tools: [studio, notes] },
				{ browser_tools: [], host_tools: [notes, studio, fleet] },
				{ browser_tools: [], host_tools: [fleet, notes, studio] }
			]) {
				const offered = yield* catalogue(yield* ctx(over));
				expect(offered.host.map((t) => t.name)).toEqual(['notes']);
				expect(yield* offered.run('lookup', {}, 'c')).toMatchObject(unavailable('lookup'));
			}
			// an MCP tool and a host tool that would share a provider-visible name
			const clash = yield* catalogue(
				yield* ctx({
					host_tools: [hostTool('kagi__web_search', calls)],
					mcpTools: [mcpTool('kagi', 'web_search')],
					mcp: recording(mcpCalls),
					approved: () => true
				})
			);
			expect([...clash.host, ...clash.mcp]).toEqual([]);
			expect(yield* clash.run('kagi__web_search', {}, 'c1')).toMatchObject(unavailable('kagi__web_search'));
			expect(
				yield* clash.run('run_tool', { name: 'kagi__web_search', input: {} }, 'c2')
			).toMatchObject(unavailable('kagi__web_search'));
			expect(calls).toEqual([]);
			expect(mcpCalls).toEqual([]);
		})
	);
	it.effect('MCP names never merge two tools: punctuation, separators, Unicode and length', () =>
		Effect.gen(function* () {
			const pairs = [
				['s', 'a.b'],
				['s', 'a_b'],
				['s', 'a-b'],
				['a_', 'b'],
				['a', '_b'],
				['a__b', 'c'],
				['a', 'b__c'],
				['s', '検索'],
				['s', '検索する'],
				['s', ''],
				['s', 'x'.repeat(100)],
				['s', `${'x'.repeat(99)}y`]
			] as const;
			const calls: McpCall[] = [];
			const offered = yield* catalogue(
				yield* ctx({
					mcpTools: pairs.map(([server, name]) => mcpTool(server, name)),
					mcp: recording(calls),
					approved: () => true
				})
			);
			const listed = offered.mcp.map((t) => t.name);
			expect(new Set(listed).size).toBe(pairs.length);
			for (const name of listed) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
			// readable where it reads back to one pair; otherwise its readable start and a digest of the pair
			expect(listed.slice(0, 7)).toEqual([
				expect.stringMatching(/^s_a_b_[0-9a-f]{12}$/),
				's__a_b',
				's__a-b',
				expect.stringMatching(/^a_b_[0-9a-f]{12}$/),
				'a___b',
				expect.stringMatching(/^a_b_c_[0-9a-f]{12}$/),
				'a__b__c'
			]);
			// each advertised name reaches its exact pair
			for (const [at, name] of listed.entries()) yield* offered.run(name, {}, `c${at}`);
			expect(calls).toEqual(pairs.map(([server, tool]) => ({ server, tool })));
			// the same discovery is named alike on the next step, in any order
			const again = yield* catalogue(
				yield* ctx({ mcpTools: [...pairs].reverse().map(([server, name]) => mcpTool(server, name)) })
			);
			expect(again.mcp.map((t) => t.name)).toEqual([...listed].reverse());
		})
	);
	it.effect("an approval, the advertised name and the server's call identify the same tool", () =>
		Effect.gen(function* () {
			const calls: McpCall[] = [];
			const tools = [mcpTool('s', 'a.b'), mcpTool('s', 'a_b')];
			const [dotted, plain] = (yield* catalogue(yield* ctx({ mcpTools: tools }))).mcp.map((t) => t.name);
			const offered = yield* catalogue(
				yield* ctx({ mcpTools: tools, mcp: recording(calls), approved: (name) => name === dotted })
			);
			expect(yield* offered.run(required(plain), { q: 1 }, 'c1')).toEqual({ confirm: true });
			expect(yield* offered.run(required(dotted), { q: 1 }, 'c2')).toEqual({
				result: { server: 's', tool: 'a.b' }
			});
			expect(calls).toEqual([{ server: 's', tool: 'a.b' }]);
			expect(offered.presentation('run_tool', { name: required(dotted), input: { q: 1 } }).name).toBe(dotted);
		})
	);
	it.effect('a request carries at most TOOLS_PER_REQUEST tools: the MCP tools past the room are left out by name, in any order', () =>
		Effect.gen(function* () {
			const calls: McpCall[] = [];
			const listed = Array.from({ length: TOOLS_PER_REQUEST }, (_, i) =>
				mcpTool('s', `t${String(i).padStart(3, '0')}`)
			);
			const advertised = listed.map((tool) => `s__${tool.name}`);
			const offered = yield* catalogue(
				yield* ctx({ mcpTools: [...listed].reverse(), mcp: recording(calls), approved: () => true })
			);
			const room = TOOLS_PER_REQUEST - offered.fixed.length - offered.host.length;
			expect(room).toBeGreaterThan(0);
			expect(room).toBeLessThan(TOOLS_PER_REQUEST);
			// the first by name stay, whatever order discovery answered in
			expect(offered.mcp.map((tool) => tool.name).sort()).toEqual(advertised.slice(0, room));
			const again = yield* catalogue(yield* ctx({ mcpTools: listed }));
			expect(again.mcp.map((tool) => tool.name)).toEqual(advertised.slice(0, room));
			// one left out is in no list and runs nothing, by its name or through run_tool
			const left = required(advertised.at(-1));
			expect(offered.available.map((tool) => tool.name)).not.toContain(left);
			expect(yield* offered.run(left, {}, 'c1')).toMatchObject(unavailable(left));
			expect(yield* offered.run('run_tool', { name: left, input: {} }, 'c2')).toMatchObject(unavailable(left));
			expect(calls).toEqual([]);
		})
	);
	it.effect('an unknown capability is unavailable, by its name and through run_tool', () =>
		Effect.gen(function* () {
			const offered = yield* catalogue(yield* ctx());
			expect(yield* offered.run('nope', {}, 'c1')).toMatchObject(unavailable('nope'));
			expect(yield* offered.run('run_tool', { name: 'nope', input: {} }, 'c2')).toMatchObject(
				unavailable('nope')
			);
		})
	);
	it.effect('a tool the actor is not granted, or one holding for a card, performs nothing', () =>
		Effect.gen(function* () {
			const calls: string[] = [],
				mcpCalls: McpCall[] = [];
			const denied = yield* catalogue(
				yield* ctx({ authority: member(), host_tools: [hostTool('lookup', calls)] })
			);
			expect(denied.host).toEqual([]);
			expect(yield* denied.run('lookup', {}, 'c1')).toMatchObject(unavailable('lookup'));
			const held = yield* catalogue(
				yield* ctx({
					host_tools: [{ ...hostTool('lookup', calls), confirm: () => true }],
					mcpTools: [mcpTool('s', 'send')],
					mcp: recording(mcpCalls)
				})
			);
			expect(yield* held.run('lookup', {}, 'c2')).toEqual({ confirm: true });
			expect(yield* held.run('s__send', {}, 'c3')).toEqual({ confirm: true });
			expect(calls).toEqual([]);
			expect(mcpCalls).toEqual([]);
		})
	);
});
