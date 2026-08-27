import { describe, expect, it } from 'vitest';
import {
	boundedCollectionReadResult,
	READ_COLLECTION_RESULT_BYTE_LIMIT
} from '../../src/runtime/agents/platform-tools.js';

const encodedBytes = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('agent collection read result', () => {
	it('returns small reads in the same explicit paging envelope', () => {
		expect(
			boundedCollectionReadResult(
				[
					{ id: 'a', title: 'First' },
					{ id: 'b', title: 'Second' }
				],
				50
			)
		).toEqual({
			rows: [
				{ id: 'a', title: 'First' },
				{ id: 'b', title: 'Second' }
			],
			truncated: false,
			rowCount: { requested: 50, fetched: 2, page: 2, returned: 2, omitted: 0 },
			cursor: { hasMore: false, next: null },
			diagnostic: null
		});
	});

	it('keeps a truthful continuation cursor when the look-ahead row proves another page', () => {
		const result = boundedCollectionReadResult(
			[
				{ id: 'a', title: 'First' },
				{ id: 'b', title: 'Look-ahead' }
			],
			1
		) as {
			readonly rows: ReadonlyArray<unknown>;
			readonly cursor: { readonly hasMore: boolean; readonly next: string | null };
		};
		expect(result.rows).toEqual([{ id: 'a', title: 'First' }]);
		expect(result.cursor.hasMore).toBe(true);
		expect(result.cursor.next).toEqual(expect.any(String));
	});

	it('caps UTF-8 bytes with complete rows and keeps count, cursor, and diagnostic metadata', () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `row-${String(index).padStart(2, '0')}`,
			// Four-byte code points prove the limit is bytes, not JavaScript string length.
			note: '🧪'.repeat(1_000)
		}));
		const result = boundedCollectionReadResult(rows, rows.length) as {
			readonly rows: ReadonlyArray<unknown>;
			readonly truncated: boolean;
			readonly rowCount: {
				readonly page: number;
				readonly returned: number;
				readonly omitted: number;
			};
			readonly cursor: { readonly hasMore: boolean; readonly next: string | null };
			readonly diagnostic: {
				readonly code: string;
				readonly reason: string;
				readonly byteLimit: number;
				readonly originalBytes: number;
			};
		};

		expect(encodedBytes(result)).toBeLessThanOrEqual(READ_COLLECTION_RESULT_BYTE_LIMIT);
		expect(result.truncated).toBe(true);
		expect(result.rows.length).toBeGreaterThan(0);
		expect(result.rows).toEqual(rows.slice(0, result.rows.length));
		expect(result.rowCount).toMatchObject({
			page: rows.length,
			returned: result.rows.length,
			omitted: rows.length - result.rows.length
		});
		expect(result.cursor).toEqual({ hasMore: true, next: expect.any(String) });
		expect(result.diagnostic).toEqual({
			code: 'read_collection_result_truncated',
			reason: 'complete-row-prefix',
			byteLimit: READ_COLLECTION_RESULT_BYTE_LIMIT,
			originalBytes: expect.any(Number)
		});
		expect(result.diagnostic.originalBytes).toBeGreaterThan(READ_COLLECTION_RESULT_BYTE_LIMIT);
	});

	it('does not skip a first row that cannot fit as a complete JSON value', () => {
		const result = boundedCollectionReadResult(
			[{ id: 'oversized', note: 'x'.repeat(READ_COLLECTION_RESULT_BYTE_LIMIT * 2) }],
			1
		) as {
			readonly rows: ReadonlyArray<unknown>;
			readonly cursor: { readonly hasMore: boolean; readonly next: string | null };
			readonly diagnostic: { readonly reason: string };
		};
		expect(encodedBytes(result)).toBeLessThanOrEqual(READ_COLLECTION_RESULT_BYTE_LIMIT);
		expect(result.rows).toEqual([]);
		expect(result.cursor).toEqual({ hasMore: true, next: null });
		expect(result.diagnostic.reason).toBe('first-row-exceeds-serialized-byte-limit');
	});
});
