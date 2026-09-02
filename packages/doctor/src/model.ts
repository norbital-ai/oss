/**
 * One node model for every front-end. A file is one tree; `inside`/`has` cross languages.
 */
import type { Matcher } from './matcher.js';
import { evaluateFact } from './facts.js';
import ts from 'typescript';

export type Language = 'ts' | 'svelte' | 'css' | 'trivia' | 'sql';

export type Range = Readonly<{ start: number; end: number }>;

export type Node = {
	kind: string;
	field: string | undefined;
	fields: Map<string, Array<Node>>;
	children: Array<Node>;
	parent: Node | undefined;
	text: string;
	range: Range;
	language: Language;
	origin: ts.Node | undefined;
};

export type ModelHost = Readonly<{
	file: string;
	root: string;
	source: ts.SourceFile;
	original: string;
}>;

/** A node's identifier name, when it has one. */
export function nameOf(node: ts.Node): ts.Identifier | undefined {
	const name = Reflect.get(node, 'name');
	if (name === undefined) return undefined;
	return ts.isIdentifier(name as ts.Node) ? (name as ts.Identifier) : undefined;
}

export function createNode(
	kind: string,
	language: Language,
	original: string,
	range: Range,
	origin?: ts.Node
): Node {
	return {
		kind,
		field: undefined,
		fields: new Map(),
		children: [],
		parent: undefined,
		text: original.slice(range.start, range.end),
		range,
		language,
		origin
	};
}

export function attach(parent: Node, child: Node, field?: string): Node {
	child.parent = parent;
	child.field = field;
	parent.children.push(child);
	if (field !== undefined) {
		const held = parent.fields.get(field) ?? [];
		held.push(child);
		parent.fields.set(field, held);
	}
	return child;
}

export function walk(node: Node, visit: (current: Node) => void): void {
	visit(node);
	for (const child of node.children) walk(child, visit);
}

export function lineOf(source: string, offset: number): number {
	let line = 1;
	const end = Math.min(Math.max(offset, 0), source.length);
	for (let index = 0; index < end; index += 1) if (source.charCodeAt(index) === 10) line += 1;
	return line;
}

export function kindMatches(wanted: string, node: Node): boolean {
	const name = wanted.startsWith('ts:') ? wanted.slice(3) : wanted;
	if (name === node.kind || wanted === node.kind) return true;
	if (node.kind.startsWith('ts:') && node.kind.slice(3) === name) return true;
	const origin = node.origin;
	if (origin === undefined || name.includes(':')) return false;
	const numeric = ts.SyntaxKind[name as keyof typeof ts.SyntaxKind];
	return typeof numeric === 'number' && origin.kind === numeric;
}

function ancestors(node: Node): ReadonlyArray<Node> {
	const chain: Array<Node> = [];
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) chain.push(parent);
	return chain;
}

function descendants(node: Node): ReadonlyArray<Node> {
	const found: Array<Node> = [];
	const queue = [...node.children];
	while (queue.length > 0) {
		const current = queue.shift()!;
		found.push(current);
		queue.push(...current.children);
	}
	return found;
}

const NAMESPACED = /^(?:ts|svelte|css|trivia|sql):/;

/** True when a matcher tree names a front-end kind the TypeScript walker cannot see. */
export function hasNamespacedKind(matcher: Matcher): boolean {
	if (typeof matcher === 'string') return false;
	if ('kind' in matcher) return NAMESPACED.test(matcher.kind) && !matcher.kind.startsWith('ts:');
	if ('inside' in matcher) return hasNamespacedKind(matcher.inside);
	if ('has' in matcher) return hasNamespacedKind(matcher.has);
	if ('follows' in matcher) return hasNamespacedKind(matcher.follows);
	if ('precedes' in matcher) return hasNamespacedKind(matcher.precedes);
	if ('not' in matcher) return hasNamespacedKind(matcher.not);
	if ('all' in matcher) return matcher.all.some(hasNamespacedKind);
	if ('any' in matcher) return matcher.any.some(hasNamespacedKind);
	if ('of' in matcher) return matcher.of.some(hasNamespacedKind);
	if ('count' in matcher) return hasNamespacedKind(matcher.count.of);
	if ('fact' in matcher) {
		const fact = matcher.fact as Readonly<Record<string, unknown>>;
		for (const value of Object.values(fact))
			if (value !== null && typeof value === 'object') return hasNamespacedKind(value as Matcher);
	}
	return false;
}

