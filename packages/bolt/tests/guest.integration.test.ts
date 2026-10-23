/// <reference types="node" />
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Effect, Exit, Layer, Scope } from 'effect';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import {
	EventSink,
	eventsPiece,
	SLICE,
	TelemetryLive,
	type SysEvent
} from '../src/engine/guest/telemetry.ts';
import { RANK, schemaObjects } from '../src/engine/schema/ddl.ts';
import { Guest, Telemetry, type Bridge, type InvocationEvents } from '../src/engine/services.ts';
import { SYSTEM } from '../src/system/index.ts';
import { guestLayer, program } from './support/guest-fixture.ts';

const invocation: Invocation = {
	id: 'run-1',
	kind: 'automation',
	target: 'a',
	input: null,
	ctx: {
		actor: { kind: 'system', run: 'run-1', by: { automation: 'a' } },
		now: '2026-01-01T00:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 's'
	},
	budget: {
		cpuMs: LIMITS.guestCpuMs,
		crossings: LIMITS.crossings.automation,
		readBytes: LIMITS.readBytes
	}
};
const threeCalls = program(
	'export default { automation: { a: { body: function* (_, ctx) { for (let i = 0; i < 3; i++) yield* ctx.ai.sys_2.infer({ prompt: "p" + i }); return "done"; } } } };'
);
const database = Effect.gen(function* () {
	const inner = PgliteDb.make(yield* PgliteDb.open());
	const model = SYSTEM.models['sys_event'];
	if (model === undefined) throw new Error('the built-in event model is missing');
	const log = schemaObjects({
		models: { sys_event: model },
		relationships: {},
		currency: null,
		tz: 'UTC'
	})
		.filter((o) => o.table === 'sys_event')
		.sort((a, b) => RANK[a.rank] - RANK[b.rank]);
	for (const text of log.flatMap((o) => o.create)) yield* inner.write({ text, params: [] });
	let statements = 0;
	const db = TenantDb.typed({
		read: inner.read,
		transaction: inner.transaction,
		write: (sql, lock) =>
			Effect.gen(function* () {
				statements++;
				return yield* inner.write(sql, lock);
			})
	});
	const rows = Effect.map(
		db.read([{ text: 'select count(*)::int as n from sys_event', params: [] }]),
		(result) => result[0]?.rows[0]?.['n']
	);
	return { db, rows, statements: () => statements };
});
const eventLog = (
	db: TenantDb['Service'],
	ids: Parameters<Telemetry['Service']['open']>[0],
	sink: (row: SysEvent) => Effect.Effect<void> = () => Effect.void
) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TelemetryLive.pipe(
				Layer.provide(Layer.mergeAll(Layer.succeed(TenantDb, db), Layer.succeed(EventSink, sink)))
			)
		);
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const events = yield* Scope.provide(scope)(Context.get(context, Telemetry).open(ids));
		return { events, end: Scope.close(scope, Exit.void) };
	});
const run = (events: InvocationEvents, bridge: Bridge) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer(yield* threeCalls, { console: () => {} }, () => Effect.succeed(events))
		);
		return yield* Context.get(context, Guest).invoke(invocation, bridge);
	});

