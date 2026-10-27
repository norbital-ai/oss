// The agent catalogue over typed native ports: one-write act, approvals, workspace search and run waits.
import { memberCap } from '../src/engine/agent/settings.ts';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Deferred, Effect, Fiber, Layer, Predicate, Schema } from 'effect';
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
import type { AgentEngine } from '../src/engine/agent/index.ts';
import {
	catalogue,
	jobs,
	type HostTool,
	type HostToolContext,
	type ToolContext,
	type WorkspacePort
} from '../src/engine/agent/tools.ts';
import { TenantDb, type RawDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { Bundler, Files, GuestIsolates, Http, Logs } from '../src/engine/ports.ts';
import { bundler } from '../src/node/bundler/index.ts';
import { BROKEN, filesOf, RENDER, REPORT, SALES, skillOf } from './support/run-file-trees.ts';
import { REFERENCE } from '../src/engine/agent/run-js.ts';
import { treeDigest } from '../src/engine/artifact/read.ts';
import { Approvals, Callables, Live, Reads, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../src/test/effect.ts';
import { toolSchema } from '../src/engine/agent/ai.ts';
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
	models: {},
	automations: [],
	capabilities: { apps: [], tools: o.tools ?? [], mcp: [], skills: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	exposures: {
		tasks: { read: { tasks: { fields: 'all' } }, create: { columns: { tasks: ['title'] } } }
	},
	models: { tasks: { description: 'A task', label: 'title', fields: { title: { kind: 'text' } } } },
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
		const native = yield* Layer.build(TestWorkspace.layer({ manifest: m }));
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
				...(engine.read === undefined ? {} : { read: engine.read }),
				...(engine.act === undefined ? {} : { act: engine.act }),
				...(engine.convert === undefined ? {} : { convert: engine.convert }),
				guest: engine.guest ?? Context.get(native, GuestIsolates),
				...(engine.http === undefined ? {} : { http: engine.http }),
				...(engine.bundler === undefined ? {} : { bundler: engine.bundler })
			},
			authority: member({ admin: true }),
			bindings: { now: '2026-09-26T00:00:00.000Z', today: '2026-09-26', tz: 'UTC', params: {} },
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
			files: [],
			jobs: yield* jobs(),
			setPlan: () => Effect.void,
			setGoals: () => Effect.void,
			compact: () => false,
			ask: () => {},
			messages: () => Effect.succeed([]),
			row: () => Effect.succeed(undefined),
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
/** Rows pushed into a context's runtime log, `id` their position. */
const logRows = (
	x: ToolContext,
	rows: readonly (Pick<LogRow, 'at' | 'severity' | 'event' | 'invocation' | 'attributes'> &
		Partial<Pick<LogRow, 'run'>>)[]
) => {
	const log = kitLogs.get(x);
	if (log === undefined) throw new Error('no kit log for this context');
	for (const row of rows)
		log.push({ run: null, conversation: null, turn: null, ...row, id: String(log.length + 1) });
};
/** This step's tool names, one tool of its toolkit (or none), and one call run as the actor (P7: the catalogue is a toolkit). */
const names = (x: ToolContext) => Effect.map(catalogue(x), (c) => c.tools.map((t) => t.name));
const tool = (x: ToolContext, name: string) =>
	Effect.map(catalogue(x), (c) => (Object.hasOwn(c.toolkit.tools, name) ? c.toolkit.tools[name] : undefined));
const requiredTool = (x: ToolContext, name: string) =>
	Effect.flatMap(tool(x, name), (t) =>
		t === undefined ? Effect.die(new Error(`missing tool ${name}`)) : Effect.succeed(t)
	);
const result = (x: ToolContext, name: string, input: Json) =>
	Effect.flatMap(catalogue(x), (c) => c.run(name, input, 'call'));
const first = <A>(items: readonly A[]): A => {
	const item = items[0];
	if (item === undefined) throw new Error('fixture produced no item');
	return item;
};
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
		'read takes one layer map: every root in one crossing; an unreadable root refuses the call',
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const answer = { tasks: { rows: [{ id: '1', title: 'Fix the van' }], next: null } };
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
					yield* result(x, 'read', { tasks: { where: { id: { eq: '1' } }, limit: 5 } })
				).toMatchObject({ result: answer });
				expect(reads).toHaveLength(1);
				// the schema names the caller's roots and paths (propertyNames): an unreadable root is no valid key
				expect(yield* result(x, 'read', { tasks: {}, secrets: {} })).toEqual({
					result: { error: expect.stringContaining('secrets') }
				});
				const read = yield* requiredTool(x, 'read');
				expect(JSON.stringify(toolSchema(read))).toContain('propertyNames');
				expect(reads).toHaveLength(1);
			})
	);
	it.effect(
		'the removed read forms are refused by the schema before any read: { model }, { query, input }, { reads }, an undeclared layer, a sixth level',
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const x = yield* ctx(
					{},
					{
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [{ tasks: { rows: [], next: null } }];
							})
					}
				);
				for (const input of [
					{ model: 'tasks' },
					{ query: 'tasks.open', input: {} },
					{ reads: [{ model: 'tasks' }] },
					{ 'tasks.nope': {} },
					{ tasks: { search: true } },
					{ tasks: { select: { title: true } } },
					{ 'tasks.a.b.c.d.e': {} }
				])
					expect(yield* result(x, 'read', input)).toEqual({
						result: { error: expect.stringContaining('Invalid parameters for tool') }
					});
				expect(reads).toHaveLength(0);
				// text goes in search (or a `like` where) of the root it reads
				yield* result(x, 'read', { tasks: { search: '2807' } });
				expect(reads).toHaveLength(1);
				expect(JSON.stringify(reads.at(-1))).toContain('2807');
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
						return { captured: [], v: 0, outcome: { kind: 'committed', output: null, records: [] } };
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
});
describe('approval decisions through act', () => {
	it.effect(
		'offered to staff when writes need approval; they decide as themselves, confirming first in the app',
		() =>
			Effect.gen(function* () {
				expect(yield* tool(yield* ctx({ authority: member({ external: true }) }), 'act')).toBeUndefined();
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
				const big = (n: number) => `## Part ${n}\n${'word '.repeat(1200)}\n`;
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
			})
	);
});
describe('workspace_search', () => {
	const source: { [path: string]: string } = {
		'src/a.ts': 'x\nbolt.read(tasks)\nexport function total(a: number) {\n\treturn a;\n}\n',
		'src/app/b.svelte': '<p>{bolt.READ}</p>'
	};
	const workspace: WorkspacePort = {
		files: async () => Object.keys(source),
		read: async (path) => source[path] ?? null
	};
	it.effect(
		'finds lines by text, reads a file by path, and searches a draft; external members get no tool',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx({ workspace, authority: member() });
				expect(yield* result(x, 'workspace_search', { text: 'bolt.read' })).toEqual({
					result: {
						total: 2,
						hits: [
							{ path: 'src/a.ts', line: 2, text: 'bolt.read(tasks)' },
							{ path: 'src/app/b.svelte', line: 1, text: '<p>{bolt.READ}</p>' }
						]
					}
				});
				expect(
					yield* result(x, 'workspace_search', { text: 'bolt.read', paths: ['src/app/'] })
				).toMatchObject({ result: { total: 1 } });
				expect(
					yield* result(x, 'workspace_search', { path: 'src/a.ts', from: 2, to: 2 })
				).toMatchObject({ result: { path: 'src/a.ts', lines: ['2: bolt.read(tasks)'] } });
				expect(yield* result(x, 'workspace_search', { path: 'a.ts' })).toEqual({
					result: { error: "No file 'a.ts'. Did you mean src/a.ts?" }
				});
				expect(yield* result(x, 'workspace_search', { draft: true })).toEqual({
					result: { error: 'You have no Studio draft in this workspace.' }
				});
				const draft: WorkspacePort = {
					files: async () => ['src/new.ts'],
					read: async () => 'draft'
				};
				expect(
					yield* result(yield* ctx({ workspace, draft, authority: member() }), 'workspace_search', {
						draft: true
					})
				).toEqual({
					result: {
						files: ['src/new.ts'],
						read: 'pass path (with draft: true for your draft) to read one of these'
					}
				});
				expect(
					yield* tool(yield* ctx({ workspace, authority: member({ external: true }) }), 'workspace_search')
				).toBeUndefined();
			})
	);
});
describe('act starts automations', () => {
	it.effect(
		"act starts an automation or the model's named file and remote syncs",
		() =>
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
							runAs: 'trigger',
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
				expect((yield* requiredTool(x, 'act')).description).toContain('tidy(day?: date)');
				expect(
					yield* result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })
				).toMatchObject({ result: { outcome: { output: { kind: 'queued' } } } });
				expect(started[0]).toMatchObject({
					automation: 'tidy',
					runs: [{ input: { day: '2026-09-01' } }]
				});
				expect(yield* result(x, 'act', { callable: 'automation.purge' })).toEqual({
					result: { error: "You may not run 'automation.purge'." }
				});
				expect((yield* requiredTool(x, 'act')).description).toContain(
					'A file sync runs as <model>.sync.<sync>'
				);
				expect((yield* requiredTool(x, 'act')).description).toContain(
					'tasks.sync.sheet(mode: import | export)'
				);
				expect(
					yield* result(x, 'act', {
						callable: 'automation.tasks.sync.sheet',
						input: { mode: 'import' }
					})
				).toEqual({ result: { error: "You may not run 'automation.tasks.sync.sheet'." } });
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
				expect((yield* requiredTool(synced, 'act')).description).toContain(
					'A remote sync reads its source now as <model>.sync.<sync> with {}: tasks.sync.erp'
				);
				expect((yield* requiredTool(synced, 'act')).description).not.toContain('tasks.sync.erp()');
				yield* result(synced, 'act', { callable: 'tasks.sync.erp', input: {} });
				expect(started.at(-1)).toMatchObject({
					automation: 'tasks.sync.erp',
					runs: [{ input: {} }]
				});
				started.pop();
				expect(
					yield* result(synced, 'act', { callable: 'automation.tasks.sync.erp', input: {} })
				).toEqual({ result: { error: "You may not run 'automation.tasks.sync.erp'." } });
				active = 'run-1';
				expect(
					yield* result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })
				).toEqual({ result: { run: 'run-1', alreadyActive: true } });
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
													starter: null
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
			const x = yield* ctx();
			kitOrigins.get(x)?.set('https://law.example/index.ts', new TextEncoder().encode('export {}'));
			expect(yield* result(x, 'download', { url: 'https://law.example/index.ts' })).toEqual({
				result: { error: expect.stringContaining('not media') }
			});
			expect(yield* result(x, 'download', { url: 'https://law.example/gone.png' })).toEqual({
				result: { error: 'The URL answered 404.' }
			});
			expect(
				yield* x.engine.db.rows(Schema.Struct({ id: Schema.String }), {
					text: 'SELECT id FROM sys_file',
					params: []
				})
			).toEqual([]);
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
});
describe('run_js', () => {
	const rows = Array.from({ length: 200 }, (_, i) => ({
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
						lines: 200,
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
	it.live('transforms 200 rows of input, its console lines beside the answer', () =>
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
			).toEqual({ result: { answer: totals, console: ['200 rows'] } });
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
					{ text: 'SELECT name, mime, field FROM sys_file ORDER BY name', params: [] }
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
	it.live(
		'ends an endless loop at its CPU budget',
		() =>
			Effect.gen(function* () {
				const x = yield* ctx();
				expect(yield* run(x, { code: 'for (;;) {}' })).toEqual({
					result: { error: 'the script used its 2 s of CPU' }
				});
			}),
		30_000
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
describe('run_js over a file', () => {
	const run = (x: ToolContext, input: Json) => result(x, 'run_js', input);
	/** A context whose skills run through a real confined bundler. */
	const files = (skills: ToolContext['skills']) =>
		Effect.gen(function* () {
			const host = yield* bundler();
			const service = Context.get(yield* Layer.build(Bundler.fromAbi(host.port('acme'))), Bundler);
			return { host, x: yield* ctx({ skills }, { bundler: service }) };
		});
	const Ref = Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String });
	const Kept = Schema.Struct({
		result: Schema.Struct({ answer: Schema.Struct({ files: Schema.Array(Ref) }) })
	});
	it.live(
		"runs a skill's CommonJS script as written: siblings, a vendored package, a conversation file at /in, argv, Buffer, and /out kept as the person's file",
		() =>
			Effect.gen(function* () {
				const { x } = yield* files({ report: skillOf(REPORT) });
				// the conversation's CSV: a file the person holds here (an output of an earlier run)
				const [csv] = Schema.decodeUnknownSync(Kept)(
					yield* run(x, {
						input: [{ name: 'sales.csv', text: SALES }],
						code: 'return { files: input };'
					})
				).result.answer.files;
				if (csv === undefined) throw new Error('no CSV kept');
				expect(
					yield* run(x, {
						file: 'report/scripts/report.js',
						args: ['/in/sales.csv', '/out/summary.json'],
						files: [{ id: csv.id }]
					})
				).toEqual({
					result: {
						exitCode: 0,
						files: [
							{
								id: expect.any(String),
								name: 'summary.json',
								mime: 'application/json',
								size: expect.any(Number)
							}
						],
						console: ['wrote summary.json: 4 rows']
					}
				});
				const [stored] = yield* x.engine.db.rows(Schema.Struct({ key: Schema.String }), {
					text: "SELECT key FROM sys_file WHERE name = 'summary.json'",
					params: []
				});
				if (stored === undefined || x.engine.files === undefined) throw new Error('no summary');
				const totals = { north: 140, south: 80.25, east: 42 };
				expect(
					JSON.parse(new TextDecoder().decode(yield* x.engine.files.get(stored.key, 1 << 20)))
				).toEqual({
					count: 4,
					totals,
					month: 'October 2026',
					digest: Buffer.from(JSON.stringify(totals)).toString('base64')
				});
				// the skill names its own files to run, never the packages it vendors
				expect(yield* result(x, 'skill', { name: 'report' })).toMatchObject({
					result: { files: ['scripts/lib/summarize.js', 'scripts/report.js', 'shared/index.js'] }
				});
			}),
		60_000
	);
	it.live(
		'runs an ES module with top-level await, node:fs/promises, sibling .mjs and .cjs and an ES-module-only package; a repeat bundles nothing',
		() =>
			Effect.gen(function* () {
				const { host, x } = yield* files({ render: skillOf(RENDER) });
				const page = {
					result: {
						exitCode: 0,
						files: [{ id: expect.any(String), name: 'page.html', mime: 'text/plain', size: 54 }],
						console: ['October review']
					}
				};
				expect(yield* run(x, { file: 'render/scripts/render.mjs' })).toEqual(page);
				expect(yield* run(x, { file: 'render/scripts/render.mjs' })).toEqual(page);
				expect(host.counts().built).toBe(1);
			}),
		60_000
	);
	it.live(
		"reports each failure at the author's file: a bundle's errors, a throw mapped back, a refused built-in by its requirer, an exit code",
		() =>
			Effect.gen(function* () {
				const { x } = yield* files({ broken: skillOf(BROKEN) });
				const error = (file: string) =>
					run(x, { file }).pipe(
						Effect.map(
							(answer) =>
								Schema.decodeUnknownSync(
									Schema.Struct({ result: Schema.Struct({ error: Schema.String }) })
								)(answer).result.error
						)
					);
				expect(yield* error('broken/scripts/missing.mjs')).toMatch(
					/^scripts\/missing\.mjs:2:25: Cannot find module '\.\/lib\/nowhere\.mjs'/
				);
				expect(yield* error('broken/scripts/spawn.mjs')).toMatch(
					/^scripts\/spawn\.mjs:1:26: 'node:child_process' is not available in run_js/
				);
				const thrown = yield* error('broken/scripts/throws.js');
				expect(thrown).toMatch(/^Error: failed at stage E1\n/);
				expect(thrown).toContain('scripts/lib/explode.js:4:11');
				expect(thrown).not.toContain('guest.mjs');
				expect(yield* error('broken/scripts/os.js')).toMatch(
					/^Error: 'os' is not available in run_js \(required by scripts\/os\.js\)/
				);
				expect(yield* run(x, { file: 'broken/scripts/exit.js' })).toEqual({
					result: { exitCode: 3, console: ['leaving'] }
				});
				expect(yield* run(x, { file: 'broken/scripts/none.js' })).toEqual({
					result: { error: "The skill broken has no file 'scripts/none.js'." }
				});
				expect(yield* run(x, { file: 'nobody/x.js' })).toEqual({
					result: { error: "No skill 'nobody' is available: file is '<skill>/<path>'." }
				});
			}),
		60_000
	);
	it.live(
		'sees only its mounts: no host file, no writes to its tree, an empty env, no fetch unless granted',
		() =>
			Effect.gen(function* () {
				const { x } = yield* files({
					probe: skillOf({
						'SKILL.md': '---\ndescription: probe\n---\n',
						'probe.js':
							"const fs = require('fs');\n" +
							'const tried = (f) => { try { f(); return "allowed"; } catch (e) { return e.code; } };\n' +
							"console.log(JSON.stringify({ host: tried(() => fs.readFileSync('/etc/passwd')), escape: tried(() => fs.readFileSync('../../etc/passwd')), tree: tried(() => fs.writeFileSync('/app/probe.js', 'x')), env: Object.keys(process.env).length, fetch: typeof fetch, list: fs.readdirSync('/') }));\n"
					})
				});
				expect(yield* run(x, { file: 'probe/probe.js' })).toEqual({
					result: {
						exitCode: 0,
						console: [
							JSON.stringify({
								host: 'ENOENT',
								escape: 'ENOENT',
								tree: 'EROFS',
								env: 0,
								fetch: 'undefined',
								list: ['app', 'in', 'out']
							})
						]
					}
				});
			}),
		60_000
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
	it.live(
		"runs a reference's file from its index as pure computation: no fetch, http refused",
		() =>
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
				const host = yield* bundler();
				const service = Context.get(
					yield* Layer.build(Bundler.fromAbi(host.port('acme'))),
					Bundler
				);
				const x = yield* ctx({ hostTools: [reference] }, { bundler: service, http });
				store = x.engine.files;
				expect(yield* result(x, 'reference', {})).toMatchObject({
					result: { reference: NAME, files: [{ name: NAME, mime: REFERENCE.mime }] }
				});
				const run = (input: Json) => result(x, 'run_js', input);
				expect(yield* run({ file: `${NAME}/src/main.js` })).toEqual({
					result: { exitCode: 0, console: [JSON.stringify({ sum: 5, fetch: 'undefined' })] }
				});
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
			}),
		60_000
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
			expect(child).toEqual(
				expect.arrayContaining(['read', 'act', 'wait', 'goals', 'ask_parent'])
			);
			expect(yield* names(yield* ctx({ delegation: true, agents: ['workspace'] }))).not.toContain(
				'ask_parent'
			);
		})
	);
});
describe('job waits', () => {
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
describe('runs and logs', () => {
	const runs = (x: ToolContext) =>
		x.engine.db.write({
			text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts, results, error, actor, finished_at) VALUES
			('r1', 'billing.invoice', '{"month":"09"}', '2026-09-20T01:00:00Z', 'schedule', 0, 'succeeded', 1, '[]', NULL, NULL, '2026-09-20T01:00:05Z'),
			('r2', 'billing.invoice', '{"month":"10"}', '2026-09-21T01:00:00Z', 'schedule', 0, 'failed', 2, '[{"error":{"code":"timeout"}},{"error":{"code":"guest","message":"boom"}}]', '{"code":"guest","message":"boom"}', NULL, '2026-09-21T01:00:09Z'),
			('r3', 'billing.dunning', '{}', '2026-09-22T01:00:00Z', 'start', 0, 'queued', 0, '[]', NULL, NULL, NULL),
			('r4', 'tidy', '{"secret":1}', '2026-09-23T01:00:00Z', 'start', 0, 'stopped', 1, '[]', '{"code":"stopped","message":"The run was stopped."}', $1, '2026-09-23T01:00:01Z'),
			('r5', 'tidy', '{}', '2026-09-24T01:00:00Z', 'start', 0, 'succeeded', 1, '[]', NULL, 'member:someone-else', NULL)`,
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
				// a member holding billing.invoice: its runs in full, a run they caused as its status, nobody else's
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
				const caused = yield* result(holder, 'runs', { id: 'r4' });
				expect(caused).toMatchObject({
					result: { status: 'cancelled', error: { code: 'stopped' } }
				});
				expect(caused).not.toHaveProperty('result.input');
				expect(yield* result(holder, 'runs', { id: 'r5' })).toEqual({
					result: { error: 'No automation run r5 you may read.' }
				});
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
	const hostTools = [host('web_search'), host('browser_navigate')];
	it.effect('a workspace MCP tool named web_search hides only the host web_search', () =>
		Effect.gen(function* () {
			const plain = yield* names(yield* ctx({ hostTools }));
			expect(plain).toEqual(expect.arrayContaining(['web_search', 'browser_navigate']));
			const own = yield* names(
				yield* ctx({
					hostTools,
					mcpTools: [
						{ server: 'kagi', name: 'web_search', description: 'Kagi', input: { type: 'object' } },
						{
							server: 'kagi',
							name: 'browser_navigate',
							description: 'x',
							input: { type: 'object' }
						}
					]
				})
			);
			expect(own).toEqual(expect.arrayContaining(['mcp__kagi__web_search', 'browser_navigate']));
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
