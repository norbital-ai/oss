import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { BUCKET_MS, due_at, duration, offset_ms } from '../src/engine/runs/time.ts';
import { enqueue, next_due } from '../src/engine/runs/queue.ts';
import { retryDelay } from '../src/engine/queue.ts';
import { Chain } from '../src/engine/write/sql.ts';
import { post, settle } from '../src/engine/conversations/store.ts';

describe('run time and the one enqueue builder', () => {
	it.effect('keeps imminent times exact and rounds distant times up', () =>
		Effect.sync(() => {
			expect(due_at(1_001, 2_001)).toBe(2_001);
			expect(due_at(1_001, 1_001 + BUCKET_MS)).toBe(2 * BUCKET_MS);
			expect(duration('15min')).toBe(900_000);
			expect(offset_ms('-1h')).toBe(-3_600_000);
			expect(retryDelay(2, duration('1min'), 3_600_000)).toBe(120_000);
			expect(retryDelay(10, duration('1h'), 3_600_000)).toBe(3_600_000);
		})
	);
	it.effect('supplies the queue defaults and returns due times for the commit', () =>
		Effect.sync(() => {
			const chain = new Chain();
			const run = enqueue(chain, { select: "SELECT 'work'::text AS automation" });
			const statement = chain.sql(`${next_due(chain)} AS next_due`);
			expect(run).toBe('run0');
			expect(statement.text).toContain(
				"coalesce(r.j->>'due_at', 'now')::timestamptz"
			);
			expect(statement.text).toContain(
				"CASE WHEN state = 'queued' THEN due_at ELSE NULL END AS due_at"
			);
			expect(statement.text).toContain('SELECT min(due_at)');
			expect(statement.text).not.toContain("r.j->>'dueAt'");
		})
	);
});

it.effect('message pieces preserve completed assistant and tool nulls', () =>
	Effect.sync(() => {
		const chain = new Chain();
		post(chain, {
			conversation: 'thread',
			role: 'assistant',
			content: { text: 'done', toolCalls: [] },
			state: null,
			mode: null,
			meta: null
		});
		settle(chain, 'message', {
			content: { id: 'call', name: 'tool', result: null },
			state: null,
			meta: null
		});
		const statement = chain.sql('true AS done');
		expect(statement.params.filter((value) => value === 'queued' || value === 'agent')).toEqual([]);
		expect(statement.params).not.toContainEqual({});
		expect(statement.text).toContain('gen_random_uuid()::text');
	})
);
