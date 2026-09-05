import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	type SyncAdvanceSubscription,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { applyPrefixDelta } from '../src/client/live-query/project.js';
import * as Collections from '../src/runtime/collections/collections.js';
import * as Sync from '../src/runtime/sync/sync.js';
import {
	advanceActivePrefix,
	describeSyncQuery,
	extendActivePrefix,
	resolveInitialPrefix
} from '../src/runtime/sync/delta-engine.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * Two things a browser probe sees only as a stall, and which are decidable here.
 *
 * S5 pulls a seeded calendar day out of the BCA board and asks that it not hang. The bug class
 * underneath it is not the picker: it is a live query whose predicate names a day or instant
 * boundary, where the value the client sends and the value PostgreSQL stores are the same instant
 * written two different ways. Every downstream comparison — the retained prefix key, the keyset
 * cursor a prefix extension is anchored on, the transition that decides whether a row entered — is
 * done on the *storage wire* value. If the key were built from anything else, the prefix would
 * disagree with the answer and the query would either reset forever or quietly lose a row.
 *
 * The second half is the projection: a query that joins has to actually project the columns it
 * joins on, even when the caller's `columns` mask does not name them. `effective-plan.test.ts`
 * checks that masked *ordering* fields survive as internal requirements. Nothing checked the join
 * fields, and a join field lost to a mask does not fail — it returns `null` relations.
 */

