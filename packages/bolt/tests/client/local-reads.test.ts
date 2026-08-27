import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type {
	QueryWindowProof,
	RecomputedWindow,
	WindowLedger
} from '../../src/client/replica/coverage.js';
import {
	createLocalReader,
	createLocalWindowRecomputer,
	type LocalWindowRead,
	type ReplicaShape
} from '../../src/client/replica/local-reads.js';
import type {
	LocalReplicaStore,
	ReplicaRead
} from '../../src/client/replica/pglite-sql.js';

const identity = {
	protocolVersion: 6,
	schemaFingerprint: 'sha256:local-read-tests',
	partitionKey: 'partition-a'
};

const shape: ReplicaShape = {
	collections: [
		{
			name: 'people',
			fields: {
				name: { type: 'string', required: true, indexed: false },
				team: { type: 'string', required: false, indexed: false },
				rank: { type: 'number', required: false, indexed: false }
			},
			readableFields: ['id', 'name', 'team']
		}
	],
	relations: []
};

const rows = [
	{ id: '00000000-0000-5000-8000-000000000001', name: 'Ada', team: 'core', rank: 2, row_version: 3 },
	{ id: '00000000-0000-5000-8000-000000000002', name: 'Grace', team: 'flight', rank: 1, row_version: 4 },
	{ id: '00000000-0000-5000-8000-000000000003', name: 'Aaron', team: 'other', rank: 0, row_version: 1 }
] as const;

const proofOf = (
	queryKey: string,
	orderedRowIds: ReadonlyArray<string>,
	overrides: Partial<QueryWindowProof> = {}
): QueryWindowProof => ({
	queryKey,
	canonical: {},
	collection: 'people',
	dependencies: ['people'],
	proofOwner: 'local',
	locallyReproducible: true,
	valid: true,
	dirty: false,
	readCursor: { xid: 3, sequence: 2 },
	dependencyGenerations: { people: 4 },
	orderedRowIds,
	relationshipRefs: [],
	nextCursor: null,
	lookaheadCount: 0,
	leaseCount: 1,
	...overrides
});

const windowsWith = (
	orderedRowIds: ReadonlyArray<string> | undefined,
	queryKeys: Array<string> = [],
	overrides: Partial<QueryWindowProof> = {}
): WindowLedger =>
	({
		readWindow: <Value>(
			queryKey: string,
			use: (proof: QueryWindowProof) => Effect.Effect<Value, unknown>
		) => {
			queryKeys.push(queryKey);
			return orderedRowIds === undefined
				? Effect.succeed(undefined)
				: use(proofOf(queryKey, orderedRowIds, overrides));
		}
	}) as unknown as WindowLedger;

const storeWith = (
	values: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
	reads: Array<ReplicaRead> = []
): LocalReplicaStore => ({
	findMany: (input) => {
		reads.push(input);
		const requested = new Set(input.recordIds ?? []);
		// Deliberately return the physical rows in reverse order. Window membership, not the table
		// scan or an IN-list implementation detail, owns the order exposed by the reader.
		return Effect.succeed(
			values.filter((row) => requested.has(String(row['id']))).toReversed()
		);
	},
	baseRows: () => Effect.succeed(values.flatMap((row) =>
		typeof row['id'] === 'string' && typeof row['row_version'] === 'number'
			? [{ recordId: row['id'], rowVersion: row['row_version'], row }]
			: []
	)),
	applyAuthoritativeRow: () => Effect.succeed({ applied: true, present: true }),
	removeAuthoritativeRow: () => Effect.succeed({ applied: true, present: false }),
	deleteRecords: () => Effect.succeed(0),
	recordIds: () => Effect.succeed(values.flatMap((row) =>
		typeof row['id'] === 'string' ? [row['id']] : []
	)),
	hasRecord: (_collection, recordId) => Effect.succeed(
		values.some((row) => row['id'] === recordId)
	),
	clearNamespace: () => Effect.void
});

