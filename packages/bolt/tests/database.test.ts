// The database request driver (`sqlserver`, §2.6): the op checked before the host's link runs it, the result bounded
// after, and a driver's diagnostics never reaching the guest.
import { expect, it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import { DbError } from '../src/engine/errors.ts';
import { inline } from '../src/engine/db/wire.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { PgliteDb, Pristine, type PgliteClient } from '../src/node/db/pglite.ts';
import { Drivers } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { manifest } from './catalogue-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import {
	validateDatabaseRequest,
	validateDatabaseResult,
	DATABASE_MAX_BYTES
} from '../src/engine/integrations/database.ts';
import { instanceRequest } from '../src/engine/integrations/instances.ts';
const request = { op: 'values' as const, values: { name: 'Ada' } };
const m: EngineManifest = {
	...manifest,
	integrations: {
		ledger: {
			description: 'A ledger database',
			driver: 'sqlserver',
			credential: { connection: { kind: 'text' } }
		}
	}
};
const db = TenantDb.typed({
	read: () =>
		Effect.succeed([
			{
				rows: [
					{
						id: 'books',
						integration: 'ledger',
						owner: null,
						active: true,
						configuration: {},
						status: null
					}
				],
				affected: 0
			}
		]),
	write: () => Effect.succeed({ rows: [], affected: 0 }),

	transaction: () => Effect.fail(DbError.make('XX000', 'this test opens no transaction'))
});
const drivers = (request: Drivers['Service']['request']): Drivers['Service'] => ({
	available: true,
	request,
	send: () => Port.unavailable('link'),
	typing: () => Port.unavailable('link'),
	read: () => Port.unavailable('link'),
	changed: () => Port.unavailable('link')
});

it('rejects unterminated SQL quotes', () => {
	for (const quote of ["'", '"'])
		expect(() => inline({ text: 'select $1, ' + quote, params: ['value'] })).toThrowError(
			expect.objectContaining({ sqlstate: '42601' })
		);
});

it.live('refuses writes through a PGlite read batch and leaves the table intact', () =>
	Effect.gen(function* () {
		const db = PgliteDb.make(yield* PgliteDb.open());
		yield* db.write({ text: 'create table read_probe (value text)', params: [] });
		const select = { text: 'select value from read_probe', params: [] };
		const answer = yield* Effect.result(
			db.read([select, { text: 'insert into read_probe values ($1)', params: ['unexpected'] }])
		);
		expect(answer).toMatchObject({ _tag: 'Failure', failure: { sqlstate: '25006' } });
		expect(yield* db.read([select])).toEqual([{ rows: [], affected: 0 }]);
	}).pipe(Effect.provide(Pristine.layer))
);

it.live('interrupts a SQL batch and drains native rollback before closing its database', () =>
	Effect.gen(function* () {
		const started = Promise.withResolvers<void>();
		const finishStatement = Promise.withResolvers<void>();
		const rollingBack = Promise.withResolvers<void>();
		const finishRollback = Promise.withResolvers<void>();
		const events: string[] = [];
		const sent: string[] = [];
		const client: PgliteClient = {
			query: async () => ({ rows: [] }),
			execProtocol: () => Promise.reject(new Error('this fake runs no parameterised statement')),
			parsers: {},
			transaction: (body) =>
				body({
					query: async () => ({ rows: [] }),
					exec: async (text) => {
						sent.push(text);
						if (text === 'select 1') {
							events.push('statement started');
							started.resolve();
							await finishStatement.promise;
							events.push('statement settled');
						}
						return [];
					}
				}).catch((cause: unknown) => {
					events.push('rollback started');
					rollingBack.resolve();
					return finishRollback.promise.then(() => {
						events.push('rollback finished');
						throw cause;
					});
				})
		};
		const transaction = PgliteDb.make(client).transaction({
			statements: [
				{ text: 'select 1', params: [] },
				{ text: 'select 2', params: [] }
			],
			lock: { tables: ['work'], advisory: ['batch'] }
		});
		yield* Effect.gen(function* () {
			const call = yield* Effect.forkChild(
				Effect.scoped(
					Effect.acquireRelease(Effect.void, () =>
						Effect.sync(() => events.push('database closed'))
					).pipe(Effect.andThen(transaction))
				)
			);
			yield* Effect.promise(() => started.promise);
			const stopping = yield* Fiber.interrupt(call).pipe(
				Effect.forkChild({ startImmediately: true })
			);
			yield* Effect.yieldNow;
			yield* Effect.sync(() => finishStatement.resolve());
			yield* Effect.promise(() => rollingBack.promise);
			yield* Effect.sync(() => {
				expect(events).toEqual(['statement started', 'statement settled', 'rollback started']);
				// the batch's locks go as one text, then its statement
				expect(sent.slice(-2)).toEqual([
					[
						'lock table "work" in SHARE ROW EXCLUSIVE mode',
						"select pg_advisory_xact_lock(hashtext('batch'))"
					].join(';\n'),
					'select 1'
				]);
			}).pipe(Effect.ensuring(Effect.sync(() => finishRollback.resolve())));
			yield* Fiber.join(stopping);
			expect(events).toEqual([
				'statement started',
				'statement settled',
				'rollback started',
				'rollback finished',
				'database closed'
			]);
			expect(Exit.hasInterrupts(yield* Fiber.await(call))).toBe(true);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					finishStatement.resolve();
					finishRollback.resolve();
				})
			)
		);
	})
);

