/**
 * The checkpoint delta, with a real git fixture: commit a tree, move the working tree, and
 * demand that every count move with it. The assertion that matters most is the comment-only
 * edit — changed content with a zero code-LOC delta — because a delta that counted comments
 * would report reduction that never happened.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCheckpointDelta, deltaSummary } from '../build/index.js';

function git(cwd: string, args: ReadonlyArray<string>): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** One committed checkpoint plus a working tree that moved against it. */
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), 'doctor-delta-test-'));
	git(root, ['init', '-q', '-b', 'main']);
	git(root, ['config', 'user.email', 'delta@test.local']);
	git(root, ['config', 'user.name', 'delta']);
	mkdirSync(join(root, 'src', 'hosting'), { recursive: true });
	mkdirSync(join(root, 'src', 'ui'), { recursive: true });
	mkdirSync(join(root, 'tests', 'hosting'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
	// 2 code lines at the checkpoint; gains one code line on disc.
	writeFileSync(join(root, 'src/hosting/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
	// Removed on disc entirely.
	writeFileSync(join(root, 'src/hosting/b.ts'), 'export const gone = 1;\nexport const also = 2;\nexport const third = 3;\n');
	// Comment-only edit on disc: changed content, zero code-LOC movement.
	writeFileSync(join(root, 'src/ui/c.ts'), 'export const c = 1;\n');
	// A test file, out of scope by default.
	writeFileSync(join(root, 'tests/hosting/a.test.ts'), 'import assert from "node:assert/strict";\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-q', '-m', 'checkpoint']);
	writeFileSync(join(root, 'src/hosting/a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const added = 3;\n');
	rmSync(join(root, 'src/hosting/b.ts'));
	writeFileSync(join(root, 'src/ui/c.ts'), '// a comment that must not count as code\nexport const c = 1;\n');
	writeFileSync(join(root, 'src/hosting/d.ts'), 'export const d = 1;\nexport const e = 2;\n');
	return root;
}

test('delta moves files and code LOC per pillar between checkpoint and working tree', () => {
	const root = fixture();
	try {
		const delta = computeCheckpointDelta({ root, against: 'HEAD' });
		assert.equal(delta.kind, 'checkpoint-delta');
		assert.equal(delta.checkpoint.ref, 'HEAD');
		assert.match(delta.checkpoint.commit, /^[0-9a-f]{40}$/);
		assert.equal(delta.includeTests, false);
		const hosting = delta.pillars.find(({ pillar }) => pillar.endsWith(':hosting'));
		assert.ok(hosting, 'hosting is its own pillar');
		assert.ok(hosting.added.some((path) => path.endsWith('src/hosting/d.ts')), `added lists d.ts: ${JSON.stringify(hosting.added)}`);
		assert.ok(hosting.removed.some((path) => path.endsWith('src/hosting/b.ts')));
		assert.ok(hosting.changed.some((path) => path.endsWith('src/hosting/a.ts')));
		assert.equal(hosting.base.files, 2);
		assert.equal(hosting.disc.files, 2);
		assert.equal(hosting.delta.files, 0);
		// b.ts (-3) removed, a.ts (+1) edited, d.ts (+2) added.
		assert.equal(hosting.base.codeLoc, 5);
		assert.equal(hosting.disc.codeLoc, 5);
		assert.equal(hosting.delta.codeLoc, 0);
		const ui = delta.pillars.find(({ pillar }) => pillar.endsWith(':ui'));
		assert.ok(ui, 'ui is its own pillar');
		assert.deepEqual(ui.added, []);
		assert.deepEqual(ui.removed, []);
		assert.deepEqual(ui.changed.length, 1);
		// The comment-only edit: content moved, code LOC did not, physical LOC did.
		assert.equal(ui.base.codeLoc, 1);
		assert.equal(ui.disc.codeLoc, 1);
		assert.equal(ui.delta.codeLoc, 0);
		assert.equal(ui.delta.physicalLoc, 1);
		// Pillar rows and the totals describe the same inventory.
		const sum = delta.pillars.reduce(
			(totals, { delta: row }) => ({ files: totals.files + row.files, codeLoc: totals.codeLoc + row.codeLoc }),
			{ files: 0, codeLoc: 0 }
		);
		assert.equal(delta.totals.delta.files, sum.files);
		assert.equal(delta.totals.delta.codeLoc, sum.codeLoc);
		assert.equal(delta.totals.base.files, 3);
		assert.equal(delta.totals.disc.files, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('tests stay out of scope by default and enter it with includeTests', () => {
	const root = fixture();
	try {
		const production = computeCheckpointDelta({ root, against: 'HEAD' });
		assert.ok(production.pillars.every(({ pillar }) => !pillar.endsWith(':tests')));
		const withTests = computeCheckpointDelta({ root, against: 'HEAD', includeTests: true });
		assert.ok(withTests.pillars.some(({ pillar }) => pillar.endsWith(':tests')));
		assert.equal(withTests.totals.base.files, production.totals.base.files + 1);
		assert.equal(withTests.totals.disc.files, production.totals.disc.files + 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

	test('rows sort most-reduced first and the summary prints a totals line', () => {
		const root = fixture();
		try {
			const delta = computeCheckpointDelta({ root, against: 'HEAD' });
			for (let index = 1; index < delta.pillars.length; index += 1) {
				const left = delta.pillars[index - 1];
				const right = delta.pillars[index];
				assert.ok(
					left.delta.codeLoc < right.delta.codeLoc ||
						(left.delta.codeLoc === right.delta.codeLoc && left.pillar.localeCompare(right.pillar) <= 0),
					'pillars sort by delta codeLoc, ties by id'
				);
			}
			const summary = deltaSummary(delta);
			assert.match(summary, /^norbital-doctor delta: HEAD \(/);
			assert.match(summary, /production only/);
			assert.match(summary, /totals/);
			assert.match(summary, /pillar \(sub tree\)/);
			const withTests = deltaSummary(computeCheckpointDelta({ root, against: 'HEAD', includeTests: true }));
			assert.match(withTests, /including tests/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

test('invalid evidence fails loudly instead of returning an empty delta', () => {
	const root = fixture();
	try {
		assert.throws(() => computeCheckpointDelta({ root, against: 'no-such-ref' }), /unknown git checkpoint/);
		const plain = mkdtempSync(join(tmpdir(), 'doctor-delta-nogit-'));
		try {
			assert.throws(() => computeCheckpointDelta({ root: plain, against: 'HEAD' }), /failed in/);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
