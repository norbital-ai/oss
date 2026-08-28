import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * Keyset pagination over real SQL.
 *
 * Paging never worked: the wire schema accepted `after`, the command boundary dropped it, the query
 * input had no field for it, and nothing ever produced a `nextCursor` — so every page request asked
 * for page one and got it. Because the failure is silent and idempotent, only walking the pages and
 * counting what came back distinguishes a working cursor from that.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const people = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'people',
			fields: {
				name: { type: 'string', required: true, indexed: false, search: true },
				team: { type: 'string', required: false, indexed: false }
			}
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

/**
 * Names repeat on purpose. A cursor that carries only the sort column cannot tell two rows called
 * Ada apart, so it either re-serves the whole run of duplicates or steps over it — which is exactly
 * what the primary-key tiebreaker exists to prevent.
 */
/**
 * Ordered, valid record ids.
 *
 * Records are keyed by `id uuid`, so `pid(1)` is not an identifier a database will accept —
 * it only ever worked against the `id text` column Bolt used to invent. These sort in declaration
 * order, which matters here: the point of the suite is that the primary-key tiebreaker breaks ties
 * the same way every statement, so an arbitrary hash would test nothing.
 */
const pid = (sequence: number): string =>
	`00000000-0000-5000-8000-${String(sequence).padStart(12, '0')}`;

const SEED: ReadonlyArray<readonly [string, string, string]> = [
	[pid(1), 'Ada', 'Engineering'],
	[pid(2), 'Ada', 'Research'],
	[pid(3), 'Ada', 'Engineering'],
	[pid(4), 'Bea', 'Research'],
	[pid(5), 'Bea', 'Engineering'],
	[pid(6), 'Cy', 'Research']
];

const seed = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			for (const [id, name, team] of SEED) {
				yield* collections.create(harness.effectId(id), adminSubject, {
					collection: 'people',
					id,
					values: { name, team }
				});
			}
		})
	);

/**
 * The credential every paged request below carries.
 *
 * Placed in `admin`, the one team this workspace declares — it holds the policy granting `*`, and a
 * caller in no team holds nothing, so the row predicate would narrow every page to empty and the
 * cursor walk would prove nothing.
 */
const session = (harness: BoltTestRuntime) =>
	seedSession(harness, {
		token: 'admin-token',
		user: adminSubject.userId,
		team: 'admin',
		tenantId: adminSubject.tenantId,
		email: 'admin@example.test'
	});

const findMany = (input: Record<string, unknown>) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`page-${JSON.stringify(input)}`),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		deadlineEpochMs: Date.now() + 30_000,
		command: 'collections.findMany',
		input,
		headers: { authorization: ['Bearer admin-token'] }
	});

const collectionRead = (command: string, input: Record<string, unknown>) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`${command}-${JSON.stringify(input)}`),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input,
		headers: { authorization: ['Bearer admin-token'] }
	});

type Page = Readonly<{
	rows: ReadonlyArray<Record<string, unknown>>;
	retainedRows: ReadonlyArray<Record<string, unknown>>;
	baseRows: ReadonlyArray<Record<string, unknown>>;
	relationshipRefs: ReadonlyArray<Record<string, unknown>>;
	pageCursor: string | null;
	nextCursor: string | null;
	readCursor: Readonly<{ xid: number; sequence: number }>;
}>;

const page = async (harness: BoltTestRuntime, input: Record<string, unknown>): Promise<Page> => {
	const response = await harness.runtime.runPromise(dispatchInvocation(findMany(input)));
	const value = (response.value ?? {}) as Record<string, unknown>;
	const rows = value['rows'];
	const baseRows = value['baseRows'];
	const relationshipRefs = value['relationshipRefs'];
	const lookahead = value['lookahead'];
	const pageCursor = value['pageCursor'];
	const nextCursor = value['nextCursor'];
	const readCursor = value['readCursor'];
	// Asserted rather than defaulted. A response missing either field is the bug this file exists for,
	// and a default would report it as a perfectly well-formed single last page.
	if (
		!Array.isArray(rows) ||
		!Array.isArray(baseRows) ||
		!Array.isArray(relationshipRefs) ||
		typeof lookahead !== 'number' ||
		lookahead < 0 ||
		lookahead > rows.length ||
		!(pageCursor === null || typeof pageCursor === 'string') ||
		!(nextCursor === null || typeof nextCursor === 'string') ||
		typeof readCursor !== 'object' ||
		readCursor === null ||
		typeof Reflect.get(readCursor, 'xid') !== 'number' ||
		typeof Reflect.get(readCursor, 'sequence') !== 'number'
	) {
		throw new Error(
			`collections.findMany did not answer a page: ${JSON.stringify(response.value)}`
		);
	}
	const retainedRows = rows as ReadonlyArray<Record<string, unknown>>;
	return {
		rows: retainedRows.slice(0, retainedRows.length - lookahead),
		retainedRows,
		baseRows: baseRows as ReadonlyArray<Record<string, unknown>>,
		relationshipRefs: relationshipRefs as ReadonlyArray<Record<string, unknown>>,
		pageCursor,
		nextCursor,
		readCursor: readCursor as Page['readCursor']
	};
};

