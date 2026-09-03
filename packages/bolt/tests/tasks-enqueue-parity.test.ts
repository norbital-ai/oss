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
 * **Instance 2 — deliveries that lose their drain.** Every transaction that appends outbox delivery
 * rows must also announce the flush task. Miss one and that path's deliveries are written
 * correctly, error nothing, and are never sent. There is one such transaction now — the
 * declarative-graph apply — so the diff has one entry on each side, which is exactly why it must be
 * a diff: a second write path added without its announcement would be a second entry on one side
 * only.
 *
 * **Instance 3 — task rows that never announce.** The queue has one enqueue shape: a `bolt_task` row
 * written by the runtime itself, plus a `Wake` that arms the host timer. A wake sent *before* the
 * write commits costs a false alarm on a crash — the host wakes, finds nothing due, re-arms — while
 * a wake the other way round, or none at all, costs durable work nobody comes back for. Miss the
 * wake and the task is durable, correct, and simply *late* until something unrelated wakes the
 * tenant, which presents as "the scheduler is a bit slow" rather than as a defect.
 *
 * Both are checked by enumerating call sites out of the source and diffing the sets, rather than by
 * reading the two paths and concluding they agree.
 */

const RUNTIME = join(import.meta.dirname, '../src/runtime');

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
	[...set]
		.filter(([, body]) => pattern.test(body))
		.map(([name]) => name)
		.toSorted();

const occurrences = (source: string, pattern: RegExp): number =>
	(source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;

/**
 * The statement shapes that write a `bolt_task` row.
 *
 * Two aliases per module name the same table (`boltTaskTable`, `taskTable`), and integrations
 * reaches its own insert through the `enqueueTaskRow` builder, so all three spellings are the write.
 */
const TASK_ROW_WRITE =
	/insert\(\s*(?:boltTask\w*|taskTable)\)|insert\s+into\s+bolt_task|enqueueTaskRow\(/u;

describe('instance 2 — every write path that queues a delivery also queues its drain', () => {
	const source = readFileSync(join(RUNTIME, 'collections/collections.ts'), 'utf8');
	const blocks = blocksOf(source);

	it('has the two sets, and they are the same set', () => {
		// A write path is one that puts outbound delivery rows in its transaction. The delivery rows
		// and their drain task enter through the `createStatements`/`deleteStatements` builders, so a
		// call site — a spread into a transaction's statement list, never the `const` definition — is
		// a path that can emit a delivery, and every one of them must announce the flush.
		const emits = named(blocks, /\.\.\.createStatements\(|\.\.\.deleteStatements\(/u);
		const announces = named(blocks, /announceFlush\(/u);
		// Printed on failure rather than only compared, so a diff says *which* path lost its drain.
		expect({ emits, announces }).toEqual({ emits, announces: emits });
	});

	it('announces before it assembles the transaction statements', () => {
		// Order is the assertion, not merely presence. The wake is sent before the commit on purpose:
		// a crash in between costs a false alarm — the host wakes, finds nothing due, re-arms — while
		// a crash the other way round costs a committed delivery nobody ever comes back for.
		const body = blocks.get('Collections.applyDeclarativeGraph');
		expect(body).toBeDefined();
		const flushAt = body?.search(/announceFlush\(/u) ?? -1;
		const statementsAt =
			body?.search(/\.\.\.createStatements\(|\.\.\.deleteStatements\(/u) ?? -1;
		expect(flushAt).toBeGreaterThan(-1);
		expect(statementsAt).toBeGreaterThan(-1);
		expect(flushAt).toBeLessThan(statementsAt);
	});

	it('is not vacuous — there are write paths to check', () => {
		// A parity assertion over two empty sets passes and proves nothing. This is the guard against
		// the check silently becoming decorative after a refactor renames the builders.
		// The declarative engine consolidated the per-record create/delete builders into one apply
		// pass; the outbox builder keeps at least its definition plus its commit-path call sites.
		expect(occurrences(source, /outboxStatements\(/u)).toBeGreaterThanOrEqual(2);
		expect(
			occurrences(source, /\.\.\.createStatements\(|\.\.\.deleteStatements\(|applyDeclarativeGraph\(/u)
		).toBeGreaterThanOrEqual(1);
	});
});

describe('instance 3 — every task row written is announced to the host', () => {
	/**
	 * There is one enqueue shape, and the wake is half of it.
	 *
	 * A `bolt_task` row is a direct insert joined into the writer's own transaction (or a whole
	 * transaction of its own), and the host timer is armed by a `Wake` beside the write. A module
	 * that writes the row without the wake is the failure this set diff exists to surface.
	 */
	const files = runtimeFiles();

	it('writes bolt_task rows from exactly the known enqueue paths', () => {
		// The other half of the contract, and the one a wake-discipline diff would miss: a module that
		// wrote task rows entirely outside these paths would appear in neither set. The queue itself
		// (`tasks/queue.ts`) writes occurrence rows when the host's own discover tick asks for it, so
		// it needs no wake of its own — the host is already here.
		const writers = files
			.filter((file) => TASK_ROW_WRITE.test(readFileSync(file, 'utf8')))
			.map((file) => file.slice(RUNTIME.length + 1))
			.toSorted();
		expect(writers).toEqual([
			'agents/agents.ts',
			'approvals/approvals.ts',
			'collections/collections.ts',
			'envoys/envoys.ts',
			'integrations/integrations.ts',
			'tasks/queue.ts'
		]);
	});

	it('every block that commits a task row in its own transaction arms the host timer first', () => {
		const offenders = files.flatMap((file) => {
			const blocks = blocksOf(readFileSync(file, 'utf8'));
			return [...blocks]
				// A block that only *builds* the statement — the collections drain rows, the approvals
				// follow-up CTE — commits nothing itself; its caller's announcement is the contract, and
				// the callers are pinned by the other tests in this file.
				.filter(([, body]) => /executeBuilt\(/u.test(body))
				.filter(([, body]) => TASK_ROW_WRITE.test(body))
				.filter(([, body]) => {
					const wakeAt = body.search(/\.wake\(/u);
					const writeAt = body.search(TASK_ROW_WRITE);
					return wakeAt === -1 || wakeAt > writeAt;
				})
				.map(([name]) => `${file.slice(RUNTIME.length + 1)}:${name}`);
		});
		expect(offenders).toEqual([]);
	});

	it('statement-joining task writers are covered by an announcing flow', () => {
		// Approvals joins its follow-up task row into the decision transaction through a CTE built in
		// `projectionOf`. The flows that execute that builder wake the host before the transaction —
		// decide and withdraw both do — and a flow that stopped doing so must fail here, since the
		// joining block itself has no execution to hang a wake on.
		const blocks = blocksOf(readFileSync(join(RUNTIME, 'approvals/approvals.ts'), 'utf8'));
		const flows = [...blocks]
			.filter(
				([name, body]) =>
					name !== 'Approvals.projectionOf' &&
					/transitionQuery\(/u.test(body) &&
					/executeBuilt\(/u.test(body)
			)
			.map(([name]) => name);
		expect(flows.length).toBeGreaterThanOrEqual(2);
		for (const name of flows) {
			expect({ flow: name, announces: /\.wake\(/u.test(blocks.get(name) ?? '') }).toEqual({
				flow: name,
				announces: true
			});
		}
	});
});
