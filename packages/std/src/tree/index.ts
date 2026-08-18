/*
 * Generic tree helpers for manipulating tree-shaped data structures.
 * Works with any object that has a children property (or any specified key).
 */

import { Effect } from 'effect';

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

export function treeFilterLeaves<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	predicate: (node: T) => boolean
): T[] {
	return treeFlatten(nodes, childrenKey).filter((node) => {
		const children = node[childrenKey];
		const isLeaf = !Array.isArray(children) || (children as unknown[]).length === 0;
		return isLeaf && predicate(node);
	});
}

export function treeMap<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	mapper: (node: T) => T
): T[] {
	if (!nodes || nodes.length === 0) return [];
	return nodes.map((node) => {
		const rawChildren = node[childrenKey];
		const mappedChildren = Array.isArray(rawChildren)
			? treeMap(rawChildren as T[], childrenKey, mapper)
			: rawChildren;
		const withMappedChildren = {
			...node,
			[childrenKey]: mappedChildren
		} as T;
		return mapper(withMappedChildren);
	});
}

export function treeWalk<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	visitor: (node: T, parent: T | null) => void | boolean,
	parent: T | null = null
): void {
	if (!nodes || nodes.length === 0) return;
	for (const node of nodes) {
		const proceed = visitor(node, parent);
		if (proceed === false) continue;
		const children = node[childrenKey];
		if (Array.isArray(children)) {
			treeWalk(children as T[], childrenKey, visitor, node);
		}
	}
}

export function treeReduce<T extends object, K extends keyof T, A>(
	root: T | readonly T[] | undefined | null,
	childrenKey: K,
	reducer: (accumulator: A, node: T, parent: T | null, depth: number) => A,
	initial: A
): A {
	const reduceNode = (acc: A, node: T, parent: T | null, depth: number): A => {
		let next = reducer(acc, node, parent, depth);
		const rawChildren = node[childrenKey];
		if (Array.isArray(rawChildren)) {
			for (const child of rawChildren as T[]) {
				next = reduceNode(next, child, node, depth + 1);
			}
		} else if (rawChildren && typeof rawChildren === 'object') {
			for (const child of Object.values(rawChildren as Record<string, T>)) {
				next = reduceNode(next, child, node, depth + 1);
			}
		}
		return next;
	};

	let acc = initial;
	if (Array.isArray(root)) {
		for (const r of root as T[]) acc = reduceNode(acc, r, null, 0);
	} else if (root) {
		acc = reduceNode(acc, root as T, null, 0);
	}
	return acc;
}

export function treeRemove<T extends object, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	predicate: (node: T) => boolean
): { result: T[]; removed: T | null } {
	if (!nodes || nodes.length === 0) return { result: [], removed: null };
	let removed: T | null = null;

	const result = nodes.filter((node) => {
		if (predicate(node)) {
			removed = node;
			return false;
		}
		return true;
	});

	if (!removed) {
		return {
			result: result.map((node) => {
				const children = node[childrenKey];
				if (Array.isArray(children)) {
					const childResult = treeRemove(children as T[], childrenKey, predicate);
					if (childResult.removed) removed = childResult.removed;
					return { ...node, [childrenKey]: childResult.result } as T;
				}
				return node;
			}),
			removed
		};
	}

	return { result, removed };
}

export function treeInsert<T extends object & { id: string }, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	newNode: T,
	parentId: string | null
): T[] {
	if (!parentId) return [...(nodes || []), newNode];
	if (!nodes || nodes.length === 0) return [];

	return nodes.map((node) => {
		if (node.id === parentId) {
			const children = (node[childrenKey] as T[] | undefined) ?? [];
			return { ...node, [childrenKey]: [...children, newNode] } as T;
		}
		const children = node[childrenKey];
		if (Array.isArray(children)) {
			return {
				...node,
				[childrenKey]: treeInsert(children as T[], childrenKey, newNode, parentId)
			} as T;
		}
		return node;
	});
}

export function treeUpdate<T extends object & { id: string }, K extends keyof T>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	id: string,
	updater: (node: T) => T
): T[] {
	if (!nodes || nodes.length === 0) return [];
	return nodes.map((node) => {
		if (node.id === id) return updater(node);
		const children = node[childrenKey];
		if (Array.isArray(children)) {
			return {
				...node,
				[childrenKey]: treeUpdate(children as T[], childrenKey, id, updater)
			} as T;
		}
		return node;
	});
}

