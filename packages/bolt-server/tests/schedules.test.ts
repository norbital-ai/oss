import { assert, it } from '@effect/vitest';
import {
	EnvironmentName,
	InvocationScope,
	ReleaseId,
	TenantId,
	systemSignaturePayload,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import { Effect, Redacted, Schedule } from 'effect';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import { runScheduleTick } from '../src/schedules.js';
import { makeTaskInvocationControl } from '../src/schedules.js';

/**
 * The tick loop, driven the way the guest expects to be driven.
 *
 * The suite this replaces asserted that a timer fired but never asserted the schedule conversation.
 * A host could therefore dispatch an obsolete command, back off on the logged refusal, and leave
 * every scheduled task inert while the suite stayed green. Everything below asserts the real
 * discover/task/settle conversation — which commands, in which order, carrying what, and what the
 * host does with each answer.
 */

const GATEWAY_SECRET = 'test-gateway-secret';

const scope = InvocationScope.make({
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('test-release')
});

const answered = (value: unknown) => ({
	_tag: 'Success',
	response: { status: 200, headers: {}, value }
});

const refused = (message: string) => ({
	_tag: 'Failure',
	error: { code: 'invalid_input', message, retryable: false, outcome: 'known' }
});

const occurrence = {
	taskId: 'schedule:nightly@1',
	scheduleKey: 'nightly',
	scheduledForEpochMs: 1,
	command: 'automations.nightly',
	input: { proof: true },
	attempt: 2
};

/** A guest that answers each command from a table, recording every invocation it was handed. */
const guest = (
	answers: Readonly<Record<string, (invocation: Invocation) => unknown>>,
	onDispatch?: (invocation: Invocation, signal: AbortSignal) => void
) => {
	const seen: Array<Invocation> = [];
	return {
		seen,
		dispatch: async (invocation: Invocation, signal: AbortSignal) => {
			seen.push(invocation);
			onDispatch?.(invocation, signal);
			const answer =
				invocation._tag === 'Command' || invocation._tag === 'Task'
					? answers[invocation.command]
					: undefined;
			return answer === undefined ? answered(null) : answer(invocation);
		}
	};
};

const options = (
	dispatch: (invocation: Invocation, signal: AbortSignal) => Promise<unknown>,
	overrides?: { readonly gatewaySecret?: Redacted.Redacted<string> | undefined }
) => ({
	scope,
	deadlineMillis: 5_000,
	gatewaySecret:
		overrides !== undefined && 'gatewaySecret' in overrides
			? overrides.gatewaySecret
			: Redacted.make(GATEWAY_SECRET),
	invocations: makeTaskInvocationControl(),
	dispatch
});

/** The command invocations a tick made, in order, which is the shape of the protocol itself. */
const commandsOf = (seen: ReadonlyArray<Invocation>): ReadonlyArray<string> =>
	seen.flatMap((invocation) =>
		invocation._tag === 'Command' || invocation._tag === 'Task' ? [invocation.command] : []
	);

const inputOf = (seen: ReadonlyArray<Invocation>, command: string): unknown => {
	for (const invocation of seen) {
		if (
			(invocation._tag === 'Command' || invocation._tag === 'Task') &&
			invocation.command === command
		)
			return invocation.input;
	}
	return undefined;
};

it.effect('discovers, invokes and settles one occurrence, answering the next instant', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: 1_000 }),
			'automations.nightly': () => answered({ ran: true }),
			'host.schedules.settle': () => answered({ settled: true, nextDueAtEpochMs: 9_000 })
		});

		const nextDue = yield* runScheduleTick(options(bundle.dispatch));

		// The three-command conversation, in the only order that is correct: the occurrence runs
		// between the two host commands, never as one of them.
		assert.deepStrictEqual(commandsOf(bundle.seen), [
			'host.schedules.discover',
			'automations.nightly',
			'host.schedules.settle'
		]);
		// And the occurrence is a `Task`, which is what makes the runtime's enqueue gate the thing that
		// decides whether it may run. A `Command` here would be the host minting tenant authority.
		assert.strictEqual(bundle.seen[1]?._tag, 'Task');
		assert.deepStrictEqual(inputOf(bundle.seen, 'automations.nightly'), occurrence.input);
		assert.deepStrictEqual(inputOf(bundle.seen, 'host.schedules.settle'), {
			occurrence,
			outcome: { _tag: 'Done', result: { ran: true } }
		});
		// The settle answer is the later fact about the same queue, so it is what the timer arms to.
		assert.strictEqual(nextDue, 9_000);
	})
);

