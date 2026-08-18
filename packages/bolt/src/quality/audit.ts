import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { SYSTEM_COLUMN_NAMES } from '../compiler/schema-plan.js';

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
				if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
				if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
					const argument = node.arguments[0];
					if (argument !== undefined && ts.isStringLiteral(argument)) dependencies.push(argument.text);
				}
				ts.forEachChild(node, visitor.visit);
			}
		};
		visitor.visit(sourceFile);
		return dependencies;
	},
	forbidden: (dependency: string): string | undefined => {
		for (const root of forbiddenBoltDependencies) if (dependency === root || dependency.startsWith(`${root}/`)) return root;
		for (const root of forbiddenProviderDependencies) if (dependency === root || dependency.startsWith(`${root}/`)) return root;
		for (const root of forbiddenHostModules) if (dependency === root || dependency.startsWith(`${root}/`)) return root;
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
 * Authored source handing a framework-owned `norbital_*` value back to a framework component.
 *
 * The rule is not "authored code may not name a system column" — it may, and must. A workspace
 * decides what "live" means by filtering on `norbital_approval_id`, lists key on `norbital_id`, and
 * reports order by `norbital_created_at`. Those spell a column *name* into a query, or read a value
 * the author then joins on; the framework never sees the value.
 *
 * What is banned is the value crossing back over the boundary as a prop. `recordId={record?.
 * norbital_id}` and `view={`employees:employments:${record.norbital_id}`}` told a component the row
 * identity of the surface that had just mounted it — the one fact the framework unambiguously
 * already had. Fifty-one of those existed; every one was the author re-deriving framework state by
 * hand, and each was a place the shape of `norbital_id` could not change without editing tenant
 * source. It has since changed, from a generated mirror of an invented `id text` to a real `uuid`
 * primary key, which is exactly the migration those call sites would have blocked.
 *
 * Judged on the syntax tree, in prop-value position only. A member read nested inside an object
 * literal, an array, or a function body is not reported, because that is where the legitimate uses
 * live: `query={{ where: { employee_id: { eq: record.norbital_id } } }}` is a predicate the author
 * owns, and `onValueChange={(value) => …}` is authored behavior. The descent below follows only the
 * expression forms that *produce the prop's value* — chains, conditionals, concatenation, template
 * interpolation, and call arguments, which is how `String(record.norbital_id)` would otherwise slip
 * through — and stops at the forms that merely contain one.
 */
const AuthoringAudit = {
	isSystemColumnRead: (node: Readonly<Record<string, unknown>>): string | undefined => {
		if (node['type'] !== 'MemberExpression') return undefined;
		const property = node['property'] as Readonly<Record<string, unknown>> | undefined;
		if (property === undefined) return undefined;
		// `record['norbital_id']` and `Reflect.get(record, 'norbital_id')` reach the same column by a
		// spelling a property-name check alone does not see.
		const name = property['type'] === 'Identifier' ? property['name'] : property['type'] === 'Literal' ? property['value'] : undefined;
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
	valueSources: (node: Readonly<Record<string, unknown>>): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		const keys = ((): ReadonlyArray<string> => {
			switch (node['type']) {
				case 'ChainExpression':
				case 'TSNonNullExpression':
				case 'TSAsExpression':
				case 'ParenthesizedExpression':
					return ['expression'];
				// The test is not handed over; only the branches are.
				case 'ConditionalExpression': return ['consequent', 'alternate'];
				case 'LogicalExpression':
				case 'BinaryExpression':
					return ['left', 'right'];
				case 'TemplateLiteral':
				case 'SequenceExpression':
					return ['expressions'];
				// Arguments only — a callee named `norbital_id` would be a function, not a column, and
				// descending into them is what stops `String(record.norbital_id)` laundering the value.
				case 'CallExpression': return ['arguments'];
				default: return [];
			}
		})();
		return keys.flatMap((key) => {
			const value = node[key];
			return value === null || value === undefined ? [] : Array.isArray(value) ? value : [value as Readonly<Record<string, unknown>>];
		});
	},
	/** Every expression tag a single attribute carries, whether quoted with text or standing alone. */
	attributeExpressions: (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> => {
		const parts = Array.isArray(value) ? value : [value];
		return parts.flatMap((part) => {
			const node = part as Readonly<Record<string, unknown>> | null;
			return node !== null && typeof node === 'object' && node['type'] === 'ExpressionTag' ? [node['expression'] as Readonly<Record<string, unknown>>] : [];
		});
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
/**
 * Reports an authored `+integrations.ts`, because nothing reads one.
 *
 * `defineConnection` is exported from the authoring surface and these files typecheck, so a
 * connection with pull and push bindings looks supported. It is not: no glob in `sync.ts` discovers
 * the filename, the manifest hardcodes `integrations: []`, and — checked against history — no
 * runtime in Bolt or in Pod before it ever consumed one. The declaration was added to match the
 * documentation and a runtime was never built.
 *
 * A warning is the right severity rather than a build failure. The files are real work describing
 * real intent, and refusing them would break every template that has one for a defect none of them
 * caused; what has to stop is the silence. This is the same reading as the channel declarations that
 * were discarded until something said so.
 */
export const auditAuthoredSystemColumns = (files: Readonly<Record<string, string>>): ReadonlyArray<SystemColumnFinding> => {
	const findings: Array<SystemColumnFinding> = [];
	for (const [file, source] of Object.entries(files)) {
		if (!file.endsWith('.svelte')) continue;
		const root = parse(source, { modern: true, filename: file }) as unknown as Readonly<Record<string, unknown>>; // stupidity: boundary-cast — the audit walks the fragment structurally and Svelte does not publish a node union it can narrow against.
		/** Descends the whole fragment, because a component can be nested in any block or snippet. */
		const visit = (node: Readonly<Record<string, unknown>> | null | undefined): void => {
			if (node === null || node === undefined || typeof node !== 'object') return;
			if (Array.isArray(node)) {
				for (const child of node) visit(child as Readonly<Record<string, unknown>>);
				return;
			}
			if (node['type'] === 'Component' || node['type'] === 'SvelteComponent' || node['type'] === 'SvelteSelf') {
				const component = typeof node['name'] === 'string' ? node['name'] : 'component';
				for (const attribute of (node['attributes'] as ReadonlyArray<Readonly<Record<string, unknown>>> | undefined) ?? []) {
					if (attribute['type'] !== 'Attribute') continue;
					const pending = [...AuthoringAudit.attributeExpressions(attribute['value'])];
					while (pending.length > 0) {
						const expression = pending.pop();
						if (expression === undefined) continue;
						const column = AuthoringAudit.isSystemColumnRead(expression);
						if (column !== undefined) {
							findings.push({
								file,
								line: source.slice(0, typeof expression['start'] === 'number' ? expression['start'] : 0).split('\n').length,
								component,
								prop: typeof attribute['name'] === 'string' ? attribute['name'] : '',
								column
							});
							continue;
						}
						pending.push(...AuthoringAudit.valueSources(expression));
					}
				}
			}
			for (const [key, value] of Object.entries(node)) {
				if (key === 'parent') continue;
				visit(value as Readonly<Record<string, unknown>>);
			}
		};
		// The fragment only: a system column named in `<script>` is a query or a join, which the rule
		// permits, and walking it would report every legitimate use in the workspace.
		visit(root['fragment'] as Readonly<Record<string, unknown>>);
	}
	return findings;
};

/** Parses the module graph and reports forbidden framework or provider dependencies. */
export const auditImports = (files: Readonly<Record<string, string>>): ReadonlyArray<AuditFinding> => {
	const findings: Array<AuditFinding> = [];
	for (const [file, source] of Object.entries(files)) {
		for (const dependency of DependencyAudit.moduleSpecifiers(file, source)) {
			const forbidden = DependencyAudit.forbidden(dependency);
			if (forbidden !== undefined) findings.push({ file, dependency: forbidden });
		}
		if (DependencyAudit.readsAmbientEnvironment(file, source)) findings.push({ file, dependency: 'process.env' });
	}
	return findings;
};
