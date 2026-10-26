// A leased native transaction owns one connection until settlement, interruption or its absolute deadline.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Fiber, Schema } from 'effect';
import { vi } from 'vitest';
import { DbError } from '../src/engine/errors.ts';
import { PostgresDb, type PgClient, type PgPool } from '../src/node/db/postgres.ts';
import { PgliteDb, type PgliteClient } from '../src/node/db/pglite.ts';

type Query = Parameters<PgClient['query']>[0];
type Answer = Awaited<ReturnType<PgClient['query']>>;
type Listener = (error?: unknown) => void;
const EMPTY: Answer = { rows: [], rowCount: 0 };
const statement = { text: 'select 1', params: [] };
const versionSql = "select current_setting('server_version_num')::int as version";
const numbers = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })));

function fake(
	answer: (query: Query) => Promise<Answer> = () => Promise.resolve(EMPTY),
	version = 170000
) {
	const sent: Query[] = [];
	const released: boolean[] = [];
	const release = Promise.withResolvers<void>();
	const listeners = { error: new Set<Listener>(), end: new Set<Listener>() };
	const client: PgClient = {
		query: (query) => {
			sent.push(query);
			return query.text === versionSql
				? Promise.resolve({ rows: [{ version }], rowCount: 1 })
				: answer(query);
		},
		release: (destroy) => {
			released.push(destroy === true);
			release.resolve();
		},
		end: async () => {
			for (const listener of listeners.end) listener();
		},
		connection: { stream: { destroy: () => {} } },
		on: (event, listener) => listeners[event].add(listener),
		removeListener: (event, listener) => listeners[event].delete(listener)
	};
	return {
		client,
		pool: { connect: async () => client },
		sent,
		released,
		release: release.promise,
		emit: (event: 'error' | 'end', error?: unknown) => {
			for (const listener of listeners[event]) listener(error);
		},
		listenerCount: () => listeners.error.size + listeners.end.size
	};
}

