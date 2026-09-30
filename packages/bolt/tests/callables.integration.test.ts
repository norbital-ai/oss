// Collection queries and actions, starts, visitors and refusal scoping (rules 31, 32, 33, 33a, 38d) on PGlite.
import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { forActor } from '../src/engine/callables/index.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const ACME = '0199a000-0000-4000-8000-0000000000c1';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } },
		orders: { description: 'An order', label: 'title', fields: {
			title: { kind: 'text' }, region: { kind: 'enum', values: ['north', 'south'] },
			status: { kind: 'state', initial: 'draft', states: { draft: { to: ['submitted'] }, submitted: {} } } } },
		notes: { description: 'A note', label: 'text', fields: { text: { kind: 'text' } } },
	},
	relationships: { 'orders.customer': { to: 'customers', inverse: 'orders' }, 'notes.order': { to: 'orders', inverse: 'notes' } },
	collections: {
		customers: { read: { fields: 'all' } },
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'region', 'customer'] } },
			update: { input: { columns: ['title', 'status'] } },
			queries: {
				mine: { description: 'My orders', input: {}, output: { kind: 'int' } },
				secret: { description: 'Internal', input: {}, output: { kind: 'int' }, internal: true },
			},
			actions: {
				place: { description: 'Place', input: { title: { kind: 'text' }, customer: { kind: 'id', of: 'customers' } }, output: { kind: 'text' } },
				submit: { description: 'Submit', input: {}, target: 'record' },
				audit: { description: 'Internal', input: {}, internal: true },
				boom: { description: 'Throws', input: {} },
			},
		},
		notes: { read: { fields: 'all' }, create: { input: { columns: ['text', 'order'] } } },
	},
	integrations: {}, pipelines: {},
	policies: {
		rep: { description: 'Rep', automations: ['followup'], grants: {
			customers: { read: true },
			orders: { read: { created_by: { eq: { actor: 'id' } } }, create: true, update: 'read', moves: { status: ['draft->submitted'] },
				queries: ['mine', 'secret'], actions: ['place', 'submit', 'boom', 'audit'] },
			notes: { read: true, create: true },
		} },
		// may call `place` but writes no orders: the action's recorded write is judged as this caller (rule 33)
		clerk: { description: 'Clerk', grants: { customers: { read: true }, orders: { read: true, actions: ['place'] } } },
	},
	teams: {}, automations: { followup: { description: 'Follow up', input: { order: { kind: 'id', of: 'orders' } }, runAs: ['rep'] } },
	channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}, agent: { skills: {} },
	apps: {},
} as unknown as EngineManifest;

const guest = { source: `export default { collection: { orders: { bodies: {
	queries: {
		mine: async (input, ctx) => (await ctx.read('orders', { all: true })).rows.length,
		secret: async () => 42,
	},
	actions: {
		place: async (input, ctx) => {
			const o = await ctx.act('orders.create', { title: input.title, region: 'north', customer: input.customer });
			const id = o.records[0].id;
			await ctx.act('notes.create', { text: 'placed ' + input.title, order: id });
			if (input.title === 'no') ctx.refuse('not that one', { field: 'title' });
			const run = await ctx.schedule('followup', { order: id }, { at: { now: '+1h' } });
			await ctx.notify({ to: { policy: 'rep' }, title: 'Placed' });
			return id + ':' + run.automation + ':' + (await ctx.query('orders', 'secret', {}));
		},
		submit: async (input, ctx) => { await ctx.act('orders.update', { target: ctx.target.id, set: { status: 'submitted' } }); return ctx.target.title; },
		audit: async () => 'ok',
		boom: async () => { throw new Error('a bug'); },
	},
} } } };` };

let t: TestWorkspace;
beforeEach(async () => {
	t = await testWorkspace({ manifest, guest, seed: { customers: [{ id: ACME, name: 'Acme' }] } });
});
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const rows = async (sql: string) => (await t.db.read([{ text: sql, params: [] }]))[0]!.rows;

