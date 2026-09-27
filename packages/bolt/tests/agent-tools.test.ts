// The agent's tool catalogue over stub ports (rule 58): batched reads and writes, queries through `read`, approval
// decisions and automation starts through `act`, `workspace_search` over the released source or a draft, and `sandbox_run` (a host capability: in-app staff holding it, its
// inputs this conversation's own attachments, its outputs stored as the member's files).
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { catalogue, jobs, type SandboxPort, type ToolContext } from '../src/engine/agent/tools.ts';

type Stub = { [k: string]: unknown };
const member = (o: { external?: boolean; admin?: boolean; tools?: string[]; team?: string } = {}) => ({
	key: 'k', actor: { kind: 'member', id: 'ann', external: o.external ?? false, teamPath: o.team === undefined ? [] : [o.team] }, admin: o.admin ?? false, policies: [], collections: {},
	automations: [], capabilities: { apps: [], tools: o.tools ?? [], mcp: [], skills: [] }, limits: [], teamTree: [], scopes: {},
});
const ctx = (over: Stub = {}, engine: Stub = {}) => ({
	engine: { manifest: { collections: { tasks: { read: { fields: 'all' }, create: { input: {} } } }, models: { tasks: { label: 'title', fields: { title: { kind: 'text' } } } }, relationships: {}, workspace: { tz: 'UTC' }, agent: { skills: {} },
		policies: { staff: { description: '', grants: { tasks: { create: { approval: [{ steps: [['Leads']] }] } } } } } }, ...engine },
	authority: member({ admin: true }), bindings: { now: '2026-09-26T00:00:00.000Z', today: '2026-09-26', tz: 'UTC', params: {} }, turn: 't1',
	conv: { id: 'c1', channel: null, plan: null, goals: [] }, mode: 'agent', inApp: true, delegation: false, skills: {}, mcpTools: [], hostTools: [],
	receipts: [], files: [], jobs: jobs(), ...over,
}) as unknown as ToolContext;
const tool = (x: ToolContext, name: string) => catalogue(x).find((t) => t.name === name);
const result = async (x: ToolContext, name: string, input: Json) => (await tool(x, name)!.run(input, 'call')) as { result: Json } | { confirm: true };

describe('tool schemas', () => {
	it('every parameter declares its type: an untyped one reaches a routed model as { item: … } (Jev, staging)', () => {
		const untyped: string[] = [];
		const walk = (schema: Json, at: string): void => {
			if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
			const s = schema as { [k: string]: Json };
			if (at !== '' && s['type'] === undefined && s['anyOf'] === undefined && s['enum'] === undefined) untyped.push(at);
			for (const [k, v] of Object.entries((s['properties'] ?? {}) as { [k: string]: Json })) walk(v, `${at}.${k}`);
			if (s['items'] !== undefined) walk(s['items'], `${at}[]`);
		};
		const workspace = { files: async () => [], read: async () => null, types: async () => null };
		const tools = [...catalogue(ctx({ inApp: false })), ...catalogue(ctx({ workspace, authority: member() }))];
		expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['read', 'act', 'workspace_search']));
		for (const t of tools) walk(t.input, t.name);
		expect(untyped).toEqual([]);
	});
});

describe('fewer calls for the common paths', () => {
	it('read takes several reads in one call, each answered in order and refused on its own', async () => {
		const reads: Json[] = [];
		const x = ctx({}, { read: async (irs: Json[]) => { reads.push(...irs); return [{ id: '1', title: 'Fix the van' }]; } });
		const got = await result(x, 'read', { reads: [{ collection: 'tasks', id: '1', asOf: '2026-09-01T00:00:00Z' }, { collection: 'secrets' }] });
		expect(got).toEqual({ result: [{ id: '1', title: 'Fix the van' }, { error: expect.stringContaining("You may not read 'secrets'") }] });
		expect(reads).toHaveLength(1);
	});

	it('act runs several writes in order under their own keys, stops at the first that does not commit, and refuses the batch whole when one is not allowed', async () => {
		const keys: string[] = [];
		const act = async (r: { key: string }) => { keys.push(r.key); return { outcome: keys.length === 2 ? { kind: 'refused', code: 'invalid', message: 'no title' } : { kind: 'committed', records: [] } }; };
		const x = ctx({ inApp: false }, { act });
		const create = { callable: 'tasks.create', input: { title: 'a' } };
		const got = await result(x, 'act', { actions: [create, create, create] }) as { result: { results: Json[]; stopped: string } };
		expect(keys).toEqual(['agent:t1:call', 'agent:t1:call#1']);
		expect(got.result.results).toHaveLength(2);
		expect(got.result.stopped).toMatch(/did not run/);
		expect(await result(x, 'act', { actions: [create, { callable: 'tasks.delete', input: {} }] })).toEqual({ result: { error: "You may not run 'tasks.delete'." } });
		expect(keys).toHaveLength(2);
	});
});

