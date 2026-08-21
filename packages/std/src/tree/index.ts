/* Generic helpers for reading tree-shaped data structures. */

export function treeFlatten<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K
): T[] {
	if (!nodes || nodes.length === 0) return [];
	const result: T[] = [];
	for (const node of nodes) {
		result.push(node);
		const children = node[childrenKey];
		if (Array.isArray(children)) {
			result.push(...treeFlatten(children as T[], childrenKey));
		}
	}
	return result;
}

export function treeFind<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	predicate: (node: T) => boolean
): T | null {
	if (!nodes || nodes.length === 0) return null;
	for (const node of nodes) {
		if (predicate(node)) return node;
		const children = node[childrenKey];
		if (Array.isArray(children)) {
			const found = treeFind(children as T[], childrenKey, predicate);
			if (found) return found;
		}
	}
	return null;
}
