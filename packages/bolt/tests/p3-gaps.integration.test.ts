// P3 gaps through the engine entry and the test kit: `search.semantic` embeddings and the `bolt.embed` run (rule 16),
// an erase re-answering live views without firing triggers (rules 38e, 50, 66), and `start` over `/__bolt/act` with a
// caller-minted uuidv7 run id (rules 24, 31).
import { describe, expect, it } from 'vitest';
import type { EmbeddingsPort, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { lowerRead } from '../src/engine/index.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { uuidv7, uuidv7Within, type ActReply, type Frame } from '../src/protocol/wire.ts';
import { respondSystem1, testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { docs: { description: 'A doc', label: 'title', fields: { title: { kind: 'text' }, body: { kind: 'text', optional: true } },
		search: { text: ['title'], semantic: { fields: ['title'], model: 'small', dim: 3 } } } },
	relationships: {},
	collections: { docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'body'] } }, update: { input: { columns: ['title', 'body'] } } } },
	policies: { p: { description: 'P', grants: { docs: { read: true, create: true, update: true } }, automations: ['tidy'] } },
	automations: { tidy: { description: 'Tidy', runAs: ['p'] } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const created = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o.records[0]!.id; };
const sql = async (t: TestWorkspace, text: string, ...params: string[]) => (await t.db.read([{ text, params }]))[0]!.rows;
const embedded = (t: TestWorkspace, id: string) => sql(t, 'SELECT bolt_embedding::text AS e FROM docs WHERE id::text = $1', id).then((r) => r[0]!['e']);
const queued = (t: TestWorkspace) => sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.embed' AND state = 'queued'`).then((r) => r[0]!['n']);

