// Cold guest error families share the public constructors and retain their wire validation and failure ABI.
import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Option, Schema } from 'effect';
import * as Errors from '../src/decl/errors.ts';
import * as Act from '../src/decl/errors/act.ts';
import * as Browser from '../src/decl/errors/browser.ts';
import * as Facility from '../src/decl/errors/facility.ts';
import * as Read from '../src/decl/errors/read.ts';
import { Refusal } from '../src/decl/errors/refusal.ts';
import { finalOf } from '../src/decl/runtime/guest-failure.ts';
import { runBody } from '../src/decl/runtime/guest.ts';

describe('canonical guest error families', () => {
	it('the public API reexports the canonical constructors and decoders', () => {
		for (const [publicValue, canonical] of [
			[Errors.Refusal, Refusal],
			[Errors.ActRefused, Act.ActRefused],
			[Errors.ActConflict, Act.ActConflict],
			[Errors.ActUnknown, Act.ActUnknown],
			[Errors.actFailure, Act.actFailure],
			[Errors.FACILITY_KINDS, Facility.FACILITY_KINDS],
			[Errors.FacilityFailure, Facility.FacilityFailure],
			[Errors.Unavailable, Facility.Unavailable],
			[Errors.facilityFailure, Facility.facilityFailure],
			[Errors.ReadFailed, Read.ReadFailed],
			[Errors.TransportFailed, Browser.TransportFailed],
			[Errors.ProtocolFailed, Browser.ProtocolFailed],
			[Errors.DescribeTimeout, Browser.DescribeTimeout]
		])
			expect(publicValue).toBe(canonical);
	});

	it('act outcomes still decode canonical errors and reject malformed failure-shaped values', () => {
		expect(
			Option.getOrThrow(Act.actFailure({ kind: 'refused', code: 'unique', message: 'taken' }))
		).toBeInstanceOf(Errors.ActRefused);
		expect(
			Option.getOrThrow(
				Act.actFailure({
					kind: 'conflict',
					records: [{ collection: 'jobs', id: 'j1', fields: ['owner'] }]
				})
			)
		).toBeInstanceOf(Errors.ActConflict);
		expect(Option.getOrThrow(Act.actFailure({ kind: 'unknown', invocation: 'i1' }))).toBeInstanceOf(
			Errors.ActUnknown
		);
		for (const invalid of [
			{ kind: 'refused', code: 7, message: 'taken' },
			{ kind: 'conflict', records: [{ collection: 'jobs', id: 'j1', fields: [7] }] },
			{ kind: 'unknown', invocation: 7 },
			{ kind: 'committed' },
			null
		])
			expect(Option.isNone(Act.actFailure(invalid))).toBe(true);
	});

	it('facility and declared-read failures retain their schema validation', () => {
		expect(
			Option.getOrThrow(Facility.facilityFailure({ kind: 'timeout', message: 'slow', status: 504 }))
		).toBeInstanceOf(Errors.FacilityFailure);
		expect(
			Option.getOrThrow(
				Facility.facilityFailure({ kind: 'unavailable', facility: 'geo', reason: 'unbound' })
			)
		).toBeInstanceOf(Errors.Unavailable);
		for (const invalid of [
			{ kind: 'timeout', message: 'slow', status: '504' },
			{ kind: 'unavailable', facility: 'geo', reason: 7 },
			{ kind: 'other', message: 'wrong kind' }
		])
			expect(Option.isNone(Facility.facilityFailure(invalid))).toBe(true);
		expect(
			Option.getOrThrow(Read.readFailure({ kind: 'bolt', code: 'forbidden', message: 'no' }))
		).toBeInstanceOf(Errors.ReadFailed);
		expect(Option.isNone(Read.readFailure({ kind: 'bolt', code: 7, message: 'no' }))).toBe(true);
		expect(
			Option.isNone(Read.readFailure({ kind: 'other', code: 'forbidden', message: 'no' }))
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
			message: 'no',
			field: 'title'
		});
		expect(finalOf(Cause.fail(new Act.ActRefused({ code: 'unique', message: 'taken' })))).toEqual({
			kind: 'refused',
			message: 'taken',
			field: undefined
		});
		expect(finalOf(Cause.fail(new Act.ActConflict({ records: [] })))).toEqual({
			kind: 'refused',
			message: '{"kind":"conflict","records":[]}',
			field: undefined
		});
		expect(finalOf(Cause.fail(new Act.ActUnknown({ invocation: 'i1' })))).toEqual({
			kind: 'refused',
			message: '{"kind":"unknown","invocation":"i1"}',
			field: undefined
		});
		const spoof = finalOf(Cause.fail({ _tag: 'ActConflict', records: [], message: 'plain value' }));
		expect(spoof).toBeInstanceOf(Error);
		expect(spoof).toMatchObject({ name: 'ActConflict', message: 'plain value' });
		const defect = new Error('native defect');
		expect(finalOf(Cause.die(defect))).toBe(defect);
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
				expect(rejection).toEqual({ kind: 'refused', message: 'no', field: 'title' });
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
