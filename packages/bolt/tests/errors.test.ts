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
	is_transient,
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
		const inner = BoltError.make('guest_error', 'guest', 'inner', new Error('root'));
		const e = BoltError.make('refused', 'commit', '', inner);
		expect(e.cause).toBe(inner);
		expect(inner.cause).toMatchObject({ message: 'root' });
		expect(BoltError.make('not_found', 'admission', 'gone').cause).toBeUndefined();
	});

	it('is an Error named BoltError, tagged, carrying its code and phase', () => {
		const e = BoltError.make('not_found', 'admission', 'gone');
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(BoltError);
		expect(e.name).toBe('BoltError');
		expect(e._tag).toBe('BoltError');
		expect(String(e)).toBe('BoltError: gone');
		expect(e).toMatchObject({ code: 'not_found', phase: 'admission', message: 'gone' });
		expect(new BoltError({ code: 'not_found', phase: 'admission', message: 'gone' })).toMatchObject({
			code: 'not_found',
			message: 'gone'
		});
	});

	it('round-trips through its Schema', () => {
		const e = BoltError.make('not_found', 'admission', 'gone');
		const encoded = Schema.encodeSync(BoltError)(e);
		expect(encoded).toEqual({
			_tag: 'BoltError',
			code: 'not_found',
			phase: 'admission',
			message: 'gone'
		});
		const back = Schema.decodeUnknownSync(BoltError)(encoded);
		expect(back).toBeInstanceOf(BoltError);
		expect(back).toMatchObject({ code: 'not_found', phase: 'admission', message: 'gone' });
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

	it('transient table: a run retries upstream, timeout, rate_limited and conflict, nothing else (rule 54)', () => {
		expect(CODES.filter((code) => is_transient(BoltError.make(code, 'facility', code)))).toEqual([
			'conflict',
			'rate_limited',
			'timeout',
			'upstream'
		]);
		expect(
			['40001', '40P01', '57014', '08006', '08001', '55P03', '53300', '57P01', '57P02', '57P03', '57P05'].map((s) => is_transient(DbError.make(s, s)))
		).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
		for (const sqlstate of ['23505', '23503', '42601', '42P01', '53100', '53200', '53400', '57P04', '08invalid'])
			expect(is_transient(DbError.make(sqlstate, sqlstate))).toBe(false);
		expect(is_transient(new Conflict({ records: [] }))).toBe(true);
		expect(is_transient(new SerializationReplay())).toBe(true);
		expect(is_transient(new Fenced({ instance: 'i', message: 'another link took i' }))).toBe(false);
		expect(is_transient(new Interrupted())).toBe(false);
		expect(is_transient(new IdentityRefusal({ code: 'timeout', message: 'slow' }))).toBe(true);
		expect(is_transient(new IdentityRefusal({ code: 'forbidden', message: 'no' }))).toBe(false);
		expect(is_transient(new ManifestInvalid({ issues: ['workspace: missing'] }))).toBe(false);
		for (const kind of ['upstream', 'timeout', 'rate_limited'] as const) {
			expect(is_transient(BoltError.make('guest_error', 'guest', 'failed', { kind }))).toBe(true);
		}
		for (const cause of [{ kind: 'invalid' }, { kind: 'unsupported' }, { kind: 'unknown' }, null]) {
			expect(is_transient(BoltError.make('guest_error', 'guest', 'failed', cause))).toBe(false);
		}
		expect(is_transient(BoltError.make('internal', 'guest', 'bug', { kind: 'timeout' }))).toBe(
			false
		);
	});
});
