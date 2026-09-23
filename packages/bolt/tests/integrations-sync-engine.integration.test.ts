import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	INTEGRATION_HTTP_OPERATION,
	type ConnectorRequest,
	type ConnectorResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { defineIntegration, http } from '../src/authoring/index.js';
import { describeIntegration } from '../src/authoring/integrations-schema.js';
import { field } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Integrations from '../src/runtime/integrations/integrations.js';
import { automationChannels } from '../src/runtime/channels/channels.js';
import * as Database from '../src/runtime/facilities/database.js';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The sync engine against an in-memory source (integrations.md §12): no provider, just the source
 * contract answered by a fake ERP behind the connector facility, exactly as a host performs it.
 */

type Remote = { code: string; name: string; currency: string; rev: number };

/** A tiny ERP: list pages of three, create/update/delete by code, a monotonically rising revision. */
const fakeErp = () => {
	const records = new Map<string, Remote>();
	let revision = 0;
	let serial = 0;
	/** When set, the next request fails the way a flaky source does: a 503 the caller must retry. */
	let failures = 0;
	const put = (record: Omit<Remote, 'rev'>) => {
		const stored = { ...record, rev: ++revision };
		records.set(record.code, stored);
		return stored;
	};
	const answer = (status: number, body: unknown): ConnectorResponse => ({
		output: { status, headers: {}, body: body as Schema.Json }
	});
	const binding: FacilityBinding<ConnectorRequest, ConnectorResponse> = {
		call: async (_metadata, request) => {
			if (request.operation !== INTEGRATION_HTTP_OPERATION) throw new Error('unexpected connector call');
			const input = request.input as { method: string; url: string; body?: Record<string, unknown> };
			if (failures > 0) {
				failures -= 1;
				return { _tag: 'Success', value: answer(503, { error: 'try later' }) };
			}
			const url = new URL(input.url);
			const [, collection, code] = url.pathname.split('/');
			if (collection !== 'customers') return { _tag: 'Success', value: answer(404, {}) };
			if (input.method === 'GET' && code === undefined) {
				const all = [...records.values()].toSorted((a, b) => a.code.localeCompare(b.code));
				const after = url.searchParams.get('after');
				const start = after === null ? 0 : all.findIndex((record) => record.code === after) + 1;
				const page = all.slice(start, start + 3);
				const next = start + 3 < all.length ? page.at(-1)?.code : undefined;
				return { _tag: 'Success', value: answer(200, { customers: page, ...(next === undefined ? {} : { next }) }) };
			}
			if (input.method === 'GET') {
				const found = records.get(decodeURIComponent(code!));
				return { _tag: 'Success', value: answer(found === undefined ? 404 : 200, found ?? {}) };
			}
			if (input.method === 'POST') {
				const body = input.body ?? {};
				const created = put({ code: `R${++serial}`, name: String(body['name'] ?? ''), currency: String(body['currency'] ?? '') });
				return { _tag: 'Success', value: answer(201, created) };
			}
			const existing = records.get(decodeURIComponent(code!));
			if (existing === undefined) return { _tag: 'Success', value: answer(404, {}) };
			if (input.method === 'PATCH') {
				const updated = put({ ...existing, ...(input.body as Partial<Remote>) });
				return { _tag: 'Success', value: answer(200, updated) };
			}
			if (input.method === 'DELETE') {
				records.delete(existing.code);
				return { _tag: 'Success', value: answer(204, {}) };
			}
			return { _tag: 'Success', value: answer(405, {}) };
		}
	};
	return {
		binding,
		records,
		put,
		createRemote: (name: string, currency: string) => put({ code: `R${++serial}`, name, currency }),
		failNext: (count: number) => {
			failures = count;
		}
	};
};

const Customer = Schema.Struct({
	code: Schema.String,
	name: Schema.String,
	currency: Schema.String,
	rev: Schema.Number
});
const erp = http.source({ baseUrl: 'https://erp.test' });
const erpSource = erp.records({
	list: { path: '/customers', records: 'customers', page: { query: 'after', next: 'next' } },
	get: { path: '/customers/:id' },
	create: { method: 'POST', path: '/customers' },
	update: { method: 'PATCH', path: '/customers/:id' },
	delete: { method: 'DELETE', path: '/customers/:id' },
	identity: 'code',
	version: 'rev',
	record: Customer
});

const accounts = {
	name: 'accounts',
	fields: {
		external_code: field.string(),
		name: field.string(),
		currency: field.string(),
		note: field.string()
	}
};

