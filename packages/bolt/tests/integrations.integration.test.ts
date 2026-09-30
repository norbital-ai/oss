// engine/integrations and engine/pipelines on PGlite: one guarantee per test (§3.3.5, rules 23, 30; G12 (1), (8)).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { FilesPort, Outcome } from '../src/engine/contracts.ts';
import { guestRunner } from '../src/engine/guest/runner.ts';
import { lowerRead } from '../src/engine/index.ts';
import { integrations, syncState } from '../src/engine/integrations/runner.ts';
import { pausedIntegrations, setPaused } from '../src/engine/integrations/sync.ts';
import { pipelines } from '../src/engine/pipelines/pipeline.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { readableFile } from '../src/engine/decisions/index.ts';
import { randomUUID } from 'node:crypto';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import { fakeErp, guestSource, mail, manifest, type Customer } from './integrations-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const guest = guestRunner({ source: guestSource }, { lowerRead: (member, args) => lowerRead(manifest, member, args), console: () => {} });
let t: TestWorkspace, erp: ReturnType<typeof fakeErp>, sync: ReturnType<typeof integrations>, runs = 0;
beforeEach(async () => {
	t = await testWorkspace({ manifest, now: NOW });
	erp = fakeErp();
	sync = integrations({ engine: t.engine, guest, http: erp.port, now: () => NOW });
});
const run = (mode: 'pull' | 'push' | 'reconcile') => sync.run('accounts', mode, `run-${runs++}`);
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const sales = () => t.as(t.member(['sales']));
const accounts = async () => (await t.as(t.admin).read('accounts', { all: true, orderBy: 'erp_id' })).rows;
const byErp = async (id: string) => (await accounts()).find((r) => r['erp_id'] === id)!;

describe('one_way: serial-pcn supplier mail (the reference)', () => {
	it('a delivered mail lands in pcn_notices, which no grant names, in one statement, its supplier resolved by Reply-To', async () => {
		const onsemi = ok(await t.as(t.admin).act('suppliers.create', { name: 'onsemi', domain: 'onsemi.com' })).records[0]!.id;
		t.count.reset();
		const [report] = await sync.deliver({ kind: 'inbound', channel: 'supplier_inbox', message: mail() }, 'run-mail');
		expect(report).toMatchObject({ pulled: 1, failures: [] });
		expect(t.count.writes).toBe(1);
		const [row] = (await sales().read('pcn_notices', { all: true, select: { message_id: true, subject: true, supplier: true, from_address: true, attachment_manifest: true } })).rows;
		expect(row).toMatchObject({ message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234: wafer fab move', supplier: onsemi,
			from_address: 'pcn@onsemi.com', attachment_manifest: [{ name: 'pcn.pdf', kind: 'application/pdf', size: 2048 }] });
	});

	it('a mail the sender edits converges its row; a redelivery is no second row', async () => {
		await sync.deliver({ kind: 'inbound', channel: 'supplier_inbox', message: mail() }, 'r1');
		await sync.deliver({ kind: 'inbound', channel: 'supplier_inbox', message: mail({ subject: 'PCN 1234 rev B' }) }, 'r2');
		await sync.deliver({ kind: 'inbound', channel: 'supplier_inbox', message: mail({ subject: 'PCN 1234 rev B' }) }, 'r3');
		const rows = (await t.as(t.admin).read('pcn_notices', { all: true })).rows;
		expect(rows.map((r) => [r['subject'], r['supplier'], r['revision']])).toEqual([['PCN 1234 rev B', null, 2]]);
	});

	it('the mirror is read-only locally: no local writer creates or deletes a notice', async () => {
		expect(await t.as(t.admin).act('pcn_notices.create', { subject: 'x' })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await sales().act('pcn_notices.delete', { target: '0199a000-0000-7000-8000-000000000001' })).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});

	it('a mail on another channel, or a delivery event, runs nothing', async () => {
		expect(await sync.deliver({ kind: 'inbound', channel: 'support', message: mail() }, 'r')).toEqual([]);
		expect(await sync.deliver({ kind: 'delivery', channel: 'supplier_inbox', providerId: 'p', report: { kind: 'sent', at: NOW, provider: 'fake' } }, 'r')).toEqual([]);
	});
});

