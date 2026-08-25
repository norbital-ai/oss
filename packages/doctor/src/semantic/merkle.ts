/**
 * Content addressing for the semantic index, and the diff that decides what a refresh re-embeds.
 *
 * The index stores one vector per file, but "which files changed since the last run" must not
 * require re-reading every vector or trusting file mtimes — mtimes lie across checkouts and CI.
 * A Merkle tree over per-file content hashes gives a single root digest that answers "did anything
 * change" in one comparison, and — because interior nodes hash their children — a diff that walks
 * from the root can skip an untouched subtree wholesale. That skip is the entire point: on a
 * repository where one file moved, the diff must touch nodes proportional to the change, not to
 * the tree.
 *
 * Everything here is pure over flat maps so the tree can be rebuilt from a manifest alone and so
 * the tests need no filesystem. Leaf keys are repository-relative paths; directory keys carry a
 * trailing `/` (root is `/`) so a file and its directory can never collide in the shared node map.
 */
import { createHash } from 'node:crypto';

const sha256 = (text: string): string =>
	createHash('sha256').update(text, 'utf8').digest('hex');

const ROOT_KEY = '/';

/** A hashed tree: leaf nodes keyed by file path, directory nodes keyed with a trailing slash. */
type MerkleTree = Readonly<{
	/** The root digest. Equal roots prove equal trees, which is what the store diffs against. */
	readonly root: string;
	/** Every node, leaves and directories alike, keyed as documented above. */
	readonly nodes: Map<string, string>;
}>;

type Child = Readonly<{ name: string; hash: string }>;

const byName = (left: Child, right: Child): number =>
	left.name === right.name
		? left.hash < right.hash
			? -1
			: 1
		: left.name < right.name
			? -1
			: 1;

/**
 * Fold leaf hashes into a tree.
 *
 * Directory digests hash the sorted `name\0hash` lines so sibling order — the one thing a naive
 * `Object.keys` fold would leak from insertion order — is pinned. Directories are folded deepest
 * first; reverse-lexicographic order over slash-separated keys guarantees a descendant's key sorts
 * after its ancestor's, so one pass suffices without an explicit depth field.
 *
 * An empty index still gets a root (the sha256 of the empty string) rather than a special case:
 * the store's manifest schema has no "no root yet" state, and a stable empty root lets a fresh
 * checkout diff cleanly against a wiped index.
 */
export function hashesToTree(leaves: ReadonlyMap<string, string>): MerkleTree {
	const nodes = new Map<string, string>();
	if (leaves.size === 0) {
		const root = sha256('');
		nodes.set(ROOT_KEY, root);
		return { root, nodes };
	}

	const filesByDirectory = new Map<string, Child[]>();
	for (const [path, hash] of [...leaves].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const cut = path.lastIndexOf('/');
		const directory = cut === -1 ? '' : path.slice(0, cut);
		const bucket = filesByDirectory.get(directory) ?? [];
		bucket.push({ name: path.slice(cut + 1), hash });
		filesByDirectory.set(directory, bucket);
		nodes.set(path, hash);
	}

	// Every ancestor of a file's directory needs a node too, even the ones that hold only
	// subdirectories and no files of their own — and the repository root itself, which top-level
	// files would otherwise leave out of the ancestor walk entirely.
	const directories = new Set<string>(['']);
	for (const directory of filesByDirectory.keys()) {
		for (let key = directory; ; ) {
			directories.add(key);
			const cut = key.lastIndexOf('/');
			if (cut === -1) break;
			key = key.slice(0, cut);
		}
	}

	const subdirectoriesByParent = new Map<string, Child[]>();
	for (const directory of [...directories].sort().reverse()) {
		const children = [
			...(filesByDirectory.get(directory) ?? []),
			...(subdirectoriesByParent.get(directory) ?? [])
		].sort(byName);
		const hash = sha256(children.map((child) => `${child.name}\0${child.hash}`).join('\n'));
		nodes.set(directory === '' ? ROOT_KEY : `${directory}/`, hash);
		const cut = directory.lastIndexOf('/');
		const parent = cut === -1 ? '' : directory.slice(0, cut);
		const bucket = subdirectoriesByParent.get(parent) ?? [];
		bucket.push({ name: directory.slice(cut + 1), hash });
		subdirectoriesByParent.set(parent, bucket);
	}

	const root = nodes.get(ROOT_KEY);
	if (root === undefined)
		throw new Error('norbital-doctor: merkle tree finished without a root node');
	return { root, nodes };
}