it.effect('signs each host command over its own command, tenant and input', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: null }),
			'automations.nightly': () => answered(null),
			'host.schedules.settle': () => answered({ settled: true, nextDueAtEpochMs: null })
		});

		yield* runScheduleTick(options(bundle.dispatch));

		for (const invocation of bundle.seen) {
			if (invocation._tag !== 'Command') continue;
			const signature = invocation.headers['x-colony-system-signature']?.[0];
			const timestamp = invocation.headers['x-colony-system-timestamp']?.[0];
			assert.isDefined(signature);
			assert.isDefined(timestamp);
			// Recomputed from the protocol's own renderer rather than from a copy written here: the
			// runtime rebuilds the same bytes, so this is the check that would fail if either side
			// started signing something else.
			assert.strictEqual(
				signature,
				createHmac('sha256', GATEWAY_SECRET)
					.update(
						systemSignaturePayload({
							timestamp: Number(timestamp),
							command: invocation.command,
							tenantId: scope.tenantId,
							input: invocation.input
						}),
						'utf8'
					)
					.digest('hex')
			);
		}
		// The occurrence carries no signature, because a `Task` carries no credential at all.
		const task = bundle.seen.find((invocation) => invocation._tag === 'Task');
		assert.strictEqual(task?._tag, 'Task');
	})
);

it.effect('refuses to dispatch at all when no gateway secret is configured', () =>
	Effect.gen(function* () {
		const bundle = guest({});

		const failure = yield* runScheduleTick(
			options(bundle.dispatch, { gatewaySecret: undefined })
		).pipe(Effect.flip);

		// Named, not generic: an unsigned `host.*` command is refused for want of a credential, which
		// would report a missing environment variable as an authorization problem.
		assert.include(failure.message, 'COLONY_GATEWAY_SECRET');
		assert.strictEqual(bundle.seen.length, 0);
	})
);

it.effect('reports a refused occurrence to the queue instead of failing the tick', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: 2_000 }),
			'automations.nightly': () => refused('the automation threw'),
			'host.schedules.settle': () => answered({ settled: true, nextDueAtEpochMs: null })
		});

		const nextDue = yield* runScheduleTick(options(bundle.dispatch));

		// The task ran and did not succeed. That is the guest's fact to record and apply attempts to,
		// so the host settles it and stays punctual rather than backing its whole clock off.
		assert.deepStrictEqual(inputOf(bundle.seen, 'host.schedules.settle'), {
			occurrence,
			outcome: { _tag: 'Failed', error: 'the automation threw', retryable: false }
		});
		// A settle answering `null` does not erase what discovery reported: one harmless extra tick is
		// the safe direction, a disarmed timer is not.
		assert.strictEqual(nextDue, 2_000);
	})
);

it.effect('renders a thrown occurrence dispatch as a failed outcome', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: null }),
			'automations.nightly': () => {
				throw new Error('bundle exploded');
			},
			'host.schedules.settle': () => answered({ settled: true, nextDueAtEpochMs: null })
		});

		yield* runScheduleTick(options(bundle.dispatch));

		assert.deepStrictEqual(commandsOf(bundle.seen), [
			'host.schedules.discover',
			'automations.nightly',
			'host.schedules.settle'
		]);
		const settled = inputOf(bundle.seen, 'host.schedules.settle');
		assert.deepStrictEqual((settled as { outcome?: unknown } | undefined)?.outcome, {
			_tag: 'Failed',
			error: 'Bolt bundle dispatch failed',
			retryable: true
		});
	})
);

it.effect('fails the tick when the guest refuses discovery, so the host backs off', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () => refused('unauthorized')
		});

		const failure = yield* runScheduleTick(options(bundle.dispatch)).pipe(Effect.flip);

		assert.strictEqual(failure.operation, 'host.schedules.discover');
		assert.include(failure.message, 'unauthorized');
	})
);

it.effect('fails the tick when an occurrence ran but could not be settled', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: 1_000 }),
			'automations.nightly': () => answered(null),
			'host.schedules.settle': () => refused('settle unavailable')
		});

		const failure = yield* runScheduleTick(options(bundle.dispatch)).pipe(Effect.flip);

		assert.strictEqual(failure.operation, 'host.schedules.settle');
		assert.include(failure.message, '0/1');
	})
);

