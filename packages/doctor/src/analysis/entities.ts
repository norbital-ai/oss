import { createHash } from 'node:crypto';
import ts from 'typescript';
import { LANGUAGE_HEALTH_PROFILE } from '../health-profile.js';
import type { Distribution } from './composite.js';
import { distribution, roundedRatio } from './composite.js';

export const GENERIC_CALLS: ReadonlySet<string> = new Set([
	'add', 'at', 'every', 'filter', 'find', 'flatMap', 'forEach', 'get', 'has', 'includes',
	'join', 'map', 'push', 'reduce', 'set', 'slice', 'some', 'sort', 'trim'
]);

const GENERIC_LABEL_WORDS: ReadonlySet<string> = new Set([
	'anonymous', 'build', 'calculate', 'create', 'from', 'get', 'handle', 'load',
	'make', 'of', 'process', 'run', 'set', 'to'
]);

function genericLabelCalls(
	labels: ReadonlyArray<string> = LANGUAGE_HEALTH_PROFILE.genericLabels
): ReadonlySet<string> {
	return new Set([...GENERIC_CALLS, ...labels]);
}

export type PathwayEntity = Readonly<{
	name: string;
	kind: 'function' | 'method' | 'class';
	ownerClassId: string | null;
	line: number;
	cyclomatic: number;
	nesting: number;
	passThrough: boolean;
	hash: string;
	tokens: number;
	shingles: ReadonlyArray<string>;
	overlapBucket?: string;
	file: string;
	concept: string;
	pillar: string;
	rootId: string;
}>;

export type PathwayEntityCore = Omit<PathwayEntity, 'file' | 'concept' | 'pillar' | 'rootId'> & {
	overlapBucket?: string;
};

export type EntityOccurrence = Readonly<{
	id: string;
	file: string;
	entity: string;
	kind: string;
	line: number;
	concept: string;
	pillar: string;
	tokens: number;
	cyclomatic: number;
	nesting: number;
	passThrough: boolean;
	operationSignature: string | null;
}>;

export type DuplicateGroup = Readonly<{
	kind: 'class' | 'callable';
	hash: string;
	occurrences: ReadonlyArray<EntityOccurrence>;
}>;

export type OverlapPair = Readonly<{
	similarity: number;
	operationSignature: string;
	left: EntityOccurrence;
	right: EntityOccurrence;
}>;

export type FunctionalityCluster = Readonly<{
	id: string;
	label: string;
	members: ReadonlyArray<EntityOccurrence>;
	concepts: ReadonlyArray<string>;
	crossConcept: boolean;
	pillars: ReadonlyArray<string>;
	crossPillar: boolean;
	operationSignatures: ReadonlyArray<string>;
	exactRelationships: number;
	overlapRelationships: number;
	overlapDensity: number;
	averageSimilarity: number | null;
	complexity: Readonly<{
		cyclomatic: Distribution;
		nesting: Distribution;
		excessCyclomatic: number;
		totalTokens: number;
	}>;
	colocation: Readonly<{
		sameConceptRelationships: number;
		samePillarRelationships: number;
		samePillarShare: number;
	}>;
	indirection: Readonly<{ passThroughMembers: number; passThroughShare: number }>;
}>;

function rawName(node: ts.Node): ts.Node | undefined {
	return (node as { name?: ts.Node }).name;
}