describe('approval decisions through act', () => {
	it('offered to a member whose team a route names; they decide as themselves, confirming first in the app', async () => {
		expect(tool(ctx({ authority: member() }), 'act')).toBeUndefined();
		const decided: Stub[] = [];
		const approvals = { process: async (d: Stub) => { decided.push(d); return { kind: 'decided', requestId: d['requestId'], status: d['status'] }; } };
		const input = { callable: 'approvals.process', input: { requestId: 'r1', status: 'APPROVED', reason: 'ok' } };
		expect(await result(ctx({ authority: member({ team: 'Leads' }) }, { approvals }), 'act', input)).toEqual({ confirm: true });
		expect(await result(ctx({ authority: member({ team: 'Leads' }), inApp: false }, { approvals }), 'act', input)).toEqual({ result: { kind: 'decided', requestId: 'r1', status: 'APPROVED' } });
		expect(decided[0]).toMatchObject({ requestId: 'r1', status: 'APPROVED', reason: 'ok', authority: { actor: { id: 'ann' } } });
	});
});

describe('workspace_search', () => {
	const source: { [p: string]: string } = { 'src/a.ts': 'x\nbolt.read(tasks)\nexport function total(a: number) {\n\treturn a;\n}\n', 'src/app/b.svelte': '<p>{bolt.READ}</p>' };
	const workspace = { files: async () => Object.keys(source), read: async (p: string) => source[p] ?? null, types: async () => null };
	it('finds lines by text, code by an ast-grep rule (the whole match), reads a file by path, and searches a draft; external members get no tool', async () => {
		const x = ctx({ workspace, authority: member() });
		expect(await result(x, 'workspace_search', { text: 'bolt.read' })).toEqual({ result: { total: 2, hits: [{ path: 'src/a.ts', line: 2, text: 'bolt.read(tasks)' },
			{ path: 'src/app/b.svelte', line: 1, text: '<p>{bolt.READ}</p>' }] } });
		expect(await result(x, 'workspace_search', { text: 'bolt.read', paths: ['src/app/'] })).toMatchObject({ result: { total: 1 } });
		expect(await result(x, 'workspace_search', { rule: 'export function $F($$$) { $$$ }' })).toEqual({ result: { total: 1,
			matches: [{ path: 'src/a.ts', line: 3, code: 'export function total(a: number) {\n\treturn a;\n}', bound: expect.stringContaining('$F=total') }] } });
		expect(await result(x, 'workspace_search', { path: 'src/a.ts', from: 2, to: 2 })).toMatchObject({ result: { path: 'src/a.ts', lines: ['2: bolt.read(tasks)'] } });
		expect(await result(x, 'workspace_search', { path: 'a.ts' })).toEqual({ result: { error: "No file 'a.ts'. Did you mean src/a.ts?" } });
		expect(await result(x, 'workspace_search', { draft: true })).toEqual({ result: { error: 'You have no Studio draft in this workspace.' } });
		const draft = { files: async () => ['src/new.ts'], read: async () => 'draft', types: async () => null };
		expect(await result(ctx({ workspace, draft, authority: member() }), 'workspace_search', { draft: true })).toEqual({ result: { files: ['src/new.ts'] } });
		expect(tool(ctx({ workspace, authority: member({ external: true }) }), 'workspace_search')).toBeUndefined();
	});
});

describe('read runs queries and act starts automations', () => {
	it('a collection query is { query, input } on read; automation.<name> on act starts a run or an import pipeline the actor may start', async () => {
		const queried: Stub[] = [], started: Stub[] = [];
		const manifest = { collections: { tasks: { read: { fields: 'all' }, queries: { open: { description: 'Open tasks' } } } }, models: { tasks: { fields: {} } }, relationships: {},
			workspace: { tz: 'UTC' }, agent: { skills: {} }, policies: {}, automations: { tidy: { input: { day: { kind: 'date', optional: true } } } }, pipelines: { tasks: { import: {} } } };
		const calls = { query: async (q: Stub) => (queried.push(q), { count: 2 }), start: async (s: Stub) => (started.push(s), { kind: 'queued' }) };
		let active: string | null = null;
		const db = { read: async () => [{ rows: active === null ? [] : [{ id: active }] }] };
		const x = ctx({ authority: { ...member({ admin: true }), automations: ['tidy'] }, inApp: false }, { manifest, calls, db });
		expect(tool(x, 'read')!.description).toContain('tasks.open (Open tasks)');
		expect(await result(x, 'read', { query: 'tasks.open', input: {} })).toEqual({ result: { count: 2 } });
		expect(queried[0]).toMatchObject({ collection: 'tasks', query: 'open' });
		expect(tool(x, 'act')!.description).toContain('tidy(day?: date)');
		expect(await result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })).toMatchObject({ result: { outcome: { kind: 'queued' } } });
		expect(started[0]).toMatchObject({ automation: 'tidy', input: { day: '2026-09-01' } });
		expect(await result(x, 'act', { callable: 'automation.purge' })).toEqual({ result: { error: "You may not run 'automation.purge'." } });
		expect(tool(x, 'act')!.description).toContain('tasks.pipeline(mode: import, file?: a stored file id)');
		await result(x, 'act', { callable: 'automation.tasks.pipeline', input: { mode: 'import', file: 'f1' } });
		expect(started[1]).toMatchObject({ automation: 'tasks.pipeline', input: { mode: 'import', file: 'f1' } });
		// a list a routed model sent as { item: [...] } is the list (Jev on staging wrapped an import's rows so)
		await result(x, 'act', { callable: 'automation.tasks.pipeline', input: { mode: 'import', rows: { item: [{ a: 1 }] } } });
		expect(started[2]).toMatchObject({ input: { rows: [{ a: 1 }] } });
		started.pop();
		// the same start while that run is queued or running answers it, and queues nothing
		active = 'run-1';
		expect(await result(x, 'act', { callable: 'automation.tidy', input: { day: '2026-09-01' } })).toEqual({ result: { run: 'run-1', alreadyActive: true } });
		expect(started).toHaveLength(2);
	});
});