it('request shape and transport-independent bounds reject malformed operations', () => {
	for (const value of [
		{ ...request, maxRows: 1001 },
		{ ...request, maxRows: 1.5 },
		{ ...request, transaction: 'unsafe' },
		{ ...request, values: { value: Infinity } },
		{
			op: 'call',
			procedure: { schema: 'dbo', name: 'submit' },
			arguments: { 'name; DROP TABLE x': 'Ada' }
		},
		{ ...request, values: { text: 'x'.repeat(DATABASE_MAX_BYTES + 1) } }
	])
		expect(() => validateDatabaseRequest(value)).toThrow();
	expect(validateDatabaseRequest(request)).toEqual(request);
	expect(() => validateDatabaseResult({ rows: [{ v: 'x'.repeat(DATABASE_MAX_BYTES) }] })).toThrow(
		'bounds'
	);
	expect(() => validateDatabaseResult({ rows: [{ v: 1 }, { v: 2 }] }, 1)).toThrow('bounds');
});

it.effect(
	'an instance runs a checked statement through its link; an invalid op never reaches it, a result over its rows is refused',
	() =>
		Effect.gen(function* () {
			const sent: Json[] = [];
			const links = drivers((instance, op) =>
				Effect.sync(() => {
					sent.push([instance, op]);
					return { rows: [{ name: 'Ada' }, { name: 'Bob' }] };
				})
			);
			expect(yield* instanceRequest({ manifest: m, db, links }, 'books', request)).toEqual({
				ok: true,
				value: { rows: [{ name: 'Ada' }, { name: 'Bob' }] }
			});
			expect(sent).toEqual([['books', request]]);
			expect(
				yield* instanceRequest({ manifest: m, db, links }, 'books', { ...request, maxRows: 0 })
			).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalidInput' } });
			expect(sent).toHaveLength(1);
			expect(
				yield* instanceRequest({ manifest: m, db, links }, 'books', { ...request, maxRows: 1 })
			).toMatchObject({
				ok: false,
				error: { kind: 'upstream', message: expect.stringContaining('bounds') }
			});
			expect(
				yield* instanceRequest({ manifest: m, db, links }, 'books', { method: 'GET', path: 'x' })
			).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalidInput' } });
		})
);

it.effect('transport diagnostics cannot disclose credentials to an authored body', () =>
	Effect.gen(function* () {
		const links = drivers(() =>
			Effect.fail(
				new FacilityFailure({ kind: 'upstream', message: 'Connection failed: password=private' })
			)
		);
		expect(yield* instanceRequest({ manifest: m, db, links }, 'books', request)).toEqual({
			ok: false,
			error: { kind: 'upstream', message: 'Database request failed.' }
		});
	})
);