export function declarationName(node: ts.Node): string {
	const name = rawName(node);
	if (name && ts.isIdentifier(name)) return name.text;
	if (
		(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
		ts.isVariableDeclaration(node.parent) &&
		ts.isIdentifier(node.parent.name)
	)
		return node.parent.name.text;
	return '<anonymous>';
}

export function containingClass(node: ts.Node): ts.ClassDeclaration | ts.ClassExpression | null {
	let current = node.parent;
	while (current) {
		if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
		current = current.parent;
	}
	return null;
}

export function className(node: ts.ClassDeclaration | ts.ClassExpression, file: ts.SourceFile): string {
	const name = rawName(node);
	if (name && ts.isIdentifier(name)) return name.text;
	if (
		ts.isClassExpression(node) &&
		ts.isVariableDeclaration(node.parent) &&
		ts.isIdentifier(node.parent.name)
	)
		return node.parent.name.text;
	return `<class@${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}>`;
}

export function duplicateCallableKind(
	node: ts.Node
): 'function' | 'method' | null {
	if (ts.isFunctionDeclaration(node) && rawName(node)) return 'function';
	if (
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	)
		return 'method';
	if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return null;
	if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return 'function';
	const parent = node.parent as ts.Node;
	if (
		(ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
		rawName(parent)
	)
		return 'method';
	return null;
}

export function duplicateCallableName(node: ts.Node, file: ts.SourceFile): string {
	const owner = containingClass(node);
	const ownerPrefix = owner ? `${className(owner, file)}.` : '';
	if (ts.isConstructorDeclaration(node)) return `${ownerPrefix}constructor`;
	const name = rawName(node);
	if (name) return `${ownerPrefix}${name.getText(file)}`;
	if (
		(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
		(ts.isVariableDeclaration(node.parent) ||
			ts.isPropertyDeclaration(node.parent) ||
			ts.isPropertyAssignment(node.parent))
	)
		return `${ownerPrefix}${node.parent.name.getText(file)}`;
	return declarationName(node);
}

export function pathwayHash(text: string): {
	hash: string;
	tokens: number;
	shingles: Array<string>;
} | undefined {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
	const exactTokens: Array<string> = [];
	const structuralTokens: Array<string> = [];
	let previousToken = ts.SyntaxKind.Unknown;
	for (
		let token = scanner.scan();
		token !== ts.SyntaxKind.EndOfFileToken;
		token = scanner.scan()
	) {
		if (token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.PrivateIdentifier) {
			const identifier = scanner.getTokenText();
			const normalized =
				previousToken === ts.SyntaxKind.DotToken ? `$member:${identifier}` : '$id';
			exactTokens.push(normalized);
			structuralTokens.push(normalized);
		} else if (
			token === ts.SyntaxKind.StringLiteral ||
			token === ts.SyntaxKind.NumericLiteral ||
			token === ts.SyntaxKind.BigIntLiteral ||
			token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
			token === ts.SyntaxKind.RegularExpressionLiteral ||
			token === ts.SyntaxKind.TemplateHead ||
			token === ts.SyntaxKind.TemplateMiddle ||
			token === ts.SyntaxKind.TemplateTail
		) {
			exactTokens.push(`$lit:${scanner.getTokenText()}`);
			structuralTokens.push('$lit');
		} else {
			const normalized = ts.tokenToString(token) ?? String(token);
			exactTokens.push(normalized);
			structuralTokens.push(normalized);
		}
		previousToken = token;
	}
	if (structuralTokens.length < 40) return undefined;
	const shingles = new Set<string>();
	for (let index = 0; index <= structuralTokens.length - 5; index += 1) {
		shingles.add(
			createHash('sha256')
				.update(structuralTokens.slice(index, index + 5).join(' '))
				.digest('hex')
				.slice(0, 16)
		);
	}
	return {
		hash: createHash('sha256').update(exactTokens.join(' ')).digest('hex').slice(0, 20),
		tokens: structuralTokens.length,
		shingles: [...shingles].sort()
	};
}

export function classPathway(
	node: ts.ClassDeclaration | ts.ClassExpression,
	file: ts.SourceFile
): { hash: string; tokens: number; shingles: Array<string> } | undefined {
	const pathway = pathwayHash(node.members.map((member) => member.getText(file)).join('\n'));
	if (!pathway) return undefined;
	const publicShape = node.members
		.map((member) =>
			ts.isConstructorDeclaration(member)
				? 'constructor'
				: `${ts.SyntaxKind[member.kind]}:${rawName(member)?.getText(file) ?? '<anonymous>'}`
		)
		.join('|');
	return {
		...pathway,
		hash: createHash('sha256').update(`${publicShape}\0${pathway.hash}`).digest('hex').slice(0, 20)
	};
}

export function overlapProfile(body: ts.Node): { overlapBucket: string } | undefined {
	const calls = new Map<string, number>();
	const controls = new Map<string, number>();
	const visit = (node: ts.Node, root: ts.Node): void => {
		if (node !== root && ts.isFunctionLike(node)) return;
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const callee = node.expression;
			const name = ts.isIdentifier(callee)
				? callee.text
				: ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
						? callee.argumentExpression.text
						: null;
			if (name && !GENERIC_CALLS.has(name)) calls.set(name, (calls.get(name) ?? 0) + 1);
		}
		const control =
			ts.isIfStatement(node) || ts.isConditionalExpression(node)
				? 'if'
				: ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
					? 'for'
					: ts.isWhileStatement(node) || ts.isDoStatement(node)
						? 'while'
						: ts.isSwitchStatement(node)
							? 'switch'
							: ts.isTryStatement(node)
								? 'try'
								: null;
		if (control) controls.set(control, (controls.get(control) ?? 0) + 1);
		ts.forEachChild(node, (child) => visit(child, root));
	};
	visit(body, body);
	if (calls.size < 2) return undefined;
	const encode = (entries: Iterable<[string, number]>): string =>
		[...entries]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, count]) => `${key}:${count}`)
			.join(',');
	return { overlapBucket: `${encode(calls)}|${encode(controls)}` };
}

