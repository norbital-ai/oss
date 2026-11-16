import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FacilityFailure } from '@norbital-ai/host-api';
import { refuse_platform_addresses } from '@norbital-ai/host-api/node';
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