describe('wait', () => {
	it('follows an automation run act started until it ends, and says when there is no such run', async () => {
		let state = 'running';
		const row = () => ({ id: 'run-1', automation: 'tidy', cause: 'start', state, due_at: 'd', started: 's', progress: null, output: state === 'succeeded' ? { ok: true } : null,
			error: null, attempts: 1, results: [], input: {}, actor: null, starter: null });
		const db = { read: async (q: { params: Json[] }[]) => [{ rows: (q[0]!.params[0] as string[]).includes('run-1') ? [row()] : [] }] };
		const x = ctx({}, { db });
		setTimeout(() => { state = 'succeeded'; }, 50);
		expect(await result(x, 'wait', { jobs: ['run-1'], seconds: 10 })).toMatchObject({ result: { settled: { id: 'run-1', status: 'succeeded', result: { ok: true } } } });
		expect(await result(x, 'wait', { jobs: ['nope'] })).toEqual({ result: { error: 'No job or automation run nope.' } });
	});
});

describe('sandbox_run', () => {
	const setup = (authority: ReturnType<typeof member>) => {
		const jobsRun: Parameters<SandboxPort['run']>[0][] = [], written: Json[][] = [];
		const sandbox: SandboxPort = { async run(job) { jobsRun.push(job); return { code: 0, stdout: 'ok', stderr: '', files: [{ name: 'chart.png', mime: 'image/png', bytes: new Uint8Array([1, 2]) }] }; } };
		const engine = {
			files: { get: async () => new Uint8Array([7]), put: async (b: Uint8Array) => ({ key: 'k-out', bytes: b.byteLength, sha256: 'h', mime: 'image/png' }) },
			db: { read: async () => [{ rows: [{ key: 'k-in', name: 'sales.csv' }] }], write: async (q: { params: Json[] }) => { written.push(q.params); return { rows: [] }; } },
		};
		const row = async (seq: number) => seq === 3 ? { seq, files: [{ id: 'f-in', name: 'sales.csv', mime: 'text/csv' }] } : undefined;
		const x = ctx({ authority, sandbox, row }, engine);
		return { x, jobsRun, written };
	};
	it('is a capability: offered to in-app staff who hold it (or admins), never to others', () => {
		expect(tool(setup(member()).x, 'sandbox_run')).toBeUndefined();
		expect(tool(setup(member({ tools: ['sandbox_run'] })).x, 'sandbox_run')).toBeDefined();
		expect(tool(setup(member({ admin: true })).x, 'sandbox_run')).toBeDefined();
		expect(tool(setup(member({ external: true, admin: false, tools: ['sandbox_run'] })).x, 'sandbox_run')).toBeUndefined();
		expect(tool(ctx({ ...setup(member({ admin: true })).x, inApp: false }), 'sandbox_run')).toBeUndefined();
	});
	it('mounts this conversation\'s attachment, stores what it produced as the member\'s file and shows the image', async () => {
		const { x, jobsRun, written } = setup(member({ tools: ['sandbox_run'] }));
		const got = await result(x, 'sandbox_run', { command: 'node', args: ['-e', '1'], files: [{ seq: 3 }] }) as { result: { code: number; files: { id: string; name: string }[] } };
		expect(jobsRun[0]).toMatchObject({ command: 'node', args: ['-e', '1'], files: [{ name: 'sales.csv', bytes: new Uint8Array([7]) }] });
		expect(got.result).toMatchObject({ code: 0, stdout: 'ok', files: [{ name: 'chart.png', mime: 'image/png', size: 2 }] });
		expect(written[0]).toEqual([got.result.files[0]!.id, 'chart.png', 'image/png', 2, 'k-out', 'h', '2026-09-26T00:00:00.000Z', 'ann']);
		expect(x.files).toHaveLength(1);
		expect(await result(x, 'sandbox_run', { command: 'node', files: [{ seq: 9 }] })).toEqual({ result: { error: 'Message 9 has no stored file 0.' } });
	});
});
