// The API reference (§7.3): `src/cli/docs.ts` writes it into `build/docs/` at the end of bolt's build, so this reads
// the corpus the last build produced (`pnpm --dir oss build` first). Every symbol a workspace imports has a summary;
// declaration functions carry their option shapes; the agent's `docs` tool reads the same corpus.
import { expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { docs } from '../src/docs/index.ts';
import { catalogue, jobs, type ToolContext } from '../src/engine/agent/tools.ts';
import { mcpSessions } from '../src/engine/agent/mcp.ts';
import type { AgentEngine } from '../src/engine/agent/index.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Docs, Mcp } from '../src/engine/ports.ts';
import { docsPort } from '../src/node/docs.ts';
import { off } from '../src/facilities/index.ts';

it('one namespace per public entry, with its module and the entry summary', () => {
	const names = docs.index().namespaces.map((n) => n.namespace);
	expect(names).toEqual(
		expect.arrayContaining([
			'bolt',
			'bolt/page',
			'bolt/test',
			'ui',
			'ui/layout',
			'std/date',
			'std/zone',
			'std/label'
		])
	);
	expect(names).toEqual([...names].sort());
	expect(docs.index().namespaces.find((n) => n.namespace === 'bolt/page')?.module).toBe(
		'@norbital-ai/bolt/page'
	);
	for (const n of docs.index().namespaces.filter((x) => x.reference))
		expect(n.summary, n.namespace).not.toBe('');
});

it('the declaration functions and native mask guard are documented, and spec parameters list their fields', () => {
	const fns = docs
		.namespace('bolt')!
		.symbols.filter((s) => s.kind === 'function')
		.map((s) => s.name);
	expect(fns).toEqual([
		'app',
		'automation',
		'customField',
		'envoy',
		'group',
		'instanceId',
		'integration',
		'isInstance',
		'isMasked',
		'jsonDiff',
		'kiosk',
		'mcp',
		'messages',
		'model',
		'pageServer',
		'policy',
		'secrets',
		'team',
		'workspace'
	]);
	const model = docs.symbol('bolt', 'model')!;
	expect(model.signature).toContain('function model');
	expect(model.source).toMatch(/^packages\/bolt\/src\/decl\/model\.ts:\d+$/);
	expect(model.params?.[1]?.fields?.map((f) => f.name)).toContain('fields');
	expect(docs.symbol('bolt', 'pageServer')?.params?.[0]?.fields?.map((f) => f.name)).toEqual([
		'data',
		'load'
	]);
});

it('svelte components list their props with the props docs', () => {
	const stack = docs.symbol('ui/layout', 'Stack')!;
	expect(stack.kind).toBe('component');
	expect(stack.props?.map((p) => p.name)).toContain('gap');
	expect(docs.symbol('ui', 'Table')?.kind).toBe('component');
});

it('search ranks an exact name first and narrows by namespace', () => {
	expect(docs.search('model')[0]).toMatchObject({
		namespace: 'bolt',
		name: 'model',
		kind: 'function'
	});
	expect(
		docs.search('add days', { namespaces: ['std/'] }).every((h) => h.namespace.startsWith('std/'))
	).toBe(true);
	expect(docs.search('zzzz-no-such-word')).toEqual([]);
	// a sentence finds what its words name, never nothing when one of them matches
	const sentence = docs.search('app page table view records edit form');
	expect(sentence.length).toBeGreaterThan(0);
	const names = sentence.map((h) => h.name);
	expect(names).toContain('app');
	expect(names.some((n) => n.startsWith('Table'))).toBe(true);
	expect(names).not.toContain('ApprovalPanel'); // "app" matches where a word starts, not inside "approval"
	expect(docs.search('enum field kind values options')[0]?.name).toBe('FieldKind');
});

// A complete native context with unrelated capabilities that fail if the docs tool calls them.
const unexpected = () => Effect.die(new Error('The docs tool called an unrelated capability.'));
const unexpectedSync = (): never => {
	throw new Error('The docs tool called an unrelated capability.');
};
const manifest: AgentEngine['manifest'] = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	exposures: {},
	relationships: {},
	integrations: {},
	connections: {},
	policies: {},
	automations: {},
	teams: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const engine: AgentEngine = {
	manifest,
	db: TenantDb.typed({
		read: unexpected,
		write: unexpected,
		transaction: unexpected,
		session: () =>
			Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions'))
	}),
	live: {
		publish: unexpectedSync,
		syncChanged: unexpectedSync,
		v: unexpected(),
		connect: () => Stream.die(new Error('The docs tool opened a live connection.')),
		register: unexpected,
		drop: unexpected,
		authorize: unexpected,
		authorityOf: unexpected,
		close: unexpected,
		settled: unexpected(),
		sweep: unexpected(),
		retained: unexpected()
	},
	calls: {
		acts: unexpected,
		start: unexpected
	},
	read: unexpected,
	act: unexpected,
	approvals: { decide: unexpected, view: unexpected, list: unexpected }
};
const docsTool = (external = false) =>
	Effect.gen(function* () {
		const context: ToolContext = {
			engine,
			authority: {
				key: 'staff',
				actor: {
					kind: 'member',
					id: 'ann',
					email: null,
					phone: null,
					external,
					teams: [],
					teamPath: [],
					admin: false,
					party: null
				},
				admin: false,
				policies: [],
				models: {},
				automations: [],
				capabilities: { apps: [], tools: [], mcp: [], skills: [] },
				limits: [],
				teamTree: [],
				scopes: {}
			},
			conv: {
				id: 'c',
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
			bindings: { now: '2026-10-13T00:00:00.000Z', today: '2026-10-13', tz: 'UTC' },
			turn: 't',
			mode: 'agent',
			inApp: true,
			delegation: false,
			child: false,
			skills: {},
			agents: [],
			mcp: yield* mcpSessions(manifest).pipe(Effect.provide(Mcp.fromAbi(off))),
			logs: { write: () => Effect.void, query: () => Effect.succeed([]) },
			mcpTools: [],
			docs: yield* Docs.pipe(Effect.provide(Docs.fromAbi(docsPort()))),
			hostTools: [],
			receipts: [],
			read: new Map(),
			files: [],
			jobs: yield* jobs(),
			setPlan: unexpected,
			setGoals: unexpected,
			compact: unexpectedSync,
			ask: unexpectedSync,
			messages: unexpected,
			output: unexpected,
			history: unexpected,
			subagent: {
				spawn: unexpected,
				list: unexpected,
				read: unexpected,
				message: unexpected,
				stop: unexpected,
				running: unexpected,
				report: unexpected
			}
		};
		const offered = yield* catalogue(context);
		return offered.tools.some((tool) => tool.name === 'docs')
			? { run: (input: unknown, id: string) => offered.run('docs', input, id) }
			: undefined;
	});

it.effect(
	'the agent reads the reference through docs: namespaces, a search, one symbol; host namespaces are not offered',
	() =>
		Effect.gen(function* () {
			const tool = yield* docsTool();
			if (tool === undefined) return yield* Effect.die('Staff has no docs tool.');
			const list = yield* tool.run({}, 'c1');
			expect(list).toMatchObject({
				result: {
					namespaces: expect.arrayContaining([
						{
							namespace: 'bolt',
							import: '@norbital-ai/bolt',
							summary: expect.any(String),
							symbols: expect.any(Number)
						},
						{
							namespace: 'ui',
							import: '@norbital-ai/ui',
							summary: expect.any(String),
							symbols: expect.any(Number)
						},
						{
							namespace: 'std/date',
							import: '@norbital-ai/std/date',
							summary: expect.any(String),
							symbols: expect.any(Number)
						}
					])
				}
			});
			expect(list).not.toMatchObject({
				result: {
					namespaces: expect.arrayContaining([
						expect.objectContaining({ namespace: 'bolt/engine' })
					])
				}
			});
			expect(yield* tool.run({ symbol: 'model', namespace: 'bolt' }, 'c2')).toMatchObject({
				result: [{ import: '@norbital-ai/bolt', name: 'model' }]
			});
			expect(yield* tool.run({ namespace: 'bolt/engine' }, 'c3')).toMatchObject({
				result: { error: expect.stringMatching(/No namespace/) }
			});
			expect(yield* tool.run({ query: 'stack' }, 'c4')).toMatchObject({
				result: expect.arrayContaining([expect.objectContaining({ name: 'Stack' })])
			});
		})
);

it.effect('an external member gets no docs tool', () =>
	Effect.gen(function* () {
		expect(yield* docsTool(true)).toBeUndefined();
	})
);