/** Direct children of one directory in the node map, sorted by name. */
function directChildren(
	nodes: ReadonlyMap<string, string>,
	prefix: string
): Array<Readonly<{ key: string; name: string; isDirectory: boolean }>> {
	const children: Array<{ key: string; name: string; isDirectory: boolean }> = [];
	for (const key of nodes.keys()) {
		// The root node is the walk's entry point, never a child of itself; likewise a directory
		// key starts with its own prefix and would otherwise reappear as an empty-named child.
		if (key === ROOT_KEY || key === prefix) continue;
		if (!key.startsWith(prefix)) continue;
		const rest = key.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) children.push({ key, name: rest, isDirectory: false });
		else if (slash === rest.length - 1)
			children.push({ key, name: rest.slice(0, -1), isDirectory: true });
	}
	children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return children;
}

/** Every leaf path beneath a directory key, sorted. */
function leavesBeneath(nodes: ReadonlyMap<string, string>, prefix: string): Array<string> {
	const found: Array<string> = [];
	for (const key of nodes.keys())
		if (key.startsWith(prefix) && !key.endsWith('/')) found.push(key);
	return found.sort();
}

/**
 * Per-node comparison the diff prunes with, exposed so tests (and future callers) can assert the
 * skip decision directly instead of inferring it from timing. True only when both trees carry the
 * key and the digests match — a missing node is not "same", it is absent.
 */
export function sameSubtree(left: MerkleTree, right: MerkleTree, key: string): boolean {
	const a = left.nodes.get(key);
	const b = right.nodes.get(key);
	return a !== undefined && a === b;
}

type TreeDiff = Readonly<{
	readonly added: ReadonlyArray<string>;
	readonly changed: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
}>;

/**
 * Walk two trees from the root, descending only where digests disagree.
 *
 * A directory whose hash exists identically in both trees cannot contain a difference — that is
 * the Merkle property doing real work — so its entire subtree is pruned in one comparison. A
 * rename surfaces as its two facts, an addition and a removal, because the tree hashes content,
 * not identity: nothing cheaper than a path rename could distinguish them.
 */
export function diffTrees(previous: MerkleTree, current: MerkleTree): TreeDiff {
	const added: Array<string> = [];
	const changed: Array<string> = [];
	const removed: Array<string> = [];

	const walk = (prefix: string): void => {
		const left = directChildren(previous.nodes, prefix);
		const right = directChildren(current.nodes, prefix);
		const leftByName = new Map(left.map((child) => [child.name, child]));
		const rightByName = new Map(right.map((child) => [child.name, child]));
		const names = [...new Set([...leftByName.keys(), ...rightByName.keys()])].sort();

		// One step per child keeps terminal depth at three: classify the pair, and where the two
		// sides cross each other in kind recurse one directory down.
		const step = (name: string): void => {
			const before = leftByName.get(name);
			const after = rightByName.get(name);
			if (before !== undefined && after !== undefined) {
				if (previous.nodes.get(before.key) === current.nodes.get(after.key)) return;
				if (!before.isDirectory && !after.isDirectory) {
					changed.push(before.key);
				} else if (before.isDirectory && after.isDirectory) {
					walk(`${prefix}${name}/`);
				} else {
					removed.push(...leavesBeneath(previous.nodes, before.key));
					added.push(...leavesBeneath(current.nodes, after.key));
				}
				return;
			}
			if (before === undefined && after !== undefined) {
				if (after.isDirectory) added.push(...leavesBeneath(current.nodes, after.key));
				else added.push(after.key);
				return;
			}
			if (before !== undefined && after === undefined) {
				if (before.isDirectory) removed.push(...leavesBeneath(previous.nodes, before.key));
				else removed.push(before.key);
			}
		};
		for (const name of names) step(name);
	};

	walk('');
	added.sort();
	changed.sort();
	removed.sort();
	return { added, changed, removed };
}
