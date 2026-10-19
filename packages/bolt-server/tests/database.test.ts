import { beforeEach, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, Exit, Fiber } from 'effect';
import { sqlServerDatabase } from '../src/database.ts';
import type { config as SqlConfig } from 'mssql';
const harness = vi.hoisted(
	(): {
		rows: Record<string, unknown>[];
		parameters: Record<string, unknown>;
		statement: string;
		closed: number;
		cancelled: number;
		begun: number;
		committed: number;
		rolledBack: number;
		fail: boolean;
		closeFail: boolean;
		pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		started: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		configuration: SqlConfig | undefined;
		parsed: SqlConfig;
	} => ({
		rows: [],
		parameters: {},
		statement: '',
		closed: 0,
		cancelled: 0,
		begun: 0,
		committed: 0,
		rolledBack: 0,
		fail: false,
		closeFail: false,
		pending: undefined,
		started: undefined,
		configuration: undefined,
		parsed: { server: 'sql.example', port: 1433 }
	})
);
vi.mock('mssql', () => ({
	default: {
		Float: 'float',
		Bit: 'bit',
		MAX: 65535,
		NVarChar: (size: number) => `text:${size}`,
		ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
		ConnectionPool: class {
			static parseConnectionString() {
				return harness.parsed;
			}
			constructor(configuration: SqlConfig) {
				harness.configuration = configuration;
			}
			on() {}
			async connect() {}
			async close() {
				harness.closed++;
				if (harness.closeFail) throw new Error('dsn=private');
			}
			request() {
				let rowListener: ((row: Record<string, unknown> | Error) => void) | undefined;
				let errorListener: ((error: Record<string, unknown> | Error) => void) | undefined;
				let cancelled = false;
				return {
					stream: false,
					on(name: string, listener: (value: Record<string, unknown> | Error) => void) {
						if (name === 'row') rowListener = listener;
						if (name === 'error') errorListener = listener;
					},
					input(name: string, _type: unknown, value: unknown) {
						harness.parameters[name] = value;
					},
					cancel() {
						cancelled = true;
						harness.cancelled++;
						harness.pending?.resolve();
					},
					// mssql 11 in stream mode: a failure is only an 'error' event, and the promise still resolves (base/request.js query)
					async query(statement: string) {
						harness.statement = statement;
						harness.started?.resolve();
						await harness.pending?.promise;
						for (const row of harness.rows) {
							if (cancelled) break;
							rowListener?.(row);
						}
						if (harness.fail || cancelled) {
							const error = new Error('password=private');
							if (!this.stream) throw error;
							errorListener?.(error);
						}
						return { recordset: [] };
					}
				};
			}
		},
		Transaction: class {
			private pool: { request(): unknown };
			constructor(pool: { request(): unknown }) {
				this.pool = pool;
			}
			async begin(level: string) {
				expect(level).toBe('serializable');
				harness.begun++;
			}
			request() {
				return this.pool.request();
			}
			async commit() {
				harness.committed++;
			}
			async rollback() {
				harness.rolledBack++;
			}
		}
	}
}));
beforeEach(() => {
	harness.rows = [];
	harness.parameters = {};
	harness.statement = '';
	harness.closed = 0;
	harness.cancelled = 0;
	harness.begun = 0;
	harness.committed = 0;
	harness.rolledBack = 0;
	harness.fail = false;
	harness.closeFail = false;
	harness.pending = undefined;
	harness.started = undefined;
	harness.configuration = undefined;
	harness.parsed = { server: 'sql.example', port: 1433 };
});
const request = {
	statement: 'SELECT @text AS text',
	parameters: { text: "'; DROP TABLE x; --", yes: true, amount: 1.5, empty: null }
};
const query = (input = request) => sqlServerDatabase().query('private DSN', input);
it.effect(
	'installs the checked connector before mssql can dial and preserves original TLS identity',
	() =>
		Effect.gen(function* () {
			harness.parsed = {
				server: 'sql.example',
				port: 1444,
				options: { encrypt: false, trustServerCertificate: true, serverName: 'different.example' }
			};
			yield* query();
			expect(harness.configuration?.options).toMatchObject({
				encrypt: true,
				trustServerCertificate: false,
				serverName: 'sql.example',
				connector: expect.any(Function)
			});
			expect(harness.configuration?.beforeConnect).toEqual(expect.any(Function));
		})
);
it.effect('refuses named-instance discovery before constructing a pool', () =>
	Effect.gen(function* () {
		harness.parsed = { server: 'sql.example', options: { instanceName: 'internal' } };
		expect(yield* Effect.flip(query())).toMatchObject({ code: 'unsupported' });
		expect(harness.configuration).toBeUndefined();
	})
);
it.effect('binds parameters without interpolation and preserves transport values', () =>
	Effect.gen(function* () {
		harness.rows = [
			{
				binary: Buffer.from('0102', 'hex'),
				time: new Date('2026-10-13T00:00:00Z'),
				integer: 12345678901234567890n,
				decimal: '1234567890.123456789',
				nothing: null
			}
		];
		expect(yield* query()).toEqual({
			rows: [
				{
					binary: '0x0102',
					time: '2026-10-13T00:00:00.000Z',
					integer: '12345678901234567890',
					decimal: '1234567890.123456789',
					nothing: null
				}
			]
		});
		expect(harness.statement).toBe(request.statement);
		expect(harness.parameters).toEqual(request.parameters);
		expect(harness.closed).toBe(1);
	})
);
it.effect('serializable batch commits only after the bounded result is accepted', () =>
	Effect.gen(function* () {
		harness.rows = [{ id: 'remote' }];
		yield* sqlServerDatabase().query('private DSN', { ...request, transaction: 'serializable' });
		expect(harness).toMatchObject({ begun: 1, committed: 1, rolledBack: 0, closed: 1 });
	})
);
it.effect(
	'streamed row overflow cancels and rolls back instead of returning a partial result',
	() =>
		Effect.gen(function* () {
			harness.rows = [{ id: 'a' }, { id: 'b' }];
			expect(
				yield* Effect.flip(
					sqlServerDatabase().query('private DSN', {
						...request,
						maxRows: 1,
						transaction: 'serializable'
					})
				)
			).toMatchObject({ message: expect.stringContaining('row limit') });
			expect(harness).toMatchObject({ cancelled: 1, committed: 0, rolledBack: 1, closed: 1 });
		})
);
it.effect('oversized or unsupported values cancel before storage and drain the pool', () =>
	Effect.gen(function* () {
		harness.rows = [{ text: 'x'.repeat(4 * 1024 * 1024) }];
		expect(yield* Effect.flip(query())).toMatchObject({
			message: expect.stringContaining('byte limit')
		});
		expect(harness.closed).toBe(1);
		harness.rows = [{ bad: { nested: true } }];
		expect(yield* Effect.flip(query())).toMatchObject({
			message: expect.stringContaining('unsupported value')
		});
		expect(harness.closed).toBe(2);
	})
);
it.effect('caller interruption cancels the native request and drains its scope', () =>
	Effect.gen(function* () {
		const started = Promise.withResolvers<void>();
		harness.started = started;
		harness.pending = Promise.withResolvers<void>();
		const pending = yield* query().pipe(Effect.forkChild);
		yield* Effect.promise(() => started.promise);
		yield* Fiber.interrupt(pending);
		expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
		expect(harness).toMatchObject({ cancelled: 1, closed: 1 });
	})
);
it.effect(
	'driver errors are masked and cleanup failures preserve the original operation failure',
	() =>
		Effect.gen(function* () {
			harness.fail = true;
			harness.closeFail = true;
			expect(yield* Effect.flip(query())).toMatchObject({ message: 'Database request failed.' });
			harness.fail = false;
			expect(yield* Effect.flip(query())).toMatchObject({
				message: 'Database connection cleanup failed.'
			});
		})
);
it.effect(
	'a statement error in a streamed batch rejects and rolls back instead of answering empty rows',
	() =>
		Effect.gen(function* () {
			harness.fail = true;
			expect(
				yield* Effect.flip(
					sqlServerDatabase().query('private DSN', { ...request, transaction: 'serializable' })
				)
			).toMatchObject({ message: 'Database request failed.' });
			expect(harness).toMatchObject({ begun: 1, committed: 0, rolledBack: 1, closed: 1 });
		})
);
