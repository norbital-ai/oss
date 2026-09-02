/**
 * Facts are independently testable: same inputs, one computation, identical answers.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { analyseCrossFile, bindCrossFileIndex } from '../build/cross-file.js';
import { evaluateFact, memoised } from '../build/facts.js';
import '../build/analyses/index.js';

function file(source: string, name = 'src/probe.ts'): ts.SourceFile {
	return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

test('nestingDepth is true at four and false below', () => {
	const deep = file(
		'export function f(a, b, c, d) { if (a) { if (b) { if (c) { if (d) { return 1; } } } } return 0; }'
	);
	const shallow = file('export function f(a) { if (!a) return 0; return 1; }');
	const deepFn = deep.statements[0]!;
	const shallowFn = shallow.statements[0]!;
	const ctx = (node: ts.Node, source: ts.SourceFile) => ({
		node,
		source,
		bindings: new Map(),
		file: source.fileName,
		root: '.'
	});
	assert.equal(evaluateFact('nestingDepth', { atLeast: 4 }, ctx(deepFn, deep)), true);
	assert.equal(evaluateFact('nestingDepth', { atLeast: 4 }, ctx(shallowFn, shallow)), false);
});

test('callSites names a private one-call identity wrapper', () => {
	const source = file(
		'const shim = (input) => bridge(input);\nexport const kickoff = (input) => shim(input);'
	);
	let declaration: ts.Node | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'shim')
			declaration = node;
		ts.forEachChild(node, visit);
	};
	visit(source);
	assert.ok(declaration);
	assert.equal(
		evaluateFact(
			'callSites',
			{ exactly: 1, candidate: 'transparent-forwarder' },
			{ node: declaration, source, bindings: new Map(), file: 'src/probe.ts', root: '.' }
		),
		true
	);
});

test('openDomainIdentifier flags a literal team.name comparison and leaves role alone', () => {
	const source = file(
		'export const canPublish = team.name === "Engineering";\nexport const isAssistant = message.role === "assistant";'
	);
	const ctx = (node: ts.Node) => ({
		node,
		source,
		bindings: new Map(),
		file: source.fileName,
		root: '.'
	});
	const params = {
		shape: 'comparison',
		properties:
			'^(?:name|slug|handle|title|label|displayName|email|username|teamName|collectionName|workspaceName)$',
		entities:
			'^(?:team|teams|collection|collections|workspace|tenant|policy|policies|app|apps|role|group|member|organization|org|project)$'
	};
	const statements = source.statements;
	assert.equal(evaluateFact('openDomainIdentifier', params, ctx(statements[0]!)), false);
	let comparison: ts.Node | undefined;
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && comparison === undefined) comparison = node;
		ts.forEachChild(node, visit);
	};
	visit(statements[0]!);
	assert.ok(comparison);
	assert.equal(evaluateFact('openDomainIdentifier', params, ctx(comparison)), true);
	comparison = undefined;
	visit(statements[1]!);
	assert.ok(comparison);
	assert.equal(evaluateFact('openDomainIdentifier', params, ctx(comparison)), false);
});

function parsed(root: string, file: string, source: string) {
	writeFileSync(join(root, file), source);
	return {
		file,
		source,
		sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	};
}

function factContext(root: string, file: string, node: ts.Node, source: ts.SourceFile) {
	return { node, source, bindings: new Map(), file, root };
}

test('unreferencedModule / unreferencedExport / duplicateBody are repository facts', (context) => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-facts-graph-'));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'package.json'), '{"name":"facts","type":"module","exports":"./src/index.ts"}');
	const shared = `export function summarise(rows: ReadonlyArray<{ amount: number; kind: string }>): string {
	let total = 0;
	const kinds = new Set<string>();
	for (const row of rows) {
		total += row.amount;
		kinds.add(row.kind);
	}
	return \`\${total} across \${kinds.size} kinds\`;
}
`;
	const index = parsed(
		root,
		'src/index.ts',
		`import { used } from './helper.js';
import './other.js';
export const run = (): number => used();
${shared}`
	);
	const helper = parsed(
		root,
		'src/helper.ts',
		`export const used = (): number => 1;
export const orphan = (): number => 3;
`
	);
	const other = parsed(root, 'src/other.ts', shared);
	const orphan = parsed(root, 'src/orphan.ts', 'export const leftover = (): number => 0;\n');
	bindCrossFileIndex(
		root,
		analyseCrossFile({ root, files: [index, helper, other, orphan] })
	);

	const ctx = (file: string, sourceFile: ts.SourceFile, node: ts.Node = sourceFile) =>
		factContext(root, file, node, sourceFile);
	assert.equal(evaluateFact('unreferencedModule', {}, ctx('src/orphan.ts', orphan.sourceFile)), true);
	assert.equal(evaluateFact('unreferencedModule', {}, ctx('src/index.ts', index.sourceFile)), false);
	assert.equal(evaluateFact('unreferencedModule', {}, ctx('src/orphan.ts', orphan.sourceFile)), true);

	let orphanExport: ts.Node | undefined;
	const visitHelper = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'orphan')
			orphanExport = node;
		ts.forEachChild(node, visitHelper);
	};
	visitHelper(helper.sourceFile);
	assert.ok(orphanExport);
	assert.equal(evaluateFact('unreferencedExport', {}, ctx('src/helper.ts', helper.sourceFile, orphanExport)), true);

	let usedExport: ts.Node | undefined;
	const visitUsed = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'used')
			usedExport = node;
		ts.forEachChild(node, visitUsed);
	};
	visitUsed(helper.sourceFile);
	assert.ok(usedExport);
	assert.equal(evaluateFact('unreferencedExport', {}, ctx('src/helper.ts', helper.sourceFile, usedExport)), false);

	let otherFn: ts.Node | undefined;
	const visitOther = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && otherFn === undefined) otherFn = node;
		ts.forEachChild(node, visitOther);
	};
	visitOther(other.sourceFile);
	assert.ok(otherFn);
	assert.equal(evaluateFact('duplicateBody', {}, ctx('src/other.ts', other.sourceFile, otherFn)), true);
	let indexFn: ts.Node | undefined;
	const visitIndex = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && indexFn === undefined) indexFn = node;
		ts.forEachChild(node, visitIndex);
	};
	visitIndex(index.sourceFile);
	assert.ok(indexFn);
	assert.equal(evaluateFact('duplicateBody', {}, ctx('src/index.ts', index.sourceFile, indexFn)), false);
});

test('memoised computes once per host and key', () => {
	const host = {};
	let runs = 0;
	const first = memoised(host, 'k', () => {
		runs += 1;
		return 7;
	});
	const second = memoised(host, 'k', () => {
		runs += 1;
		return 8;
	});
	assert.equal(first, 7);
	assert.equal(second, 7);
	assert.equal(runs, 1);
});