describe('leased database sessions', () => {
	it.live(
		'a dying lease owns late errors until its socket closes before returning to the pool',
		() =>
			Effect.gen(function* () {
				const closed = Promise.withResolvers<void>();
				const f = fake();
				let destroyed = 0;
				f.client.end = () => closed.promise;
				f.client.connection = {
					stream: {
						destroy: () => {
							destroyed++;
						}
					}
				};
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						f.emit('error', DbError.make('25P04', 'transaction timeout'));
						expect(destroyed).toBe(1);
						expect(f.released).toEqual([]);
						expect(f.listenerCount()).toBe(2);
						f.emit('error', DbError.make('25P04', 'late transaction timeout'));
						expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '57014' });
						closed.resolve();
						yield* session.rollback;
						expect(f.released).toEqual([true]);
						expect(f.listenerCount()).toBe(0);
					}).pipe(Effect.ensuring(Effect.sync(() => closed.resolve())))
				);
			})
	);

	it.live(
		'a failed savepoint establishment closes the lease before COMMIT can report success',
		() =>
			Effect.gen(function* () {
				const failure = DbError.make('25P02', 'transaction is aborted');
				const f = fake((query) =>
					/^savepoint\b/i.test(query.text) ? Promise.reject(failure) : Promise.resolve(EMPTY)
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						expect(yield* Effect.flip(session.db.write(statement))).toMatchObject({
							sqlstate: '25P02'
						});
						expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '25P02' });
						yield* session.rollback;
					})
				);
				expect(f.released).toEqual([true]);
				expect(f.sent.some((query) => query.text === 'commit')).toBe(false);
				expect(f.sent.some((query) => query.text === statement.text)).toBe(false);
			})
	);

	it.live('interrupted acquisition destroys a connection that the pool supplies later', () =>
		Effect.gen(function* () {
			const pending = Promise.withResolvers<PgClient>();
			const connecting = Promise.withResolvers<void>();
			const f = fake(() => Promise.resolve(EMPTY));
			const pool: PgPool = {
				connect: () => {
					connecting.resolve();
					return pending.promise;
				}
			};
			const call = yield* Effect.forkChild(Effect.scoped(PostgresDb.make(pool).session()));
			yield* Effect.promise(() => connecting.promise);
			yield* Fiber.interrupt(call);
			expect(Exit.hasInterrupts(yield* Fiber.await(call))).toBe(true);
			expect(f.released).toEqual([]);
			pending.resolve(f.client);
			yield* Effect.promise(() => f.release);
			expect(f.sent).toEqual([]);
			expect(f.released).toEqual([true]);
		})
	);

	it.live('older PostgreSQL refuses the lease before BEGIN and releases its connection', () =>
		Effect.gen(function* () {
			const f = fake(undefined, 160006);
			expect(yield* Effect.flip(Effect.scoped(PostgresDb.make(f.pool).session()))).toMatchObject({
				_tag: 'DbError',
				sqlstate: '0A000'
			});
			expect(f.sent.map((query) => query.text)).toEqual([versionSql]);
			expect(f.released).toHaveLength(1);
			expect(f.listenerCount()).toBe(0);
		})
	);

	it.live('a client without lifecycle notifications cannot acquire a lease', () =>
		Effect.gen(function* () {
			const released: boolean[] = [];
			let queried = false;
			const client: PgClient = {
				query: async () => {
					queried = true;
					return EMPTY;
				},
				release: (destroy) => released.push(destroy === true)
			};
			expect(
				yield* Effect.flip(
					Effect.scoped(PostgresDb.make({ connect: async () => client }).session())
				)
			).toMatchObject({ sqlstate: '0A000' });
			expect(queried).toBe(false);
			expect(released).toEqual([true]);
		})
	);

	it.live('scope exit rolls back an unsettled lease once and removes its lifecycle listeners', () =>
		Effect.gen(function* () {
			const f = fake();
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					expect(f.listenerCount()).toBe(2);
					yield* session.db.write(statement);
					expect(f.released).toEqual([]);
				})
			);
			const sent = f.sent.map((query) => query.text);
			expect(sent.join(';\n')).toContain('begin isolation level serializable');
			expect(sent.filter((text) => text === 'rollback')).toHaveLength(1);
			expect(sent).not.toContain('commit');
			expect(f.released).toEqual([false]);
			expect(f.listenerCount()).toBe(0);
		})
	);

	it.live('SQL refuses to enter while COMMIT is in flight', () =>
		Effect.gen(function* () {
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<Answer>();
			const f = fake((query) => {
				if (query.text === 'commit') {
					entered.resolve();
					return finish.promise;
				}
				return Promise.resolve(EMPTY);
			});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					const committing = yield* Effect.forkChild(session.commit);
					yield* Effect.promise(() => entered.promise);
					const before = f.sent.length;
					expect(yield* Effect.flip(session.db.write(statement))).toMatchObject({
						sqlstate: '25000'
					});
					expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '25000' });
					expect(f.sent).toHaveLength(before);
					finish.resolve(EMPTY);
					yield* Fiber.join(committing);
				}).pipe(Effect.ensuring(Effect.sync(() => finish.resolve(EMPTY))))
			);
			expect(f.released).toEqual([false]);
		})
	);

	it.live(
		'explicit commit settles one lease and refuses later SQL without touching the client',
		() =>
			Effect.gen(function* () {
				const f = fake((query) =>
					Promise.resolve(query.text === statement.text ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY)
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						const rows = yield* session.db.read([statement]);
						expect(yield* numbers(rows[0]?.rows ?? [])).toEqual([{ n: 7 }]);
						yield* session.commit;
						const settled = f.sent.length;
						expect(yield* Effect.flip(session.db.write(statement))).toMatchObject({
							sqlstate: '25000'
						});
						expect(yield* session.commit).toBeUndefined();
						expect(yield* session.rollback).toBeUndefined();
						expect(f.sent).toHaveLength(settled);
					})
				);
				expect(f.sent.filter((query) => query.text === 'commit')).toHaveLength(1);
				expect(f.sent.map((query) => query.text)).not.toContain('rollback');
				expect(f.released).toEqual([false]);
				expect(f.listenerCount()).toBe(0);
			})
	);

	it.live('confirmed rollback is idempotent and a later COMMIT refuses without native SQL', () =>
		Effect.gen(function* () {
			const f = fake();
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					yield* session.rollback;
					const settled = f.sent.length;
					expect(yield* session.rollback).toBeUndefined();
					expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '25000' });
					expect(yield* Effect.flip(session.db.read([statement]))).toMatchObject({
						sqlstate: '25000'
					});
					expect(f.sent).toHaveLength(settled);
				})
			);
			expect(f.sent.filter((query) => query.text === 'rollback')).toHaveLength(1);
			expect(f.released).toEqual([false]);
		})
	);

	it.live('interrupting an in-flight SQL request destroys the leased connection', () =>
		Effect.gen(function* () {
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<Answer>();
			const f = fake((query) => {
				if (query.text === statement.text) {
					entered.resolve();
					return finish.promise;
				}
				return Promise.resolve(EMPTY);
			});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					const reading = yield* Effect.forkChild(session.db.read([statement]));
					yield* Effect.promise(() => entered.promise);
					yield* Fiber.interrupt(reading);
					expect(Exit.hasInterrupts(yield* Fiber.await(reading))).toBe(true);
					expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '57014' });
				}).pipe(Effect.ensuring(Effect.sync(() => finish.resolve(EMPTY))))
			);
			expect(f.released).toEqual([true]);
			expect(f.sent.map((query) => query.text)).not.toContain('commit');
			expect(f.listenerCount()).toBe(0);
		})
	);

	it.live(
		'queued requests preserve order and commit refuses while any request is outstanding',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>();
				const finish = Promise.withResolvers<Answer>();
				const second = { text: 'select 2', params: [] };
				const f = fake((query) => {
					if (query.text === statement.text) {
						entered.resolve();
						return finish.promise;
					}
					return Promise.resolve(
						query.text === second.text ? { rows: [{ n: 2 }], rowCount: 1 } : EMPTY
					);
				});
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						const first = yield* Effect.forkChild(session.db.read([statement]));
						yield* Effect.promise(() => entered.promise);
						const next = yield* session.db
							.read([second])
							.pipe(Effect.forkChild({ startImmediately: true }));
						yield* Effect.yieldNow;
						expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '55000' });
						expect(f.sent.map((query) => query.text)).not.toContain(second.text);
						finish.resolve({ rows: [{ n: 1 }], rowCount: 1 });
						expect(yield* Fiber.join(first)).toEqual([{ rows: [{ n: 1 }], affected: 1 }]);
						expect(yield* Fiber.join(next)).toEqual([{ rows: [{ n: 2 }], affected: 1 }]);
						yield* session.commit;
					}).pipe(Effect.ensuring(Effect.sync(() => finish.resolve(EMPTY))))
				);
				const sent = f.sent.map((query) => query.text);
				expect(sent.indexOf(statement.text)).toBeLessThan(sent.indexOf(second.text));
				expect(sent.indexOf(second.text)).toBeLessThan(sent.indexOf('commit'));
				expect(f.released).toEqual([false]);
			})
	);

	it.live('server transaction_timeout is the canonical expiry and never permits COMMIT', () =>
		Effect.gen(function* () {
			const f = fake((query) =>
				query.text === statement.text
					? Promise.reject(
							DbError.make('25P04', 'terminating connection due to transaction timeout')
						)
					: Promise.resolve(EMPTY)
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					expect(yield* Effect.flip(session.db.read([statement]))).toMatchObject({
						sqlstate: '57014'
					});
					expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '57014' });
				})
			);
			expect(f.released).toEqual([true]);
			expect(f.sent.map((query) => query.text)).not.toContain('commit');
			expect(f.listenerCount()).toBe(0);
		})
	);

	it.live('a failed batch rolls back its private savepoint and keeps the outer lease usable', () =>
		Effect.gen(function* () {
			const refused = DbError.make('23505', 'duplicate key');
			const failure = { text: 'insert duplicate', params: [] };
			const skipped = { text: 'insert skipped', params: [] };
			const f = fake((query) =>
				query.text === failure.text
					? Promise.reject(refused)
					: Promise.resolve(
							query.text === statement.text ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY
						)
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					expect(
						yield* Effect.flip(
							session.db.transaction({
								statements: [failure, skipped],
								lock: { advisory: ['lease-batch'] }
							})
						)
					).toBe(refused);
					const rows = yield* session.db.read([statement]);
					expect(yield* numbers(rows[0]?.rows ?? [])).toEqual([{ n: 7 }]);
					yield* session.commit;
				})
			);
			const sent = f.sent.map((query) => query.text);
			const savepoint = sent.findIndex((text) => /^savepoint\b/i.test(text));
			const rollback = sent.findIndex((text) => /^rollback to\b/i.test(text));
			const released = sent.findIndex((text) => /^release savepoint\b/i.test(text));
			expect(savepoint).toBeGreaterThan(-1);
			expect(savepoint).toBeLessThan(sent.indexOf(failure.text));
			expect(sent.join(';\n')).toContain("pg_advisory_xact_lock(hashtext('lease-batch'))");
			expect(sent.indexOf(failure.text)).toBeLessThan(rollback);
			expect(rollback).toBeLessThan(released);
			expect(released).toBeLessThan(sent.indexOf(statement.text));
			expect(sent).not.toContain(skipped.text);
			expect(f.released).toEqual([false]);
		})
	);

	it.live('a dry-run batch answers its results and rolls back only its private savepoint', () =>
		Effect.gen(function* () {
			const f = fake((query) =>
				Promise.resolve(query.text === statement.text ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY)
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					const rows = yield* session.db.transaction({ statements: [statement], rollback: true });
					expect(yield* numbers(rows[0]?.rows ?? [])).toEqual([{ n: 7 }]);
					yield* session.db.write({ text: 'insert retained', params: [] });
					yield* session.commit;
				})
			);
			const sent = f.sent.map((query) => query.text);
			const rollback = sent.findIndex((text) => /^rollback to\b/i.test(text));
			expect(rollback).toBeGreaterThan(sent.indexOf(statement.text));
			expect(rollback).toBeLessThan(sent.indexOf('insert retained'));
			expect(sent).not.toContain('rollback');
			expect(sent.at(-1)).toBe('commit');
			expect(f.released).toEqual([false]);
		})
	);

	for (const event of ['error', 'end'] as const) {
		it.live(`a native ${event} event invalidates the lease and destroys its connection`, () =>
			Effect.gen(function* () {
				const f = fake();
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						const before = f.sent.length;
						f.emit(event, new Error('socket ended'));
						expect(yield* Effect.flip(session.db.write(statement))).toBeInstanceOf(DbError);
						expect(yield* Effect.flip(session.commit)).toBeInstanceOf(DbError);
						expect(f.sent).toHaveLength(before);
					})
				);
				expect(f.released).toEqual([true]);
				expect(f.listenerCount()).toBe(0);
			})
		);
	}

	for (const settle of ['commit', 'rollback'] as const) {
		it.live(`an uncertain ${settle} destroys the connection instead of returning it`, () =>
			Effect.gen(function* () {
				const disconnected = DbError.make('08006', 'connection lost');
				const f = fake((query) =>
					query.text === settle ? Promise.reject(disconnected) : Promise.resolve(EMPTY)
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						const error = yield* Effect.flip(session[settle]);
						if (settle === 'commit') expect(error).toMatchObject({ sqlstate: '08007' });
						else expect(error).toBe(disconnected);
						const settled = f.sent.length;
						expect(yield* session.rollback).toBeUndefined();
						expect(f.sent).toHaveLength(settled);
					})
				);
				expect(f.released).toEqual([true]);
				expect(f.listenerCount()).toBe(0);
			})
		);
	}

	for (const event of ['end', 'error'] as const) {
		it.live(
			`a native ${event} after COMMIT is sent keeps the outcome unknown for every retry`,
			() =>
				Effect.gen(function* () {
					const entered = Promise.withResolvers<void>();
					const finish = Promise.withResolvers<Answer>();
					const disconnected = Object.assign(new Error('server shut down before COMMIT answered'), {
						code: event === 'error' ? '57P01' : '08006'
					});
					const f = fake((query) => {
						if (query.text === 'commit') {
							entered.resolve();
							return finish.promise;
						}
						return Promise.resolve(EMPTY);
					});
					yield* Effect.scoped(
						Effect.gen(function* () {
							const session = yield* PostgresDb.make(f.pool).session();
							const committing = yield* Effect.forkChild(session.commit);
							yield* Effect.promise(() => entered.promise);
							f.emit(event, disconnected);
							expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '08007' });
							finish.reject(disconnected);
							expect(yield* Effect.flip(Fiber.join(committing))).toMatchObject({
								sqlstate: '08007'
							});
							expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '08007' });
							expect(yield* session.rollback).toBeUndefined();
						}).pipe(Effect.ensuring(Effect.sync(() => finish.resolve(EMPTY))))
					);
					expect(f.sent.filter((query) => query.text === 'commit')).toHaveLength(1);
					expect(f.released).toEqual([true]);
					expect(f.listenerCount()).toBe(0);
				})
		);
	}

	it.live('a deterministic serialization failure at COMMIT preserves its native SQLSTATE', () =>
		Effect.gen(function* () {
			const retry = DbError.make('40001', 'serialization failure');
			const f = fake((query) =>
				query.text === 'commit' ? Promise.reject(retry) : Promise.resolve(EMPTY)
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* PostgresDb.make(f.pool).session();
					expect(yield* Effect.flip(session.commit)).toBe(retry);
				})
			);
			expect(f.sent.filter((query) => query.text === 'commit')).toHaveLength(1);
			expect(f.released).toEqual([true]);
		})
	);

	it.live(
		'failed scope rollback destroys the connection and preserves the original SQL failure',
		() =>
			Effect.gen(function* () {
				const refused = DbError.make('23505', 'duplicate key');
				const f = fake((query) =>
					query.text === statement.text
						? Promise.reject(refused)
						: query.text === 'rollback'
							? Promise.reject(DbError.make('08006', 'rollback disconnected'))
							: Promise.resolve(EMPTY)
				);
				const error = yield* Effect.flip(
					Effect.scoped(
						Effect.gen(function* () {
							const session = yield* PostgresDb.make(f.pool).session();
							yield* session.db.write(statement);
						})
					)
				);
				expect(error).toBe(refused);
				expect(f.sent.map((query) => query.text)).toContain('rollback');
				expect(f.released).toEqual([true]);
				expect(f.listenerCount()).toBe(0);
			})
	);

	it.live('failed savepoint cleanup destroys the connection and preserves the batch failure', () =>
		Effect.gen(function* () {
			const refused = DbError.make('23505', 'duplicate key');
			const f = fake((query) =>
				query.text === statement.text
					? Promise.reject(refused)
					: /^rollback to\b/i.test(query.text)
						? Promise.reject(DbError.make('08006', 'savepoint disconnected'))
						: Promise.resolve(EMPTY)
			);
			const error = yield* Effect.flip(
				Effect.scoped(
					Effect.gen(function* () {
						const session = yield* PostgresDb.make(f.pool).session();
						yield* session.db.transaction({ statements: [statement] });
					})
				)
			);
			expect(error).toBe(refused);
			expect(f.sent.map((query) => query.text).some((text) => /^rollback to\b/i.test(text))).toBe(
				true
			);
			expect(f.sent.map((query) => query.text)).not.toContain('commit');
			expect(f.released).toEqual([true]);
			expect(f.listenerCount()).toBe(0);
		})
	);

	for (const operation of ['SQL', 'COMMIT'] as const) {
		it.live(`the watchdog settles ${operation} even when its native query never answers`, () =>
			Effect.acquireUseRelease(
				Effect.sync(() =>
					vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
				),
				() =>
					Effect.scoped(
						Effect.gen(function* () {
							const entered = Promise.withResolvers<void>();
							const unanswered = new Promise<Answer>(() => {});
							const text = operation === 'SQL' ? statement.text : 'commit';
							const sqlstate = operation === 'SQL' ? '57014' : '08007';
							const f = fake((query) => {
								if (query.text === text) {
									entered.resolve();
									return unanswered;
								}
								return Promise.resolve(EMPTY);
							});
							const session = yield* PostgresDb.make(f.pool).session();
							const pending = yield* Effect.forkChild(
								operation === 'SQL' ? Effect.asVoid(session.db.read([statement])) : session.commit
							);
							yield* Effect.promise(() => entered.promise);
							yield* Effect.promise(() => vi.advanceTimersByTimeAsync(4_999));
							expect(f.released).toEqual([]);
							yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
							expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({ sqlstate });
							expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate });
							expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate });
							expect(yield* session.rollback).toBeUndefined();
							expect(f.released).toEqual([true]);
							expect(f.listenerCount()).toBe(0);
							expect(f.sent.filter((query) => query.text === 'commit')).toHaveLength(
								operation === 'SQL' ? 0 : 1
							);
						})
					),
				() => Effect.sync(() => vi.useRealTimers())
			)
		);
	}

	it.live('four seconds acquiring the connection leave only one second of the lease', () =>
		Effect.acquireUseRelease(
			Effect.sync(() =>
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
			),
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const f = fake();
						const connecting = Promise.withResolvers<void>();
						const pending = Promise.withResolvers<PgClient>();
						const pool: PgPool = {
							connect: () => {
								connecting.resolve();
								return pending.promise;
							}
						};
						const acquiring = yield* Effect.forkChild(PostgresDb.make(pool).session());
						yield* Effect.promise(() => connecting.promise);
						yield* Effect.promise(() => vi.advanceTimersByTimeAsync(4_000));
						pending.resolve(f.client);
						const session = yield* Fiber.join(acquiring);
						const deadlines = f.sent.filter((query) => /transaction_timeout\s*=/i.test(query.text));
						expect(deadlines).toHaveLength(1);
						expect(deadlines[0]?.text).toMatch(/transaction_timeout\s*=\s*'1000ms'/i);
						yield* Effect.promise(() => vi.advanceTimersByTimeAsync(999));
						yield* session.db.read([statement]);
						expect(f.released).toEqual([]);
						yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
						expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '57014' });
						expect(f.released).toEqual([true]);
						expect(f.sent.map((query) => query.text)).not.toContain('commit');
					})
				),
			() => Effect.sync(() => vi.useRealTimers())
		)
	);

	it.live('late acquisition checks the original deadline before any native watchdog can run', () =>
		Effect.acquireUseRelease(
			Effect.sync(() => vi.spyOn(performance, 'now').mockReturnValue(0)),
			(clock) =>
				Effect.scoped(
					Effect.gen(function* () {
						const f = fake();
						const connecting = Promise.withResolvers<void>();
						const pending = Promise.withResolvers<PgClient>();
						const pool: PgPool = {
							connect: () => {
								connecting.resolve();
								return pending.promise;
							}
						};
						const acquiring = yield* Effect.forkChild(PostgresDb.make(pool).session());
						yield* Effect.promise(() => connecting.promise);
						clock.mockReturnValue(6_000);
						pending.resolve(f.client);
						expect(yield* Effect.flip(Fiber.join(acquiring))).toMatchObject({ sqlstate: '57014' });
						expect(f.sent).toEqual([]);
						expect(f.released).toEqual([true]);
					})
				),
			(clock) => Effect.sync(() => clock.mockRestore())
		)
	);

	it.live(
		'successful requests cannot reset the absolute five-second lease or permit a late COMMIT',
		() =>
			Effect.acquireUseRelease(
				Effect.sync(() =>
					vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
				),
				() =>
					Effect.scoped(
						Effect.gen(function* () {
							const f = fake();
							const session = yield* PostgresDb.make(f.pool).session();
							yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_500));
							yield* session.db.write(statement);
							yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_499));
							expect(f.released).toEqual([]);
							yield* session.db.read([statement]);
							yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
							const before = f.sent.length;
							expect(yield* Effect.flip(session.commit)).toMatchObject({ sqlstate: '57014' });
							expect(yield* Effect.flip(session.db.read([statement]))).toMatchObject({
								sqlstate: '57014'
							});
							expect(yield* session.rollback).toBeUndefined();
							expect(f.sent).toHaveLength(before);
							expect(f.sent.map((query) => query.text)).not.toContain('commit');
							const deadlines = f.sent.filter((query) =>
								/transaction_timeout\s*=/i.test(query.text)
							);
							expect(deadlines).toHaveLength(1);
							expect(deadlines[0]?.text).toMatch(/transaction_timeout\s*=\s*'(5000ms|5s)'/i);
							expect(f.released).toEqual([true]);
						})
					),
				() => Effect.sync(() => vi.useRealTimers())
			)
	);

	it.live('PGlite refuses a leased session before invoking its native driver', () =>
		Effect.gen(function* () {
			let touched = false;
			const query: PgliteClient['query'] = async () => {
				touched = true;
				return { rows: [] };
			};
			const client: PgliteClient = {
				query,
				transaction: (body) => {
					touched = true;
					return body({ query });
				}
			};
			expect(yield* Effect.flip(Effect.scoped(PgliteDb.make(client).session()))).toMatchObject({
				_tag: 'DbError',
				sqlstate: '0A000'
			});
			expect(touched).toBe(false);
		})
	);
});
