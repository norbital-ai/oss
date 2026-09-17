import { describe, expect, it } from 'vitest';
import { runTransactionInOneRoundTrip } from '../src/index.js';

/**
 * One `Transaction` request is one database round trip (§5.1).
 *
 * A true network round-trip count needs a peer, so this is the strongest observable proxy: an
 * instrumented transport whose `submit` only enqueues, with one flush per event-loop turn. One
 * flush is one write burst and one response stream — the round trip. A helper that awaits a
 * statement before submitting the next cannot put two statements in one flush and needs one
 * flush per statement, so the assertion below fails exactly when a binding stops pipelining.
 */
const countingTransport = () => {
	let roundTrips = 0;
	let scheduled = false;
	let pending: Array<{
		readonly sql: string;
		readonly resolve: (result: { sql: string }) => void;
		readonly reject: (reason: unknown) => void;
	}> = [];
	const submitted: string[] = [];
	const flush = () => {
		scheduled = false;
		if (pending.length === 0) return;
		roundTrips += 1;
		const batch = pending;
		pending = [];
		for (const entry of batch) {
			if (entry.sql === 'fail') entry.reject(new Error(`statement failed: ${entry.sql}`));
			else entry.resolve({ sql: entry.sql });
		}
	};
	return {
		roundTrips: () => roundTrips,
		submitted: () => submitted,
		submit: (sql: string) =>
			new Promise<{ sql: string }>((resolve, reject) => {
				submitted.push(sql);
				pending.push({ sql, resolve, reject });
				if (!scheduled) {
					scheduled = true;
					setImmediate(flush);
				}
			})
	};
};

describe('one Transaction request is one database round trip', () => {
	it('runs a ten-statement Transaction in one write burst (instrumented-transport proxy)', async () => {
		const transport = countingTransport();
		const statements = Array.from({ length: 10 }, (_, index) => ({
			sql: `insert into notes (body) values ($1) /* ${index} */`,
			parameters: [`note ${index}`]
		}));

		const results = await runTransactionInOneRoundTrip(transport.submit, statements);

		expect(transport.roundTrips()).toBe(1);
		expect(results).toHaveLength(10);
		expect(results.map((result) => result.sql)).toEqual(
			statements.map((statement) => statement.sql)
		);
	});

	it('rolls back and rejects when a statement fails', async () => {
		const transport = countingTransport();
		const statements = [
			{ sql: 'select 1', parameters: [] },
			{ sql: 'fail', parameters: [] },
			{ sql: 'select 3', parameters: [] }
		];

		await expect(runTransactionInOneRoundTrip(transport.submit, statements)).rejects.toThrow(
			'statement failed'
		);
		expect(transport.submitted().at(-1)).toBe('rollback');
	});
});
