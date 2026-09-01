import { parse } from 'svelte/compiler';
import { Result, Schema } from 'effect';
import ts from 'typescript';
import { SYSTEM_COLUMN_NAMES } from '../authoring/system-row-model.js';

export const forbiddenBoltDependencies = [
	'@norbital-ai/pod',
	/*
	 * The whole package, not just `/runtime`.
	 *
	 * The narrower entry read as a ban and was not one: `forbidden` matches a root or a subpath of
	 * it, so `@norbital-ai/platform-utils/collection` sailed past — which is how a Bolt test came to
	 * import the collection contract from a package Bolt does not declare, resolving only through
	 * pnpm's workspace hoisting. The contract now lives in `@norbital-ai/std/collection`, so nothing
	 * in Bolt needs any part of platform-utils and the ban can say what it meant.
	 */
	'@norbital-ai/platform-utils',
	'@norbital-ai/bolt-server',
	'@norbital-ai/core',
	'@norbital-ai/colony'
] as const;

const forbiddenProviderDependencies = ['openai', 'pg', '@aws-sdk', '@slack', 'stripe'] as const;

const AstNode = Schema.Record(Schema.String, Schema.Unknown);
const isAstNode = Schema.is(AstNode);
const decodeAstNode = Schema.decodeUnknownResult(AstNode);

/**
 * Host surfaces Bolt must not open for itself.
 *
 * Bolt describes a workspace; a host runs it. Importing a listener, a process supervisor, or a raw
 * socket is how that inverts — not by naming Colony, which the dependency list already catches, but
 * by quietly growing a second host inside the neutral package. These are the modules such an
 * implementation cannot avoid.
 */
const forbiddenHostModules = [
	'node:http',
	'node:https',
	'node:http2',
	'node:net',
	'node:cluster',
	'node:child_process',
	'node:worker_threads',
	'ws'
] as const;

export type AuditFinding = Readonly<{ readonly file: string; readonly dependency: string }>;