export function treeBuildIndex<T extends object, K extends keyof T, V>(
	nodes: readonly T[] | undefined | null,
	childrenKey: K,
	indexer: (node: T) => [string, V] | [string, V][] | null
): Record<string, V> {
	const map: Record<string, V> = {};
	treeWalk(nodes, childrenKey, (node) => {
		const result = indexer(node);
		if (result) {
			if (Array.isArray(result[0])) {
				for (const [key, value] of result as [string, V][]) {
					map[key] = value;
				}
			} else {
				const [key, value] = result as [string, V];
				map[key] = value;
			}
		}
	});
	return map;
}

export interface TreeMapRecordAsyncConfig<TIn, TOut, TCtx> {
	mapNode: (
		node: TIn,
		ctx: TCtx,
		isRoot: boolean
	) => Effect.Effect<Omit<TOut, 'include'>> | Omit<TOut, 'include'>;
	mapChildEntry: (
		key: string,
		child: TIn,
		ctx: TCtx
	) =>
		Effect.Effect<{ key: string; childCtx: TCtx } | null> | { key: string; childCtx: TCtx } | null;
}

const toEffect = <A>(value: A | Effect.Effect<A>): Effect.Effect<A> =>
	Effect.isEffect(value) ? value : Effect.succeed(value);

export function treeMapRecordAsync<TIn extends object, TOut extends object, TCtx>(
	node: TIn,
	childrenKey: keyof TIn & keyof TOut & string,
	config: TreeMapRecordAsyncConfig<TIn, TOut, TCtx>,
	ctx: TCtx,
	isRoot: boolean = true
): Effect.Effect<TOut> {
	return Effect.gen(function* () {
		const mappedNode = yield* toEffect(config.mapNode(node, ctx, isRoot));
		const children = node[childrenKey] as Record<string, TIn> | undefined;

		if (children === undefined) {
			return mappedNode as TOut;
		}

		if (Object.keys(children).length === 0) {
			return {
				...mappedNode,
				[childrenKey]: {}
			} as TOut;
		}

		const mappedChildren: Record<string, TOut> = {};

		// stupidity:allow A6 -- mapping is intentionally depth-first to preserve callback ordering
		for (const [key, child] of Object.entries(children)) {
			const entryResult = yield* toEffect(config.mapChildEntry(key, child as TIn, ctx));
			if (!entryResult) continue;

			const { key: newKey, childCtx } = entryResult;
			const mappedChild = yield* treeMapRecordAsync(
				child as TIn,
				childrenKey,
				config,
				childCtx,
				false
			);
			mappedChildren[newKey] = mappedChild;
		}

		return {
			...mappedNode,
			[childrenKey]: mappedChildren
		} as TOut;
	});
}

export function toAsciiTree(root: string, section: string, items: string[]): string {
	const lines: string[] = [root];
	if (items.length === 0) return lines.join('\n');
	lines.push(`|- ${section}`);
	const lastIndex = items.length - 1;
	for (let i = 0; i < items.length; i++) {
		const prefix = i === lastIndex ? '`- ' : '|- ';
		lines.push(`|   ${prefix}${items[i]}`);
	}
	return lines.join('\n');
}

export function renderTreeAscii<T extends object, K extends keyof T>(
	nodes: T | readonly T[] | undefined | null,
	childrenKey: K,
	formatter: (node: T, depth: number) => string
): string {
	const lines: string[] = [];

	const renderNode = (node: T, depth: number, isLast: boolean, prefix: string): void => {
		const branch = isLast ? '└─ ' : '├─ ';
		const line =
			depth === 0 ? formatter(node, depth) : `${prefix}${branch}${formatter(node, depth)}`;
		lines.push(line);

		const rawChildren = node[childrenKey];
		if (Array.isArray(rawChildren) && (rawChildren as T[]).length > 0) {
			const children = rawChildren as T[];
			const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
			children.forEach((child, index) => {
				renderNode(child, depth + 1, index === children.length - 1, childPrefix);
			});
		}
	};

	const nodeArray = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
	nodeArray.forEach((node, index) => {
		renderNode(node as T, 0, index === nodeArray.length - 1, '');
	});

	return lines.join('\n');
}

interface TreeOptionItem {
	id?: string;
	title?: string;
	metadata?: { description?: string | null };
	children?: TreeOptionItem[];
}

export function flattenTreeOptions<T extends { description?: string | null }>(
	items: (TreeOptionItem & { metadata?: T })[] | undefined
): Map<string, string> {
	const map = new Map<string, string>();
	if (!items) return map;

	const process = (nodes: (TreeOptionItem & { metadata?: T })[]) => {
		for (const node of nodes) {
			if (node.id) {
				const desc = node.metadata?.description || node.title;
				if (desc && desc !== node.id) {
					map.set(node.id, desc);
				}
			}
			if (node.children) {
				process(node.children as (TreeOptionItem & { metadata?: T })[]);
			}
		}
	};
	process(items);
	return map;
}