describe('two_way: accounts ↔ the ERP over HTTP', () => {
	it('a pull pages the list and writes credit_limit, a remote-owned field no local writer may change (G12 (8))', async () => {
		for (const n of ['a', 'b', 'c']) erp.add({ name: n, credit_limit: 100, note: null });
		expect(await run('pull')).toMatchObject({ pulled: 3, failures: [] });
		expect((await accounts()).map((r) => [r['erp_id'], r['name'], r['credit_limit']])).toEqual([['E1', 'a', 100], ['E2', 'b', 100], ['E3', 'c', 100]]);
		const id = String((await byErp('E1'))['id']);
		expect(await sales().act('accounts.update', { target: id, set: { credit_limit: 5 } })).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'credit_limit' });
	});

	it('a local write queues its push in its own statement; the push lands remotely and settles the shadow', async () => {
		erp.add({ name: 'acme', credit_limit: 10, note: null });
		await run('pull');
		const id = String((await byErp('E1'))['id']);
		t.count.reset();
		ok(await sales().act('accounts.update', { target: id, set: { note: 'VIP' } }));
		expect(t.count.writes).toBe(1);
		const [queued] = await t.db.read([{ text: `SELECT automation, input FROM sys_run`, params: [] }]);
		expect(queued!.rows).toEqual([{ automation: 'accounts.integration', input: { mode: 'push' } }]);
		expect(await sync.handlers()['accounts.integration']!({ mode: 'push' })).toMatchObject({ pushed: 1, failures: [] });
		expect(erp.records.get('E1')).toMatchObject({ note: 'VIP', credit_limit: 10 });
		expect(erp.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/customers/E1', body: { note: 'VIP' } });
		erp.calls.length = 0;
		expect(await run('push')).toMatchObject({ pushed: 0 });
		expect(erp.calls).toEqual([]);
	});

	it('both sides changed: the rule settles each field and the run logs the conflict', async () => {
		erp.add({ name: 'acme', credit_limit: 10, note: 'n0' });
		await run('pull');
		const id = String((await byErp('E1'))['id']);
		ok(await sales().act('accounts.update', { target: id, set: { name: 'Acme Local', note: 'local' } }));
		erp.records.set('E1', { ...erp.records.get('E1')!, name: 'Acme Remote', note: 'remote' });
		const report = await run('reconcile');
		expect(report.conflicts).toEqual([
			{ field: 'name', base: 'acme', local: 'Acme Local', remote: 'Acme Remote', rule: 'remote_wins', winner: 'remote', remote_id: 'E1' },
			{ field: 'note', base: 'n0', local: 'local', remote: 'remote', rule: 'local_wins', winner: 'local', remote_id: 'E1' },
		]);
		expect(await byErp('E1')).toMatchObject({ name: 'Acme Remote', note: 'local' });
		expect(erp.records.get('E1')).toMatchObject({ name: 'Acme Remote', note: 'local' });
	});

	it('a failed push is visible on the row and on its run until a push succeeds', async () => {
		erp.add({ name: 'acme', credit_limit: 10, note: null });
		await run('pull');
		const id = String((await byErp('E1'))['id']);
		ok(await sales().act('accounts.update', { target: id, set: { note: 'x' } }));
		erp.down = true;
		const failed = await run('push');
		expect(failed.failures).toEqual([{ record: id, error: 'PATCH /customers/E1 answered 503' }]);
		expect((await syncState(t.db, 'accounts', [id])).get(id)).toMatchObject({ status: 'failed', error: 'PATCH /customers/E1 answered 503' });
		erp.down = false;
		expect(await run('push')).toMatchObject({ pushed: 1, failures: [] });
		expect((await syncState(t.db, 'accounts', [id])).get(id)).toMatchObject({ status: 'ok', error: null });
	});

	it('a local create is created remotely once, even when its answer is lost; its remote id lands on the row', async () => {
		const id = ok(await sales().act('accounts.create', { name: 'new co' })).records[0]!.id;
		erp.lose = (r) => r.method === 'POST' ? 'answer' : null;
		expect((await run('push')).failures).toHaveLength(1);
		erp.lose = () => null;
		await run('push');
		expect([...erp.records.values()]).toEqual([{ id: 'E1', name: 'new co', credit_limit: null, note: null }]);
		expect(await t.as(t.admin).get('accounts', id)).toMatchObject({ erp_id: 'E1' });
		expect(await run('reconcile')).toMatchObject({ pulled: 1, pushed: 0, conflicts: [] });
	});

	it('a local delete deletes remotely, and a pull before the push does not bring the record back', async () => {
		erp.add({ name: 'acme', credit_limit: 10, note: null });
		await run('pull');
		ok(await sales().act('accounts.delete', { target: String((await byErp('E1'))['id']) }));
		await run('pull');
		expect(await accounts()).toEqual([]);
		await run('push');
		expect(erp.records.size).toBe(0);
	});

	it('a reconcile deletes the rows whose remote record is gone', async () => {
		erp.add({ name: 'a', credit_limit: 1, note: null });
		erp.add({ name: 'b', credit_limit: 1, note: null });
		await run('pull');
		erp.records.delete('E1');
		expect(await run('reconcile')).toMatchObject({ pruned: 1 });
		expect((await accounts()).map((r) => r['erp_id'])).toEqual(['E2']);
	});

	it('a paused integration talks to no connection until it is resumed; a push owed meanwhile is still sent (L-BOLT-365)', async () => {
		erp.add({ name: 'acme', credit_limit: 10, note: null });
		await run('pull');
		await setPaused(t.db, 'accounts', true);
		expect(await pausedIntegrations(t.db)).toEqual(new Set(['accounts']));
		ok(await sales().act('accounts.update', { target: String((await byErp('E1'))['id']), set: { note: 'VIP' } }));
		erp.calls.length = 0;
		expect(await run('reconcile')).toMatchObject({ paused: true, pulled: 0, pushed: 0 });
		expect(erp.calls).toEqual([]);
		await setPaused(t.db, 'accounts', false);
		expect(await run('push')).toMatchObject({ pushed: 1 });
		expect(erp.records.get('E1')).toMatchObject({ note: 'VIP' });
	});

	it('converges: random interleavings of local and remote edits, creates and deletes, pulls and pushes, lost requests and answers', async () => {
		let state = 7;
		const rand = (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2 ** 31; return state % n; };
		const words = ['a', 'b', 'c', 'd'];
		for (let trial = 0; trial < 6; trial++) {
			t = await testWorkspace({ manifest, now: NOW });
			erp = fakeErp();
			sync = integrations({ engine: t.engine, http: erp.port, now: () => NOW });
			for (let i = 0; i < 3; i++) erp.add({ name: `r${i}`, credit_limit: i, note: null });
			// PATCH/DELETE are idempotent, so their answers may be lost; a create's answer only with its key (tested above)
			erp.lose = (r) => rand(4) === 0 ? 'request' : r.method !== 'GET' && r.method !== 'POST' && rand(4) === 0 ? 'answer' : null;
			for (let step = 0; step < 25; step++) {
				const rows = await accounts(), remote = [...erp.records.values()];
				const pick = <T>(xs: readonly T[]) => xs[rand(xs.length)];
				switch (rand(7)) {
					case 0: { const r = pick(rows); if (r) await sales().act('accounts.update', { target: String(r['id']), set: { [pick(['name', 'note'])!]: pick(words)! } }); break; }
					case 1: { const r = pick(remote), f = pick(['name', 'note', 'credit_limit'] as const)!;
						if (r) erp.records.set(r.id, { ...r, [f]: f === 'credit_limit' ? rand(9) : pick(words)! } as Customer); break; }
					case 2: await sales().act('accounts.create', { name: pick(words)! }); break;
					case 3: erp.add({ name: pick(words)!, credit_limit: rand(9), note: null }); break;
					case 4: { const r = pick(rows); if (r && rand(3) === 0) await sales().act('accounts.delete', { target: String(r['id']) }); break; }
					case 5: await run('pull').catch(() => {}); break;
					case 6: await run('push').catch(() => {}); break;
				}
			}
			erp.lose = () => null;
			await run('reconcile');
			await run('reconcile');
			const local = (await accounts()).map((r) => ({ id: r['erp_id'], name: r['name'], credit_limit: r['credit_limit'], note: r['note'] }));
			const theirs = [...erp.records.values()].map((r) => ({ id: r.id, name: r.name, credit_limit: r.credit_limit, note: r.note }))
				.sort((a, b) => a.id < b.id ? -1 : 1);
			expect({ trial, local }).toEqual({ trial, local: theirs as Json });
		}
	});
});