/** Walks every page the server offers, capped so a cursor that never advances fails as a loop. */
const walk = async (harness: BoltTestRuntime, input: Record<string, unknown>) => {
	const ids: Array<string> = [];
	const cursors: Array<string | null> = [];
	let after: string | null = null;
	for (let turn = 0; turn < 20; turn += 1) {
		const answer: Page = await page(harness, { ...input, ...(after === null ? {} : { after }) });
		ids.push(...answer.rows.map((row) => String(row['id'])));
		cursors.push(answer.pageCursor);
		if (answer.pageCursor === null) return { ids, cursors, pages: turn + 1 };
		after = answer.pageCursor;
	}
	throw new Error(`pagination did not terminate: ${ids.join(',')}`);
};

describe('collection pagination', () => {
	it('answers count with one SQL aggregate and proof facts, never row hydration', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);
		harness.database.forget();

		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				collectionRead('collections.count', {
					collection: 'people',
					where: { team: { eq: 'Research' } }
				})
			)
		);
		const value = (response.value ?? {}) as Record<string, unknown>;
		expect(value['count']).toBe(3);
		expect(value['readCursor']).toEqual(
			expect.objectContaining({ xid: expect.any(Number), sequence: expect.any(Number) })
		);
		expect(value['confirmedDependencies']).toEqual(['people']);
		expect(value['dependencyGenerations']).toEqual(
			expect.objectContaining({ people: expect.any(Number) })
		);
		expect(value['reproducibility']).toEqual(
			expect.objectContaining({ _tag: 'ServerProof', reasons: expect.arrayContaining(['aggregate']) })
		);
		const reads = harness.database.statements.filter((statement) =>
			/\bfrom\s+(?:"people"|people)(?:\s|$)/iu.test(statement)
		);
		expect(reads).toHaveLength(1);
		expect(reads[0]).toMatch(/count\s*\(/iu);
		expect(reads[0]).not.toMatch(/jsonb_agg|\blimit\b/iu);
	});

	it('groups the complete authorized set from one bounded relational read', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);
		harness.database.forget();

		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				collectionRead('collections.findGrouped', {
					collection: 'people',
					group: { by: 'team', lanes: ['Engineering', 'Research'] },
					orderBy: { name: 'asc' }
				})
			)
		);
		const value = (response.value ?? {}) as Record<string, unknown>;
		const groups = value['groups'] as Record<string, Array<Record<string, unknown>>>;
		expect(groups['Engineering']?.map(({ name }) => name)).toEqual(['Ada', 'Ada', 'Bea']);
		expect(groups['Research']?.map(({ name }) => name)).toEqual(['Ada', 'Bea', 'Cy']);
		expect(Object.values(groups).flat()).toHaveLength(6);
		expect(value['baseRows']).toHaveLength(6);
		expect(value['reproducibility']).toEqual(
			expect.objectContaining({ _tag: 'ServerProof', reasons: expect.arrayContaining(['grouped']) })
		);
		const reads = harness.database.statements.filter((statement) =>
			/\bfrom\s+(?:"people"|people)(?:\s|$)/iu.test(statement)
		);
		expect(reads).toHaveLength(1);
		expect(reads[0]).toMatch(/\blimit\b/iu);
		expect(reads[0]).not.toMatch(/jsonb_agg\s*\(/iu);
	});

	it('stamps the page with a sync head sampled before the row query', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);
		harness.database.forget();

		const input = { collection: 'people', orderBy: { name: 'asc' }, limit: 2 };
		const answer = await page(harness, input);
		expect(answer.rows).toHaveLength(2);
		expect(answer.readCursor.sequence).toBeGreaterThanOrEqual(0);

		const expectedInvocationId = `page-${JSON.stringify(input)}`;
		const headIndex = harness.database.calls.findIndex(
			({ effectId }) => effectId.startsWith(`${expectedInvocationId}:page-position`)
		);
		const pageIndex = harness.database.statements.findIndex(
			(sql, index) => index > headIndex && /\bfrom\s+(?:"people"|people)(?:\s|$)/iu.test(sql)
		);
		expect(headIndex).toBeGreaterThanOrEqual(0);
		expect(pageIndex).toBeGreaterThan(headIndex);
		expect(harness.database.statements[headIndex]).toContain('bolt_sync_outbox');
	});

	it('visits every row exactly once across pages of a non-unique sort column', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		const walked = await walk(harness, {
			collection: 'people',
			orderBy: { name: 'asc' },
			limit: 2
		});
		// Six rows in pages of two: every id once, in the compiled order, over exactly three pages.
		expect(walked.ids).toEqual([pid(1), pid(2), pid(3), pid(4), pid(5), pid(6)]);
		expect(walked.pages).toBe(3);
	});

	it('pages a descending sort without repeating the duplicate run', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		// A DESC column has to seek with `<`; seeking with `>` hands back the rows already served. The
		// tiebreaker stays ASC while the sort is DESC, so each direction has to be read per column.
		const walked = await walk(harness, {
			collection: 'people',
			orderBy: { name: 'desc' },
			limit: 2
		});
		expect(walked.ids).toEqual([pid(6), pid(4), pid(5), pid(1), pid(2), pid(3)]);
	});

	it('reports no next cursor on the last page', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		const walked = await walk(harness, {
			collection: 'people',
			orderBy: { name: 'asc' },
			limit: 2
		});
		expect(walked.cursors.at(-1)).toBeNull();
		expect(walked.cursors.slice(0, -1).every((cursor) => typeof cursor === 'string')).toBe(true);

		// A last page that exactly fills the limit is the case a naive "rows.length === limit" check gets
		// wrong: it offers a next page that comes back empty, and the table keeps offering one forever.
		const exact = await page(harness, { collection: 'people', orderBy: { name: 'asc' }, limit: 6 });
		expect(exact.rows).toHaveLength(6);
		expect(exact.pageCursor).toBeNull();
	});

	it('pages the filtered set when a cursor is combined with a search term', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		// Three Adas, one per page. A seek that did not compose with the search predicate would walk the
		// whole collection instead of the rows the term left.
		const walked = await walk(harness, {
			collection: 'people',
			orderBy: { name: 'asc' },
			search: 'Ada',
			limit: 1
		});
		expect(walked.ids).toEqual([pid(1), pid(2), pid(3)]);
	});

	it('refuses a malformed cursor rather than answering page one', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		// Silently ignoring a bad cursor returns the first page, which is indistinguishable from paging
		// being broken — the failure has to reach the caller.
		const outcome = await harness.runtime.runPromise(
			dispatchInvocation(
				findMany({
					collection: 'people',
					orderBy: { name: 'asc' },
					limit: 2,
					after: 'not-a-cursor'
				})
			).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
	});

	it('refuses a cursor cut from a different sort', async () => {
		harness = await makeBoltTestRuntime(people);
		await seed(harness);
		await session(harness);

		const ascending = await page(harness, {
			collection: 'people',
			orderBy: { name: 'asc' },
			limit: 2
		});
		expect(ascending.pageCursor).not.toBeNull();
		// The tuple was measured against `name asc`. Seeking with it under `name desc` would compare the
		// right values with the wrong operator and quietly skip rows.
		const outcome = await harness.runtime.runPromise(
			dispatchInvocation(
				findMany({
					collection: 'people',
					orderBy: { name: 'desc' },
					limit: 2,
					after: ascending.pageCursor
				})
			).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
	});

	it('pages a nullable sort column without dropping the rows that follow the nulls', async () => {
		harness = await makeBoltTestRuntime(people);
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				for (const [id, team] of [
					[pid(11), 'Engineering'],
					[pid(12), undefined],
					[pid(13), undefined],
					[pid(14), 'Research']
				] as const) {
					yield* collections.create(harness!.effectId(id), adminSubject, {
						collection: 'people',
						id,
						values: { name: id, ...(team === undefined ? {} : { team }) }
					});
				}
			})
		);
		await session(harness);

		// Postgres sorts nulls last under `asc`, and `column > null` is null rather than false. A seek
		// that did not spell that out would lose every row from the first null onwards.
		const walked = await walk(harness, {
			collection: 'people',
			orderBy: { team: 'asc' },
			limit: 1
		});
		expect(walked.ids.toSorted()).toEqual([pid(11), pid(12), pid(13), pid(14)]);
	});
});