describe('collection actions (rules 31, 33)', () => {
	it('records every ctx.act, schedule and notice and commits them in the one statement', async () => {
		const rep = t.as(t.member(['rep']));
		// L-BOLT-354: the `{ policy: 'rep' }` notice fans out to the one member on file who holds it
		await t.db.write({ text: `WITH u AS (INSERT INTO sys_user (id, name) VALUES ('u9', 'Rep') RETURNING id)
			INSERT INTO sys_assignment (id, principal_type, principal, policy) SELECT 'a9', 'sys_user', id, 'rep' FROM u`, params: [] });
		t.count.reset();
		const placed = ok(await rep.act('orders.place', { title: 'desk', customer: ACME }));
		expect(t.count.writes).toBe(1);
		expect(placed.records.map((r) => r.collection).sort()).toEqual(['notes', 'orders']);
		const id = placed.records.find((r) => r.collection === 'orders')!.id;
		expect(placed.output).toBe(`${id}:followup:42`);
		expect((await rep.read('notes', { all: true })).rows.map((n) => n['text'])).toEqual(['placed desk']);
		const [run] = await rows(`SELECT automation, input, due_at, cause FROM sys_run`);
		expect(run).toMatchObject({ automation: 'followup', input: { order: id }, cause: 'schedule' });
		expect(new Date(String(run!['due_at'])).toISOString()).toBe('2026-09-25T11:00:00.000Z');
		expect(t.fakes.deadlines.announced).toEqual([{ scope: 'test', at: '2026-09-25T11:00:00.000Z' }]);
		expect(await rows(`SELECT title, member FROM sys_notification`)).toEqual([{ title: 'Placed', member: 'u9' }]);
	});

	it('a ctx.refuse after writes commits nothing and is recorded once', async () => {
		const rep = t.as(t.member(['rep']));
		const first = await rep.act('orders.place', { title: 'no', customer: ACME }, { key: 'k' });
		expect(first).toEqual({ kind: 'refused', code: 'refused', message: 'not that one', field: 'title', rule: 'orders.place' });
		t.count.reset();
		expect(await rep.act('orders.place', { title: 'no', customer: ACME }, { key: 'k', retry: true })).toEqual(first);
		expect(t.count.writes).toBe(0);
		expect(await rows('SELECT id FROM orders')).toEqual([]);
	});

	it('an unmarked replay returns the first outcome and writes nothing new', async () => {
		const rep = t.as(t.member(['rep']));
		const first = await rep.act('orders.place', { title: 'desk', customer: ACME }, { key: 'same' });
		expect(await rep.act('orders.place', { title: 'desk', customer: ACME }, { key: 'same' })).toEqual(first);
		expect(await rows('SELECT count(*)::int AS n FROM orders')).toEqual([{ n: 1 }]);
		expect(await rep.act('orders.place', { title: 'other', customer: ACME }, { key: 'same' })).toMatchObject({ kind: 'refused', code: 'keyReuse' });
	});

	it("an action's write is judged as the caller: a clerk who may call it but not write orders is forbidden", async () => {
		expect(await t.as(t.member(['clerk'])).act('orders.place', { title: 'desk', customer: ACME })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await rows('SELECT id FROM orders')).toEqual([]);
	});

	it('is reachable only by policy, and an internal action only from server code (rule 33a)', async () => {
		expect(await t.as(t.member([])).act('orders.place', { title: 'x', customer: ACME })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await t.as(t.member(['rep'])).act('orders.audit', {})).toMatchObject({ kind: 'refused', code: 'forbidden' });
		await expect(t.as(t.member(['rep'])).query('orders.secret')).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('decodes the input and checks its refs before guest code (rules 23, 36)', async () => {
		const rep = t.as(t.member(['rep']));
		expect(await rep.act('orders.place', { title: 1, customer: ACME })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'title' });
		expect(await rep.act('orders.place', { title: 'x', customer: '0199a000-0000-4000-8000-00000000dead' })).toMatchObject({ kind: 'refused', code: 'notFound', field: 'customer' });
	});

	it('a record action runs on its target row', async () => {
		const rep = t.as(t.member(['rep']));
		const id = ok(await rep.act('orders.create', { title: 'chair', region: 'north', customer: ACME })).records[0]!.id;
		expect(ok(await rep.act('orders.submit', { target: id })).output).toBe('chair');
		expect(await rep.get('orders', id)).toMatchObject({ status: 'submitted' });
		expect(await t.as(t.member(['rep'])).act('orders.submit', { target: id })).toMatchObject({ kind: 'refused', code: 'notFound', field: 'target' });
	});

	it('a guest failure is unknown, not a refusal, and is not recorded (rule 72a)', async () => {
		t.count.reset();
		const r = await t.calls.action({ collection: 'orders', action: 'boom', input: {}, key: 'b', issuedAt: t.clock.now(), invocationId: 'inv-1',
			authority: t.engine.authority(t.member(['rep'])), bindings: { now: t.clock.now(), today: '2026-09-25', tz: 'UTC', params: {} }, from: 'client' });
		expect(r.outcome).toEqual({ kind: 'unknown', invocation: 'inv-1' });
		expect(r.error).toMatchObject({ code: 'guestError', message: 'a bug' });
		expect(t.count.writes).toBe(0);
	});
});

describe('collection queries (rule 31: a /q read)', () => {
	it('reads as the caller, writes nothing, and is reachable only by policy', async () => {
		const a = t.as(t.member(['rep'])), b = t.as(t.member(['rep']));
		ok(await a.act('orders.create', { title: 'x', region: 'north', customer: ACME }));
		t.count.reset();
		expect(await a.query('orders.mine')).toBe(1);
		expect(await b.query('orders.mine')).toBe(0);
		expect(t.count.writes).toBe(0);
		await expect(t.as(t.member(['clerk'])).query('orders.mine')).rejects.toMatchObject({ code: 'forbidden' });
		await expect(a.query('orders.mine', { extra: 1 })).rejects.toMatchObject({ code: 'invalidInput' });
	});
});

describe('start (rules 31, 33, 51)', () => {
	it('the client-minted id is the key: same input is the same run, other input keyReuse, and only policy.automations may start', async () => {
		const rep = t.as(t.member(['rep']));
		const order = ok(await rep.act('orders.create', { title: 'x', region: 'north', customer: ACME })).records[0]!.id;
		const id = '0199a000-0000-7000-8000-000000000001';
		const first = await rep.start('followup', { order }, { id });
		expect(first).toEqual({ kind: 'committed', output: { id, automation: 'followup' }, records: [] });
		expect(await rep.start('followup', { order }, { id })).toEqual(first);
		expect(await rep.start('followup', { order: ACME }, { id })).toMatchObject({ kind: 'refused', code: 'keyReuse' });
		expect(await rows('SELECT due_at, cause FROM sys_run')).toHaveLength(1);
		expect(await t.as(t.member(['clerk'])).start('followup', { order })).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});
});

describe('the kit: signIn and the clock', () => {
	it('signIn resolves the member by email with their assigned policies; the clock binds every call', async () => {
		await t.db.write({ text: `WITH u AS (INSERT INTO sys_user (id, email, name) VALUES ('u1', 'Rep@Example.com', 'Rep') RETURNING id)
			INSERT INTO sys_assignment (id, principal_type, principal, policy) SELECT 'a1', 'sys_user', id, 'rep' FROM u`, params: [] });
		const rep = t.as(await t.signIn('rep@example.com'));
		expect(rep.authority.policies).toEqual(['rep']);
		t.clock.advance('2h');
		expect(t.clock.now()).toBe('2026-09-25T12:00:00.000Z');
		ok(await rep.act('orders.place', { title: 'desk', customer: ACME }));
		const [run] = await rows('SELECT due_at FROM sys_run');
		expect(new Date(String(run!['due_at'])).toISOString()).toBe('2026-09-25T13:00:00.000Z');
		await expect(t.signIn('nobody@example.com')).rejects.toThrow();
	});
});

describe('refusal messages by actor (rule 32)', () => {
	it('public and API-key actors receive codes only', () => {
		const no: Outcome = { kind: 'refused', code: 'refused', message: 'Shady is blocked', field: 'customer' };
		expect(forActor(no, { kind: 'apiKey', key: 'k' })).toEqual({ kind: 'refused', code: 'refused', message: 'refused' });
		expect(forActor(no, { kind: 'envoy', envoy: 'e', channel: 'c', sender: 's', member: null })).toEqual({ kind: 'refused', code: 'refused', message: 'refused' });
		expect(forActor(no, { kind: 'member', id: 'u', email: null, phone: null, external: false, teams: [], teamPath: [], admin: false, party: null })).toEqual(no);
	});
});

// ── rule 38d: the careers recipe (§6.3) ──
const OPEN = '0199a000-0000-4000-8000-00000000000a', CLOSED = '0199a000-0000-4000-8000-00000000000b';
const careers = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		openings: { description: 'Roles', label: 'title', fields: { title: { kind: 'text' }, location: { kind: 'text' }, description: { kind: 'text' },
			status: { kind: 'enum', values: ['draft', 'open', 'closed'] } } },
		applications: { description: 'Applications', label: 'name', fields: { name: { kind: 'text' }, email: { kind: 'text', format: 'email' },
			cv: { kind: 'file', accept: ['application/pdf'], max: '5MiB', optional: true } } },
	},
	relationships: { 'applications.opening': { to: 'openings', inverse: 'applications' } },
	collections: {
		openings: { read: { fields: 'all' }, queries: { count: { description: 'Count', input: {}, output: { kind: 'int' } } } },
		applications: { read: { fields: 'all' }, create: { input: { columns: ['opening', 'name', 'email', 'cv'] } } },
	},
	integrations: {}, pipelines: {},
	policies: { applicant: { description: 'Apply', grants: {
		openings: { read: { where: { status: { eq: 'open' } }, fields: ['title', 'location', 'description'] }, queries: ['count'] },
		applications: { create: { opening: { is: { status: { eq: 'open' } } } } } },
	limits: { register: { rate: '10/h', per: 'ip' } } } },
	apps: { careers: { title: 'Careers', description: 'Jobs', icon: 'x', audience: { public: ['applicant'] }, pages: {} } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

describe('visitors (rule 38d)', () => {
	let v: TestWorkspace;
	beforeEach(async () => {
		v = await testWorkspace({ manifest: careers, seed: { openings: [
			{ id: OPEN, title: 'Engineer', location: 'SG', description: 'Build', status: 'open' },
			{ id: CLOSED, title: 'Old', location: 'KL', description: 'Gone', status: 'closed' }] } });
	});

	it('lists open roles masked to the granted fields, applies to an open role, and nothing else', async () => {
		const me = v.visitor('careers');
		const open = (await me.read('openings', { all: true })).rows;
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({ id: OPEN, title: 'Engineer', location: 'SG', description: 'Build', status: { $masked: true } });
		ok(await me.act('applications.create', { opening: OPEN, name: 'Ada', email: 'ada@example.com' }));
		expect(await me.act('applications.create', { opening: CLOSED, name: 'Ada', email: 'ada@example.com' })).toMatchObject({ kind: 'refused', code: 'notFound', field: 'opening' });
		expect(await me.act('applications.create', { opening: '0199a000-0000-4000-8000-00000000dead', name: 'A', email: 'a@x.io' })).toMatchObject({ code: 'notFound', field: 'opening' });
		await expect(me.read('applications', { all: true })).rejects.toMatchObject({ code: 'forbidden' });
		await expect(me.query('openings.count')).rejects.toMatchObject({ code: 'forbidden' });
		expect(await me.act('applications.update', { target: OPEN, set: {} })).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});

	it('the 11th attempt in an hour from one IP is rateLimited, whatever the first ten were; a new visitor id does not reset it', async () => {
		const at = (ip: string) => v.visitor('careers', { ip });
		for (let i = 0; i < 10; i++) {
			const input = i % 3 === 0 ? { opening: OPEN, name: `A${i}`, email: 'a@x.io' } : i % 3 === 1 ? { opening: CLOSED, name: 'A', email: 'a@x.io' } : { nope: true };
			expect((await at('198.51.100.1').act('applications.create', input)).kind).not.toBe('pendingApproval');
		}
		expect(await at('198.51.100.1').act('applications.create', { opening: OPEN, name: 'Z', email: 'z@x.io' })).toMatchObject({ kind: 'refused', code: 'rateLimited' });
		ok(await at('198.51.100.2').act('applications.create', { opening: OPEN, name: 'Z', email: 'z@x.io' }));
	});

	it('uploads persist one sys_file row per client-minted id; a resend adds none', async () => {
		const me = v.visitor('careers');
		const file = { name: 'cv.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]), id: '0199a000-0000-7000-8000-0000000000f1' };
		const first = ok(await me.upload('applications.cv', file));
		expect(first.output).toMatchObject({ id: file.id, name: 'cv.pdf', mime: 'application/pdf', bytes: 3 });
		expect(await me.upload('applications.cv', file)).toEqual(first);
		expect(await v.db.read([{ text: 'SELECT count(*)::int AS n FROM sys_file', params: [] }]).then((r) => r[0]!.rows)).toEqual([{ n: 1 }]);
		expect(await me.upload('applications.cv', { ...file, id: undefined, mime: 'image/png' } as never)).toMatchObject({ kind: 'refused', code: 'invalidInput' });
		expect(await me.upload('applications.name' as `${string}.${string}`, file)).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});
});

describe('the kit compiles a workspace directory (root)', () => {
	it('bolt check → engine → a transform act and a collection query through the built guest', async () => {
		const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { dirname, join } = await import('node:path');
		const root = join(tmpdir(), 'norbital-scratch', `kit-${crypto.randomUUID()}`);
		const files: { [p: string]: string } = {
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			'src/data/model/orders/+model.ts': `export default { description: 'Orders', label: 'title', fields: { title: { kind: 'text' } } };`,
			'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
const c = collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
	queries: { count: { description: 'Count', input: {}, output: { kind: 'int' } } } });
c.transform(async (rows) => rows.map((r) => ({ ...r, title: r.title.trim() })));
c.query('count', async (input, ctx) => (await ctx.read('orders', { all: true })).rows.length);
export default c;`,
			'src/access/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, queries: ['count'] } } };`,
			'seed/orders.json': JSON.stringify([{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }]),
		};
		for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
		try {
			const k = await testWorkspace({ root });
			const rep = k.as(k.member(['rep']));
			const id = ok(await rep.act('orders.create', { title: '  desk ' })).records[0]!.id;
			expect(await rep.get('orders', id)).toMatchObject({ title: 'desk' });
			expect(await rep.query('orders.count')).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a custom field's validate runs on every write and refuses with the field and its message (§3.3.2)", async () => {
		const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { dirname, join } = await import('node:path');
		const root = join(tmpdir(), 'norbital-scratch', `kit-${crypto.randomUUID()}`);
		const files: { [p: string]: string } = {
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			'src/data/custom_field/code/+definition.ts': `import { customField } from '@norbital-ai/bolt';
const f = customField({ description: 'An upper-case code', shape: { kind: 'text' } });
export default f;
f.validate((v) => /^[A-Z]+$/.test(v) ? undefined : 'Use capital letters only.');`,
			'src/data/model/orders/+model.ts': `export default { description: 'Orders', label: 'title', fields: { title: { kind: 'text' },
	code: { kind: 'custom', of: 'code', optional: true }, codes: { kind: 'custom', of: 'code', many: true, optional: true } } };`,
			'src/data/collection/orders/+collection.ts': `import { collection } from '@norbital-ai/bolt';
export default collection('orders', { read: { fields: 'all' }, create: { input: { columns: ['title', 'code', 'codes'] } }, update: { input: { columns: ['code'] } } });`,
			'src/access/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, update: true } } };`,
		};
		for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
		try {
			const k = await testWorkspace({ root, seed: 'none' });
			const rep = k.as(k.member(['rep']));
			const id = ok(await rep.act('orders.create', { title: 'a', code: 'ABC', codes: ['X', 'Y'] })).records[0]!.id;
			expect(await rep.act('orders.create', { title: 'b', code: 'abc' })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'code', message: 'Use capital letters only.' });
			expect(await rep.act('orders.create', { title: 'c', codes: ['X', 'y'] })).toMatchObject({ kind: 'refused', field: 'codes' });
			expect(await rep.act('orders.update', { target: id, set: { code: 'lower' } })).toMatchObject({ kind: 'refused', field: 'code', message: 'Use capital letters only.' });
			expect(await k.as(k.admin).act('orders.create', { title: 'd', code: 'x1' })).toMatchObject({ kind: 'refused', field: 'code' });
			expect(await rep.get('orders', id)).toMatchObject({ code: 'ABC' });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
