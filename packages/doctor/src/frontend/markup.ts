/**
 * Svelte/HTML markup as nodes, plus the TypeScript, CSS, trivia and SQL projections it hosts.
 * Class tokens, directives and interpolations are first-class.
 */
import ts from 'typescript';
import { attach, createNode, walk, type Node } from '../model.js';

const TAG_NAME = /^<([A-Za-z][\w:.-]*)/;
const CLOSE = /^<\/([A-Za-z][\w:.-]*)>/;
const ATTR =
	/([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([\s\S]*?)\}|(\S+)))?/g;
const INTERPOLATION = /\{(?![:#@/])([\s\S]*?)\}/g;
const BLOCK = /\{([#:/@][\s\S]*?)\}/g;
const COMMENT = /<!--([\s\S]*?)-->/g;
const REGION = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;
const CSS_DECLARATION = /([a-zA-Z-]+)\s*:\s*([^;]+);?/g;
const RAW_SQL =
	/\b(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*\bSET\b|DELETE\s+FROM\b|MERGE\s+INTO\b|TRUNCATE\s+(?:TABLE\s+)?(?:"[\w$]+"|'[\w$]+'|[\w$]+)|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|SCHEMA|TRIGGER|FUNCTION|POLICY|EXTENSION|VIEW)\b|ALTER\s+(?:TABLE|POLICY|VIEW)\b|DROP\s+(?:TABLE|INDEX|SCHEMA|TRIGGER|FUNCTION|POLICY|EXTENSION|VIEW)\b|BEGIN\b|COMMIT\b|ROLLBACK\b|START\s+TRANSACTION\b|SAVEPOINT\b)/i;
const SQL_VERB =
	/^(\s*)(SELECT|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|START|SAVEPOINT)\b/i;
const TRIVIA =
	/<!--([\s\S]*?)-->|\/\*([\s\S]*?)\*\/|\/\/([^\n]*)/g;
const NOT_A_FIELD: ReadonlySet<string> = new Set([
	'parent',
	'original',
	'symbol',
	'locals',
	'nextContainer',
	'flowNode',
	'emitNode',
	'jsDoc',
	'jsDocCache'
]);
const STATEMENT = new Set([
	'VariableStatement',
	'FunctionDeclaration',
	'ExpressionStatement',
	'ReturnStatement',
	'ClassDeclaration',
	'MethodDeclaration',
	'TypeAliasDeclaration',
	'InterfaceDeclaration'
]);

/** End of a start tag, ignoring `>` that lives inside quotes or `{...}` (arrow functions). */
function tagClose(source: string, from: number): number {
	let quote: '"' | "'" | undefined;
	let depth = 0;
	for (let index = from; index < source.length; index += 1) {
		const ch = source[index]!;
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '{') {
			depth += 1;
			continue;
		}
		if (ch === '}' && depth > 0) {
			depth -= 1;
			continue;
		}
		if (ch === '>' && depth === 0) return index;
	}
	return -1;
}

function covered(intervals: ReadonlyArray<Readonly<{ start: number; end: number }>>, index: number): boolean {
	return intervals.some((span) => index >= span.start && index < span.end);
}

function parseClassTokens(parent: Node, original: string, start: number, value: string): void {
	const pattern = /[^\s]+/g;
	for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
		if (match[0]?.startsWith('{')) continue;
		const at = start + match.index;
		attach(
			parent,
			createNode('svelte:ClassToken', 'svelte', original, { start: at, end: at + match[0].length }),
			'tokens'
		);
	}
}

function parseAttributes(element: Node, original: string, start: number, raw: string): void {
	ATTR.lastIndex = 0;
	for (let match = ATTR.exec(raw); match !== null; match = ATTR.exec(raw)) {
		const name = match[1] ?? '';
		const at = start + match.index;
		const end = at + match[0].length;
		const quoted = match[2] ?? match[3];
		const interp = match[4];
		if (name.startsWith('class:') || name.includes(':')) {
			const directive = attach(
				element,
				createNode('svelte:Directive', 'svelte', original, { start: at, end }),
				'directives'
			);
			if (name.startsWith('class:')) {
				const token = name.slice(6);
				const tokenAt = at + name.indexOf(token);
				attach(
					directive,
					createNode('svelte:ClassToken', 'svelte', original, {
						start: tokenAt,
						end: tokenAt + token.length
					}),
					'tokens'
				);
			}
			continue;
		}
		const attribute = attach(
			element,
			createNode('svelte:Attribute', 'svelte', original, { start: at, end }),
			'attributes'
		);
		attribute.fields.set('name', [
			createNode('svelte:Name', 'svelte', original, { start: at, end: at + name.length })
		]);
		if (name === 'class' && quoted !== undefined) {
			const valueAt = original.indexOf(quoted, at);
			parseClassTokens(attribute, original, valueAt >= 0 ? valueAt : at, quoted);
		}
		if (name === 'style' && quoted !== undefined) {
			for (const declaration of quoted.split(';')) {
				const trimmed = declaration.trim();
				if (trimmed === '') continue;
				const declAt = original.indexOf(trimmed, at);
				if (declAt >= 0)
					attach(
						attribute,
						createNode('svelte:StyleProperty', 'svelte', original, {
							start: declAt,
							end: declAt + trimmed.length
						}),
						'style'
					);
			}
		}
		if (interp !== undefined) {
			const interpAt = original.indexOf(`{${interp}`, at);
			attach(
				attribute,
				createNode('svelte:Interpolation', 'svelte', original, {
					start: interpAt >= 0 ? interpAt : at,
					end: (interpAt >= 0 ? interpAt : at) + interp.length + 2
				}),
				'value'
			);
		}
	}
}

function fieldOf(parent: ts.Node, child: ts.Node): string | undefined {
	for (const [key, value] of Object.entries(parent)) {
		if (NOT_A_FIELD.has(key)) continue;
		if (value === child) return key;
		if (Array.isArray(value) && value.includes(child)) return key;
	}
	return undefined;
}

function projectTs(node: ts.Node, source: ts.SourceFile, original: string, offset: number): Node {
	const start = offset + node.getStart(source);
	const end = offset + node.getEnd();
	const model = createNode(ts.SyntaxKind[node.kind] ?? 'Unknown', 'ts', original, { start, end }, node);
	ts.forEachChild(node, (child) => {
		attach(model, projectTs(child, source, original, offset), fieldOf(node, child));
	});
	return model;
}

function followingDeclaration(root: Node, after: number): Node | undefined {
	let best: Node | undefined;
	walk(root, (node) => {
		if (node.language !== 'ts' || node.range.start < after) return;
		const origin = node.origin;
		const named =
			STATEMENT.has(node.kind) ||
			(origin !== undefined &&
				(ts.isVariableStatement(origin) ||
					ts.isFunctionDeclaration(origin) ||
					ts.isExpressionStatement(origin) ||
					ts.isReturnStatement(origin) ||
					ts.isClassDeclaration(origin) ||
					ts.isMethodDeclaration(origin) ||
					ts.isTypeAliasDeclaration(origin) ||
					ts.isInterfaceDeclaration(origin)));
		if (!named) return;
		if (best === undefined || node.range.start < best.range.start) best = node;
	});
	return best;
}

function attachTrivia(root: Node, original: string, from = 0, to = original.length): void {
	TRIVIA.lastIndex = from;
	for (let match = TRIVIA.exec(original); match !== null && match.index < to; match = TRIVIA.exec(original)) {
		const start = match.index;
		const end = start + match[0].length;
		const html = match[1] !== undefined;
		const block = match[2] !== undefined;
		const kind = html ? 'trivia:HtmlComment' : block ? 'trivia:BlockComment' : 'trivia:LineComment';
		const comment = createNode(kind, 'trivia', original, { start, end });
		if (block && /^\s*\*/.test(match[2] ?? '')) {
			comment.kind = 'trivia:JSDoc';
			for (const tag of match[2]?.matchAll(/@([A-Za-z][\w-]*)/g) ?? []) {
				const tagStart = start + (match[0].indexOf(tag[0]) >= 0 ? match[0].indexOf(tag[0]) : 0);
				attach(
					comment,
					createNode('trivia:JSDocTag', 'trivia', original, {
						start: tagStart,
						end: tagStart + (tag[1]?.length ?? 0) + 1
					}),
					'tags'
				);
			}
		}
		attach(followingDeclaration(root, end) ?? root, comment, 'trivia');
	}
	walk(root, (node) => {
		const origin = node.origin;
		if (origin === undefined) return;
		for (const tag of ts.getJSDocTags(origin)) {
			const start = tag.getStart();
			const end = tag.getEnd();
			if (node.children.some((child) => child.kind === 'trivia:JSDocTag' && child.range.start === start))
				continue;
			attach(
				node,
				createNode('trivia:JSDocTag', 'trivia', original, { start, end }, tag),
				'jsDocTags'
			);
		}
	});
}

function isTaggedSql(node: ts.Node): boolean {
	const parent = node.parent;
	return (
		parent !== undefined &&
		ts.isTaggedTemplateExpression(parent) &&
		parent.template === node &&
		parent.tag.getText() === 'sql'
	);
}

function attachSql(root: Node, original: string): void {
	walk(root, (node) => {
		if (node.language === 'sql' || node.fields.has('sql')) return;
		const origin = node.origin;
		if (origin === undefined) return;
		if (
			!(
				ts.isStringLiteral(origin) ||
				ts.isNoSubstitutionTemplateLiteral(origin) ||
				ts.isTemplateExpression(origin)
			)
		)
			return;
		const text = node.text.replace(/^[\s'"`]+|[\s'"`]+$/g, '');
		if (!RAW_SQL.test(text) && !isTaggedSql(origin)) return;
		const statement = createNode('sql:Statement', 'sql', original, node.range, origin);
		const verb = SQL_VERB.exec(text);
		if (verb?.[2] !== undefined) {
			const at = node.range.start + node.text.indexOf(verb[2]);
			attach(
				statement,
				createNode('sql:Verb', 'sql', original, { start: at, end: at + verb[2].length }, origin),
				'verb'
			);
		}
		attach(node, statement, 'sql');
	});
}

function projectStyle(original: string, span: Readonly<{ start: number; end: number }>): Node {
	const root = createNode('css:StyleSheet', 'css', original, span);
	const body = original.slice(span.start, span.end);
	CSS_RULE.lastIndex = 0;
	for (let match = CSS_RULE.exec(body); match !== null; match = CSS_RULE.exec(body)) {
		const ruleStart = span.start + match.index;
		const ruleEnd = ruleStart + match[0].length;
		const rule = attach(root, createNode('css:Rule', 'css', original, { start: ruleStart, end: ruleEnd }), 'rules');
		const selectorText = match[1] ?? '';
		attach(
			rule,
			createNode('css:Selector', 'css', original, {
				start: ruleStart,
				end: ruleStart + selectorText.length
			}),
			'selector'
		);
		const block = match[2] ?? '';
		const blockStart = ruleStart + (match[0].indexOf('{') + 1);
		CSS_DECLARATION.lastIndex = 0;
		for (
			let declaration = CSS_DECLARATION.exec(block);
			declaration !== null;
			declaration = CSS_DECLARATION.exec(block)
		) {
			const at = blockStart + declaration.index;
			const end = at + declaration[0].length;
			const node = attach(
				rule,
				createNode('css:Declaration', 'css', original, { start: at, end }),
				'declarations'
			);
			const property = declaration[1] ?? '';
			attach(
				node,
				createNode('css:Property', 'css', original, { start: at, end: at + property.length }),
				'property'
			);
			const value = declaration[2]?.trim() ?? '';
			const valueAt = original.indexOf(value, at);
			if (valueAt >= 0)
				attach(
					node,
					createNode('css:Value', 'css', original, { start: valueAt, end: valueAt + value.length }),
					'value'
				);
		}
	}
	return root;
}

function projectScript(
	original: string,
	file: string,
	span?: Readonly<{ start: number; end: number }>
): Node {
	const start = span?.start ?? 0;
	const end = span?.end ?? original.length;
	const body = original.slice(start, end);
	const scriptKind = file.endsWith('.tsx')
		? ts.ScriptKind.TSX
		: file.endsWith('.jsx')
			? ts.ScriptKind.JSX
			: /\.(?:m|c)?js$/.test(file)
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, scriptKind);
	const root = projectTs(source, source, original, start);
	attachTrivia(root, original, start, end);
	attachSql(root, original);
	return root;
}

export function projectMarkup(original: string, file: string): Node {
	const root = createNode('svelte:Component', 'svelte', original, { start: 0, end: original.length });
	const skipped: Array<{ start: number; end: number }> = [];
	REGION.lastIndex = 0;
	for (let match = REGION.exec(original); match !== null; match = REGION.exec(original)) {
		const start = match.index;
		const end = start + match[0].length;
		skipped.push({ start, end });
		const innerStart = start + match[0].indexOf(match[3] ?? '');
		const innerEnd = innerStart + (match[3]?.length ?? 0);
		if ((match[1] ?? '').toLowerCase() === 'script') {
			attach(root, projectScript(original, file, { start: innerStart, end: innerEnd }), 'script');
		} else {
			attach(root, projectStyle(original, { start: innerStart, end: innerEnd }), 'style');
		}
	}
	COMMENT.lastIndex = 0;
	for (let match = COMMENT.exec(original); match !== null; match = COMMENT.exec(original)) {
		if (covered(skipped, match.index)) continue;
		const start = match.index;
		const end = start + match[0].length;
		skipped.push({ start, end });
		attach(root, createNode('trivia:HtmlComment', 'trivia', original, { start, end }), 'trivia');
	}
	const stack: Array<Node> = [root];
	let cursor = 0;
	while (cursor < original.length) {
		if (covered(skipped, cursor)) {
			const span = skipped.find((item) => cursor >= item.start && cursor < item.end);
			cursor = span?.end ?? cursor + 1;
			continue;
		}
		if (original.startsWith('</', cursor)) {
			const close = CLOSE.exec(original.slice(cursor));
			if (close) {
				cursor += close[0].length;
				if (stack.length > 1) stack.pop();
				continue;
			}
		}
		const tag = TAG_NAME.exec(original.slice(cursor));
		if (tag !== null) {
			const name = tag[1] ?? '';
			const nameEnd = cursor + tag[0].length;
			const closeAt = tagClose(original, nameEnd);
			if (closeAt >= 0) {
				const start = cursor;
				const end = closeAt + 1;
				const raw = original.slice(nameEnd, closeAt);
				const selfClosing = raw.endsWith('/');
				const attrs = selfClosing ? raw.slice(0, -1) : raw;
				const element = attach(
					stack[stack.length - 1]!,
					createNode('svelte:Element', 'svelte', original, { start, end }),
					'children'
				);
				attach(
					element,
					createNode('svelte:Name', 'svelte', original, {
						start: start + 1,
						end: start + 1 + name.length
					}),
					'tagName'
				);
				parseAttributes(element, original, nameEnd, attrs);
				if (!selfClosing) stack.push(element);
				cursor = end;
				continue;
			}
		}
		if (original[cursor] === '{') {
			BLOCK.lastIndex = cursor;
			INTERPOLATION.lastIndex = cursor;
			const block = BLOCK.exec(original);
			const interp = INTERPOLATION.exec(original);
			const next =
				block !== null && block.index === cursor
					? block
					: interp !== null && interp.index === cursor
						? interp
						: null;
			if (next !== null) {
				const kind = next === block ? 'svelte:Block' : 'svelte:Interpolation';
				attach(
					stack[stack.length - 1]!,
					createNode(kind, 'svelte', original, {
						start: cursor,
						end: cursor + next[0].length
					}),
					next === block ? 'blocks' : 'text'
				);
				cursor += next[0].length;
				continue;
			}
		}
		cursor += 1;
	}
	return root;
}

export function projectFile(file: string, source: string): Node {
	return file.endsWith('.svelte') ? projectMarkup(source, file) : projectScript(source, file);
}