export function shingleSimilarity(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
	let leftIndex = 0;
	let rightIndex = 0;
	let intersection = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const order = (left[leftIndex] ?? '').localeCompare(right[rightIndex] ?? '');
		if (order === 0) {
			intersection += 1;
			leftIndex += 1;
			rightIndex += 1;
		} else if (order < 0) leftIndex += 1;
		else rightIndex += 1;
	}
	return intersection / Math.max(left.length + right.length - intersection, 1);
}

function operationCalls(
	signature: string | null | undefined,
	labels: ReadonlyArray<string>
): Array<[string, number]> {
	if (!signature) return [];
	const generic = genericLabelCalls(labels);
	return (signature.split('|', 1)[0] ?? '')
		.split(',')
		.map((item) => /^(.+):(\d+)$/.exec(item))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match): [string, number] => [match[1] ?? '', Number(match[2] ?? '')])
		.filter(([name]) => !generic.has(name));
}

export function clusterLabel(
	members: ReadonlyArray<EntityOccurrence>,
	labels: ReadonlyArray<string> = LANGUAGE_HEALTH_PROFILE.genericLabels
): string {
	const calls = new Map<string, number>();
	for (const member of members)
		for (const [name, count] of operationCalls(member.operationSignature, labels))
			calls.set(name, (calls.get(name) ?? 0) + count);
	const rankedCalls = [...calls]
		.sort(
			([leftName, leftCount], [rightName, rightCount]) =>
				rightCount - leftCount || leftName.localeCompare(rightName)
		)
		.slice(0, 3)
		.map(([name]) => name);
	if (rankedCalls.length) return `calls: ${rankedCalls.join(' + ')}`;
	const words = new Map<string, number>();
	for (const member of members)
		for (const word of member.entity
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.split(/[^A-Za-z0-9]+/)
			.map((item) => item.toLowerCase())
			.filter((item) => item.length > 1 && !GENERIC_LABEL_WORDS.has(item)))
			words.set(word, (words.get(word) ?? 0) + 1);
	const rankedWords = [...words]
		.sort(
			([leftWord, leftCount], [rightWord, rightCount]) =>
				rightCount - leftCount || leftWord.localeCompare(rightWord)
		)
		.slice(0, 3)
		.map(([word]) => word);
	return rankedWords.length
		? `functions: ${rankedWords.join(' + ')}`
		: 'structurally duplicated pathway';
}