it.effect('fails the tick when schedules were rejected and nothing could be run', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({
					occurrences: [],
					rejections: [{ scheduleKey: 'nightly', reason: 'unparseable cron' }],
					nextDueAtEpochMs: 60_000
				})
		});

		const failure = yield* runScheduleTick(options(bundle.dispatch)).pipe(Effect.flip);

		assert.include(failure.message, 'nightly');
		assert.include(failure.message, 'unparseable cron');
	})
);

it.effect('answers nothing due without invoking anything', () =>
	Effect.gen(function* () {
		const bundle = guest({
			'host.schedules.discover': () =>
				answered({ occurrences: [], rejections: [], nextDueAtEpochMs: null })
		});

		const nextDue = yield* runScheduleTick(options(bundle.dispatch));

		assert.strictEqual(nextDue, null);
		assert.deepStrictEqual(commandsOf(bundle.seen), ['host.schedules.discover']);
	})
);

it.effect('aborts the exact occurrence dispatch an interrupt names', () =>
	Effect.gen(function* () {
		const invocations = makeTaskInvocationControl();
		let occurrenceAborted: boolean | undefined;
		const bundle = guest(
			{
				'host.schedules.discover': () =>
					answered({ occurrences: [occurrence], rejections: [], nextDueAtEpochMs: null }),
				'automations.nightly': () => answered(null),
				'host.schedules.settle': () => answered({ settled: true, nextDueAtEpochMs: null })
			},
			(invocation, signal) => {
				if (invocation._tag !== 'Task') return;
				// What the guest itself does from inside the task: it points the durable task id at the
				// invocation serving it, and something elsewhere asks for that task to stop.
				invocations.active(occurrence.taskId, invocation.id);
				invocations.interrupt(occurrence.taskId);
				occurrenceAborted = signal.aborted;
			}
		);

		yield* runScheduleTick({ ...options(bundle.dispatch), invocations });

		assert.strictEqual(occurrenceAborted, true);
	})
);

/**
 * The same loop again, through `startApplication` this time, so nothing between the timer and the
 * bundle is stubbed: the activation answer arms the timekeeper, the timer fires, and the fixture
 * records the three invocations it was handed.
 *
 * `it.live` because the clock that matters here is the host's own `setTimeout`, not a test one.
 */
const scheduleFixturePath = fileURLToPath(
	new URL('./fixtures/schedule-bundle.mjs', import.meta.url)
);

const scheduleConfiguration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: scheduleFixturePath,
	scope,
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 5_000,
	requestBodyLimitBytes: 1024,
	gatewaySecret: Redacted.make(GATEWAY_SECRET)
});

it.live('runs a due occurrence end to end from the armed timer', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() =>
			startApplication({
				configuration: scheduleConfiguration,
				facilities: { scope: scheduleConfiguration.scope }
			})
		),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const entries = yield* Effect.gen(function* () {
					yield* Effect.sleep('20 millis');
					const response = yield* Effect.tryPromise(() => fetch(`${base}/schedule-log`));
					const body = (yield* Effect.tryPromise(() => response.json())) as {
						readonly log: ReadonlyArray<Record<string, unknown>>;
					};
					if (!body.log.some((entry) => entry['kind'] === 'settle'))
						return yield* Effect.fail(body.log);
					return body.log;
				}).pipe(Effect.retry(Schedule.recurs(100)));

				assert.deepStrictEqual(
					entries.slice(0, 3).map((entry) => entry['kind']),
					['discover', 'task', 'settle'],
					JSON.stringify(entries)
				);
				const discovered = entries[0] ?? {};
				// The host proved itself to its own bundle. Without this the runtime mints no system
				// principal, `host.schedules.discover` is refused, and nothing here would have run.
				assert.strictEqual(
					discovered['signature'],
					createHmac('sha256', GATEWAY_SECRET)
						.update(
							systemSignaturePayload({
								timestamp: Number(discovered['timestamp']),
								command: 'host.schedules.discover',
								tenantId: scope.tenantId,
								input: discovered['input']
							}),
							'utf8'
						)
						.digest('hex')
				);
				assert.strictEqual(entries[1]?.['command'], 'automations.nightly');
				assert.strictEqual(entries[1]?.['syncCommitted'], true);
				assert.strictEqual(entries[1]?.['attempt'], occurrence.attempt);
				assert.strictEqual(entries[2]?.['taskId'], occurrence.taskId);
				assert.strictEqual(
					(entries[2]?.['outcome'] as { readonly _tag?: string } | undefined)?._tag,
					'Done'
				);
			}),
		(application) => Effect.promise(() => application.stop())
	)
);
