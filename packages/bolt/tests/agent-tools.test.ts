// The agent catalogue over typed native ports: batching, approvals, workspace search, run waits and sandbox files.
import { readFileSync } from 'node:fs';
import { memberCap } from '../src/engine/agent/settings.ts';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Deferred, Effect, Fiber, Layer, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Sql } from '../src/engine/contracts.ts';
import { DbError } from '../src/engine/errors.ts';
import type { AgentEngine } from '../src/engine/agent/index.ts';
import type { MessageRow } from '../src/engine/agent/schema.ts';
import {
	catalogue,
	jobs,
	type HostTool,
	type HostToolContext,
	type SandboxPort,
	type ToolContext,
	type WorkspacePort
} from '../src/engine/agent/tools.ts';
import { TenantDb, type RawDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { Files } from '../src/engine/ports.ts';
import { Approvals, Callables, Live, Reads, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../src/test/effect.ts';
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
	collections: {},
	automations: [],
	capabilities: { apps: [], tools: o.tools ?? [], mcp: [], skills: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	collections: { tasks: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
	models: { tasks: { description: 'A task', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {},
	integrations: {},
	agent: { skills: {} },
	policies: {
		staff: {
			description: '',
			grants: { tasks: { approval: { create: [{ steps: [['Leads']] }] } } }
		}
	},
	teams: { Leads: [] },
	automations: {},
	pipelines: {},
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
				...(engine.convert === undefined ? {} : { convert: engine.convert })
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
		return x;
	});
const tool = (x: ToolContext, name: string) => catalogue(x).find((t) => t.name === name);
const requiredTool = (x: ToolContext, name: string) => {
	const t = tool(x, name);
	if (t === undefined) throw new Error(`missing tool ${name}`);
	return t;
};
const result = (x: ToolContext, name: string, input: Json) =>
	requiredTool(x, name).run(input, 'call');
const first = <A>(items: readonly A[]): A => {
	const item = items[0];
	if (item === undefined) throw new Error('fixture produced no item');
	return item;
};
const message = (seq: number, files: Json): MessageRow => ({
	id: `m${seq}`,
	conversation: 'c1',
	seq,
	role: 'user',
	content: '',
	text: '',
	state: null,
	mode: null,
	as: null,
	author: 'ann',
	meta: null,
	supersedes: null,
	turn: null,
	files
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
					read: async () => null,
					types: async () => null
				};
				const tools = [
					...catalogue(yield* ctx({ inApp: false })),
					...catalogue(yield* ctx({ workspace, authority: member() }))
				];
				expect(tools.map((t) => t.name)).toEqual(
					expect.arrayContaining(['read', 'act', 'workspace_search'])
				);
				for (const t of tools) {
					const document = Schema.toJsonSchemaDocument(t.input);
					walk(yield* Schema.decodeUnknownEffect(Schema.Json)(document.schema), t.name);
					for (const [name, definition] of Object.entries(document.definitions))
						walk(
							yield* Schema.decodeUnknownEffect(Schema.Json)(definition),
							`${t.name}.$defs.${name}`
						);
				}
				expect(untyped).toEqual([]);
			})
	);
});
describe('fewer calls for the common paths', () => {
	it.effect(
		'read takes several reads in one call, each answered in order and refused on its own',
		() =>
			Effect.gen(function* () {
				const reads: Parameters<AgentEngine['read']>[0][number][] = [];
				const x = yield* ctx(
					{},
					{
						read: (irs) =>
							Effect.sync(() => {
								reads.push(...irs);
								return [{ id: '1', title: 'Fix the van' }];
							})
					}
				);
				expect(
					yield* result(x, 'read', {
						reads: [
							{ collection: 'tasks', id: '1', asOf: '2026-09-01T00:00:00Z' },
							{ collection: 'secrets' }
						]
					})
				).toEqual({
					result: [
						{ id: '1', title: 'Fix the van' },
						{ error: expect.stringContaining("You may not read 'secrets'") }
					]
				});
				expect(reads).toHaveLength(1);
			})
	);
	it.effect(
		'act runs several writes in order under their own keys, stops at the first that does not commit, and refuses the batch whole when one is not allowed',
		() =>
			Effect.gen(function* () {
				const keys: string[] = [];
				const act: AgentEngine['act'] = (r) =>
					Effect.sync(() => {
						keys.push(r.key);
						return {
							captured: [],
							v: 0,
							outcome:
								keys.length === 2
									? { kind: 'refused', code: 'invalidInput', message: 'no title' }
									: { kind: 'committed', output: null, records: [] }
						};
					});
				const x = yield* ctx({ inApp: false }, { act }),
					create = { callable: 'tasks.create', input: { title: 'a' } };
				const got = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						result: Schema.Struct({ results: Schema.Array(Schema.Json), stopped: Schema.String })
					})
				)(yield* result(x, 'act', { actions: [create, create, create] }));
				expect(keys).toEqual(['agent:t1:call', 'agent:t1:call#1']);
				expect(got.result.results).toHaveLength(2);
				expect(got.result.stopped).toMatch(/did not run/);
				expect(
					yield* result(x, 'act', { actions: [create, { callable: 'tasks.delete', input: {} }] })
				).toEqual({ result: { error: "You may not run 'tasks.delete'." } });
				expect(keys).toHaveLength(2);
			})
	);
});
describe('approval decisions through act', () => {
	it.effect(
		'offered to a member whose team a route names; they decide as themselves, confirming first in the app',
		() =>
			Effect.gen(function* () {
				expect(tool(yield* ctx({ authority: member() }), 'act')).toBeUndefined();
				const decided: Parameters<AgentEngine['approvals']['process']>[0][] = [];
				const approvals: Partial<AgentEngine['approvals']> = {
					process: (d) =>
						Effect.sync(() => {
							decided.push(d);
							return { kind: 'decided', requestId: d.requestId, status: d.status };
						})
				};
				const input = {
					callable: 'approvals.process',
					input: { requestId: 'r1', status: 'APPROVED', reason: 'ok' }
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
				).toEqual({ result: { kind: 'decided', requestId: 'r1', status: 'APPROVED' } });
				expect(decided[0]).toMatchObject({
					requestId: 'r1',
					status: 'APPROVED',
					reason: 'ok',
					authority: { actor: { id: 'ann' } }
				});
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
		read: async (path) => source[path] ?? null,
		types: async () => null
	};
	it.effect(
		'finds lines by text, code by an ast-grep rule (the whole match), reads a file by path, and searches a draft; external members get no tool',
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
					yield* result(x, 'workspace_search', { rule: 'export function $F($$$) { $$$ }' })
				).toEqual({
					result: {
						total: 1,
						matches: [
							{
								path: 'src/a.ts',
								line: 3,
								code: 'export function total(a: number) {\n\treturn a;\n}',
								bound: expect.stringContaining('$F=total')
							}
						]
					}
				});
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
					read: async () => 'draft',
					types: async () => null
				};
				expect(
					yield* result(yield* ctx({ workspace, draft, authority: member() }), 'workspace_search', {
						draft: true
					})
				).toEqual({ result: { files: ['src/new.ts'] } });
				expect(
					tool(yield* ctx({ workspace, authority: member({ external: true }) }), 'workspace_search')
				).toBeUndefined();
			})
	);
});
describe('read runs queries and act starts automations', () => {
	it.effect(
		"a collection query is { query, input } on read; act starts automation.<name> and a collection's <c>.pipeline the actor may start",
		() =>
			Effect.gen(function* () {
				const queried: Parameters<AgentEngine['calls']['query']>[0][] = [],
					started: Parameters<AgentEngine['calls']['start']>[0][] = [];
				const m: EngineManifest = {
					...manifest,
					policies: {},
					collections: {
						tasks: {
							read: { fields: 'all' },
							queries: {
								open: {
									description: 'Open tasks',
									input: {},
									output: { kind: 'object', fields: { count: { kind: 'int' } } }
								}
							}
						}
					},
					automations: {
						tidy: {
							description: '',
							runAs: 'trigger',
							input: { day: { kind: 'date', optional: true } }
						}
					},
					pipelines: { tasks: { import: { description: '', input: {} } } }
				};
				const calls: Partial<AgentEngine['calls']> = {
					query: (q) =>
						Effect.sync(() => {
							queried.push(q);
							return { count: 2 };
						}),
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
				expect(requiredTool(x, 'read').description).toContain('tasks.open (Open tasks)');
				expect(yield* result(x, 'read', { query: 'tasks.open', input: {} })).toEqual({
					result: { count: 2 }
				});
				expect(queried[0]).toMatchObject({ collection: 'tasks', query: 'open' });
				expect(yield* result(x, 'read', { collection: 'tasks', query: 'open', input: {} })).toEqual(
					{ result: { count: 2 } }
				);
				expect(queried[1]).toMatchObject({ collection: 'tasks', query: 'open' });
				expect(requiredTool(x, 'act').description).toContain('tidy(day?: date)');
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
				expect(requiredTool(x, 'act').description).toContain(
					'runs as <collection>.pipeline with { mode, file? }'
				);
				expect(requiredTool(x, 'act').description).toContain('tasks.pipeline(mode: import)');
				expect(
					yield* result(x, 'act', {
						callable: 'automation.tasks.pipeline',
						input: { mode: 'import' }
					})
				).toEqual({ result: { error: "You may not run 'automation.tasks.pipeline'." } });
				yield* result(x, 'act', {
					callable: 'tasks.pipeline',
					input: { mode: 'import', file: 'f1' }
				});
				expect(started[1]).toMatchObject({
					automation: 'tasks.pipeline',
					runs: [{ input: { mode: 'import', file: 'f1' } }]
				});
				yield* result(x, 'act', {
					callable: 'tasks.pipeline',
					input: { mode: 'import', rows: [{ a: 1 }] }
				});
				expect(started[2]).toMatchObject({ runs: [{ input: { rows: [{ a: 1 }] } }] });
				started.pop();
				const big = { mode: 'import', rows: [{ a: 1 }, { a: 2 }] };
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
				yield* result(withFiles, 'act', { callable: 'tasks.pipeline', inputFile: 'f-json' });
				expect(started[2]).toMatchObject({ automation: 'tasks.pipeline', runs: [{ input: big }] });
				started.pop();
				expect(
					yield* result(withFiles, 'act', { callable: 'tasks.pipeline', inputFile: 'someone-else' })
				).toMatchObject({
					result: { error: expect.stringContaining('No file someone-else of yours') }
				});
				const synced = yield* ctx(
					{ authority: { ...member(), automations: ['tidy', 'erp.tasks'] }, inApp: false },
					{
						manifest: {
							...m,
							integrations: {
								erp: {
									description: 'An ERP',
									driver: 'sqlserver',
									feeds: { tasks: { into: 'tasks', key: ['title'], cron: '* * * * *' } }
								}
							}
						},
						calls,
						db
					}
				);
				expect(requiredTool(synced, 'act').description).toContain(
					'A feed pulls its source now as <definition>.<feed> with {}: erp.tasks'
				);
				expect(requiredTool(synced, 'act').description).not.toContain('erp.tasks()');
				yield* result(synced, 'act', { callable: 'erp.tasks', input: {} });
				expect(started.at(-1)).toMatchObject({ automation: 'erp.tasks', runs: [{ input: {} }] });
				started.pop();
				expect(
					yield* result(synced, 'act', { callable: 'automation.erp.tasks', input: {} })
				).toEqual({ result: { error: "You may not run 'automation.erp.tasks'." } });
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
describe('a sub-agent', () => {
	it.effect('keeps its checklist but has no plan or sub-agents of its own: one level deep', () =>
		Effect.gen(function* () {
			const names = (x: ToolContext) => catalogue(x).map((t) => t.name);
			// update_plan is a plan-mode tool, subagent an agent-mode one; goals is in both
			expect(names(yield* ctx({ mode: 'plan' }))).toEqual(
				expect.arrayContaining(['update_plan', 'goals'])
			);
			expect(names(yield* ctx({ delegation: true, agents: ['workspace'] }))).toEqual(
				expect.arrayContaining(['goals', 'subagent'])
			);
			const child = [
				...names(yield* ctx({ mode: 'plan', child: true })),
				...names(yield* ctx({ child: true }))
			];
			for (const n of ['update_plan', 'subagent']) expect(child).not.toContain(n);
			expect(child).toEqual(expect.arrayContaining(['read', 'act', 'wait', 'goals', 'ask_parent']));
			expect(names(yield* ctx({ delegation: true, agents: ['workspace'] }))).not.toContain(
				'ask_parent'
			);
		})
	);
});
describe('sandbox_run', () => {
	const setup = (authority: Authority) =>
		Effect.gen(function* () {
			const jobsRun: Parameters<SandboxPort['run']>[0][] = [],
				written: Sql['params'][] = [];
			const sandbox: SandboxPort = {
				async run(job) {
					jobsRun.push(job);
					return {
						code: 0,
						stdout: 'ok',
						stderr: '',
						files: [{ name: 'chart.png', mime: 'image/png', bytes: new Uint8Array([1, 2]) }]
					};
				}
			};
			const x = yield* ctx(
				{
					authority,
					sandbox,
					row: (seq) =>
						Effect.succeed(
							seq === 3
								? message(seq, [{ id: 'f-in', name: 'sales.csv', mime: 'text/csv' }])
								: undefined
						)
				},
				{
					files: {
						get: () => Effect.succeed(new Uint8Array([7])),
						put: (bytes) =>
							Effect.succeed({
								key: 'k-out',
								bytes: bytes.byteLength,
								sha256: 'h',
								mime: 'image/png'
							})
					},
					db: {
						read: () =>
							Effect.succeed([{ rows: [{ key: 'k-in', name: 'sales.csv' }], affected: 0 }]),
						write: (statement) =>
							Effect.sync(() => {
								written.push(statement.params);
								return { rows: [], affected: 0 };
							})
					}
				}
			);
			return { x, jobsRun, written };
		});
	it.effect(
		'is a capability: offered to in-app staff who hold it (or admins), never to others',
		() =>
			Effect.gen(function* () {
				const { x } = yield* setup(member());
				expect(tool(x, 'sandbox_run')).toBeUndefined();
				expect(
					tool({ ...x, authority: member({ tools: ['sandbox_run'] }) }, 'sandbox_run')
				).toBeDefined();
				expect(tool({ ...x, authority: member({ admin: true }) }, 'sandbox_run')).toBeDefined();
				expect(
					tool(
						{ ...x, authority: member({ external: true, admin: false, tools: ['sandbox_run'] }) },
						'sandbox_run'
					)
				).toBeUndefined();
				expect(
					tool({ ...x, authority: member({ admin: true }), inApp: false }, 'sandbox_run')
				).toBeUndefined();
			})
	);
	it.effect(
		"mounts this conversation's attachment, stores what it produced as the member's file and shows the image",
		() =>
			Effect.gen(function* () {
				const { x, jobsRun, written } = yield* setup(member({ tools: ['sandbox_run'] }));
				const got = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						result: Schema.Struct({
							code: Schema.Number,
							stdout: Schema.String,
							files: Schema.Array(
								Schema.Struct({
									id: Schema.String,
									name: Schema.String,
									mime: Schema.String,
									size: Schema.Number
								})
							)
						})
					})
				)(
					yield* result(x, 'sandbox_run', {
						command: 'node',
						args: ['-e', '1'],
						files: [{ seq: 3 }]
					})
				);
				expect(jobsRun[0]).toMatchObject({
					command: 'node',
					args: ['-e', '1'],
					files: [{ name: 'sales.csv', bytes: new Uint8Array([7]) }]
				});
				expect(got.result).toMatchObject({
					code: 0,
					stdout: 'ok',
					files: [{ name: 'chart.png', mime: 'image/png', size: 2 }]
				});
				expect(written[0]).toEqual([
					first(got.result.files).id,
					'chart.png',
					'image/png',
					2,
					'k-out',
					'h',
					'2026-09-26T00:00:00.000Z',
					'ann'
				]);
				expect(x.files).toHaveLength(1);
				expect(yield* result(x, 'sandbox_run', { command: 'node', files: [{ seq: 9 }] })).toEqual({
					result: { error: 'Message 9 has no stored file 0.' }
				});
			})
	);
	it.effect(
		'hands a workbook with one CSV per worksheet beside it, so a program never unzips it',
		() =>
			Effect.gen(function* () {
				const book = new Uint8Array(
						readFileSync(new URL('./fixtures/files/items.xlsx', import.meta.url))
					),
					jobsRun: Parameters<SandboxPort['run']>[0][] = [];
				const sandbox: SandboxPort = {
					async run(job) {
						jobsRun.push(job);
						return { code: 0, stdout: '', stderr: '', files: [] };
					}
				};
				const x = yield* ctx(
					{
						authority: member({ admin: true }),
						sandbox,
						row: () => Effect.succeed(message(1, [{ id: 'f', name: 'items.xlsx' }]))
					},
					{
						files: { get: () => Effect.succeed(book) },
						db: {
							read: () =>
								Effect.succeed([{ rows: [{ key: 'k', name: 'items.xlsx' }], affected: 0 }]),
							write: () => Effect.succeed({ rows: [], affected: 0 })
						}
					}
				);
				yield* result(x, 'sandbox_run', { command: 'node', files: [{ seq: 1 }] });
				const run = first(jobsRun),
					names = run.files.map((file) => file.name);
				expect(names[0]).toBe('items.xlsx');
				const csv = run.files.find((file) => /^items\.xlsx\.0\..+\.csv$/.test(file.name));
				expect(csv, names.join()).toBeDefined();
				if (csv === undefined) return yield* Effect.die(new Error('workbook CSV missing'));
				expect(new TextDecoder().decode(csv.bytes).split('\n')[0]).toContain(',');
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
				// one run in detail: input, result, every attempt and its log lines, in one statement
				yield* x.engine.db.write({
					text: `INSERT INTO sys_event (at, severity, event, invocation, run, attributes) VALUES (now(), 'error', 'console', 'r2:2', 'r2', '{"automation":"billing.invoice","level":"error","line":"boom"}'), (now(), 'info', 'console', 'r1:1', 'r1', '{}')`,
					params: []
				});
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
				yield* x.engine.db.write({
					text: `INSERT INTO sys_event (at, severity, event, invocation, run, attributes) VALUES
				('2026-09-21T01:00:01Z', 'info', 'console', 'r2:1', 'r2', '{"automation":"billing.invoice","line":"starting"}'),
				('2026-09-21T01:00:02Z', 'warn', 'facility.failed', 'r2:1', 'r2', '{"facility":"http"}'),
				('2026-09-21T01:00:03Z', 'error', 'console', 'r2:2', 'r2', '{"automation":"billing.invoice","line":"${'y'.repeat(3000)}"}'),
				('2026-09-22T01:00:00Z', 'info', 'act.settled', 'a1', NULL, '{}')`,
					params: []
				});
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
				expect(tool(yield* ctx({ authority: member() }), 'logs')).toBeUndefined();
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
			const names = (x: ToolContext) => catalogue(x).map((t) => t.name);
			const plain = names(yield* ctx({ hostTools }));
			expect(plain).toEqual(expect.arrayContaining(['web_search', 'browser_navigate']));
			const own = names(
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
