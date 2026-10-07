// Gaps the template migration found in the write area, one reproduction each: collection
// notifications on an ordinary commit (rule 47), writing an exclusive arc (polymorphic ref), json `shape` on write, a
// model check's authored message, `accept: ['*/*']` at upload, an automation calling a collection action, `revision`
// as a model field, and an FK to `sys_user` read back through its relation.
import { describe, expect, it } from 'vitest';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { manifestErrors, type Manifest } from '../src/compiler/load.ts';
import { testWorkspace } from '../src/test/index.ts';

const U = '019fc6bb-7f21-76fd-8597-7de44181da68';
const empty = { integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} } };
const manifest = {
	...empty,
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		projects: { description: 'A project', label: 'title', fields: {
			title: { kind: 'text' },
			profile: { kind: 'json', optional: true, shape: { kind: 'object', fields: { grade: { kind: 'enum', values: ['a', 'b'] }, weight: { kind: 'number', optional: true } } } },
			stock: { kind: 'int', default: 0 },
			doc: { kind: 'file', accept: ['*/*'], max: '1MiB', optional: true },
		}, check: { stock_not_negative: { where: { stock: { gte: 0 } }, message: 'Stock cannot go below zero.' }, bare: { stock: { lte: 1000 } } } },
		quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
		activities: { description: 'An activity', label: 'subject', fields: { subject: { kind: 'text' } } },
		cases: { description: 'A case', label: 'title', fields: { title: { kind: 'text' } } },
		classifications: { description: 'A classification', label: 'note', fields: { note: { kind: 'text' } } },
	},
	relationships: {
		'activities.regarding': { to: ['projects', 'quotes'], optional: true, inverse: 'activities' },
		'projects.owner': { to: 'sys_user', optional: true, default: { actor: 'id' } },
		'classifications.case': { to: 'cases', inverse: 'classifications' },
	},
	collections: {
		projects: { read: { fields: 'all', relations: 'all' }, create: { input: { columns: ['title', 'profile', 'stock', 'doc', 'owner'] } },
			update: { input: { columns: ['title', 'profile', 'stock', 'owner'] } },
			notifications: { committed: [
				{ channel: 'inbox', to: [{ team: 'R&D' }], on: { action: ['create'] }, title: { one: 'New project', many: '{count} new projects' } },
				{ channel: 'inbox', to: [{ user: 'owner' }, 'requestor'], on: { action: ['update'] }, title: 'Project changed' },
			] } },
		quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } },
		activities: { read: { fields: 'all', relations: 'all' }, create: { input: { columns: ['subject', 'regarding'] } }, update: { input: { columns: ['regarding'] } } },
		cases: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
			notifications: { committed: [{ channel: 'inbox', to: [{ team: 'QA' }], title: 'Case raised' }] },
			actions: { raise: { description: 'Raise a case with its classification', input: { title: { kind: 'text' } }, output: { kind: 'text' } } } },
		classifications: { read: { fields: 'all' }, create: { input: { columns: ['note', 'case'] } } },
	},
	policies: {
		ops: { description: 'Ops', automations: ['file'], grants: { cases: { read: true, create: true, actions: ['raise'] }, classifications: { read: true, create: true },
			projects: { read: { owner: { eq: { actor: 'id' } } }, create: true, update: 'read' } } },
	},
	automations: { file: { description: 'Files a scan', input: { title: { kind: 'text' } }, runAs: ['ops'] } },
} as unknown as EngineManifest;
const guest = { source: `export default {
	collection: { cases: { bodies: { queries: {}, actions: {
		raise: async (input, ctx) => {
			const c = await ctx.act('cases.create', { title: input.title });
			await ctx.act('classifications.create', { note: 'auto', case: c.records[0].id });
			return c.records[0].id;
		},
	} } } },
	automation: { file: { body: async (input, ctx) => { await ctx.act('cases.raise', { title: input.title }); } } },
};` };

const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const setup = async () => {
	const t = await testWorkspace({ manifest, guest });
	// L-BOLT-354: inbox notices fan out to members on file — Ana is R&D, Quinn is QA
	await t.db.write({ text: `WITH t AS (INSERT INTO sys_team (id, name) VALUES ('t-rd', 'R&D'), ('t-qa', 'QA') RETURNING id)
		INSERT INTO sys_user (id, email, name, kind, admin, team) SELECT * FROM (VALUES ('${U}', 'a@x.test', 'Ana', 'staff', false, 't-rd'), ('u-qa', 'q@x.test', 'Quinn', 'staff', false, 't-qa')) v
		WHERE (SELECT count(*) FROM t) = 2`, params: [] });
	const rows = async (sql: string) => (await t.db.read([{ text: sql, params: [] }]))[0]!.rows;
	return { t, rows, A: t.as(t.admin) };
};

