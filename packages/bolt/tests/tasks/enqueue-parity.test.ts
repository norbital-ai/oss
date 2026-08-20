import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two more set diffs, for two more failures that are silences.
 *
 * The general rule these are instances of: **if a change's failure mode is that something stops
 * happening, a green suite cannot detect it.** A test proves that what runs, runs correctly; it
 * cannot prove that everything which used to run still does. An absent trigger raises nothing, fails
 * nothing and logs nothing. The membership test is *when this goes wrong, is there an artifact?* —
 * and when the honest answer is "no, it simply does not happen", a set diff is the only proof.
 *
 * **Instance 2 — deliveries that lose their drain.** Every write path that appends outbox delivery
 * statements must also append the flush-task enqueue. Miss one operation and that path's deliveries
 * are written correctly, error nothing, and are never sent. The minute cron used to paper over this;
 * the same change that introduces the risk is the one that deletes the cover.
 *
 * **Instance 3 — enqueues that never announce.** Every path writing a task row due sooner than the
 * instant the host holds must send `Wake`. Miss one and the task is durable, correct, and simply
 * *late* until something unrelated wakes the tenant. This is the most pervasive of the three and the
 * hardest to notice, because the work does eventually happen — it presents as "the scheduler is a
 * bit slow" rather than as a defect. And the cost lands exactly where this whole change is aimed: a
 * tenant that wakes on unrelated traffic rather than on its own schedule is the billing problem it
 * set out to delete, quietly reintroduced.
 *
 * Both are checked by enumerating call sites out of the source and diffing the sets, rather than by
 * reading the two paths and concluding they agree.
 */

const RUNTIME = join(import.meta.dirname, '../../src/runtime');

/**
 * The source of one module, split into named blocks at each `Effect.fn('<Name>')` boundary.
 *
 * Block-level rather than file-level because that is the granularity the invariant actually holds
 * at: "this write path announces" is a statement about one function, and a file-level check would
 * pass on a file where three of four paths announce.
 */
const blocksOf = (source: string): ReadonlyMap<string, string> => {
	const boundaries = [...source.matchAll(/Effect\.fn\('([^']+)'\)/gu)];
	const blocks = new Map<string, string>();
	for (const [index, boundary] of boundaries.entries()) {
		const start = boundary.index;
		const end = boundaries[index + 1]?.index ?? source.length;
		blocks.set(boundary[1] ?? `block:${index}`, source.slice(start, end));
	}
	return blocks;
};

/** Every `.ts` under `src/runtime`, recursively — so a new module cannot opt out by being new. */
const runtimeFiles = (directory: string = RUNTIME): ReadonlyArray<string> =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? runtimeFiles(join(directory, entry.name))
			: entry.name.endsWith('.ts')
				? [join(directory, entry.name)]
				: []
	);

const named = (set: ReadonlyMap<string, string>, pattern: RegExp): ReadonlyArray<string> =>
	[...set].filter(([, body]) => pattern.test(body)).map(([name]) => name).toSorted();

describe('instance 2 — every write path that queues a delivery also queues its drain', () => {
	const source = readFileSync(join(RUNTIME, 'collections/collections.ts'), 'utf8');
	const blocks = blocksOf(source);

	it('has the two sets, and they are the same set', () => {
		// A write path is one that puts outbound delivery rows in its transaction. `createStatements`
		// is the shared builder the create paths use, and it is the one that calls `outboxStatements`,
		// so a path that calls either is a path that can emit a delivery.
		const emits = named(blocks, /outboxStatements\(|createStatements\(/u).filter(
			// `Collections.findNearest` is a read, not a write path, but its block still matches:
			// `createStatements` is a plain const defined between `findNearest` and the next
			// `Effect.fn`, so the builder's whole body — which calls `outboxStatements` — lands inside
			// the read's block. A read has no delivery to announce, so it is dropped before the sets
			// are compared.
			(name) => name !== 'Collections.findNearest'
		);
		const announces = named(blocks, /announceFlush\(/u);
		// Printed on failure rather than only compared, so a diff says *which* path lost its drain.
		expect({ emits, announces }).toEqual({ emits, announces: emits });
	});

	it('is not vacuous — there are write paths to check', () => {
		// A parity assertion over two empty sets passes and proves nothing. This is the guard against
		// the check silently becoming decorative after a refactor renames the builders.
		expect(named(blocks, /outboxStatements\(|createStatements\(/u).length).toBeGreaterThanOrEqual(3);
	});
});

describe('instance 3 — every task row written is announced to the host', () => {
	/**
	 * There are exactly two ways to write a task row, and they differ in who must announce.
	 *
	 * `TaskQueue.enqueue` writes in a transaction of its own and sends `Wake` itself, before the
	 * write — so no caller of it can forget. `TaskQueue.statements` returns statements for a caller's
	 * *own* transaction, which is the whole point of it (the job cannot exist without the write that
	 * asked for it), and therefore cannot announce on the caller's behalf. Its callers must.
	 */
	const files = runtimeFiles();

	it('enqueue announces before it writes, so its callers cannot get it wrong', () => {
		const tasks = readFileSync(join(RUNTIME, 'tasks/tasks.ts'), 'utf8');
		const body = blocksOf(tasks).get('TaskQueue.enqueue');
		expect(body).toBeDefined();
		const wakeAt = body?.indexOf('wake(') ?? -1;
		const writeAt = body?.indexOf('database.execute') ?? -1;
		expect(wakeAt).toBeGreaterThan(-1);
		expect(writeAt).toBeGreaterThan(-1);
		// Order is the assertion, not merely presence. A crash between the announcement and the commit
		// costs a false alarm — the host wakes, finds nothing, re-arms. A crash the other way round
		// costs a committed job nobody comes back for.
		expect(wakeAt).toBeLessThan(writeAt);
	});

	it('every block that uses the statement-joining path announces in the same block', () => {
		const offenders = files.flatMap((file) => {
			const blocks = blocksOf(readFileSync(file, 'utf8'));
			return named(blocks, /queue\.statements\(|\.statements\(\[/u)
				.filter((name) => !/announceFlush\(|\.wake\(/u.test(blocks.get(name) ?? ''))
				.map((name) => `${file.slice(RUNTIME.length + 1)}:${name}`);
		});
		expect(offenders).toEqual([]);
	});

	it('nothing writes bolt_task except the queue', () => {
		// The other half of instance 3, and the one a set diff of call sites would miss: a module that
		// bypassed the queue entirely and inserted a row with its own SQL would announce nothing and
		// appear in neither set. The queue owns the table; `queue.ts` composes every statement that
		// touches it, and `tasks.ts` is the only place that hands one to a facility.
		const offenders = files.filter(
			(file) =>
				/insert\s+into\s+bolt_task|bolt_task\s*\(/iu.test(readFileSync(file, 'utf8')) &&
				!file.includes(join('runtime', 'tasks'))
		);
		expect(offenders.map((file) => file.slice(RUNTIME.length + 1))).toEqual([]);
	});
});