describe('pipelines: import and export feeds', () => {
	const files = (): FilesPort & { stored: Uint8Array[] } => {
		const stored: Uint8Array[] = [];
		return { stored, put: async (bytes, meta) => (stored.push(bytes), { key: `k${stored.length}`, bytes: bytes.byteLength, sha256: '', mime: meta.mime }),
			get: async () => new Uint8Array(), url: async () => '', remove: async () => {} };
	};
	const bindings = () => ({ now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} });
	const feeds = (f?: FilesPort) => pipelines({ engine: t.engine, bindings, guest, ...(f === undefined ? {} : { files: f }) });
	const caller = (key: string) => ({ authority: t.engine.authority(t.member(['sales'])), bindings: { now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} },
		key, issuedAt: NOW });

	it('crm\'s ERP item import: one act as the caller, codes already on file skipped by known + map', async () => {
		ok(await sales().act('products.create', { external_code: 'P1', name: 'kept', price: '1.00' }));
		t.count.reset();
		const o = ok(await feeds().import('products', { items: [{ external_code: ' P1 ', name: 'renamed' }, { external_code: 'P2', name: ' bolt ', unit_price: '2.50' }] }, caller('k1')));
		expect(t.count.writes).toBe(1);
		expect(o.records).toHaveLength(1);
		const rows = (await sales().read('products', { all: true, orderBy: 'external_code' })).rows;
		expect(rows.map((r) => [r['external_code'], r['name'], r['price']])).toEqual([['P1', 'kept', { $dec: '1.00' }], ['P2', 'bolt', { $dec: '2.50' }]]);
	});

	it('an import is refused as the caller would be refused', async () => {
		const reader = { ...caller('k2'), authority: t.engine.authority(t.member(['viewer'])) };
		expect(await feeds().import('products', { items: [{ external_code: 'P9', name: 'x' }] }, reader)).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});

	it('an export is every row the caller reads, the declared fields, stored as a CSV file', async () => {
		ok(await sales().act('products.create', [{ external_code: 'P1', name: 'a, "quoted"', price: '1.00' }, { external_code: 'P2', name: 'b' }]));
		const f = files();
		expect(await feeds(f).export('products', caller('x'))).toMatchObject({ name: 'products-2026-09-25.csv', file: { mime: 'text/csv' } });
		const [head, ...lines] = new TextDecoder().decode(f.stored[0]).split('\r\n');
		expect([head, ...lines.sort()]).toEqual(['external_code,name,price', 'P1,"a, ""quoted""",1.00', 'P2,b,']);
	});

	// the browser's path (ViewToolbar Import… / Export): upload to `<c>.$import`, then a `<c>.pipeline` run as its starter
	const store = (): FilesPort & { stored: Map<string, Uint8Array> } => {
		const stored = new Map<string, Uint8Array>();
		return { stored, put: async (bytes, meta) => { const key = `k${stored.size}`; stored.set(key, bytes); return { key, bytes: bytes.byteLength, sha256: '', mime: meta.mime }; },
			get: async (key) => stored.get(key)!, url: async () => '', remove: async () => {} };
	};
	type Who = ReturnType<TestWorkspace['member']>;
	const put = (f: FilesPort, who: Who, body: Json, mime = 'application/json') => upload({ manifest, db: t.engine.db, files: f },
		{ id: randomUUID(), collection: 'products', field: '$import', name: 'feed.json', mime, bytes: new TextEncoder().encode(JSON.stringify(body)),
			authority: t.engine.authority(who), now: NOW });
	const fileId = (o: Outcome) => (ok(o).output as { id: string }).id;
	const runAs = (f: FilesPort, starter: Who, input: Json) => feeds(f).handlers()['products.pipeline']!(input, { id: randomUUID(), starter });

	it('an uploaded feed file runs as products.pipeline under its starter: one act, the rows as the caller wrote them', async () => {
		const f = store(), who = t.member(['sales']);
		const file = fileId(await put(f, who, { items: [{ external_code: 'P7', name: 'bolt', unit_price: '2.50' }] }));
		expect(await runAs(f, who, { mode: 'import', file })).toEqual({ imported: 1 });
		const [row] = (await sales().read('products', { all: true })).rows;
		expect(row).toMatchObject({ external_code: 'P7', name: 'bolt', price: { $dec: '2.50' }, created_by: who.id });
	});

	it("a feed file is its uploader's alone, is JSON, and decodes against the import's declared input", async () => {
		const f = store(), who = t.member(['sales']);
		const mine = fileId(await put(f, who, { items: [] }));
		await expect(runAs(f, t.member(['sales']), { mode: 'import', file: mine })).rejects.toMatchObject({ code: 'notFound' });
		await expect(runAs(f, who, { mode: 'import', file: fileId(await put(f, who, { items: [{ name: 'no code' }] })) })).rejects.toMatchObject({ code: 'invalidInput' });
		expect(await put(f, who, {}, 'text/csv')).toMatchObject({ kind: 'refused', code: 'invalidInput' });
		expect(await put(f, t.member(['viewer']), {})).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});

	it("an export run stores the file as its starter's and answers its FileRef, which no other member downloads", async () => {
		ok(await sales().act('products.create', { external_code: 'P1', name: 'a', price: '1.20' }));
		const f = store(), who = t.member(['viewer']);
		const out = await runAs(f, who, { mode: 'export' }) as { file: { id: string } };
		expect(out.file).toMatchObject({ name: 'products-2026-09-25.csv', mime: 'text/csv' });
		expect(new TextDecoder().decode([...f.stored.values()][0])).toContain('P1,a,1.20');
		const may = (h: Who) => readableFile({ manifest, db: t.engine.db, read: t.engine.read, authority: t.engine.authority(h), bindings: bindings() },
			out.file.id, 'products.$export');
		expect([await may(who), await may(t.member(['viewer']))]).toEqual([true, false]);
	});

	it('starting products.pipeline is gated by the collection grant (import: create, export: read) and records the starter', async () => {
		const start = (who: Who, input: Json) => t.engine.calls.start({ automation: 'products.pipeline', input, id: randomUUID(),
			authority: t.engine.authority(who), bindings: bindings() });
		expect(await start(t.member(['viewer']), { mode: 'import', file: 'f' })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await start(t.member(['integration']), { mode: 'export' })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await start(t.member(['sales']), { mode: 'import', file: 'f' })).toMatchObject({ kind: 'committed' });
		expect(await start(t.member(['viewer']), { mode: 'export' })).toMatchObject({ kind: 'committed' });
		const rows = (await t.engine.db.read([{ text: `SELECT starter FROM sys_run WHERE automation = 'products.pipeline'`, params: [] }]))[0]!.rows;
		expect(rows.map((r) => (r['starter'] as { policies: string[] }).policies).sort()).toEqual([['sales'], ['viewer']]);
	});
});