export function clusterPathways(
	exact: ReadonlyArray<DuplicateGroup>,
	overlapping: ReadonlyArray<OverlapPair>,
	labels: ReadonlyArray<string> = LANGUAGE_HEALTH_PROFILE.genericLabels
): Array<FunctionalityCluster> {
	const nodes = new Map<string, EntityOccurrence>();
	const parents = new Map<string, string>();
	const exactEdges = new Map<string, { left: string; right: string }>();
	const overlapEdges = new Map<string, { left: string; right: string; similarity: number }>();
	const register = (occurrence: EntityOccurrence): void => {
		nodes.set(occurrence.id, occurrence);
		if (!parents.has(occurrence.id)) parents.set(occurrence.id, occurrence.id);
	};
	const find = (id: string): string => {
		let root = id;
		while (parents.get(root) !== root) root = parents.get(root) ?? root;
		while (parents.get(id) !== id) {
			const next = parents.get(id) ?? id;
			parents.set(id, root);
			id = next;
		}
		return root;
	};
	const unite = (left: string, right: string): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return;
		const [first, second] = [leftRoot, rightRoot].sort();
		parents.set(second ?? '', first ?? '');
	};
	const edgeKey = (left: string, right: string): string => [left, right].sort().join('\0');
	for (const group of exact) {
		for (const occurrence of group.occurrences) register(occurrence);
		for (let left = 0; left < group.occurrences.length; left += 1)
			for (let right = left + 1; right < group.occurrences.length; right += 1) {
				const leftId = group.occurrences[left]?.id ?? '';
				const rightId = group.occurrences[right]?.id ?? '';
				exactEdges.set(edgeKey(leftId, rightId), { left: leftId, right: rightId });
				unite(leftId, rightId);
			}
	}
	for (const relationship of overlapping) {
		register(relationship.left);
		register(relationship.right);
		const key = edgeKey(relationship.left.id, relationship.right.id);
		overlapEdges.set(key, {
			left: relationship.left.id,
			right: relationship.right.id,
			similarity: relationship.similarity
		});
		unite(relationship.left.id, relationship.right.id);
	}
	const grouped = new Map<string, Array<EntityOccurrence>>();
	for (const [id, occurrence] of nodes) {
		const root = find(id);
		const members = grouped.get(root) ?? [];
		members.push(occurrence);
		grouped.set(root, members);
	}
	const clusters: Array<FunctionalityCluster> = [];
	for (const members of grouped.values()) {
		members.sort(
			(left, right) =>
				left.file.localeCompare(right.file) ||
				left.line - right.line ||
				left.entity.localeCompare(right.entity)
		);
		const memberIds = new Set(members.map(({ id }) => id));
		const ownedExact = [...exactEdges.values()].filter(
			(edge) => memberIds.has(edge.left) && memberIds.has(edge.right)
		);
		const ownedOverlaps = [...overlapEdges.values()].filter(
			(edge) => memberIds.has(edge.left) && memberIds.has(edge.right)
		);
		const relationshipCount = ownedExact.length + ownedOverlaps.length;
		const relationships = [...ownedExact, ...ownedOverlaps];
		const possibleRelationships = (members.length * (members.length - 1)) / 2;
		const similarities = ownedOverlaps.map(({ similarity }) => similarity);
		const concepts = [...new Set(members.map(({ concept }) => concept))].sort();
		const pillars = [...new Set(members.map(({ pillar }) => pillar))].sort();
		const operationSignatures = [
			...new Set(
				members
					.map(({ operationSignature }) => operationSignature)
					.filter((signature): signature is string => Boolean(signature))
			)
		].sort();
		const identity = members
			.map(({ id }) => id)
			.sort()
			.join('\0');
		const samePillar = relationships.filter(
			({ left, right }) => nodes.get(left)?.pillar === nodes.get(right)?.pillar
		).length;
		const passThroughMembers = members.filter(({ passThrough }) => passThrough).length;
		clusters.push({
			id: createHash('sha256').update(identity).digest('hex').slice(0, 12),
			label: clusterLabel(members, labels),
			members,
			concepts,
			crossConcept: concepts.length > 1,
			pillars,
			crossPillar: pillars.length > 1,
			operationSignatures,
			exactRelationships: ownedExact.length,
			overlapRelationships: ownedOverlaps.length,
			overlapDensity:
				possibleRelationships === 0
					? 0
					: Math.round((relationshipCount / possibleRelationships) * 1_000_000) / 1_000_000,
			averageSimilarity:
				similarities.length === 0
					? null
					: Math.round(
							(similarities.reduce((sum, value) => sum + value, 0) / similarities.length) *
								1_000_000
						) / 1_000_000,
			complexity: {
				cyclomatic: distribution(members.map(({ cyclomatic }) => cyclomatic)),
				nesting: distribution(members.map(({ nesting }) => nesting)),
				excessCyclomatic: members.reduce(
					(sum, { cyclomatic }) => sum + Math.max(0, cyclomatic - 1),
					0
				),
				totalTokens: members.reduce((sum, { tokens }) => sum + tokens, 0)
			},
			colocation: {
				sameConceptRelationships: relationships.filter(
					({ left, right }) => nodes.get(left)?.concept === nodes.get(right)?.concept
				).length,
				samePillarRelationships: samePillar,
				samePillarShare: roundedRatio(samePillar, relationshipCount)
			},
			indirection: {
				passThroughMembers,
				passThroughShare: roundedRatio(passThroughMembers, members.length)
			}
		});
	}
	return clusters.sort(
		(left, right) =>
			right.members.length - left.members.length ||
			Number(right.crossConcept) - Number(left.crossConcept) ||
			left.label.localeCompare(right.label) ||
			left.id.localeCompare(right.id)
	);
}