/** Owns TypeScript dependency extraction and boundary classification for architecture tests. */
const DependencyAudit = {
	moduleSpecifiers: (file: string, source: string): ReadonlyArray<string> => {
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const dependencies: Array<string> = [];
		const visitor = {
			visit: (node: ts.Node): void => {
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier !== undefined &&
					ts.isStringLiteral(node.moduleSpecifier)
				)
					dependencies.push(node.moduleSpecifier.text);
				if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
					const argument = node.arguments[0];
					if (argument !== undefined && ts.isStringLiteral(argument))
						dependencies.push(argument.text);
				}
				ts.forEachChild(node, visitor.visit);
			}
		};
		visitor.visit(sourceFile);
		return dependencies;
	},
	forbidden: (dependency: string): string | undefined => {
		for (const root of forbiddenBoltDependencies)
			if (dependency === root || dependency.startsWith(`${root}/`)) return root;
		for (const root of forbiddenProviderDependencies)
			if (dependency === root || dependency.startsWith(`${root}/`)) return root;
		for (const root of forbiddenHostModules)
			if (dependency === root || dependency.startsWith(`${root}/`)) return root;
		return undefined;
	},
	/**
	 * Reads ambient host configuration back out of the source.
	 *
	 * Matched on the syntax tree rather than the text: `process.env` in a comment explaining why Bolt
	 * does not read it should not fail the audit, and a source-text scan cannot tell the two apart.
	 */
	readsAmbientEnvironment: (file: string, source: string): boolean => {
		const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		let found = false;
		const visit = (node: ts.Node): void => {
			if (found) return;
			if (
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'process' &&
				node.name.text === 'env'
			) {
				found = true;
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		return found;
	}
};

export type SystemColumnFinding = Readonly<{
	readonly file: string;
	readonly line: number;
	readonly component: string;
	readonly prop: string;
	readonly column: string;
}>;

/**
 * Authored source handing a framework-owned system-column value back to a framework component.
 *
 * The rule is not "authored code may not name a system column" — it may, and must. A workspace
 * decides what "live" means by filtering on `approval_id`, lists key on `id`, and
 * reports order by `created_at`. Those spell a column *name* into a query, or read a value
 * the author then joins on; the framework never sees the value.
 *
 * What is banned is the value crossing back over the boundary as a prop. `recordId={record?.
 * id}` and `view={`employees:employments:${record.id}`}` told a component the row
 * identity of the surface that had just mounted it — the one fact the framework unambiguously
 * already had. Fifty-one of those existed; every one was the author re-deriving framework state by
 * hand, and each was a place the shape of `id` could not change without editing tenant
 * source. It has since changed, from a generated mirror of an invented `id text` to a real `uuid`
 * primary key, which is exactly the migration those call sites would have blocked.
 *
 * Judged on the syntax tree, in prop-value position only. A member read nested inside an object
 * literal, an array, or a function body is not reported, because that is where the legitimate uses
 * live: `query={{ where: { employee_id: { eq: record.id } } }}` is a predicate the author
 * owns, and `onValueChange={(value) => …}` is authored behavior. The descent below follows only the
 * expression forms that *produce the prop's value* — chains, conditionals, concatenation, template
 * interpolation, and call arguments, which is how `String(record.id)` would otherwise slip
 * through — and stops at the forms that merely contain one.
 */
const AuthoringAudit = {
	isSystemColumnRead: (node: Readonly<Record<string, unknown>>): string | undefined => {
		if (node['type'] !== 'MemberExpression') return undefined;
		const property = isAstNode(node['property']) ? node['property'] : undefined;
		if (property === undefined) return undefined;
		// `record['id']` and `Reflect.get(record, 'id')` reach the same column by a
		// spelling a property-name check alone does not see.
		const name =
			property['type'] === 'Identifier'
				? property['name']
				: property['type'] === 'Literal'
					? property['value']
					: undefined;
		return typeof name === 'string' && SYSTEM_COLUMN_NAMES.includes(name) ? name : undefined;
	},
	/**
	 * The sub-expressions that become part of the prop's value, as opposed to those it merely holds.
	 *
	 * Named as a set of child keys rather than walked generically, because the difference between the
	 * two halves of the rule is exactly which children get descended into: an `ObjectExpression`, an
	 * `ArrayExpression` and a function body are all absent below, which is what keeps a `where`
	 * predicate, an export pipeline and an `onValueChange` handler out of the findings.
	 */
	valueSources: (
		node: Readonly<Record<string, unknown>>
	): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		const keys = ((): ReadonlyArray<string> => {
			switch (node['type']) {
				case 'ChainExpression':
				case 'TSNonNullExpression':
				case 'TSAsExpression':
				case 'ParenthesizedExpression':
					return ['expression'];
				// The test is not handed over; only the branches are.
				case 'ConditionalExpression':
					return ['consequent', 'alternate'];
				case 'LogicalExpression':
				case 'BinaryExpression':
					return ['left', 'right'];
				case 'TemplateLiteral':
				case 'SequenceExpression':
					return ['expressions'];
				// Arbitrary calls derive a new value; only explicit scalar coercions preserve identity.
				case 'CallExpression': {
					const callee = isAstNode(node['callee']) ? node['callee'] : undefined;
					return callee?.['type'] === 'Identifier' &&
						(callee['name'] === 'String' || callee['name'] === 'Number')
						? ['arguments']
						: [];
				}
				default:
					return [];
			}
		})();
		return keys.flatMap((key) => {
			const value = node[key];
			if (value == null) return [];
			if (Array.isArray(value)) return value.filter(isAstNode);
			return isAstNode(value) ? [value] : [];
		});
	},
	/** Every expression tag a single attribute carries, whether quoted with text or standing alone. */
	attributeExpressions: (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		const parts = Array.isArray(value) ? value : [value];
		return parts.flatMap((part) => {
			if (!isAstNode(part) || part['type'] !== 'ExpressionTag') return [];
			const expression = part['expression'];
			return isAstNode(expression) ? [expression] : [];
		});
	}
};

