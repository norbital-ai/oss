// Cold guest error families share the public constructors and retain their wire validation and failure ABI.
import { describe, expect, it } from '@effect/vitest';
import { Cause, Config, Effect, Option, Schema } from 'effect';
import * as Errors from '../src/decl/errors.ts';
import * as Act from '../src/decl/errors/act.ts';
import * as Browser from '../src/decl/errors/browser.ts';
import * as Facility from '../src/decl/errors/facility.ts';
import * as Read from '../src/decl/errors/read.ts';
import { Refusal } from '../src/decl/errors/refusal.ts';
import { finalOf } from '../src/decl/runtime/guest-failure.ts';
import { runBody } from '../src/decl/runtime/guest.ts';

/** An untyped module invokes the runtime entry; no callback/output/Effect witness is invented for it. */
const unknown_program = (body: unknown): Promise<unknown> => {
	const entry: unknown = runBody;
	if (typeof entry !== 'function') throw new Error('The guest runtime entry is missing.');
	const result: unknown = entry(body);
	return Promise.resolve(result);
};

describe('canonical guest error families', () => {
	it.effect('unknown module executables fail honestly at the iterator and Effect yield boundary', () =>
		Effect.gen(function* () {
			for (const [body, message] of [
				[() => ({}), 'must return a generator iterator'],
				[() => ({ next: () => null }), 'returned an invalid iterator result'],
				[() => ({ next: () => ({ done: 'no', value: Effect.void }) }), 'returned an invalid iterator result'],
				[function* () { yield 1; return 2; }, 'must yield Effects']
			] as const) {
				const failure = yield* Effect.flip(Effect.tryPromise({ try: () => unknown_program(body), catch: (error) => error }));
				expect(failure).toBeInstanceOf(TypeError);
				expect(failure).toMatchObject({ message: expect.stringContaining(message) });
			}
		})
	);

	it.effect('the native Effect iterator retains nested returns, throws, finalizers and interruption', () =>
		Effect.gen(function* () {
			const events: string[] = [];
			const result = yield* Effect.promise(() => runBody(function* () {
				try {
					const base = yield* Effect.succeed(3);
					return yield* Effect.gen(function* () { return (yield* Effect.succeed(base)) + 2; }).pipe(
						Effect.ensuring(Effect.sync(() => { events.push('success-finalizer'); }))
					);
				} finally { events.push('success-finally'); }
			}));
			expect(result).toBe(5);
			expect(events).toEqual(['success-finalizer', 'success-finally']);
			const refusal = yield* Effect.flip(Effect.tryPromise({
				try: () => runBody(function* () {
					return yield* Effect.fail(new Refusal({ message: 'No write.' })).pipe(
						Effect.ensuring(Effect.sync(() => { events.push('failure-finalizer'); }))
					);
				}), catch: (error) => error
			}));
			expect(refusal).toMatchObject({ kind: 'refused', message: 'No write.' });
			const interrupted = yield* Effect.flip(Effect.tryPromise({
				try: () => runBody(function* () {
					return yield* Effect.interrupt.pipe(Effect.ensuring(Effect.sync(() => { events.push('interrupt-finalizer'); })));
				}), catch: (error) => error
			}));
			expect(interrupted).toMatchObject({ message: 'interrupted' });
			const defect = new Error('Thrown from the body.');
			const thrown = yield* Effect.flip(Effect.tryPromise({
				try: () => runBody(function* () { yield* Effect.void; throw defect; }), catch: (error) => error
			}));
			expect(thrown).toBe(defect);
			expect(events).toEqual(['success-finalizer', 'success-finally', 'failure-finalizer', 'interrupt-finalizer']);
		})
	);

	it.effect('the invocation config provider remains available to native Config effects', () =>
		Effect.acquireUseRelease(
			Effect.sync(() => Object.getOwnPropertyDescriptor(globalThis, Symbol.for('norbital.bolt.secrets'))),
			() => Effect.gen(function* () {
				Object.defineProperty(globalThis, Symbol.for('norbital.bolt.secrets'), { value: { TOKEN: 'kept' }, configurable: true });
				expect(yield* Effect.promise(() => runBody(function* () { return yield* Config.String('TOKEN'); }))).toBe('kept');
			}),
			(previous) => Effect.sync(() => {
				const key = Symbol.for('norbital.bolt.secrets');
				if (previous === undefined) Reflect.deleteProperty(globalThis, key);
				else Object.defineProperty(globalThis, key, previous);
			})
		)
	);
	it('the public API reexports the canonical constructors and decoders', () => {
		for (const [publicValue, canonical] of [
			[Errors.ActRefused, Act.ActRefused],
			[Errors.ActConflict, Act.ActConflict],
			[Errors.FacilityFailure, Facility.FacilityFailure],
			[Errors.Unavailable, Facility.Unavailable],
			[Errors.ReadFailed, Read.ReadFailed],
			[Errors.ProtocolFailed, Browser.ProtocolFailed]
		])
			expect(publicValue).toBe(canonical);
	});

	it('act outcomes still decode canonical errors and reject malformed failure-shaped values', () => {
		expect(
			Option.getOrThrow(Act.act_failure({ kind: 'refused', code: 'unique', message: 'taken' }))
		).toBeInstanceOf(Errors.ActRefused);
		expect(
			Option.getOrThrow(
				Act.act_failure({
					kind: 'conflict',
					records: [{ model: 'jobs', id: 'j1' }]
				})
			)
		).toBeInstanceOf(Errors.ActConflict);
		expect(Option.getOrThrow(Act.act_failure({ kind: 'unknown', invocation: 'i1' }))).toBeInstanceOf(
			Act.ActUnknown
		);
		for (const invalid of [
			{ kind: 'refused', code: 7, message: 'taken' },
			{ kind: 'conflict', records: [{ model: 'jobs', id: 7 }] },
			{ kind: 'unknown', invocation: 7 },
			{ kind: 'committed' },
			null
		])
			expect(Option.isNone(Act.act_failure(invalid))).toBe(true);
	});

	it('facility and declared-read failures retain their schema validation', () => {
		expect(
			Option.getOrThrow(Facility.facility_failure({ kind: 'timeout', message: 'slow', status: 504 }))
		).toBeInstanceOf(Errors.FacilityFailure);
		expect(
			Option.getOrThrow(
				Facility.facility_failure({ kind: 'unavailable', facility: 'geo', reason: 'unbound' })
			)
		).toBeInstanceOf(Errors.Unavailable);
		for (const invalid of [
			{ kind: 'timeout', message: 'slow', status: '504' },
			{ kind: 'unavailable', facility: 'geo', reason: 7 },
			{ kind: 'other', message: 'wrong kind' }
		])
			expect(Option.isNone(Facility.facility_failure(invalid))).toBe(true);
		expect(
			Option.getOrThrow(Read.read_failure({ kind: 'bolt', code: 'forbidden', message: 'no' }))
		).toBeInstanceOf(Errors.ReadFailed);
		expect(Option.isNone(Read.read_failure({ kind: 'bolt', code: 7, message: 'no' }))).toBe(true);
		expect(
			Option.isNone(Read.read_failure({ kind: 'other', code: 'forbidden', message: 'no' }))
		).toBe(true);
		const encoded = Schema.encodeSync(Errors.ActConflict)(new Act.ActConflict({ records: [] }));
		expect(Schema.decodeUnknownSync(Errors.ActConflict)(encoded)).toBeInstanceOf(Act.ActConflict);
		expect(
			Option.isNone(
				Schema.decodeUnknownOption(Errors.ActConflict)({ _tag: 'ActConflict', records: 'bad' })
			)
		).toBe(true);
	});

	it('the cold finalizer uses class identity rather than trusting failure tags', () => {
		expect(finalOf(Cause.fail(new Refusal({ message: 'no', field: 'title' })))).toEqual({
			kind: 'refused',
			code: 'refused',
			message: 'no',
			key: 'no',
			field: 'title',
			row: undefined
		});
		expect(finalOf(Cause.fail(new Act.ActRefused({ code: 'unique', message: 'taken' })))).toEqual({
			kind: 'refused',
			code: 'unique',
			message: 'taken',
			field: undefined,
			row: undefined,
			rows: undefined,
			rule: undefined,
			data: undefined
		});
		expect(finalOf(Cause.fail(new Act.ActConflict({ records: [] })))).toEqual({
			kind: 'refused',
			code: 'conflict',
			message: 'another write changed these records since they were read',
			field: undefined,
			row: undefined,
			records: []
		});
		expect(finalOf(Cause.fail(new Act.ActUnknown({ invocation: 'i1' })))).toEqual({
			kind: 'refused',
			code: 'unknown',
			message: 'the outcome of i1 could not be confirmed',
			field: undefined,
			row: undefined,
			invocation: 'i1'
		});
		const spoof = finalOf(Cause.fail({ _tag: 'ActConflict', records: [], message: 'plain value' }));
		expect(spoof).toBeInstanceOf(Error);
		expect(spoof).toMatchObject({ name: 'ActConflict', message: 'plain value' });
		const defect = new Error('native defect');
		expect(finalOf(Cause.die(defect))).toBe(defect);
	});

	it('the cold finalizer retains native write refusal metadata', () => {
		const details = {
			code: 'locked',
			message: 'held',
			field: 'title',
			row: 2,
			rows: [2, 5],
			rule: 'jobs.update',
			data: { request_id: 'request-1' }
		};
		expect(finalOf(Cause.fail(new Act.ActRefused(details)))).toEqual({
			kind: 'refused',
			...details
		});
	});

	it.effect(
		'runBody resolves once and retains the native rejection value on its cold failure path',
		() =>
			Effect.gen(function* () {
				let runs = 0;
				expect(
					yield* Effect.promise(() =>
						runBody(function* () {
							runs++;
							return 17;
						})
					)
				).toBe(17);
				expect(runs).toBe(1);
				const rejection = yield* Effect.tryPromise({
					try: () =>
						runBody(function* () {
							return yield* Effect.fail(new Refusal({ message: 'no', field: 'title' }));
						}),
					catch: (error) => error
				}).pipe(Effect.flip);
				expect(rejection).toEqual({
					kind: 'refused',
					code: 'refused',
					message: 'no',
					key: 'no',
					field: 'title',
					row: undefined
				});
				const details = {
					code: 'forbidden',
					message: 'denied',
					field: 'owner',
					row: 1,
					rows: [1, 3],
					rule: 'jobs.create',
					data: { request_id: 'request-2' }
				};
				const native = yield* Effect.flip(
					Effect.tryPromise({
						try: () =>
							runBody(function* () {
								return yield* Effect.fail(new Act.ActRefused(details));
							}),
						catch: (error) => error
					})
				);
				expect(native).toEqual({ kind: 'refused', ...details });
				const records = [{ model: 'jobs', id: 'job-1' }];
				const conflict = yield* Effect.flip(
					Effect.tryPromise({
						try: () =>
							runBody(function* () {
								return yield* Effect.fail(new Act.ActConflict({ records }));
							}),
						catch: (error) => error
					})
				);
				expect(conflict).toEqual({
					kind: 'refused',
					code: 'conflict',
					message: 'another write changed these records since they were read',
					field: undefined,
					row: undefined,
					records
				});
				const unknown = yield* Effect.flip(
					Effect.tryPromise({
						try: () =>
							runBody(function* () {
								return yield* Effect.fail(new Act.ActUnknown({ invocation: 'invocation-1' }));
							}),
						catch: (error) => error
					})
				);
				expect(unknown).toEqual({
					kind: 'refused',
					code: 'unknown',
					message: 'the outcome of invocation-1 could not be confirmed',
					field: undefined,
					row: undefined,
					invocation: 'invocation-1'
				});
				const defect = new Error('native defect');
				const rejectedDefect = yield* Effect.tryPromise({
					try: () =>
						runBody(function* () {
							return yield* Effect.die(defect);
						}),
					catch: (error) => error
				}).pipe(Effect.flip);
				expect(rejectedDefect).toBe(defect);
			})
	);
});
