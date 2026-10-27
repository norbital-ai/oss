// The /q route's read request (P3): one JSON layer map per read, decoded and checked against the declarations before
// the caller's one batch runs, answered per root.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import type { Json } from '../src/decl/values.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { Manifest, Reads, type ReadsShape } from '../src/engine/services.ts';
import { BoltRoutes } from '../src/protocol/http.ts';
import type { ReadIR } from '../src/protocol/reads.ts';
import { decodeReadRequest, planReadRequest } from '../src/protocol/read-request.ts';
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

describe('native /q read requests', () => {
	it.effect('lowers each request to one read of the caller’s one batch and answers it per root', () =>
		Effect.gen(function* () {
			const batches: (readonly ReadIR[])[] = [];
			const values: readonly Json[] = [
				{
					accounts: { rows: [{ id: 'account-a', name: 'North', orders: [] }], next: null },
					notes: { rows: [], next: null }
				},
				{ accounts: { rows: [{ id: 'account-b', name: 'South' }], next: null } }
			];
			const response = yield* run(
				{
					reads: [
						{
							m: 'query',
							a: [
								{
									accounts: { where: { region: { eq: 'north' } }, fields: ['name'] },
									'accounts.orders': { where: { status: { eq: 'open' } }, fields: ['status'] },
									notes: { limit: 5 }
								}
							]
						},
						{ m: 'query', a: [{ accounts: { where: { name: { eq: 'South' } } } }] }
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
			const [first, second] = batches[0] ?? [];
			// one read for the whole request: its roots in request order, layers inside their root
			expect(first).toMatchObject({
				kind: 'request',
				roots: [{ root: 'accounts' }, { root: 'notes' }]
			});
			expect(second).toMatchObject({ kind: 'request', roots: [{ root: 'accounts' }] });
			expect(yield* reply(response)).toEqual({ answers: values });
		})
	);

	it.effect('refuses anything but the declared JSON layer map before dispatch', () =>
		Effect.gen(function* () {
			let runs = 0;
			const refused: readonly Json[] = [
				{}, // no root
				{ accounts: { bogus: true } }, // an unknown option
				{ accounts: { limit: 10_001 } }, // past the largest list
				{ nope: {} }, // no model
				{ 'accounts.secret': {} }, // a path the root does not declare
				{ 'orders.lines.order.account.orders.lines': {} }, // a sixth level
				{ 'accounts.orders': { after: 'cursor' } }, // a cursor below a root
				{ 'accounts.orders': { asOf: '2026-09-01T00:00:00.000Z' } } // as-of below a root
			];
			for (const body of refused) {
				const result = yield* Effect.result(
					run(
						{ reads: [{ m: 'query', a: [body] }] },
						{
							run: () =>
								Effect.sync(() => {
									runs++;
									return [];
								})
						}
					)
				);
				expect(Result.isFailure(result), JSON.stringify(body)).toBe(true);
				if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(BoltError);
			}
			expect(runs).toBe(0);
		})
	);

	it.effect('rejects a missing native answer', () =>
		Effect.gen(function* () {
			const missing = yield* Effect.result(
				run({ reads: [{ m: 'query', a: [{ accounts: {} }] }] }, { run: () => Effect.succeed([]) })
			);
			expect(Result.isFailure(missing)).toBe(true);
			if (Result.isFailure(missing)) expect(missing.failure.message).toMatch(/answer/);
		})
	);
});

describe('decodeReadRequest and planReadRequest', () => {
	it('refuses a function value: a read request is JSON only', () => {
		expect(Result.isFailure(decodeReadRequest({ accounts: { where: { name: () => 'x' } } }))).toBe(
			true
		);
		expect(Result.isFailure(decodeReadRequest({ accounts: { limit: () => 1 } }))).toBe(true);
		expect(Result.isSuccess(decodeReadRequest({ accounts: { where: { name: { eq: 'x' } } } }))).toBe(
			true
		);
	});

	it('fills the implied parents of a deep layer and groups the paths by root', () => {
		const plan = Result.flatMap(
			decodeReadRequest({ 'accounts.orders.lines': { limit: 3 }, notes: {} }),
			(json) => planReadRequest(json, manifest.exposures)
		);
		expect(plan).toEqual(
			Result.succeed({
				accounts: { accounts: {}, 'accounts.orders': {}, 'accounts.orders.lines': { limit: 3 } },
				notes: { notes: {} }
			})
		);
		const outside = Result.flatMap(decodeReadRequest({ 'notes.about': {} }), (json) =>
			planReadRequest(json, manifest.exposures)
		);
		expect(outside).toEqual(Result.fail("'notes.about' is not a read layer notes declares"));
	});
});
