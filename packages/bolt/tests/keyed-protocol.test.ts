import { describe, expect, it } from '@effect/vitest';
import { Effect, Result, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import type { Json } from '../src/decl/values.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { Manifest, Reads, type ReadsShape } from '../src/engine/services.ts';
import { BoltRoutes } from '../src/protocol/http.ts';
import type { ReadIR } from '../src/protocol/reads.ts';
import { QReply, type QBody } from '../src/protocol/schema.ts';
import { manifest, rep } from './query.fixture.ts';

const db = TenantDb.typed({
	read: () => Effect.fail(DbError.make('XX000', 'Unexpected protocol database read')),
	write: () => Effect.fail(DbError.make('XX000', 'Unexpected protocol database write')),
	session: () =>
		Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
	transaction: () => Effect.fail(DbError.make('XX000', 'Unexpected protocol transaction'))
});
const request = (body: QBody) =>
	HttpServerRequest.fromWeb(
		new Request('https://workspace.test/__bolt/q', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
const run = (body: QBody, reads: ReadsShape) =>
	BoltRoutes['POST /__bolt/q']
		.run(request(body), rep)
		.pipe(
			Effect.provideService(Manifest, manifest),
			Effect.provideService(Reads, reads),
			Effect.provideService(TenantDb, db)
		);
const reply = (response: HttpServerResponse.HttpServerResponse) =>
	Effect.tryPromise({
		try: () => HttpServerResponse.toWeb(response).json(),
		catch: (error) => BoltError.make('invalid', 'decode', String(error))
	}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(QReply)));

describe('native keyed /q reads', () => {
	it.effect('runs all groups once as caller and preserves each declared keyed answer', () =>
		Effect.gen(function* () {
			const batches: (readonly ReadIR[])[] = [];
			const values: readonly Json[] = [
				{ rows: [{ id: 'account-a', name: 'North' }], next: null },
				{ rows: [{ id: 'order-a', account: 'account-a' }], next: null },
				{ id: 'account-b', name: 'South' },
				{ rows: [], next: null }
			];
			const response = yield* run(
				{
					reads: [
						{
							m: 'query',
							a: [
								{
									accounts: { from: 'accounts', all: true },
									orders: {
										from: 'orders',
										all: true,
										where: { account: { in: { member: 'accounts', field: 'id' } } }
									}
								}
							]
						},
						{ m: 'query', a: [{}] },
						{ m: 'query', a: ['accounts', { id: '00000000-0000-0000-0000-000000000002' }] },
						{ m: 'query', a: [{ accounts: { from: 'accounts', all: true } }] }
					]
				},
				{
					run: (batch, reader) =>
						Effect.sync(() => {
							batches.push(batch);
							expect(reader).toEqual({ as: 'caller', authority: rep });
							return values;
						})
				}
			);
			expect(batches).toHaveLength(1);
			const batch = batches[0];
			expect(batch).toHaveLength(4);
			const first = batch?.[0],
				dependent = batch?.[1],
				last = batch?.[3];
			expect(first).toMatchObject({ member: 'accounts', cte: 'q:0:accounts' });
			expect(dependent).toMatchObject({
				member: 'orders',
				cte: 'q:0:orders',
				where: {
					t: 'in',
					args: { _tag: 'Member', member: 'q:0:accounts', field: 'id' }
				}
			});
			expect(last).toMatchObject({ member: 'accounts', cte: 'q:3:accounts' });
			expect(yield* reply(response)).toEqual({
				answers: [
					{ accounts: values[0], orders: values[1] },
					{},
					values[2],
					{ accounts: values[3] }
				]
			});
		})
	);

	it.effect('keeps an empty set as one answer and still invokes the reader once', () =>
		Effect.gen(function* () {
			let runs = 0;
			const response = yield* run(
				{ reads: [{ m: 'query', a: [{}] }] },
				{
					run: (batch) =>
						Effect.sync(() => {
							runs++;
							expect(batch).toEqual([]);
							return [];
						})
				}
			);
			expect(runs).toBe(1);
			expect(yield* reply(response)).toEqual({ answers: [{}] });
		})
	);

	it.effect('scopes a get member and dependent predicates within nested relation selections', () =>
		Effect.gen(function* () {
			const batches: (readonly ReadIR[])[] = [];
			yield* run(
				{
					reads: [
						{
							m: 'query',
							a: [
								{
									accounts: { from: 'accounts', all: true },
									record: {
										from: 'accounts',
										id: '00000000-0000-0000-0000-000000000001',
										select: {
											orders: {
												all: true,
												where: { account: { in: { member: 'accounts', field: 'id' } } },
												select: {
													lines: {
														all: true,
														where: { order: { in: { member: 'accounts', field: 'orders.id' } } }
													}
												}
											}
										}
									}
								}
							]
						}
					]
				},
				{
					run: (batch) =>
						Effect.sync(() => {
							batches.push(batch);
							return [{ rows: [], next: null }, null];
						})
				}
			);
			expect(batches[0]?.[1]).toMatchObject({
				kind: 'get',
				member: 'record',
				cte: 'q:0:record',
				select: {
					relations: {
						orders: {
							where: { t: 'in', args: { member: 'q:0:accounts', field: 'id' } },
							select: {
								relations: {
									lines: {
										where: { t: 'in', args: { member: 'q:0:accounts', field: 'orders.id' } }
									}
								}
							}
						}
					}
				}
			});
		})
	);

	it.effect('refuses a later, self, or foreign-group reference before dispatch', () =>
		Effect.gen(function* () {
			let runs = 0;
			for (const reads of [
				[
					{
						m: 'query',
						a: [
							{
								first: {
									from: 'orders',
									all: true,
									where: { account: { in: { member: 'later', field: 'id' } } }
								},
								later: { from: 'accounts', all: true }
							}
						]
					}
				],
				[
					{
						m: 'query',
						a: [
							{
								self: {
									from: 'orders',
									all: true,
									where: { account: { in: { member: 'self', field: 'id' } } }
								}
							}
						]
					}
				],
				[
					{ m: 'query', a: [{ previous: { from: 'accounts', all: true } }] },
					{
						m: 'query',
						a: [
							{
								next: {
									from: 'orders',
									all: true,
									where: { account: { in: { member: 'previous', field: 'id' } } }
								}
							}
						]
					}
				]
			] satisfies readonly QBody['reads'][]) {
				const result = yield* Effect.result(
					run(
						{ reads },
						{
							run: () =>
								Effect.sync(() => {
									runs++;
									return [];
								})
						}
					)
				);
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure).toBeInstanceOf(BoltError);
					expect(result.failure.message).toMatch(/member '(first|self|next)': .*no earlier member/);
				}
			}
			expect(runs).toBe(0);
		})
	);

	it.effect('names malformed members and rejects missing native answers', () =>
		Effect.gen(function* () {
			const malformedSets: readonly Json[] = [
				{ broken: { all: true } },
				{ broken: false },
				{ broken: { from: 'accounts', id: 2 } }
			];
			for (const set of malformedSets) {
				const malformed = yield* Effect.result(
					run({ reads: [{ m: 'query', a: [set] }] }, { run: () => Effect.succeed([]) })
				);
				expect(Result.isFailure(malformed)).toBe(true);
				if (Result.isFailure(malformed))
					expect(malformed.failure.message).toMatch(/member 'broken':/);
			}
			const missing = yield* Effect.result(
				run(
					{ reads: [{ m: 'query', a: [{ first: { from: 'accounts', all: true } }] }] },
					{ run: () => Effect.succeed([]) }
				)
			);
			expect(Result.isFailure(missing)).toBe(true);
			if (Result.isFailure(missing)) expect(missing.failure.message).toMatch(/answer/);
		})
	);
});
