/**
 * Merkle folding and diffing against hand-computed digests.
 *
 * The directory-hash formula (`name\0hash` lines, sorted, sha256'd) is the storage format, so the
 * tests recompute it independently with node:crypto rather than trusting the implementation to
 * agree with itself. The pruning assertions exist because "the diff is correct" and "the diff
 * prunes" are different claims — a full-scan diff passes the first while wasting the property the
 * tree exists to provide.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { diffTrees, hashesToTree, sameSubtree } from '../../build/semantic/merkle.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

test('an empty index folds to the sha256 of the empty string', () => {
	const tree = hashesToTree(new Map());
	assert.equal(tree.root, sha256(''));
	assert.deepEqual([...tree.nodes.keys()], ['/']);
});

test('directory nodes hash their sorted childName\\0childHash lines', () => {
	const h1 = sha256('f-one');
	const h2 = sha256('g-two');
	const h3 = sha256('b-root');
	const tree = hashesToTree(
		new Map([
			['a/g.txt', h2],
			['b.txt', h3],
			['a/f.txt', h1]
		])
	);
	const dirA = sha256(`f.txt\0${h1}\ng.txt\0${h2}`);
	const expectedRoot = sha256(`a\0${dirA}\nb.txt\0${h3}`);
	assert.equal(tree.nodes.get('a/'), dirA);
	assert.equal(tree.root, expectedRoot);
	assert.equal(tree.nodes.get('/'), expectedRoot);
	assert.equal(tree.nodes.get('a/f.txt'), h1);
});

test('folding is deterministic regardless of insertion order', () => {
	const leaves = new Map([
		['src/zeta.ts', sha256('z')],
		['src/alpha.ts', sha256('a')],
		['src/deep/nested.ts', sha256('n')],
		['top.ts', sha256('t')]
	]);
	assert.deepEqual(hashesToTree(leaves), hashesToTree(new Map(leaves)));
});

test('diff reports additions, changes, deletions, and renames as add plus remove', () => {
	const before = new Map([
		['keep.ts', sha256('keep')],
		['gone.ts', sha256('gone')],
		['mutated.ts', sha256('old')]
	]);
	const after = new Map([
		['keep.ts', sha256('keep')],
		['fresh.ts', sha256('fresh')],
		['mutated.ts', sha256('new')],
		['renamed.ts', sha256('gone')]
	]);
	const diff = diffTrees(hashesToTree(before), hashesToTree(after));
	assert.deepEqual(diff.added, ['fresh.ts', 'renamed.ts']);
	assert.deepEqual(diff.changed, ['mutated.ts']);
	assert.deepEqual(diff.removed, ['gone.ts']);
});

test('diffing prunes identical subtrees on a three-level tree', () => {
	const before = new Map<string, string>();
	const after = new Map<string, string>();
	for (let top = 0; top < 3; top += 1)
		for (let middle = 0; middle < 3; middle += 1)
			for (let leaf = 0; leaf < 4; leaf += 1) {
				const path = `pkg-${top}/module-${middle}/file-${leaf}.ts`;
				before.set(path, sha256(path));
				// Everything survives except one leaf deep in pkg-1/module-2.
				after.set(path, sha256(top === 1 && middle === 2 && leaf === 3 ? `${path}-changed` : path));
			}

	const oldTree = hashesToTree(before);
	const newTree = hashesToTree(after);

	// The untouched siblings of the wounded directory compare equal node-for-node, which is what
	// lets the walk skip them; everything on the wounded path and the root necessarily differ.
	for (const key of oldTree.nodes.keys()) {
		if (key !== '/' && !key.startsWith('pkg-1/') && newTree.nodes.has(key))
			assert.equal(sameSubtree(oldTree, newTree, key), true);
	}
	for (const key of ['pkg-1/', 'pkg-1/module-2/'])
		assert.equal(sameSubtree(oldTree, newTree, key), false);
	assert.equal(sameSubtree(oldTree, newTree, 'pkg-1/module-1/'), true);
	assert.equal(sameSubtree(oldTree, newTree, '/'), false);

	const diff = diffTrees(oldTree, newTree);
	assert.deepEqual(diff.added, []);
	assert.deepEqual(diff.removed, []);
	assert.deepEqual(diff.changed, ['pkg-1/module-2/file-3.ts']);
});

test('sameSubtree is false when either side lacks the node', () => {
	const tree = hashesToTree(new Map([['a.ts', sha256('a')]]));
	const other = hashesToTree(new Map([['b.ts', sha256('b')]]));
	assert.equal(sameSubtree(tree, other, 'a.ts'), false);
	assert.equal(sameSubtree(tree, tree, 'missing'), false);
});
