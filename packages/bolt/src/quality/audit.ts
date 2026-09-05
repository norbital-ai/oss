import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'svelte/compiler';
import { Result, Schema } from 'effect';
import ts from 'typescript';
import { SYSTEM_COLUMN_NAMES } from '../authoring/system-row-model.js';

const forbiddenBoltDependencies = [
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
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);

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

type AuditFinding = Readonly<{ readonly file: string; readonly dependency: string }>;

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

type SystemColumnFinding = Readonly<{
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
		return isString(name) && SYSTEM_COLUMN_NAMES.includes(name) ? name : undefined;
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
				isString(attribute['name']) ? attribute['name'] : '',
				isNumber(expression['start']) ? expression['start'] : 0
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
	const component = isString(node['name']) ? node['name'] : 'component';
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

type ClientWrapperFinding = Readonly<{
	readonly file: string;
	readonly line: number;
	readonly functionName: string;
	readonly call: string;
}>;

type HooklessMutationFinding = Readonly<{
	readonly collection: string;
	readonly file: string;
	readonly line: number;
	readonly expectedHooks: string;
}>;

/**
 * A named helper that performs a write the author should have made onsite.
 *
 * Writes are `client.db.<collection>.mutate|delete` and `client.invoke.<fn>` — the calls a
 * surface makes because it was interacted with. Reads (`findMany`, `findFirst`, `count`,
 * `pending`) belong in helpers, `$derived` and loaders; flagging them would ban the query
 * layer the framework exists to serve. `pending` in particular is state, not a write.
 *
 * Judged on the TypeScript syntax tree, in expression position only. Type references and
 * imports use different node kinds (`TypeReference`, `QualifiedName`, `ImportDeclaration`),
 * so matching only `PropertyAccessExpression`/`ElementAccessExpression` rooted at the
 * identifier `client` already leaves them out. Any other root (`operations.mutate` on a
 * prop, `api.db.*` on the server) is a different client and is not reported.
 */
const ClientWrapperAudit = {
	/** Files the rule never reads, mirroring the build guard in `vite-plugin.ts`. */
	skipped: (file: string): boolean => /\/(?:node_modules|\.yalc|\.norbital)\//.test(file),
	/**
	 * The member chain of one property/element access, unwrapping parens and assertions.
	 *
	 * `client.db['loans'].mutate` spells the same path with brackets, so element accesses with
	 * a static string or number count as segments; anything computed is not a path the rule
	 * can name and ends the walk.
	 */
	chainOf: (expression: ts.Expression): ReadonlyArray<string> | undefined => {
		const segments: Array<string> = [];
		let current: ts.Expression = expression;
		for (;;) {
			if (ts.isPropertyAccessExpression(current)) {
				segments.unshift(current.name.text);
				current = current.expression;
				continue;
			}
			if (ts.isElementAccessExpression(current)) {
				const argument = current.argumentExpression;
				if (argument !== undefined && ts.isStringLiteralLike(argument)) {
					segments.unshift(argument.text);
					current = current.expression;
					continue;
				}
				if (argument !== undefined && ts.isNumericLiteral(argument)) {
					segments.unshift(argument.text);
					current = current.expression;
					continue;
				}
				return undefined;
			}
			if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
				current = current.expression;
				continue;
			}
			if (ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
				current = current.expression;
				continue;
			}
			if (ts.isIdentifier(current)) {
				segments.unshift(current.text);
				return segments;
			}
			return undefined;
		}
	},
	/**
	 * The dotted call when a `client`-rooted chain is a write, otherwise undefined.
	 *
	 * `client.db` only counts with `.mutate`/`.delete` further along the chain — `pending`
	 * and every read (`findMany`, `findFirst`, `count`, …) stay silent. `client.invoke.*`
	 * is always effectful so any named call counts. `client.automations.*` counts for
	 * `.run`/`.stop` and stays silent for `.pending`/`.latest` reads. `client.records`,
	 * `client.history` and `client.collections` are reads and metadata, so they are
	 * recognised here and never reported.
	 */
	writeOf: (chain: ReadonlyArray<string>): string | undefined => {
		if (chain.length < 3 || chain[0] !== 'client') return undefined;
		const second = chain[1];
		if (second === 'invoke') return chain.join('.');
		if (second === 'db')
			return chain.slice(2).includes('mutate') || chain.slice(2).includes('delete')
				? chain.join('.')
				: undefined;
		if (second === 'automations')
			return chain.slice(2).includes('run') || chain.slice(2).includes('stop')
				? chain.join('.')
				: undefined;
		return undefined;
	},
	/** The display name of a property-style name, or undefined for a computed key. */
	propertyName: (name: ts.PropertyName): string | undefined => {
		if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
		if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
		return undefined;
	},
	/**
	 * The name an arrow or function expression takes from its assignment, if any.
	 *
	 * `const save = () => …`, `{ save: () => … }` and `class C { save = () => … }` are all
	 * named helpers by the variable or property that holds them. A bare arrow passed as an
	 * argument (`onSubmit={(values) => …}`, thunks, `$derived` callbacks) has no such
	 * holder and stays anonymous. A named function expression standing alone keeps its own
	 * name.
	 */
	assignedName: (fn: ts.ArrowFunction | ts.FunctionExpression): string | undefined => {
		const parent = fn.parent;
		if (
			ts.isVariableDeclaration(parent) &&
			ts.isIdentifier(parent.name) &&
			parent.initializer === fn
		)
			return parent.name.text;
		if (ts.isPropertyAssignment(parent) && parent.initializer === fn)
			return ClientWrapperAudit.propertyName(parent.name);
		if (ts.isPropertyDeclaration(parent) && parent.initializer === fn)
			return ClientWrapperAudit.propertyName(parent.name);
		if (ts.isFunctionExpression(fn) && fn.name !== undefined) return fn.name.text;
		return undefined;
	},
	/**
	 * The nearest named function holding a node, skipping anonymous arrows.
	 *
	 * The skip is the thunk case: `function save() { submit(() => client.db.x.mutate()) }`
	 * still performs its write inside the named `save` — the inner arrow is how the
	 * settlement API takes the write, not a second onsite position. Markup arrows and
	 * `$derived` callbacks have no named holder above them, so they stay silent.
	 */
	enclosingName: (node: ts.Node): string | undefined => {
		let current: ts.Node | undefined = node.parent;
		while (current !== undefined) {
			const name = ClientWrapperAudit.holderName(current);
			if (name !== undefined) return name;
			current = current.parent;
		}
		return undefined;
	},
	/** The name a syntactic function position contributes, or undefined when it holds none. */
	holderName: (node: ts.Node): string | undefined => {
		if (ts.isFunctionDeclaration(node)) return node.name?.text;
		if (
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		)
			return ClientWrapperAudit.propertyName(node.name);
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
			return ClientWrapperAudit.assignedName(node);
		return undefined;
	}
};