const syncRuntime = async (direction: 'one_way' | 'two_way', connector: FacilityBinding<ConnectorRequest, ConnectorResponse>) => {
	const described = describeIntegration(
		'erp',
		defineIntegration({
			policies: ['admin'],
			syncs: {
				accounts:
					direction === 'two_way'
						? {
								direction: 'two_way',
								source: erpSource,
								identity: 'external_code',
								fields: { name: 'name', currency: 'currency' },
								conflicts: 'remote_wins',
								onUnmatchedLocal: 'push'
							}
						: { direction: 'one_way', source: erp.records({ list: { path: '/customers', records: 'customers', page: { query: 'after', next: 'next' } }, identity: 'code', version: 'rev', record: Customer }), identity: 'external_code', fields: { name: 'name', currency: 'currency' } }
			}
		} as never)
	);
	const definition = { ...testWorkspace({ collections: [accounts] }), integrations: [described.declaration] };
	const columns = { external_code: true, name: true, currency: true, note: true } as const;
	return makeBoltTestRuntime(definition, {
		connector,
		authored: {
			...emptyAuthoredRuntime,
			collections: { accounts: { create: { input: { columns } }, update: { input: { columns } }, delete: {} } },
			integrations: { erp: described.authored }
		}
	});
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const run = <A, E>(effect: Effect.Effect<A, E, never>) => harness!.runtime.runPromise(effect as never) as Promise<A>;
const integrations = () => harness!.runtime.runPromise(Integrations.Service);
const collections = () => harness!.runtime.runPromise(Collections.Service);
let step = 0;
const reconcile = async () => {
	const service = await integrations();
	// A sweep larger than one run's page budget resumes in a continuation; run until it is done.
	for (let turn = 0; turn < 20; turn += 1) {
		const result = (await run(service.run(harness!.effectId(`run:${step++}`), 'erp', 'accounts', 'reconcile'))) as Record<string, unknown>;
		if (result['state'] !== 'backfilling' && result['state'] !== 'reconciling') return result;
	}
	throw new Error('reconcile did not finish');
};
const push = async () => {
	const service = await integrations();
	// A backed-off push is due now: the test is the clock.
	await harness!.database.query(`update bolt_integration_pushes set next_attempt_at = now() where status = 'pending'`);
	return run(service.push(harness!.effectId(`push:${step++}`), 'erp', 'accounts'));
};
const localWrite = async (action: 'create' | 'update' | 'delete', input: Record<string, unknown>) =>
	run((await collections()).write(harness!.effectId(`local:${step++}`), adminSubject, [{ collection: 'accounts', action, inputs: [input] }]));
const localRows = async () =>
	(await harness!.database.query(`select id::text as id, external_code, name, currency from accounts order by external_code`)) as ReadonlyArray<Record<string, string | null>>;

/** Deterministic randomness, so a failing interleaving can be replayed from its seed. */
const random = (seed: number) => () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
	return seed / 2_147_483_648;
};

describe('two-way sync converges', () => {
	it('adopts, pushes and links on first sync, then keeps both sides equal', async () => {
		const source = fakeErp();
		source.createRemote('Acme', 'SGD');
		source.createRemote('Globex', 'USD');
		harness = await syncRuntime('two_way', source.binding);
		// A row that predates the link, unknown to the source: pushed on first sync.
		await localWrite('create', { name: 'Initech', currency: 'MYR', note: 'ours' });
		const report = await reconcile();
		expect(report).toMatchObject({ state: 'live', report: { mode: 'backfill', created: 2, unmatched: 1, pushed: 1 } });
		await push();
		expect([...source.records.values()].map(({ name }) => name).toSorted()).toEqual(['Acme', 'Globex', 'Initech']);
		expect((await localRows()).every(({ external_code }) => external_code !== null)).toBe(true);
	});

	it('refuses a local change to a remote-owned field, and logs a conflict the rule settled', async () => {
		const source = fakeErp();
		source.createRemote('Acme', 'SGD');
		harness = await syncRuntime('two_way', source.binding);
		await reconcile();
		const [row] = await localRows();
		// Both sides change the same shared field: remote_wins, and the conflict is recorded.
		await localWrite('update', { id: row!['id'], name: 'Acme Local' });
		source.put({ ...source.records.get(row!['external_code']!)!, name: 'Acme Remote' });
		await reconcile();
		expect((await localRows())[0]?.['name']).toBe('Acme Remote');
		expect(
			await harness.database.query(`select field, rule, winner from bolt_integration_conflicts`)
		).toEqual([{ field: 'name', rule: 'remote_wins', winner: 'remote' }]);
	});

	it('checks the remote version before a push, so an edit made there meanwhile is a conflict, not an overwrite', async () => {
		// The fake ERP ignores If-Match, as many APIs do: only the pre-read can see the concurrent edit.
		const source = fakeErp();
		source.createRemote('Acme', 'SGD');
		harness = await syncRuntime('two_way', source.binding);
		await reconcile();
		const [row] = await localRows();
		source.put({ ...source.records.get(row!['external_code']!)!, currency: 'EUR' });
		await localWrite('update', { id: row!['id'], currency: 'JPY' });
		await push();
		await push();
		// remote_wins: the ERP's concurrent edit stands on both sides, and the collision is on record.
		expect(source.records.get(row!['external_code']!)?.currency).toBe('EUR');
		expect((await localRows())[0]?.['currency']).toBe('EUR');
		expect(await harness.database.query(`select field, rule, winner from bolt_integration_conflicts`)).toEqual([
			{ field: 'currency', rule: 'remote_wins', winner: 'remote' }
		]);
	});

	for (const seed of [7, 42, 1337]) {
		it(`converges after a random interleaving of edits, deletes and lost requests (seed ${seed})`, async () => {
			const next = random(seed);
			const pick = <T>(items: ReadonlyArray<T>): T | undefined => items[Math.floor(next() * items.length)];
			const source = fakeErp();
			for (let index = 0; index < 4; index += 1) source.createRemote(`Remote ${index}`, 'SGD');
			harness = await syncRuntime('two_way', source.binding);
			await reconcile();
			await push();
			for (let turn = 0; turn < 40; turn += 1) {
				const roll = next();
				const rows = await localRows();
				const remote = [...source.records.values()];
				if (roll < 0.15) await localWrite('create', { name: `Local ${turn}`, currency: 'MYR' });
				else if (roll < 0.3 && rows.length > 0) await localWrite('update', { id: pick(rows)!['id'], name: `Edited ${turn}` });
				else if (roll < 0.38 && rows.length > 0) await localWrite('delete', { id: pick(rows)!['id'] });
				else if (roll < 0.5) source.createRemote(`Remote ${turn}`, 'USD');
				else if (roll < 0.62 && remote.length > 0) {
					const target = pick(remote)!;
					source.put({ ...target, name: `Remote edit ${turn}`, currency: 'EUR' });
				} else if (roll < 0.7 && remote.length > 0) source.records.delete(pick(remote)!.code);
				else if (roll < 0.8) {
					// The source drops requests: a push or a read fails and must be retried from state.
					source.failNext(1 + Math.floor(next() * 3));
					await push();
				} else if (roll < 0.9) await push();
				else await reconcile();
			}
			// Quiesce: no new edits; reconcile and push until both sides agree (§4.2).
			source.failNext(0);
			for (let round = 0; round < 6; round += 1) {
				await reconcile();
				await push();
			}
			const local = (await localRows()).map(({ external_code, name, currency }) => ({ external_code, name, currency }));
			const remote = [...source.records.values()]
				.map(({ code, name, currency }) => ({ external_code: code, name, currency }))
				.toSorted((a, b) => a.external_code.localeCompare(b.external_code));
			expect(local).toEqual(remote);
			// Not vacuous: the interleaving left real rows behind, created on both sides.
			expect(local.length).toBeGreaterThanOrEqual(4);
			expect(local.some(({ name }) => name?.startsWith('Local') || name?.startsWith('Edited'))).toBe(true);
			expect(local.some(({ name }) => name?.startsWith('Remote'))).toBe(true);
			// No row twice: the identity is unique locally, and every local row is linked.
			expect(new Set(local.map(({ external_code }) => external_code)).size).toBe(local.length);
			expect(
				await harness.database.query(`select count(*)::int as pending from bolt_integration_pushes`)
			).toEqual([{ pending: 0 }]);
		}, 120_000);
	}
});