const definition = workspace({
	name: 'sync-boundary-projection',
	version: '1.0.0',
	collections: [
		collection({
			name: 'shifts',
			fields: {
				started_at: field.instant({ required: true, indexed: true }),
				label: field.string({ required: true })
			}
		}),
		collection({ name: 'sites', fields: { name: field.string({ required: true }) } }),
		collection({
			name: 'visits',
			fields: {
				site_id: field.uuid({ required: true, indexed: true }),
				note: field.string({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'site',
			source: 'visits',
			target: 'sites',
			cardinality: 'one',
			from: { collection: 'visits', column: 'site_id' },
			to: { collection: 'sites', column: 'id' }
		},
		{
			name: 'visits',
			source: 'sites',
			target: 'visits',
			cardinality: 'many',
			from: { collection: 'sites', column: 'id' },
			to: { collection: 'visits', column: 'site_id' }
		}
	],
	apps: [],
	teams: { admin: ['admin'] },
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	prompt: 'You are the boundary and projection test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	integrations: [],
	requiredFacilities: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const mutate = (
	h: BoltTestRuntime,
	name: string,
	target: string,
	payloads: ReadonlyArray<Readonly<Record<string, unknown>>>
) =>
	h.runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.mutate(EffectId.make(name), adminSubject, target, payloads, false, 0)
		)
	);

/** The instant the calendar cell means: `[2026-03-02, 2026-03-03)` in UTC. */
const DAY_START = '2026-03-02T00:00:00.000Z';
const DAY_END = '2026-03-03T00:00:00.000Z';

const dayQuery: SyncQueryInput = {
	kind: 'findMany',
	collection: 'shifts',
	where: { started_at: { gte: DAY_START, lt: DAY_END } },
	orderBy: { started_at: 'asc' },
	limit: 20
};

const seedShifts = (h: BoltTestRuntime) =>
	mutate(h, 'seed-shifts', 'shifts', [
		// One second before the day opens.
		{ started_at: '2026-03-01T23:59:59.000Z', label: 'before' },
		// The first instant of the day: `gte` includes it, and an inclusive boundary written the
		// other way round is how a day query loses its own first row.
		{ started_at: DAY_START, label: 'midnight' },
		{ started_at: '2026-03-02T12:00:00.000Z', label: 'noon' },
		// The last representable instant inside the day.
		{ started_at: '2026-03-02T23:59:59.999Z', label: 'last' },
		// The first instant of the next day: `lt` excludes it.
		{ started_at: DAY_END, label: 'after' }
	]);

const inDayLabels = ['midnight', 'noon', 'last'];

describe('live day-boundary queries resolve against storage-wire values (S5)', () => {
	it('an initially empty live query grows within its requested window after creates', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		const opened = await h.runtime.runPromise(
			Effect.flatMap(Sync.Service, (sync) =>
				sync.connect(EffectId.make('empty-open'), adminSubject, adminSubject, null, {
					queries: [{ queryKey: 'day', input: dayQuery, requestedPrefix: 20 }],
					detached: [],
					pending: []
				})
			)
		);
		const entry = opened.results[0];
		if (entry === undefined) throw new Error('initial answer missing');
		expect(entry.rows).toEqual([]);
		expect(entry.loadedPrefix).toBe(20);
		const committed = await seedShifts(h);
		const update = await h.runtime.runPromise(
			advanceActivePrefix(
				EffectId.make('empty-grow'),
				adminSubject,
				{
					subId: 'day',
					input: dayQuery,
					planKey: entry.planKey,
					version: entry.version,
					prefixKeys: entry.prefixKeys,
					prefixBytes: entry.prefixBytes,
					viewerPrefixes: [entry.loadedPrefix],
					credential: 'host-opaque',
					authorityFingerprint: entry.authorityFingerprint
				},
				committed.batch
			)
		);
		const delta = update?.deltas[0]?.delta;
		if (delta === undefined) throw new Error('new matching rows did not produce a delta');
		expect(applyPrefixDelta(entry.rows, delta).map((row) => row['label'])).toEqual(inDayLabels);
	});

	it('admits exactly the instants inside the day and keys the prefix on the stored value', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		await seedShifts(h);

		const resolved = await h.runtime.runPromise(
			resolveInitialPrefix(EffectId.make('day-open'), adminSubject, dayQuery, 20)
		);

		expect(resolved.rows.map((row) => row['label'])).toEqual(inDayLabels);
		// The retained key's ordering coordinate is the value the authoritative answer carries, not
		// the ISO literal the caller wrote. PostgreSQL hands `timestamptz` back in its own rendering,
		// and everything downstream — the keyset cursor, the transition comparison — compares against
		// that rendering. A key built from the request would compare unequal to the row it names.
		expect(resolved.keys.map(({ order }) => order[0])).toEqual(
			resolved.rows.map((row) => row['started_at'])
		);
		expect(resolved.keys.map(({ id }) => id)).toEqual(resolved.rows.map((row) => row['id']));
		// Named rather than left implicit: the wire value for an instant is a JSON string. A driver
		// that handed a `Date` across the facility seam instead would make the key unencodable and the
		// day-pick would stall on its first extension.
		expect(resolved.rows.map((row) => typeof row['started_at'])).toEqual([
			'string',
			'string',
			'string'
		]);
	});

	it('extends a day-bounded prefix across the stored instant cursor without skipping or repeating', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		await seedShifts(h);
		const opened = await h.runtime.runPromise(
			resolveInitialPrefix(EffectId.make('day-open-one'), adminSubject, dayQuery, 1)
		);
		expect(opened.rows.map((row) => row['label'])).toEqual(['midnight']);

		// The extension is anchored on a keyset cursor encoded from the retained boundary key, whose
		// ordering coordinate is an instant. This is the exact path a calendar day-pick takes when the
		// board asks for more rows, and the one that stalls when the coordinate cannot be encoded.
		const extension = await h.runtime.runPromise(
			extendActivePrefix(
				EffectId.make('day-extend'),
				adminSubject,
				{
					subId: 'day-plan',
					input: dayQuery,
					planKey: opened.plan.effectivePlan.fingerprint,
					version: 0,
					prefixKeys: opened.keys,
					prefixBytes: opened.retainedBytes,
					viewerPrefixes: [1],
					credential: 'host-opaque',
					authorityFingerprint: opened.plan.effectivePlan.authority.fingerprint
				},
				{ queryKey: 'day', version: 0, loadedPrefix: 1, requestedPrefix: 3 }
			)
		);

		expect(extension).toMatchObject({ fromPrefix: 1, toPrefix: 3 });
		expect(extension.rows.map((row) => row['label'])).toEqual(['noon', 'last']);
		expect(extension.prefixKeys.map(({ id }) => id)).toEqual([
			...opened.keys.map(({ id }) => id),
			...extension.rows.map((row) => row['id'])
		]);
	});

	it('moves a row in at the inclusive edge and out at the exclusive edge in one batch', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		const seeded = await seedShifts(h);
		const idOf = (label: string): string => {
			const record = seeded.records.find((row) => row['label'] === label);
			if (record === undefined) throw new Error(`the fixture has no shift labelled ${label}`);
			return String(record['id']);
		};
		const opened = await h.runtime.runPromise(
			resolveInitialPrefix(EffectId.make('edge-open'), adminSubject, dayQuery, 20)
		);
		const state: SyncAdvanceSubscription = {
			subId: 'edge-plan',
			input: dayQuery,
			planKey: opened.plan.effectivePlan.fingerprint,
			version: 0,
			prefixKeys: opened.keys,
			prefixBytes: opened.retainedBytes,
			viewerPrefixes: [opened.rows.length],
			credential: 'host-opaque',
			authorityFingerprint: opened.plan.effectivePlan.authority.fingerprint
		};

		// One batch, both edges, opposite directions. `gte` has to admit the first instant of the day
		// and `lt` has to refuse the first instant of the next one — and the transition has to see
		// both, so the prefix neither grows nor shrinks and no bound can mask a wrong answer.
		const committed = await mutate(h, 'edge-move', 'shifts', [
			{ id: idOf('before'), started_at: DAY_START },
			{ id: idOf('midnight'), started_at: DAY_END }
		]);
		const update = await h.runtime.runPromise(
			advanceActivePrefix(EffectId.make('edge-advance'), adminSubject, state, committed.batch)
		);

		expect(update).toBeDefined();
		const delta = update?.deltas[0]?.delta;
		if (delta === undefined) throw new Error('the boundary move produced no viewer delta');
		const applied = applyPrefixDelta(opened.rows, delta);
		const fresh = await h.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.findMany(EffectId.make('edge-fresh'), adminSubject, {
					collection: 'shifts',
					where: { started_at: { gte: DAY_START, lt: DAY_END } },
					orderBy: { started_at: 'asc' },
					limit: 20
				})
			)
		);
		expect(applied).toEqual(fresh);
		expect(applied.map((row) => row['label'])).toEqual(['before', 'noon', 'last']);
	});
});