describe('search.semantic embeddings (rule 16)', () => {
	it('a create queues bolt.embed in its statement; the run embeds after commit; only a source-field change makes it stale again', async () => {
		const t = await testWorkspace({ manifest });
		const calls: string[][] = [];
		const port: EmbeddingsPort = { embed: async (inputs, model) => { const texts = inputs as string[]; calls.push([model, ...texts]); return texts.map((x) => [x.length, 0, 1]); } }; // hook:runtime (text rows only)
		t.count.reset();
		const id = created(await t.as(t.admin).act('docs.create', { title: 'desk', body: 'oak' }));
		expect(t.count.writes).toBe(1);
		expect(await queued(t)).toBe(1);
		expect(t.fakes.deadlines.announced.at(-1)).toEqual({ scope: 'test', at: t.clock.now() });
		expect(await embedRun(t.manifest, t.db, port)({})).toEqual({ embedded: 1 });
		expect(calls).toEqual([['small', 'desk']]);
		expect(await embedded(t, id)).toBe('[4,0,1]');
		await t.as(t.admin).act('docs.update', { target: id, set: { body: 'pine' } });
		expect(await embedded(t, id)).toBe('[4,0,1]');
		expect(await queued(t)).toBe(1);
		await t.as(t.admin).act('docs.update', { target: id, set: { title: 'chair' } });
		expect(await embedded(t, id)).toBeNull();
		expect(await queued(t)).toBe(2);
		expect(JSON.stringify(await sql(t, 'SELECT changes FROM bolt_history'))).not.toContain('bolt_embedding');
	});

	it('without an embeddings port the queued run fails unavailable and the vector stays missing', async () => {
		const t = await testWorkspace({ manifest });
		const id = created(await t.as(t.admin).act('docs.create', { title: 'desk' }));
		await t.runDue();
		expect(await sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'bolt.embed'`)).toEqual([{ state: 'failed', code: 'unavailable' }]);
		expect(await embedded(t, id)).toBeNull();
	});
});

describe('semantic similarity over search.semantic (L-BOLT-123)', () => {
	it('similar({ to: text | { record } }) ranks by the embedding; /semantic fuses it with the lexical hit', async () => {
		const near: { [text: string]: number[] } = { desk: [1, 0, 0], table: [1, 0, 0], chair: [0.9, 0.1, 0], lamp: [0, 0, 1] };
		const embed: EmbeddingsPort['embed'] = async (inputs) => (inputs as string[]).map((x) => near[x] ?? [0, 1, 0]);
		const t = await testWorkspace({ manifest, ai: { sys_1: respondSystem1, sys_2: { models: ['default'], infer: async () => { throw new Error('unused'); } }, embed } });
		const desk = created(await t.as(t.admin).act('docs.create', { title: 'desk' }));
		for (const title of ['chair', 'lamp']) await t.as(t.admin).act('docs.create', { title });
		await embedRun(t.manifest, t.db, { embed })({});
		const b = { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} };
		const read = async (m: string, a: unknown[]) => (await t.engine.read([lowerRead(t.manifest, m, a as never)], { as: 'workspace' }, b))[0] as { title: string; $distance?: number }[] & { rows?: { title: string }[] };
		const byText = await read('similar', ['docs', { to: 'table', limit: 2 }]);
		expect(byText.map((r) => r.title)).toEqual(['desk', 'chair']);
		expect(typeof byText[0]!.$distance).toBe('number');
		expect((await read('similar', ['docs', { to: { record: { id: desk } }, limit: 5 }])).map((r) => r.title)).toEqual(['chair', 'lamp']);
		const hybrid = await read('read', ['docs', { search: '/semantic lamp', limit: 10 }]);
		expect(hybrid.rows!.map((r) => r.title)[0]).toBe('lamp');
		expect(hybrid.rows).toHaveLength(3);
		expect(() => lowerRead(t.manifest, 'similar', ['docs', { to: '', limit: 1 }])).toThrow(/to: text/);
	});
});

describe('erase and the live lane (rules 38e, 50, 66)', () => {
	it('an erase re-answers the views that showed the row and queues no triggered run', async () => {
		const t = await testWorkspace({ manifest });
		const id = created(await t.as(t.admin).act('docs.create', { title: 'desk' }));
		const admin = t.engine.authority(t.admin), frames: Frame[] = [];
		const conn = t.engine.live.connect(admin, (f) => frames.push(f), () => {});
		await t.engine.live.register(conn, 'v', { read: lowerRead(manifest, 'read', ['docs', { all: true, select: { title: true } }]) });
		const r = await t.engine.act({ collection: 'docs', verb: 'erase', input: { target: id }, key: 'e1', issuedAt: t.clock.now(), authority: admin,
			bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }, invocationId: 'e1' });
		expect(r.outcome.kind).toBe('committed');
		await t.engine.live.settled();
		// the erased row leaves the view as a patch built from the statement's RETURNING set
		expect(frames.at(-2)).toEqual({ t: 'patch', view: 'v', v: r.v, ops: [{ op: 'remove', id }] });
	});
});

describe('start over /__bolt/act (rules 24, 31)', () => {
	it('takes a uuidv7 minted within 24 h; a v4 or a stale id is invalidInput; a resend is the same run', async () => {
		const t = await testWorkspace({ manifest });
		const rep = t.engine.authority(t.member(['p']));
		const handle = boltHandler({ engine: t.engine, session: async () => rep, uuid: () => crypto.randomUUID(),
			bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
		const start = async (id: string) => {
			const res = (await handle(new Request('http://cell/__bolt/act', { method: 'POST', headers: { 'Idempotency-Key': id },
				body: JSON.stringify({ callable: 'start', input: { automation: 'tidy', input: {}, id }, issuedAt: t.clock.now() }) })))!;
			return { status: res.status, reply: await res.json() as ActReply };
		};
		const now = Date.parse(t.clock.now()), id = uuidv7(now);
		expect(uuidv7Within(id, now)).toBe(true);
		expect(uuidv7Within(uuidv7(now - 25 * 3_600_000), now)).toBe(false);
		expect(await start(crypto.randomUUID())).toMatchObject({ status: 400, reply: { outcome: { code: 'invalidInput', field: 'id' } } });
		expect(await start(uuidv7(now - 25 * 3_600_000))).toMatchObject({ status: 400 });
		expect(await start(id)).toMatchObject({ status: 200, reply: { outcome: { kind: 'committed', output: { id, automation: 'tidy' } } } });
		expect(await start(id)).toMatchObject({ status: 200 });
		expect(await sql(t, `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'tidy'`)).toEqual([{ n: 1 }]);
	});
});