describe('a one-way mirror', () => {
	it('mirrors the source, deletes what the source no longer holds, and refuses local writes to it', async () => {
		const source = fakeErp();
		const kept = source.createRemote('Acme', 'SGD');
		const gone = source.createRemote('Globex', 'USD');
		harness = await syncRuntime('one_way', source.binding);
		await reconcile();
		expect((await localRows()).map(({ name }) => name)).toEqual(['Acme', 'Globex']);

		source.records.delete(gone.code);
		source.put({ ...kept, name: 'Acme Corp' });
		await reconcile();
		expect((await localRows()).map(({ name }) => name)).toEqual(['Acme Corp']);

		const [row] = await localRows();
		// A mirror is read-only to everyone but its sync subject: no create, no delete, no synced field.
		await expect(localWrite('create', { name: 'Mine', currency: 'SGD' })).rejects.toMatchObject({
			message: expect.stringMatching(/owned by erp/)
		});
		await expect(localWrite('update', { id: row!['id'], name: 'Renamed' })).rejects.toMatchObject({
			message: expect.stringMatching(/owned by erp/)
		});
		await expect(localWrite('delete', { id: row!['id'] })).rejects.toMatchObject({
			message: expect.stringMatching(/owned by erp/)
		});
		// A local-only column stays ours.
		await localWrite('update', { id: row!['id'], note: 'call on Tuesday' });
		expect(await harness.database.query(`select name, note from accounts`)).toEqual([
			{ name: 'Acme Corp', note: 'call on Tuesday' }
		]);
	});
});

describe('api.integrations in an automation', () => {
	it('queues a full reconcile of every sync the integration declares', async () => {
		const source = fakeErp();
		source.createRemote('Acme', 'SGD');
		harness = await syncRuntime('two_way', source.binding);
		const operations = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return automationChannels(
					yield* Database.Service,
					yield* TaskQueue.Service,
					[],
					[{ name: 'erp', policies: ['admin'], syncs: [{ name: 'accounts' }] } as never],
					EffectId.make('automation-run-1')
				);
			}) as never
		) as ReturnType<typeof automationChannels>;
		await harness.runtime.runPromise(operations.integrations['erp']!.reconcile() as never);
		expect(
			await harness.database.query(`select command, input from bolt_task where command = 'integrations.run'`)
		).toEqual([{ command: 'integrations.run', input: { integration: 'erp', sync: 'accounts', mode: 'reconcile' } }]);
	});
});