describe('write gaps found by the template migration', () => {
	it('an ordinary commit writes the collection\'s `committed` notices in its statement (rule 47)', async () => {
		const { t, rows, A } = await setup();
		ok(await A.act('projects.create', [{ title: 'a', owner: U }, { title: 'b', owner: U }]));
		expect(await rows(`SELECT recipient, title, link FROM sys_notification`)).toEqual([
			{ recipient: { channel: 'inbox', recipients: [{ team: 'R&D' }] }, title: '2 new projects', link: null }]);
		const id = ok(await A.act('projects.create', { title: 'c' })).records[0]!.id;
		expect((await rows(`SELECT title, link FROM sys_notification ORDER BY at, title`)).map((r) => r['title'])).toContain('New project');
		const actor = t.admin.actor.kind === 'member' ? t.admin.actor.id : '';
		ok(await A.act('projects.update', { target: id, set: { title: 'c2', owner: U } }));
		expect(await rows(`SELECT DISTINCT recipient, link FROM sys_notification WHERE title = 'Project changed'`)).toEqual([
			{ recipient: { channel: 'inbox', recipients: [{ user: U }, { user: actor }] }, link: { collection: 'projects', id } }]);
	});

	it('a batch create answers its records in input order', async () => {
		const { rows, A } = await setup();
		const titles = ['A1', 'A5', 'A2', 'A3', 'A4', 'A0'];
		const out = ok(await A.act('quotes.create', titles.map((title) => ({ title }))));
		const byId = new Map((await rows(`SELECT id::text, title FROM quotes`)).map((r) => [r['id'], r['title']]));
		expect(out.records.map((r) => byId.get(r.id))).toEqual(titles);
	});

	it('an action\'s recorded writes carry their notices into the action\'s statement', async () => {
		const { rows, A } = await setup();
		ok(await A.act('cases.raise', { title: 'x' }));
		expect(await rows(`SELECT title FROM sys_notification`)).toEqual([{ title: 'Case raised' }]);
	});

	it('writes an exclusive arc (polymorphic reference) and reads it back as a RecordRef', async () => {
		const { A } = await setup();
		const q = ok(await A.act('quotes.create', { title: 'q' })).records[0]!.id;
		const p = ok(await A.act('projects.create', { title: 'p' })).records[0]!.id;
		const a = ok(await A.act('activities.create', { subject: 's', regarding: { collection: 'quotes', id: q } })).records[0]!.id;
		expect(await A.get('activities', a)).toMatchObject({ regarding: { collection: 'quotes', id: q } });
		ok(await A.act('activities.update', { target: a, set: { regarding: { collection: 'projects', id: p } } }));
		expect(await A.get('activities', a)).toMatchObject({ regarding: { collection: 'projects', id: p } });
		expect(await A.act('activities.create', { subject: 's', regarding: { collection: 'cases', id: q } })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'regarding' });
		expect(await A.act('activities.create', { subject: 's', regarding: { collection: 'projects', id: q } })).toMatchObject({ kind: 'refused', code: 'notFound', field: 'regarding' });
	});

	it('checks a json field against its declared shape on write', async () => {
		const { A } = await setup();
		ok(await A.act('projects.create', { title: 'p', profile: { grade: 'a', weight: 2 } }));
		expect(await A.act('projects.create', { title: 'p2', profile: { grade: 'z' } })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'profile' });
		expect(await A.act('projects.create', { title: 'p3', profile: { grade: 'a', extra: 1 } })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'profile' });
	});

	it('refuses a broken model check with its authored message', async () => {
		const { A } = await setup();
		expect(await A.act('projects.create', { title: 'p', stock: -1 })).toMatchObject({ kind: 'refused', code: 'check', message: 'Stock cannot go below zero.' });
		expect(await A.act('projects.create', { title: 'p', stock: 1001 })).toMatchObject({ kind: 'refused', code: 'check', message: "the record breaks the rule 'bare'" });
	});

	it('accepts any type at upload to `accept: [\'*/*\']`', async () => {
		const { A } = await setup();
		for (const mime of ['application/x-anything', 'audio/ogg', ''])
			expect(await A.upload('projects.doc', { name: 'f', mime, bytes: new Uint8Array([1]) })).toMatchObject({ kind: 'committed' });
	});

	it('an automation calls a collection action through ctx.act, its writes in one act', async () => {
		const { t, rows } = await setup();
		ok(await t.as(t.member(['ops'])).start('file', { title: 'scan' }));
		await t.runDue();
		expect(await rows(`SELECT state FROM sys_run`)).toEqual([{ state: 'succeeded' }]);
		expect(await rows(`SELECT c.title, k.note FROM cases c JOIN classifications k ON k."case" = c.id`)).toEqual([{ title: 'scan', note: 'auto' }]);
	});

	it('an FK to sys_user writes, defaults to the actor and reads through its relation', async () => {
		const { t, A } = await setup();
		const M = t.as(t.member(['ops'], { id: U, email: 'a@x.test' }));
		const id = ok(await M.act('projects.create', { title: 'mine' })).records[0]!.id;
		expect(await A.get('projects', id, { select: { title: true, owner: { name: true } } })).toMatchObject({ title: 'mine', owner: { name: 'Ana' } });
		expect(await M.get('projects', id, { select: { title: true, owner: { name: true } } })).toMatchObject({ title: 'mine', owner: { name: 'Ana' } });
		expect((await M.read('projects', { select: { title: true, owner: { name: true } }, where: { owner: { eq: U } }, all: true })).rows)
			.toEqual([expect.objectContaining({ title: 'mine', owner: expect.objectContaining({ name: 'Ana' }) })]);
		expect((await A.read('sys_user', { select: { name: true }, where: { id: { eq: U } }, all: true })).rows).toEqual([{ id: U, name: 'Ana' }]);
	});

	it('`revision` as a model field is a clear build error (a system column)', () => {
		const m = Object.fromEntries(['workspace', 'relationship', 'model', 'collection', 'integration', 'pipeline', 'app', 'group', 'page']
			.map((r) => [r, {}])) as unknown as Manifest;
		(m as { model: object }).model = { docs: { description: 'd', label: 'title', fields: { title: { kind: 'text' }, revision: { kind: 'text' } } } };
		expect(manifestErrors(m)).toEqual([expect.objectContaining({ code: 'load/reserved-field', path: 'src/data/model/docs/+model.ts',
			message: expect.stringContaining("'revision' is a system column") })]);
	});
});
