/// <reference types="node" />
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import { LIMITS, type Invocation, type LogEvent } from '../src/engine/contracts.ts';
import { TelemetryLive } from '../src/engine/guest/telemetry.ts';
import { Logs } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Guest, Telemetry, type Bridge, type InvocationEvents } from '../src/engine/services.ts';
import { program } from '../src/test/guest.ts';
import { guestLayer } from './support/guest-fixture.ts';

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
		crossings: LIMITS.crossings.automation,
		readBytes: LIMITS.readBytes
	}
};
const threeCalls = program(
	'export default { automation: { a: { body: function* (_, ctx) { for (let i = 0; i < 3; i++) yield* ctx.ai.sys_2.infer({ prompt: "p" + i }); return "done"; } } } };'
);
/** The host's runtime log as a test holds it: every event written, in order. */
const eventLog = (ids: Parameters<Telemetry['Service']['open']>[0]) =>
	Effect.gen(function* () {
		const written: LogEvent[] = [];
		const context = yield* Layer.build(
			TelemetryLive.pipe(
				Layer.provide(
					Layer.succeed(Logs, {
						write: (event) =>
							Effect.sync(() => {
								written.push(event);
							}),
						query: () => Port.unavailable('logs')
					})
				)
			)
		);
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const events = yield* Scope.provide(scope)(Context.get(context, Telemetry).open(ids));
		return { events, written, end: Scope.close(scope, Exit.void), scope, context };
	});
const run = (events: InvocationEvents, bridge: Bridge) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer(yield* threeCalls, { console: () => {} }, () => Effect.succeed(events))
		);
		return yield* Context.get(context, Guest).invoke(invocation, bridge);
	});

describe('next guest telemetry (§5.12)', () => {
	it.live("writes each of a long invocation's events to the host's log as it happens", () =>
		Effect.gen(function* () {
			const log = yield* eventLog({ invocation: 'run-1', run: 'run-1' });
			const seen: number[] = [];
			let call = 0;
			const bridge: Bridge = {
				cross: (calls) =>
					Effect.gen(function* () {
						seen.push(log.written.length);
						if (call++ === 0)
							for (let i = 0; i < 250; i++)
								yield* log.events.emit('info', 'model.call', { step: i });
						return calls.map(() => ({ ok: true as const, value: 'answer' }));
					})
			};
			expect(yield* run(log.events, bridge)).toMatchObject({ kind: 'ok', output: 'done' });
			expect(seen).toEqual([0, 250, 250]);
			yield* log.events.emit('warn', 'act.refused', { message: 'no leave left' });
			yield* log.end;
			expect(log.written).toHaveLength(251);
			expect(log.written[0]).toMatchObject({
				severity: 'info',
				event: 'model.call',
				invocation: 'run-1',
				run: 'run-1',
				conversation: null,
				turn: null,
				attributes: { step: 0 }
			});
			expect(log.written.at(-1)).toMatchObject({
				severity: 'warn',
				event: 'act.refused',
				attributes: { message: 'no leave left' }
			});
		})
	);

	it.live("writes tenant console lines to the run's log, bounded per invocation and per line", () =>
		Effect.gen(function* () {
			const log = yield* eventLog({ invocation: 'unused' });
			const body =
				'() => { console.error("x".repeat(3000)); for (let i = 0; i < 250; i++) console.log("line", i); return "done"; }';
			const guest = yield* Layer.build(
				guestLayer(
					{ source: `export default { automation: { a: { body: ${body} } } };\n` },
					{},
					(ids) => Scope.provide(log.scope)(Context.get(log.context, Telemetry).open(ids))
				)
			);
			expect(
				yield* Context.get(guest, Guest).invoke(
					{ ...invocation, id: 'run-1:1', run: 'run-1' },
					{
						cross: (calls) => Effect.succeed(calls.map(() => ({ ok: true as const, value: null })))
					}
				)
			).toMatchObject({ kind: 'ok', output: 'done' });
			yield* log.end;
			const lines = log.written.filter((r) => r.event === 'console');
			expect(lines).toHaveLength(200);
			expect(lines[0]).toMatchObject({
				severity: 'error',
				invocation: 'run-1:1',
				run: 'run-1',
				attributes: { automation: 'a', level: 'error' }
			});
			expect(JSON.stringify(lines[0]?.attributes).length).toBeLessThan(2200);
			expect(lines[1]).toMatchObject({ severity: 'info', attributes: { line: 'line 0' } });
			expect(log.written.filter((r) => r.event === 'console.dropped')).toHaveLength(1);
			expect(log.written).toHaveLength(201);
		})
	);
});