/** The `<script>` and `<script context="module">` bodies of a component, with file offsets. */
const svelteScriptBlocks = (
	source: string,
	file: string
): ReadonlyArray<Readonly<{ readonly content: string; readonly start: number }>> => {
	const root: unknown = parse(source, { modern: true, filename: file });
	const module = isAstNode(root) && isAstNode(root['module']) ? root['module'] : undefined;
	const instance = isAstNode(root) && isAstNode(root['instance']) ? root['instance'] : undefined;
	const holders = [module, instance];
	const blocks: Array<Readonly<{ readonly content: string; readonly start: number }>> = [];
	for (const holder of holders) {
		const content = holder?.['content'];
		if (!isAstNode(content)) continue;
		const start = content['start'];
		const end = content['end'];
		if (!isNumber(start) || !isNumber(end) || end < start) continue;
		blocks.push({ content: source.slice(start, end), start });
	}
	return blocks;
};

/**
 * Reports named helpers that perform onsite writes.
 *
 * `.svelte` files go through Svelte's own parser first — the same parser the system-column
 * rule uses — and each `<script>` body is then parsed with the TypeScript compiler API, the
 * same approach `auditImports` takes. `.ts` files are parsed whole. Markup event-handler
 * arrows live in the fragment, not in either script, so they are never visited and never
 * reported. One finding per offending access, attributed to its nearest named holder.
 */