/**
 * Walks one attribute's value-input expressions and reports every system-column read it produces.
 *
 * The pending worklist is what makes the check see through chains, conditionals and interpolation:
 * a `record.id` buried under `String(...)` or a concatenation reads the same column and is
 * reported, while anything the expression merely holds — a nested `where` predicate, an array
 * literal, a function body — stays out of the walk entirely.
 */
const reportAttributeColumnReads = (
	attribute: Readonly<Record<string, unknown>>,
	component: string,
	report: (column: string, component: string, prop: string, start: number) => void
): void => {
	const pending = [...AuthoringAudit.attributeExpressions(attribute['value'])];
	while (pending.length > 0) {
		const expression = pending.pop();
		if (expression === undefined) continue;
		const column = AuthoringAudit.isSystemColumnRead(expression);
		if (column !== undefined) {
			report(
				column,
				component,
				typeof attribute['name'] === 'string' ? attribute['name'] : '',
				typeof expression['start'] === 'number' ? expression['start'] : 0
			);
			continue;
		}
		pending.push(...AuthoringAudit.valueSources(expression));
	}
};

/** Reports a component attribute carrying a read of a framework-owned system column. */
const systemColumnReadsInComponent = (
	node: Readonly<Record<string, unknown>>,
	report: (column: string, component: string, prop: string, start: number) => void
): void => {
	const component = typeof node['name'] === 'string' ? node['name'] : 'component';
	const attributes = node['attributes'];
	for (const attribute of Array.isArray(attributes) ? attributes.filter(isAstNode) : []) {
		if (attribute['type'] !== 'Attribute') continue;
		reportAttributeColumnReads(attribute, component, report);
	}
};

/**
 * Reports authored `.svelte` source that hands a framework-owned system column to a component prop.
 *
 * Svelte's own parser, not a text scan and not the TypeScript parser. `dependencies.test.ts` in
 * Colony shows what the alternatives cost: it filters candidate files with `path.endsWith('.ts')`,
 * so every `.svelte` file walks past a ban that has been green for years, and its own comment notes
 * that feeding a `.svelte` path to `ts.createSourceFile` would under-report in silence rather than
 * fail. A component prop only exists in markup, so markup is what has to be parsed.
 */
export const auditAuthoredSystemColumns = (
	files: Readonly<Record<string, string>>
): ReadonlyArray<SystemColumnFinding> => {
	const findings: Array<SystemColumnFinding> = [];
	for (const [file, source] of Object.entries(files)) {
		if (!file.endsWith('.svelte')) continue;
		/** Descends the whole fragment, because a component can be nested in any block or snippet. */
		const visit = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const child of node) visit(child);
				return;
			}
			const decoded = decodeAstNode(node);
			if (Result.isFailure(decoded)) return;
			if (
				decoded.success['type'] === 'Component' ||
				decoded.success['type'] === 'SvelteComponent' ||
				decoded.success['type'] === 'SvelteSelf'
			) {
				systemColumnReadsInComponent(decoded.success, (column, component, prop, start) => {
					findings.push({
						file,
						line: source.slice(0, start).split('\n').length,
						component,
						prop,
						column
					});
				});
			}
			for (const [key, value] of Object.entries(decoded.success)) {
				if (key === 'parent') continue;
				visit(value);
			}
		};
		// The fragment only: a system column named in `<script>` is a query or a join, which the rule
		// permits, and walking it would report every legitimate use in the workspace.
		visit(parse(source, { modern: true, filename: file }).fragment);
	}
	return findings;
};

/** Parses the module graph and reports forbidden framework or provider dependencies. */
export const auditImports = (
	files: Readonly<Record<string, string>>
): ReadonlyArray<AuditFinding> => {
	const findings: Array<AuditFinding> = [];
	for (const [file, source] of Object.entries(files)) {
		for (const dependency of DependencyAudit.moduleSpecifiers(file, source)) {
			const forbidden = DependencyAudit.forbidden(dependency);
			if (forbidden !== undefined) findings.push({ file, dependency: forbidden });
		}
		if (DependencyAudit.readsAmbientEnvironment(file, source))
			findings.push({ file, dependency: 'process.env' });
	}
	return findings;
};