export function pathwayEvidence(
	entities: ReadonlyArray<PathwayEntity>,
	labels: ReadonlyArray<string> = LANGUAGE_HEALTH_PROFILE.genericLabels
): {
	exact: Array<DuplicateGroup>;
	overlapping: Array<OverlapPair>;
	clusters: Array<FunctionalityCluster>;
} {
	const exactBuckets = new Map<string, Array<PathwayEntity>>();
	for (const item of entities)
		if (item.hash) {
			const family = item.kind === 'class' ? 'class' : 'callable';
			const key = `${item.rootId}\0${family}\0${item.hash}`;
			const group = exactBuckets.get(key) ?? [];
			group.push(item);
			exactBuckets.set(key, group);
		}
	const duplicatedClassOwners = new Set(
		[...exactBuckets.values()]
			.filter(
				(group) =>
					group[0]?.kind === 'class' && new Set(group.map((item) => item.file)).size > 1
			)
			.flatMap((group) => group.map(({ ownerClassId }) => ownerClassId))
	);
	const eligible = entities.filter(
		(item) => !(item.kind === 'method' && duplicatedClassOwners.has(item.ownerClassId))
	);
	const occurrence = (item: PathwayEntity): EntityOccurrence => ({
		id: createHash('sha256')
			.update(`${item.rootId}\0${item.file}\0${item.line}\0${item.kind}\0${item.name}`)
			.digest('hex')
			.slice(0, 16),
		file: item.file,
		entity: item.name,
		kind: item.kind,
		line: item.line,
		concept: item.concept,
		pillar: item.pillar,
		tokens: item.tokens,
		cyclomatic: item.cyclomatic,
		nesting: item.nesting,
		passThrough: item.passThrough === true,
		operationSignature: item.overlapBucket ?? null
	});
	const eligibleIds = new Set(
		eligible.map((item) => `${item.rootId}\0${item.file}\0${item.line}\0${item.kind}\0${item.name}`)
	);
	const exact: Array<DuplicateGroup> = [...exactBuckets.entries()]
		.map(([key, group]): [string, Array<PathwayEntity>] => [
			key,
			group.filter((item) =>
				eligibleIds.has(`${item.rootId}\0${item.file}\0${item.line}\0${item.kind}\0${item.name}`)
			)
		])
		.filter(([, group]) => new Set(group.map((item) => item.file)).size > 1)
		.map(([key, group]): DuplicateGroup => ({
			kind: group[0]?.kind === 'class' ? 'class' : 'callable',
			hash: key.split('\0').at(-1) ?? '',
			occurrences: group
				.map(occurrence)
				.sort(
					(a, b) =>
						a.file.localeCompare(b.file) || a.line - b.line || a.entity.localeCompare(b.entity)
				)
		}))
		.sort((a, b) => a.hash.localeCompare(b.hash));

	const indexed = new Map<string, Array<PathwayEntity>>();
	for (const item of eligible) {
		if (item.tokens < 60 || !item.overlapBucket || !item.shingles?.length) continue;
		const key = `${item.rootId}\0${item.overlapBucket}`;
		const group = indexed.get(key) ?? [];
		group.push(item);
		indexed.set(key, group);
	}
	const overlapping: Array<OverlapPair> = [];
	for (const group of indexed.values()) {
		group.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
		for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1)
			for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
				const left = group[leftIndex];
				const right = group[rightIndex];
				if (!left || !right) continue;
				if (left.file === right.file || left.hash === right.hash) continue;
				const sizeRatio = Math.min(left.tokens, right.tokens) / Math.max(left.tokens, right.tokens);
				if (sizeRatio < 0.85) continue;
				const similarity = shingleSimilarity(left.shingles, right.shingles);
				if (similarity < 0.88) continue;
				overlapping.push({
					similarity: Math.round(similarity * 1_000_000) / 1_000_000,
					operationSignature: left.overlapBucket ?? '',
					left: occurrence(left),
					right: occurrence(right)
				});
			}
	}
	overlapping.sort(
		(a, b) =>
			b.similarity - a.similarity ||
			a.left.file.localeCompare(b.left.file) ||
			a.left.line - b.left.line ||
			a.right.file.localeCompare(b.right.file) ||
			a.right.line - b.right.line
	);
	return { exact, overlapping, clusters: clusterPathways(exact, overlapping, labels) };
}