type ModelCompiled = (node: Node, host: ModelHost) => boolean;

function compileModel(matcher: Matcher): ModelCompiled {
	if (typeof matcher === 'string')
		return (node) => node.text.replace(/\s+/g, ' ').trim().includes(matcher.replace(/\s+/g, ' ').trim());
	if ('kind' in matcher) return (node) => kindMatches(matcher.kind, node);
	if ('regex' in matcher) {
		const expression = new RegExp(matcher.regex);
		return (node) => expression.test(node.text);
	}
	if ('inside' in matcher) {
		const inner = compileModel(matcher.inside);
		const stop = matcher.stopBy ?? 'neighbor';
		const field = matcher.field;
		return (node, host) => {
			const chain = ancestors(node);
			const scope = stop === 'neighbor' ? chain.slice(0, 1) : stop === 'end' ? chain : chain;
			return scope.some(
				(parent) =>
					(field === undefined || node.field === field || parent.fields.get(field)?.includes(node)) &&
					inner(parent, host)
			);
		};
	}
	if ('has' in matcher) {
		const inner = compileModel(matcher.has);
		const stop = matcher.stopBy ?? 'neighbor';
		const field = matcher.field;
		return (node, host) => {
			const scope = stop === 'neighbor' ? node.children : descendants(node);
			return scope.some(
				(child) =>
					(field === undefined || child.field === field) && inner(child, host)
			);
		};
	}
	if ('all' in matcher) {
		const parts = matcher.all.map(compileModel);
		return (node, host) => parts.every((part) => part(node, host));
	}
	if ('any' in matcher) {
		const parts = matcher.any.map(compileModel);
		return (node, host) => parts.some((part) => part(node, host));
	}
	if ('not' in matcher) {
		const inner = compileModel(matcher.not);
		return (node, host) => !inner(node, host);
	}
	if ('matches' in matcher) return () => false;
	if ('fact' in matcher) {
		const described = matcher.fact as Readonly<{ name: string }> & Readonly<Record<string, unknown>>;
		const { name, ...params } = described;
		return (node, host) => {
			if (node.origin === undefined && name !== 'enclosingOwnerMatches') return false;
			if (node.origin === undefined) {
				return evaluateFact(name, params, {
					node: host.source,
					source: host.source,
					bindings: new Map(),
					file: host.file,
					root: host.root
				});
			}
			return evaluateFact(name, params, {
				node: node.origin,
				source: host.source,
				bindings: new Map(),
				file: host.file,
				root: host.root
			});
		};
	}
	if ('atLeast' in matcher) {
		const parts = matcher.of.map(compileModel);
		const threshold = matcher.atLeast;
		return (node, host) => {
			const subtree = [node, ...descendants(node)];
			let distinct = 0;
			for (const part of parts) {
				if (subtree.some((candidate) => part(candidate, host))) distinct += 1;
				if (distinct >= threshold) return true;
			}
			return false;
		};
	}
	return () => false;
}

/** Run a matcher against every node of a projected tree; returns the nodes that matched. */
export function matchTree(matcher: Matcher, root: Node, host: ModelHost): ReadonlyArray<Node> {
	const run = compileModel(matcher);
	const found: Array<Node> = [];
	walk(root, (node) => {
		if (run(node, host)) found.push(node);
	});
	return found;
}
