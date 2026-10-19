// The engine's failures (D3, rule 72a): construction never throws, the message rule is the old constructor's, the tags
// are Errors named for themselves, and `CODE` alone decides what a run retries (rule 54).
import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
	Conflict,
	DbError,
	Fenced,
	IdentityRefusal,
	Interrupted,
	isTransient,
	ManifestInvalid,
	SerializationReplay
} from '../src/engine/errors.ts';
import { BoltError, CODE, CODES, PHASES } from '../src/protocol/errors.ts';

describe('engine errors', () => {
	it('normalisation: a message that is not text, or is blank, becomes the phase sentence; text is kept as given', () => {
		const nasty = {
			toString() {
				throw new Error('boom');
			}
		};
		const cases: readonly (readonly [unknown, string])[] = [
			['', 'The commit failed.'],
			['   ', 'The commit failed.'],
			[42, 'The commit failed.'],
			[nasty, 'The commit failed.'],
			[undefined, 'The commit failed.'],
			[null, 'The commit failed.'],
			[new Error('inner'), 'The commit failed.'],
			['no leave left', 'no leave left'],
			[' padded ', ' padded ']
		];
		for (const [message, text] of cases)
			expect(BoltError.make('internal', 'commit', message).message).toBe(text);
		expect(PHASES.map((phase) => BoltError.make('internal', phase, '').message)).toEqual([
			'The input could not be decoded.',
			'The request was not admitted.',
			'Workspace code failed.',
			'Deriving the write failed.',
			'The commit failed.',
			'A facility call failed.',
			'Delivery failed.'
		]);
	});

	it('make never throws and keeps its cause', () => {
		const inner = BoltError.make('guestError', 'guest', 'inner', new Error('root'));
		const e = BoltError.make('refused', 'commit', '', inner);
		expect(e.cause).toBe(inner);
		expect(inner.cause).toMatchObject({ message: 'root' });
		expect(BoltError.make('notFound', 'admission', 'gone').cause).toBeUndefined();
	});

	it('is an Error named BoltError, tagged, carrying its code and phase', () => {
		const e = BoltError.make('notFound', 'admission', 'gone');
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(BoltError);
		expect(e.name).toBe('BoltError');
		expect(e._tag).toBe('BoltError');
		expect(String(e)).toBe('BoltError: gone');
		expect(e).toMatchObject({ code: 'notFound', phase: 'admission', message: 'gone' });
		expect(new BoltError({ code: 'notFound', phase: 'admission', message: 'gone' })).toMatchObject({
			code: 'notFound',
			message: 'gone'
		});
	});

	it('round-trips through its Schema', () => {
		const e = BoltError.make('notFound', 'admission', 'gone');
		const encoded = Schema.encodeSync(BoltError)(e);
		expect(encoded).toEqual({
			_tag: 'BoltError',
			code: 'notFound',
			phase: 'admission',
			message: 'gone'
		});
		const back = Schema.decodeUnknownSync(BoltError)(encoded);
		expect(back).toBeInstanceOf(BoltError);
		expect(back).toMatchObject({ code: 'notFound', phase: 'admission', message: 'gone' });
		expect(() =>
			Schema.decodeUnknownSync(BoltError)({
				_tag: 'BoltError',
				code: 'nope',
				phase: 'admission',
				message: 'x'
			})
		).toThrow();
	});

	it('DbError keeps its SQLSTATE, message and constraint', () => {
		const e = DbError.make('23505', 'duplicate key', 'customers_email_unique');
		expect(e).toBeInstanceOf(Error);
		expect(e).toMatchObject({
			_tag: 'DbError',
			name: 'DbError',
			sqlstate: '23505',
			message: 'duplicate key',
			constraint: 'customers_email_unique'
		});
		expect(DbError.make('22003', 'out of range').constraint).toBeUndefined();
	});

	it('every code has its CODE row', () => {
		for (const code of CODES) expect(CODE[code].status).toBeGreaterThanOrEqual(400);
		expect(Object.keys(CODE).sort()).toEqual([...CODES].sort());
	});

	it('transient table: a run retries upstream, timeout, rateLimited and conflict, nothing else (rule 54)', () => {
		expect(CODES.filter((code) => isTransient(BoltError.make(code, 'facility', code)))).toEqual([
			'conflict',
			'rateLimited',
			'timeout',
			'upstream'
		]);
		expect(
			['40001', '40P01', '57014', '23505', '08006'].map((s) => isTransient(DbError.make(s, s)))
		).toEqual([true, true, true, false, false]);
		expect(isTransient(new Conflict({ records: [] }))).toBe(true);
		expect(isTransient(new SerializationReplay())).toBe(true);
		expect(isTransient(new Fenced({ instance: 'i', message: 'another link took i' }))).toBe(false);
		expect(isTransient(new Interrupted())).toBe(false);
		expect(isTransient(new IdentityRefusal({ code: 'timeout', message: 'slow' }))).toBe(true);
		expect(isTransient(new IdentityRefusal({ code: 'forbidden', message: 'no' }))).toBe(false);
		expect(isTransient(new ManifestInvalid({ issues: ['workspace: missing'] }))).toBe(false);
		for (const kind of ['upstream', 'timeout', 'rateLimited'] as const) {
			expect(isTransient(BoltError.make('guestError', 'guest', 'failed', { kind }))).toBe(true);
		}
		for (const cause of [{ kind: 'invalid' }, { kind: 'unsupported' }, { kind: 'unknown' }, null]) {
			expect(isTransient(BoltError.make('guestError', 'guest', 'failed', cause))).toBe(false);
		}
		expect(isTransient(BoltError.make('internal', 'guest', 'bug', { kind: 'timeout' }))).toBe(
			false
		);
	});
});