export const auditAuthoredClientWrappers = (
	files: Readonly<Record<string, string>>
): ReadonlyArray<ClientWrapperFinding> => {
	const findings: Array<ClientWrapperFinding> = [];
	for (const [file, source] of Object.entries(files)) {
		if (ClientWrapperAudit.skipped(file)) continue;
		const blocks: ReadonlyArray<Readonly<{ readonly content: string; readonly start: number }>> =
			file.endsWith('.svelte')
				? svelteScriptBlocks(source, file)
				: file.endsWith('.ts')
					? [{ content: source, start: 0 }]
					: [];
		for (const block of blocks) {
			const sourceFile = ts.createSourceFile(
				file,
				block.content,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			const visit = (node: ts.Node): void => {
				if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
					const chain = ClientWrapperAudit.chainOf(node);
					const call = chain === undefined ? undefined : ClientWrapperAudit.writeOf(chain);
					if (call !== undefined) {
						const functionName = ClientWrapperAudit.enclosingName(node);
						if (functionName !== undefined) {
							findings.push({
								file,
								line: source.slice(0, block.start + node.getStart(sourceFile)).split('\n').length,
								functionName,
								call
							});
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}
	}
	return findings;
};

/**
 * Reports collections granted `mutate.*` that ship no `+hooks.ts`.
 *
 * Reads `src/access/policies/*.ts` under the workspace root for direct `grantOn` /
 * `grantsOn` pairs or literal policy `grants` objects and checks `src/collections/<collection>/+hooks.ts` presence. Only
 * literal collection/action pairs count — an action list held in a variable, or a grant
 * composed through a helper like `peopleGrants('read')`, is not resolved. One finding per
 * collection, at its first `mutate` grant site; `read`/`delete`-only collections stay
 * silent. Paths in findings are workspace-relative POSIX paths.
 */
export const auditHooklessMutations = (
	workspaceRoot: string
): ReadonlyArray<HooklessMutationFinding> => {
	const policiesDir = join(workspaceRoot, 'src', 'access', 'policies');
	let entries: ReadonlyArray<string>;
	// repository-health:allow EFF1 -- a missing policies directory degrades to no findings; this is a sync workspace probe, not Effect error control.
	try {
		// repository-health:allow IO1 -- sync workspace audit scanner with a synchronous public API; it runs as a build-time quality gate, not request runtime.
		entries = [...readdirSync(policiesDir)].sort();
		// repository-health:allow S1 -- an absent or unreadable policies directory contributes no findings; the audit reports grant hygiene, not IO health, and has no error channel for it.
	} catch {
		return [];
	}
	const firstGrant = new Map<string, Readonly<{ readonly file: string; readonly line: number }>>();
	const noteGrant = (collection: string, file: string, line: number): void => {
		if (!firstGrant.has(collection)) firstGrant.set(collection, { file, line });
	};
	const isMutateAction = (action: string): boolean =>
		action === 'mutate' || action.startsWith('mutate.');
	for (const entry of entries) {
		if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
		const absolute = join(policiesDir, entry);
		let text: string;
		// repository-health:allow EFF1 -- an unreadable policy file is skipped, not an Effect failure; same sync workspace probe as above.
		try {
			// repository-health:allow IO1 -- same sync audit scanner contract.
			text = readFileSync(absolute, 'utf8');
			// repository-health:allow S1 -- an unreadable policy file is skipped; the audit reads every grant file in the tree and one unreadable file must not fail the whole hygiene report.
		} catch {
			continue;
		}
		const sourceFile = ts.createSourceFile(
			absolute,
			text,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const relativeFile = ['src', 'access', 'policies', entry].join('/');
		const visit = (node: ts.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				ClientWrapperAudit.propertyName(node.name) === 'grants' &&
				ts.isObjectLiteralExpression(node.initializer)
			) {
				for (const member of node.initializer.properties) {
					if (!ts.isPropertyAssignment(member) || !ts.isObjectLiteralExpression(member.initializer))
						continue;
					const collection = ClientWrapperAudit.propertyName(member.name);
					const mutates = member.initializer.properties.some(
						(grant) =>
							ts.isPropertyAssignment(grant) &&
							ClientWrapperAudit.propertyName(grant.name) === 'mutate' &&
							ts.isObjectLiteralExpression(grant.initializer) &&
							grant.initializer.properties.some(
								(phase) =>
									ts.isPropertyAssignment(phase) &&
									['new', 'existing'].includes(ClientWrapperAudit.propertyName(phase.name) ?? '')
							)
					);
					if (collection !== undefined && mutates)
						noteGrant(
							collection,
							relativeFile,
							sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
						);
				}
			}
			if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
				ts.forEachChild(node, visit);
				return;
			}
			const callee = node.expression.text;
			if (callee === 'grantOn') {
				const [collectionArg, actionArg] = node.arguments;
				if (
					collectionArg !== undefined &&
					actionArg !== undefined &&
					ts.isStringLiteralLike(collectionArg) &&
					ts.isStringLiteralLike(actionArg) &&
					isMutateAction(actionArg.text)
				) {
					noteGrant(
						collectionArg.text,
						relativeFile,
						sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
					);
				}
			} else if (callee === 'grantsOn') {
				const [collectionArg, actionsArg] = node.arguments;
				if (
					collectionArg !== undefined &&
					actionsArg !== undefined &&
					ts.isStringLiteralLike(collectionArg) &&
					ts.isArrayLiteralExpression(actionsArg) &&
					actionsArg.elements.some(
						(element) => ts.isStringLiteralLike(element) && isMutateAction(element.text)
					)
				) {
					noteGrant(
						collectionArg.text,
						relativeFile,
						sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
					);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	const findings: Array<HooklessMutationFinding> = [];
	for (const collection of [...firstGrant.keys()].sort()) {
		const site = firstGrant.get(collection);
		if (site === undefined) continue;
		// repository-health:allow IO1 -- same sync audit scanner contract; a hooks-file existence probe.
		if (existsSync(join(workspaceRoot, 'src', 'collections', collection, '+hooks.ts'))) continue;
		findings.push({
			collection,
			file: site.file,
			line: site.line,
			expectedHooks: ['src', 'collections', collection, '+hooks.ts'].join('/')
		});
	}
	return findings;
};
