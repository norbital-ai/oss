import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FacilityFailure } from '@norbital-ai/host-api';
import { connect_public, refuse_platform_addresses } from '@norbital-ai/host-api/node';
import { sqlServerDatabase } from '../src/database.ts';

describe('host SQL routes', () => {
	it.effect('keeps the public-address guard as the default connector', () =>
		Effect.gen(function* () {
			const address = '1.2.3.250';
			refuse_platform_addresses([address]);
			const error = yield* sqlServerDatabase()
				.query(`Server=${address},1433;Database=fixture;User Id=fixture;Password=not-a-secret`, {
					op: 'values',
					values: { connected: 1 },
					max_rows: 1
				})
				.pipe(Effect.flip);
			expect(error.message).toBe('Database connection failed.');
		})
	);

	it.effect('uses the host connector with the original hostname and explicit port', () =>
		Effect.gen(function* () {
			const seen: [string, number][] = [];
			const database = sqlServerDatabase({
				connect: (host, port) => {
					seen.push([host, port]);
					return Effect.fail(FacilityFailure.invalid('Host route refused.'));
				}
			});
			yield* database
				.query(
					'Server=sql.example.test,14444;Database=fixture;User Id=fixture;Password=not-a-secret;TrustServerCertificate=True',
					{ op: 'values', values: { connected: 1 }, max_rows: 1 }
				)
				.pipe(Effect.flip);
			expect(seen).toEqual([['sql.example.test', 14444]]);
		})
	);

	it.effect('still refuses named-instance discovery before using an authorized connector', () =>
		Effect.gen(function* () {
			let calls = 0;
			const database = sqlServerDatabase({
				connect: () => {
					calls++;
					return Effect.fail(FacilityFailure.invalid('Host route refused.'));
				}
			});
			const error = yield* database
				.query(
					'Server=sql.example.test\\INSTANCE;Database=fixture;User Id=fixture;Password=not-a-secret',
					{ op: 'values', values: { connected: 1 }, max_rows: 1 }
				)
				.pipe(Effect.flip);
			expect(error.kind).toBe('unsupported');
			expect(calls).toBe(0);
		})
	);
});

// A real SQL Server 2017 login: `SQLSERVER_TEST_CONNECTION` is a connection string whose host passes the public-address guard.
const live = process.env.SQLSERVER_TEST_CONNECTION;
describe.skipIf(!live)('pooled SQL Server connections', () => {
	const level = (transaction?: 'serializable') => ({
		op: 'call' as const,
		procedure: { schema: 'sys', name: 'sp_executesql' },
		arguments: {
			stmt: 'SELECT transaction_isolation_level AS level FROM sys.dm_exec_sessions WHERE session_id=@@SPID',
			params: ''
		},
		...(transaction ? { transaction } : {})
	});
	it.live(
		'reuses one login, returns a session at the default level after a transaction, and keeps no failed login',
		() =>
			Effect.gen(function* () {
				const credential = live ?? '';
				let connects = 0;
				const database = sqlServerDatabase({
					connect: (host, port) => {
						connects++;
						return connect_public(host, port).pipe(
							Effect.mapError((error) =>
								error._tag === 'FacilityFailure'
									? error
									: new FacilityFailure({ kind: 'upstream', message: error.message })
							)
						);
					}
				});
				// mssql proves the login once with a throwaway connection, then pools one
				expect((yield* database.query(credential, level())).rows).toEqual([{ level: 2 }]);
				expect(connects).toBe(2);
				yield* database.query(credential, level());
				expect(connects).toBe(2);
				expect((yield* database.query(credential, level('serializable'))).rows).toEqual([
					{ level: 4 }
				]);
				expect((yield* database.query(credential, level())).rows).toEqual([{ level: 2 }]);
				expect(connects).toBe(2);
				// a failed transaction's session might keep SERIALIZABLE: its pool is not reused
				yield* database
					.query(credential, {
						...level('serializable'),
						arguments: { stmt: "RAISERROR('refused',16,1)", params: '' }
					})
					.pipe(Effect.flip);
				expect((yield* database.query(credential, level())).rows).toEqual([{ level: 2 }]);
				expect(connects).toBe(4);
				// a refused login is not cached: each request tries again
				const wrong = credential.replace(/Password=[^;]*/i, 'Password=wrong-password-0000');
				for (const attempt of [1, 2])
					expect(
						(yield* database.query(wrong, level()).pipe(Effect.flip)).message,
						`attempt ${attempt}`
					).toBe('Database connection failed.');
				expect(connects).toBe(6);
			}),
		60_000
	);
});