const readerWith = (
	store: LocalReplicaStore,
	windows: WindowLedger,
	replicaShape: ReplicaShape = shape
) => createLocalReader(
	store,
	replicaShape,
	new Set(['people']),
	windows,
	identity,
	{ pinnedCollation: true }
);

const pageOf = (answer: LocalWindowRead | undefined) => {
	if (answer === undefined) throw new Error('expected a retained query window');
	return Schema.decodeUnknownSync(
		Schema.Struct({
			rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
			nextCursor: Schema.NullOr(Schema.String)
		})
	)(answer.value);
};

describe('reads answered by authoritative query windows', () => {
	it('serves a retained authoritative count without reading or iterating base rows', async () => {
		const reads: Array<ReplicaRead> = [];
		const reader = readerWith(
			storeWith(rows, reads),
			windowsWith([], [], {
				proofOwner: 'server',
				locallyReproducible: false,
				valid: false,
				serverResult: { kind: 'count', value: 335 }
			})
		);
		const answer = await Effect.runPromise(
			reader.answer('collections.count', { collection: 'people', where: { team: { eq: 'core' } } })
		);
		expect(answer?.status).toBe('stale');
		expect(
			Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(answer?.value).count
		).toBe(335);
		expect(reads).toEqual([]);
	});

	it('rebuilds retained authoritative groups from group ids instead of regrouping a bounded page', async () => {
		const reads: Array<ReplicaRead> = [];
		const reader = readerWith(
			storeWith(rows, reads),
			windowsWith([rows[0].id, rows[1].id], [], {
				proofOwner: 'server',
				locallyReproducible: false,
				serverResult: {
					kind: 'findGrouped',
					groups: { core: [rows[0].id], flight: [rows[1].id], empty: [] }
				}
			})
		);
		const answer = await Effect.runPromise(
			reader.answer('collections.findGrouped', {
				collection: 'people',
				group: { by: 'team', lanes: ['core', 'flight', 'empty'] }
			})
		);
		const grouped = Schema.decodeUnknownSync(
			Schema.Struct({ groups: Schema.Record(Schema.String, Schema.Array(Schema.Json)) })
		)(answer?.value).groups;
		expect(grouped.core?.map((row) => (row as Record<string, Schema.Json>).name)).toEqual(['Ada']);
		expect(grouped.flight?.map((row) => (row as Record<string, Schema.Json>).name)).toEqual(['Grace']);
		expect(grouped.empty).toEqual([]);
		expect(reads).toHaveLength(1);
	});

	it('renders a retained search result as stale without re-evaluating search locally', async () => {
		const reader = readerWith(
			storeWith(rows),
			windowsWith([rows[0].id], [], {
				proofOwner: 'server',
				locallyReproducible: false,
				valid: false
			})
		);
		const answer = await Effect.runPromise(
			reader.answer('collections.findMany', { collection: 'people', search: 'not locally run' })
		);
		expect(answer?.status).toBe('stale');
		expect(pageOf(answer).rows.map((row) => row.name)).toEqual(['Ada']);
	});

	it('keeps pending overlays out of retained ServerProof rows', async () => {
		const reads: Array<ReplicaRead> = [];
		const reader = createLocalReader(
			storeWith(rows, reads),
			shape,
			new Set(['people']),
			windowsWith([rows[0].id], [], {
				proofOwner: 'server',
				locallyReproducible: false,
				valid: false
			}),
			identity,
			{
				pinnedCollation: true,
				localActorBinding: 'actor-a',
				overlay: {
					snapshot: async () => [{
						partitionKey: identity.partitionKey,
						localActorBinding: 'actor-a',
						issuedAtEpochMs: 1,
						idempotencyKey: 'pending-delete',
						deviceSequence: 1,
						active: true,
						operations: [{
							kind: 'remove',
							row: { collection: 'people', recordId: rows[0].id }
						}]
					}]
				}
			}
		);

		const answer = await Effect.runPromise(
			reader.answer('collections.findMany', { collection: 'people' })
		);
		expect(pageOf(answer).rows.map((row) => row.name)).toEqual(['Ada']);
		expect(reads).toHaveLength(1);
		expect(reads[0]?.overlay).toBeUndefined();
	});

	it('reconstructs retained relationships from normalized edges instead of nested row copies', async () => {
		const peopleFields = shape.collections[0]?.fields;
		if (peopleFields === undefined) throw new TypeError('people fixture is missing');
		const relatedShape: ReplicaShape = {
			collections: [{
				name: 'people',
				fields: {
					...peopleFields,
					manager: {
						type: 'reference', required: false, indexed: false,
						reference: {
							targets: [{
								tag: 'person', collection: 'people', storageColumn: 'manager_person_id'
							}],
							onDelete: 'set null'
						}
					}
				},
				readableFields: ['id', 'name', 'team', 'manager']
			}],
			relations: []
		};
		const source = { ...rows[0], manager: { kind: 'person', id: rows[1].id } };
		const reader = readerWith(
			storeWith([source, rows[1]]),
			windowsWith([source.id], [], {
				proofOwner: 'server',
				locallyReproducible: false,
				relationshipRefs: [{
					sourceCollection: 'people', sourceRecordId: source.id, relation: 'manager',
					targetCollection: 'people', targetRecordId: rows[1].id
				}]
			}),
			relatedShape
		);
		const retained = await Effect.runPromise(reader.answer('collections.findMany', {
			collection: 'people', with: { manager: { person: true } }
		}));
		expect(retained?.relationDependency).toBe(true);
		const answer = pageOf(retained);
		const manager = (answer.rows[0] as Record<string, Schema.Json>).manager as Record<string, Schema.Json>;
		expect(manager.record).toMatchObject({ id: rows[1].id, name: 'Grace' });
	});

	it('does not scan retained base rows when the canonical query has no window proof', async () => {
		const reads: Array<ReplicaRead> = [];
		const reader = readerWith(storeWith(rows, reads), windowsWith(undefined));

		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people' })
			)
		).toBeUndefined();
		expect(reads).toEqual([]);
	});

	it('serves only ordered window members and projects the shared full rows at read time', async () => {
		const reads: Array<ReplicaRead> = [];
		const queryKeys: Array<string> = [];
		const members = [rows[0].id, rows[1].id];
		const reader = readerWith(
			storeWith(rows, reads),
			windowsWith(members, queryKeys)
		);

		const projected = pageOf(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' },
					columns: { name: true }
				})
			)
		);
		expect(projected.rows).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);

		const full = pageOf(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' }
				})
			)
		);
		expect(full.rows).toEqual([
			{ id: rows[0].id, name: 'Ada', team: 'core' },
			{ id: rows[1].id, name: 'Grace', team: 'flight' }
		]);
		// Projection is not part of O5 identity, so both reads consume the same canonical window.
		expect(new Set(queryKeys).size).toBe(1);
		expect(reads).toHaveLength(2);
		expect(reads.every((read) => read.recordIds?.join(',') === members.join(','))).toBe(true);
		// Aaron exists in O3 but is not a member of this O5 window and therefore never leaks.
		expect(full.rows.some((row) => row['name'] === 'Aaron')).toBe(false);
	});

	it('walks continuations inside the same growing window', async () => {
		const queryKeys: Array<string> = [];
		const reader = readerWith(
			storeWith(rows),
			windowsWith([rows[0].id, rows[1].id], queryKeys)
		);

		const first = pageOf(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' },
					limit: 1
				})
			)
		);
		expect(first.rows.map((row) => row['name'])).toEqual(['Ada']);
		if (first.nextCursor === null) throw new Error('expected a successor inside the retained window');

		const second = pageOf(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' },
					limit: 1,
					after: first.nextCursor
				})
			)
		);
		expect(second.rows.map((row) => row['name'])).toEqual(['Grace']);
		expect(second.nextCursor).toBeNull();
		expect(queryKeys[0]).toBe(queryKeys[1]);
	});

	it('marks a continuation stale after it consumes the retained boundary row', async () => {
		const reader = readerWith(
			storeWith(rows),
			windowsWith(
				[rows[0].id, rows[1].id],
				[],
				{ nextCursor: 'hydrate:more', lookaheadCount: 1 }
			)
		);
		const first = await Effect.runPromise(reader.answer('collections.findMany', {
			collection: 'people', orderBy: { name: 'asc' }, limit: 1
		}));
		expect(first?.status).toBe('fresh');
		const firstPage = pageOf(first);
		if (firstPage.nextCursor === null) throw new Error('expected retained boundary cursor');

		const continuation = await Effect.runPromise(reader.answer('collections.findMany', {
			collection: 'people', orderBy: { name: 'asc' }, limit: 1, after: firstPage.nextCursor
		}));
		expect(continuation?.status).toBe('stale');
		expect(pageOf(continuation).rows.map((row) => row['name'])).toEqual(['Grace']);
	});

	it('declines an ordering whose values are not permitted in the local base row', async () => {
		const reads: Array<ReplicaRead> = [];
		const reader = readerWith(
			storeWith(rows, reads),
			windowsWith([rows[0].id, rows[1].id])
		);

		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { rank: 'asc' }
				})
			)
		).toBeUndefined();
		expect(reads).toEqual([]);
	});

	it('recomputes a plain-with LocalExact window through a root-only optimistic create', async () => {
		const optimistic = {
			id: '00000000-0000-5000-8000-000000000004',
			name: 'Lin',
			team: 'core',
			row_version: 0
		} as const;
		const base = storeWith(rows);
		const store: LocalReplicaStore = {
			...base,
			baseRows: (_collection, recordIds) => {
				const requested = recordIds === undefined ? undefined : new Set(recordIds);
				return Effect.succeed(rows.flatMap((row) =>
					(requested === undefined || requested.has(row.id))
						? [{ recordId: row.id, rowVersion: row.row_version, row }]
						: []
				));
			},
			findMany: (input) => {
				const affected = new Set(input.overlay?.affectedRecordIds ?? []);
				return Effect.succeed([
					...rows.filter((row) => !affected.has(row.id)),
					...(input.overlay?.rows ?? [])
				]);
			}
		};
		const recomputed: Array<RecomputedWindow> = [];
		const proof = proofOf('window:plain-with', rows.map(({ id }) => id), {
			canonical: {
				kind: 'findMany',
				collection: 'people',
				authoredWhere: null,
				userFilter: null,
				search: null,
				relationships: { manager: true },
				orderBy: [{ field: 'name', direction: 'asc' }]
			},
			dirty: true,
			valid: false
		});
		const windows = {
			readWindow: <Value>(
				_queryKey: string,
				use: (value: QueryWindowProof) => Effect.Effect<Value, unknown>
			) => use(proof),
			transaction: <Value>(body: Effect.Effect<Value, unknown>) => body,
			position: () => Effect.succeed({
				cursor: proof.readCursor,
				generations: proof.dependencyGenerations
			}),
			recomputeWindow: (input: RecomputedWindow) => Effect.sync(() => {
				recomputed.push(input);
				return true;
			}),
			pruneBaseRows: () => Effect.succeed(0)
		} as unknown as WindowLedger;
		const recomputer = createLocalWindowRecomputer(
			store,
			shape,
			windows,
			identity.partitionKey,
			{
				localActorBinding: 'actor-a',
				overlay: {
					snapshot: async () => [{
						partitionKey: identity.partitionKey,
						localActorBinding: 'actor-a',
						issuedAtEpochMs: 1,
						idempotencyKey: 'root-create',
						deviceSequence: 1,
						active: true,
						operations: [{
							kind: 'replace',
							row: { collection: 'people', recordId: optimistic.id },
							values: optimistic
						}]
					}]
				}
			}
		);

		expect(await Effect.runPromise(recomputer.recompute(proof.queryKey))).toBe(true);
		expect(recomputed).toHaveLength(1);
		expect(recomputed[0]?.orderedRowIds).toContain(optimistic.id);
		expect(recomputed[0]?.optimisticRowIds).toEqual([optimistic.id]);
	});
});