describe('next guest telemetry (§5.12)', () => {
	it.live(
		"keeps a slice of a long invocation's records before it ends, as one statement between crossings",
		() =>
			Effect.gen(function* () {
				const t = yield* database,
					log = yield* eventLog(t.db, { invocation: 'run-1', run: 'run-1' });
				const seen: unknown[] = [];
				let call = 0;
				const bridge: Bridge = {
					cross: (calls) =>
						Effect.gen(function* () {
							seen.push(yield* t.rows);
							if (call++ === 0)
								for (let i = 0; i < SLICE.events + 50; i++)
									yield* log.events.emit('info', 'model.call', { step: i });
							return calls.map(() => ({ ok: true as const, value: 'answer' }));
						}).pipe(Effect.orDie)
				};
				expect(yield* run(log.events, bridge)).toMatchObject({ kind: 'ok', output: 'done' });
				expect(seen).toEqual([0, 250, 250]);
				expect(t.statements()).toBe(1);
				yield* log.events.emit('info', 'run.settled', {});
				yield* log.end;
				expect([yield* t.rows, t.statements()]).toEqual([251, 2]);
			}).pipe(Effect.provide(Pristine.layer))
	);

	it.live('slices after 10 s even under 200 events', () =>
		Effect.gen(function* () {
			let now = Date.parse('2026-01-01T00:00:00Z');
			const live = yield* Clock.Clock;
			const clock: Clock.Clock = {
				currentTimeMillisUnsafe: () => now,
				currentTimeMillis: Effect.sync(() => now),
				currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
				currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
				monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: live.monotonicTimeNanos,
				sleep: (d) => live.sleep(d)
			};
			yield* Effect.gen(function* () {
				const t = yield* database,
					log = yield* eventLog(t.db, { invocation: 'run-1' });
				const bridge: Bridge = {
					cross: (calls) =>
						Effect.gen(function* () {
							yield* log.events.emit('info', 'model.call', {});
							now += SLICE.ms / 2 + 1;
							return calls.map(() => ({ ok: true as const, value: 'answer' }));
						})
				};
				yield* run(log.events, bridge);
				expect([yield* t.rows, t.statements()]).toEqual([2, 1]);
			}).pipe(Effect.provideService(Clock.Clock, clock));
		}).pipe(Effect.provide(Pristine.layer))
	);

	it.live('hands its buffer to an act statement as one piece, leaving nothing to write after', () =>
		Effect.gen(function* () {
			const t = yield* database,
				lines: string[] = [];
			const log = yield* eventLog(t.db, { invocation: 'act-1' }, (row) =>
				Effect.sync(() => {
					lines.push(JSON.stringify(row));
				})
			);
			yield* log.events.emit('warn', 'act.refused', { message: 'no leave left' });
			yield* log.events.emit('info', 'write', { statements: 1, pieces: 3 });
			const taken = yield* log.events.take;
			const r = yield* t.db.write({
				text: `with e as (${eventsPiece(1)} returning 1) select count(*)::int as n from e`,
				params: [JSON.stringify(taken)]
			});
			yield* log.end;
			expect([r.rows[0]?.['n'], t.statements(), lines.length]).toEqual([2, 1, 2]);
			expect(
				(yield* t.db.read([
					{ text: 'select severity, attributes from sys_event order by id', params: [] }
				]))[0]?.rows
			).toEqual([
				{ severity: 'warn', attributes: { message: 'no leave left' } },
				{ severity: 'info', attributes: { statements: 1, pieces: 3 } }
			]);
		}).pipe(Effect.provide(Pristine.layer))
	);

	it.live(
		"stores tenant console lines in the run's log, bounded per invocation and per line, all still on stdout",
		() =>
			Effect.gen(function* () {
				const t = yield* database,
					stdout: string[] = [];
				const context = yield* Layer.build(
					TelemetryLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(TenantDb, t.db),
								Layer.succeed(EventSink, (row: SysEvent) =>
									Effect.sync(() => {
										stdout.push(JSON.stringify(row));
									})
								)
							)
						)
					)
				);
				const scope = yield* Scope.make();
				const body =
					'() => { console.error("x".repeat(3000)); for (let i = 0; i < 250; i++) console.log("line", i); return "done"; }';
				const guest = yield* Layer.build(
					guestLayer(
						{ source: `export default { automation: { a: { body: ${body} } } };\n` },
						{},
						(ids) => Scope.provide(scope)(Context.get(context, Telemetry).open(ids))
					)
				);
				expect(
					yield* Context.get(guest, Guest).invoke(
						{ ...invocation, id: 'run-1:1', run: 'run-1' },
						{
							cross: (calls) =>
								Effect.succeed(calls.map(() => ({ ok: true as const, value: null })))
						}
					)
				).toMatchObject({ kind: 'ok', output: 'done' });
				yield* Scope.close(scope, Exit.void);
				const [rows] = yield* t.db.read([
					{
						text: `select severity, event, invocation, run, attributes from sys_event order by id`,
						params: []
					}
				]);
				const stored = rows?.rows ?? [];
				const lines = stored.filter((r) => r['event'] === 'console');
				expect(lines).toHaveLength(200);
				expect(lines[0]).toMatchObject({
					severity: 'error',
					invocation: 'run-1:1',
					run: 'run-1',
					attributes: { automation: 'a', level: 'error' }
				});
				expect(JSON.stringify(lines[0]?.['attributes']).length).toBeLessThan(2200);
				expect(lines[1]).toMatchObject({ severity: 'info', attributes: { line: 'line 0' } });
				expect(stored.filter((r) => r['event'] === 'console.dropped')).toHaveLength(1);
				// every stored row reaches stdout as its event line (the 50 past the bound as plain log lines)
				expect(stdout.length).toBe(201);
			}).pipe(Effect.provide(Pristine.layer))
	);
});