describe('live projections carry the fields they join on (S5-adjacent)', () => {
	const maskedJoin: SyncQueryInput = {
		kind: 'findMany',
		collection: 'visits',
		// `id` is named because a live prefix orders on it as the implicit tie-breaker, and the plan
		// refuses an ordering field the projection omits. `site_id` is deliberately *not* named: it is
		// the join column, and whether it survives the mask is the subject of these tests.
		columns: { id: true, note: true },
		with: { site: true },
		orderBy: { note: 'asc' },
		limit: 10
	};

	const seedVisits = async (h: BoltTestRuntime) => {
		const sites = await mutate(h, 'seed-sites', 'sites', [{ name: 'Kismis' }, { name: 'Tanjong' }]);
		const kismis = String(sites.records[0]?.['id']);
		const tanjong = String(sites.records[1]?.['id']);
		await mutate(h, 'seed-visits', 'visits', [
			{ site_id: kismis, note: 'alpha' },
			{ site_id: tanjong, note: 'beta' }
		]);
		return { kismis, tanjong };
	};

	it('keeps a masked join column as an internal requirement of the plan', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		const plan = await h.runtime.runPromise(describeSyncQuery(adminSubject, maskedJoin));

		// The caller asked for `note` only, so `site_id` must not widen what the browser is handed.
		expect(plan.effectivePlan.projection.fields).not.toContain('site_id');
		// But both ends of the join are still requirements the plan carries, which is what stops a
		// column mask from quietly deleting the relation.
		expect(plan.effectivePlan.fields).toContainEqual({
			collection: 'visits',
			field: 'site_id',
			purpose: 'join'
		});
		expect(plan.effectivePlan.fields).toContainEqual({
			collection: 'sites',
			field: 'id',
			purpose: 'join'
		});
		// And the joined collection is a dependency, so a change to a site can reach this plan at all.
		expect(plan.effectivePlan.dependencies).toContain('sites');
	});

	it('resolves the relation for real under the mask rather than returning a null join', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		await seedVisits(h);

		const resolved = await h.runtime.runPromise(
			resolveInitialPrefix(EffectId.make('join-open'), adminSubject, maskedJoin, 10)
		);

		expect(resolved.rows.map((row) => row['note'])).toEqual(['alpha', 'beta']);
		// The join actually happened. A join column lost to the mask does not raise anything — it
		// returns `null` here, which is why the metadata assertion above is not enough on its own.
		expect(resolved.rows.map((row) => row['site'])).toEqual([
			expect.objectContaining({ name: 'Kismis' }),
			expect.objectContaining({ name: 'Tanjong' })
		]);
		expect(resolved.rows[0]).not.toHaveProperty('site_id');
	});

	it('routes a change to the joined collection into a delta on the projecting query', async () => {
		const h = await makeBoltTestRuntime(definition);
		harness = h;
		const { kismis } = await seedVisits(h);
		const opened = await h.runtime.runPromise(
			resolveInitialPrefix(EffectId.make('join-advance-open'), adminSubject, maskedJoin, 10)
		);

		// Only the projected body changes: no `visits` row is touched at all.
		const committed = await mutate(h, 'rename-site', 'sites', [{ id: kismis, name: '58 Kismis' }]);
		const update = await h.runtime.runPromise(
			advanceActivePrefix(
				EffectId.make('join-advance'),
				adminSubject,
				{
					subId: 'join-plan',
					input: maskedJoin,
					planKey: opened.plan.effectivePlan.fingerprint,
					version: 0,
					prefixKeys: opened.keys,
					prefixBytes: opened.retainedBytes,
					viewerPrefixes: [opened.rows.length],
					credential: 'host-opaque',
					authorityFingerprint: opened.plan.effectivePlan.authority.fingerprint
				},
				committed.batch
			)
		);

		expect(update).toBeDefined();
		const delta = update?.deltas[0]?.delta;
		if (delta === undefined) throw new Error('the joined-collection change produced no delta');
		const fresh = await h.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.findMany(EffectId.make('join-fresh'), adminSubject, {
					collection: 'visits',
					columns: { id: true, note: true },
					with: { site: true },
					orderBy: { note: 'asc' },
					limit: 10
				})
			)
		);
		expect(applyPrefixDelta(opened.rows, delta)).toEqual(fresh);
		expect(fresh[0]?.['site']).toEqual(expect.objectContaining({ name: '58 Kismis' }));
	});
});
