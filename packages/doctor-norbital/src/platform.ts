/**
 * Platform ownership: the model compiler, the generated client, and operator-facing identifiers.
 *
 * Ported from `ORM1`, `DDL1`, `SQL1`, `QRY2`, `QRY3`, `UI18`, `LEGACY1`, `COMPAT1`,
 * `TRANS1`, `TRANS2`, `E3`, plus the canonical tenant-root contract `ROOT1`.
 *
 * `QRY1` and `MUT1` are deliberately absent: they are the two rows of the capability manifest in
 * `capability.ts`, which is where a co-occurrence rule belongs. That is the whole lesson of the
 * legacy `QRY1` — the rule shape was right and the evidence was wrong, so it moved rather than
 * being ported as written.
 */
import { defineRule } from '@norbital-ai/doctor';
import { nameOf } from '@norbital-ai/doctor';
import { definePack, type Pack, type Rule } from '@norbital-ai/doctor';

/** Files that own physical schema/bootstrap rendering. */
const INFRASTRUCTURE = /(?:^|\/)(?:migrations?|compiler|generator|schema|drizzle)(?:\/|$)/i;

/**
 * Provisioning DDL: the statements that stand a database up before a generated client exists.
 *
 * Recognised by what it is, not by where it lives, so the exemption travels with the statement
 * instead of with a directory name:
 *
 *   - native mechanisms such as triggers, functions, extensions and row-level-security policies;
 *   - an explicitly idempotent table/index/schema bootstrap;
 *   - a history table, whose name is derived from the collection it shadows;
 *   - DDL emitted by the compiler/schema/migration owner.
 *
 * This replaced a path test that exempted `compiler`, `schema`, `migrations`, `drizzle` and
 * `scripts` anywhere in a path — most of the platform, and every `scripts/` directory in the realm.
 */
const BOOTSTRAP_DDL =
	/^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRIGGER|FUNCTION|POLICY)\b|CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b|CREATE\s+(?:TABLE|INDEX|SCHEMA)\s+IF\s+NOT\s+EXISTS\b|DROP\s+(?:TRIGGER|FUNCTION|POLICY|EXTENSION|TABLE|INDEX|SCHEMA)\s+IF\s+EXISTS\b|ALTER\s+POLICY\b|ALTER\s+TABLE\b[\s\S]*\b(?:ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS|DROP\s+COLUMN\s+IF\s+EXISTS|(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY)\b)/i;

const TRANSACTION_CONTROL =
	/^\s*(?:(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|SAVEPOINT\s+[A-Za-z_][\w$]*|RELEASE\s+SAVEPOINT\s+[A-Za-z_][\w$]*|ROLLBACK\s+TO(?:\s+SAVEPOINT)?\s+[A-Za-z_][\w$]*)\s*;?\s*$/i;

const RAW_SQL =
	/\b(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*\bSET\b|DELETE\s+FROM\b|MERGE\s+INTO\b|TRUNCATE\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|SCHEMA|TRIGGER|FUNCTION|POLICY|EXTENSION|VIEW)\b|ALTER\s+(?:TABLE|POLICY|VIEW)\b|DROP\s+(?:TABLE|INDEX|SCHEMA|TRIGGER|FUNCTION|POLICY|EXTENSION|VIEW)\b)/i;

/** Tagged SQL that the model/compiler serializes into generated DDL, never executes as CRUD. */
const DDL_EXPRESSION_OWNER =
	/(?:^|\/)(?:compiler|migrations?|schema|drizzle)(?:\/|$)|(?:^|\/)(?:\+model|model-introspection|system-models|system-row-model)\.[cm]?[jt]s$/i;

function transactionStatementOwner(
	node: import('typescript').Node,
	context: import('@norbital-ai/doctor').RuleContext
): boolean {
	const ts = context.ts;
	const isTransactionObject = (candidate: import('typescript').ObjectLiteralExpression): boolean =>
		candidate.properties.some((property) => {
			if (!ts.isPropertyAssignment(property)) return false;
			const key = property.name;
			if (!(ts.isIdentifier(key) || ts.isStringLiteral(key)) || key.text !== '_tag') return false;
			return (
				ts.isStringLiteral(property.initializer) && property.initializer.text === 'Transaction'
			);
		});
	const ancestors = context.ancestors(node);
	for (const [index, parent] of ancestors.entries()) {
		if (!ts.isObjectLiteralExpression(parent) || !isTransactionObject(parent)) continue;
		const underStatements = ancestors.slice(0, index).some((candidate) => {
			if (!ts.isPropertyAssignment(candidate)) return false;
			const key = candidate.name;
			return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'statements';
		});
		if (underStatements) return true;
	}
	const owner = ancestors.find((parent) => ts.isFunctionLike(parent));
	if (owner === undefined) return false;
	let transactionReturn = false;
	let queryReturn = false;
	const visit = (candidate: import('typescript').Node): void => {
		// A nested callable owns its own return contract; do not use it to exonerate its parent.
		if (candidate !== owner && ts.isFunctionLike(candidate)) return;
		if (ts.isReturnStatement(candidate) && candidate.expression !== undefined) {
			const returned = context.text(candidate.expression);
			if (/\b_tag\s*:\s*['"]Transaction['"]/.test(returned)) transactionReturn = true;
			if (/\b_tag\s*:\s*['"]Query['"]/.test(returned)) queryReturn = true;
		}
		ts.forEachChild(candidate, visit);
	};
	visit(owner);
	return transactionReturn && !queryReturn;
}

function brandedTransactionSqlOwner(
	node: import('typescript').Node,
	context: import('@norbital-ai/doctor').RuleContext
): boolean {
	const imported = [...context.imports()].some(
		([specifier, names]) =>
			/^(?:#lib\/runtime\/persistence\.js|@norbital-ai\/bolt\/runtime\/persistence\.js)$/.test(
				specifier
			) && names.has('transactionSql')
	);
	if (!imported) return false;
	const ts = context.ts;
	const call = context
		.ancestors(node)
		.find((parent): parent is import('typescript').CallExpression => ts.isCallExpression(parent));
	return (
		call !== undefined &&
		context.calleeName(call) === 'transactionSql' &&
		call.arguments.some((argument) => argument === node)
	);
}

const physicalNameVocabulary = defineRule({
	id: 'ORM1',
	severity: 'error',
	summary: 'ORM column declares a second physical-name vocabulary',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	when: ['PropertyAssignment'],
	check(node, context) {
		const ts = context.ts;
		const property = node as import('typescript').PropertyAssignment;
		if (!ts.isIdentifier(property.name)) return;
		const initializer = property.initializer;
		if (!ts.isCallExpression(initializer)) return;
		const builder = context.calleeName(initializer) ?? '';
		if (!/^(?:text|integer|boolean|timestamp|uuid|jsonb?|numeric|date|real|serial)$/.test(builder))
			return;
		const [first] = initializer.arguments;
		if (first === undefined || !ts.isStringLiteral(first)) return;
		// A column naming itself differently from its property is two vocabularies for one field.
		if (first.text !== property.name.text)
			context.report(
				node,
				`property=${property.name.text} physical=${first.text} builder=${builder}`
			);
	}
});

const authoredDdl = defineRule({
	id: 'DDL1',
	severity: 'error',
	summary: 'authored table, column, constraint, or index DDL bypasses the model compiler',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability', 'no-bloat'],
	when: ['CallExpression'],
	check(node, context) {
		if (INFRASTRUCTURE.test(context.file)) return;
		const callee = context.calleeName(node) ?? '';
		if (!/^(?:pgTable|pgView|index|uniqueIndex|primaryKey|foreignKey|check)$/.test(callee)) return;
		// These are imported builders, called bare. Matching the name alone caught every
		// `Schema.Array(...).check(...)` in the realm — 22 of 25 findings were Effect Schema
		// refinements, which have nothing to do with DDL. A dotted callee is somebody's method.
		const ts = context.ts;
		const call = node as import('typescript').CallExpression;
		if (!ts.isIdentifier(call.expression)) return;
		// `index`, `check` and `primaryKey` are ordinary words; only trust them where the DDL
		// vocabulary they belong to is actually imported.
		const unambiguous = /^(?:pgTable|pgView|uniqueIndex|foreignKey)$/.test(callee);
		if (!unambiguous && !context.importsFrom('drizzle-orm')) return;
		context.report(node, `api=${callee} prefer=defineModel`);
	}
});

const rawSql = defineRule({
	id: 'SQL1',
	severity: 'error',
	summary: 'raw SQL outside transaction ownership or schema bootstrap DDL',
	principles: ['straightforwardness', 'testability'],
	when: ['StringLiteral', 'NoSubstitutionTemplateLiteral', 'TemplateExpression'],
	check(node, context) {
		const ts = context.ts;
		const text = context.text(node).replace(/^[\s'"`]+|[\s'"`]+$/g, '');
		let taggedSql = false;
		const importsPolicySql = [...context.imports()].some(
			([specifier, names]) =>
				names.has('policySql') &&
				(specifier === '@norbital-ai/bolt/authoring' ||
					/(?:^|\/)authoring\/policy-sql(?:\.js)?$/u.test(specifier))
		);
		const policyPredicate = context.ancestors(node).some((parent) => {
			if (
				ts.isTaggedTemplateExpression(parent) &&
				parent.template === node &&
				context.text(parent.tag) === 'sql'
			) {
				taggedSql = true;
				return false;
			}
			return (
				importsPolicySql &&
				ts.isCallExpression(parent) &&
				context.calleeName(parent) === 'policySql'
			);
		});
		// `policySql` is the policy compiler's deliberately narrow trusted-predicate input. It is
		// serialized as policy metadata; an ordinary function with that name is not this exception.
		if (
			policyPredicate ||
			/(?:^|\/)runtime\/schema\/system-collections\.[cm]?[jt]s$/.test(context.file)
		)
			return;
		if (TRANSACTION_CONTROL.test(text)) return;
		if (brandedTransactionSqlOwner(node, context)) return;
		if (transactionStatementOwner(node, context)) return;
		const ddl = /^(?:CREATE|ALTER|DROP)\b/i.test(text);
		if (
			ddl &&
			(INFRASTRUCTURE.test(context.file) || BOOTSTRAP_DDL.test(text) || /_history\b/i.test(text))
		)
			return;
		if (taggedSql && DDL_EXPRESSION_OWNER.test(context.file)) return;
		if (!taggedSql && !RAW_SQL.test(text)) return;
		context.report(node, 'form=raw-sql');
	}
});

function generatedQueryBinding(name: string, context: import('@norbital-ai/doctor').RuleContext): boolean {
	const ts = context.ts;
	let found = false;
	const visit = (node: import('typescript').Node): void => {
		if (found) return;
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
			const initializer = node.initializer;
			if (
				initializer !== undefined &&
				/(?:\.db\.[\w$]+\.(?:findMany|findFirst|count|groupBy)|\.(?:records|history|approvals|operations)\b|\.query\s*\()/i.test(
					context.text(initializer)
				)
			)
				found = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(context.sourceFile);
	return found;
}

const imperativeQuery = defineRule({
	id: 'QRY2',
	severity: 'error',
	summary: 'live query is refreshed manually instead of updating through sync',
	principles: ['straightforwardness', 'modularity', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		const ts = context.ts;
		const call = node as import('typescript').CallExpression;
		if (!ts.isPropertyAccessExpression(call.expression)) return;
		const operation = call.expression.name.text;
		if (operation !== 'refresh' && operation !== 'refetch') return;
		const receiver = call.expression.expression;
		const receiverText = context.text(receiver);
		const queryLike =
			/query|rows|records|history|approvals|operations/i.test(receiverText) ||
			(ts.isIdentifier(receiver) && generatedQueryBinding(receiver.text, context));
		if (!queryLike && operation === 'refresh') return;
		context.report(node, `call=${operation} owner=sync-engine`);
	}
});

const queryRefreshSurface = defineRule({
	id: 'QRY4',
	severity: 'error',
	summary: 'public query contract exposes manual refresh',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability', 'no-bloat'],
	when: ['PropertySignature', 'MethodSignature', 'PropertyDeclaration', 'MethodDeclaration'],
	check(node, context) {
		const ts = context.ts;
		if (!(
			ts.isPropertySignature(node) ||
			ts.isMethodSignature(node) ||
			ts.isPropertyDeclaration(node) ||
			ts.isMethodDeclaration(node)
		))
			return;
		const name = node.name;
		if (!(ts.isIdentifier(name) || ts.isStringLiteral(name))) return;
		if (name.text !== 'refresh' && name.text !== 'refetch') return;
		const queryOwner = context.ancestors(node).find((parent) => {
			if (
				!ts.isInterfaceDeclaration(parent) &&
				!ts.isTypeAliasDeclaration(parent) &&
				!ts.isClassDeclaration(parent)
			)
				return false;
			return parent.name !== undefined && /query/i.test(parent.name.text);
		});
		if (queryOwner === undefined) return;
		context.report(node, `member=${name.text} owner=query-contract`);
	}
});

const POLLING_IDENTIFIER =
	/(?:^poll(?:ing|ed|s)?(?:[A-Z]|$)|(?:^|_)POLL(?:ING|ED|S)?(?:_|$)|Poll(?:ing|ed|s)?(?:[A-Z]|$))/;

const pollingMechanism = defineRule({
	id: 'LIVE1',
	severity: 'error',
	summary: 'handwritten polling bypasses the live sync engine',
	principles: ['simplicity', 'straightforwardness', 'efficiency', 'testability', 'no-bloat'],
	ignore: ['packages/doctor/src/**', 'src/packs/platform.ts', 'src/packs/reactive.ts'],
	when: [
		'VariableDeclaration',
		'FunctionDeclaration',
		'CallExpression',
		'ForStatement',
		'WhileStatement',
		'DoStatement'
	],
	check(node, context) {
		const ts = context.ts;
		if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) {
			const name = node.name;
			if (name !== undefined && ts.isIdentifier(name) && POLLING_IDENTIFIER.test(name.text))
				context.report(node, `poll-owner=${name.text}`);
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = context.calleeName(node);
			if (callee !== 'setInterval' && callee !== 'setTimeout') return;
			const callback = node.arguments[0];
			if (callback === undefined) return;
			const callbackText = context.text(callback);
			if (
				!/\b(?:poll|status|refresh|refetch|fetch|request|query|findMany|findFirst|count|groupBy|operations\.run)\b/i.test(
					callbackText
				) &&
				!(callee === 'setTimeout' && /\bsetTimeout\s*\(/.test(callbackText))
			)
				return;
			context.report(node, `timer=${callee} owner=handwritten-poll`);
			return;
		}
		const loopText = context.text(node);
		// Bounded retry after an explicit failure is not a live-data poll. Retry loops say so in
		// their own source (`retryable`, `Retry-After`, retry limits); polling asks for fresh state.
		if (/\bretry/i.test(loopText)) return;
		if (!/\b(?:Effect\.sleep|sleep|delay|setTimeout)\s*\(/i.test(loopText)) return;
		if (
			!/\b(?:fetch|request|call|status|refresh|refetch|query|findMany|findFirst|count|groupBy)\s*\(/i.test(
				loopText
			)
		)
			return;
		context.report(node, 'loop=wait-and-read owner=handwritten-poll');
	}
});

function syncSseOwner(context: import('@norbital-ai/doctor').RuleContext): boolean {
	return context.file === 'packages/bolt/src/client/sync/sse-driver.ts';
}

const nonSyncSse = defineRule({
	id: 'LIVE2',
	severity: 'error',
	summary: 'server-sent events are used outside the sync engine',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability'],
	ignore: ['packages/doctor/src/**', 'src/packs/platform.ts'],
	when: ['NewExpression', 'StringLiteral', 'NoSubstitutionTemplateLiteral'],
	check(node, context) {
		if (syncSseOwner(context)) return;
		const ts = context.ts;
		if (ts.isNewExpression(node) && context.calleeName(node) === 'EventSource') {
			context.report(node, 'transport=EventSource owner=non-sync');
			return;
		}
		if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
		if (node.text !== 'sse' && !/\btext\/event-stream\b/i.test(node.text)) return;
		context.report(
			node,
			`transport=${node.text === 'sse' ? 'sse' : 'text/event-stream'} owner=non-sync`
		);
	}
});

const frozenQueryParameters = defineRule({
	id: 'QRY3',
	severity: 'error',
	summary: 'query parameters froze reactive input outside $derived',
	principles: ['simplicity', 'straightforwardness', 'testability', 'type-safety', 'no-bloat'],
	when: ['VariableDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const declaration = node as import('typescript').VariableDeclaration;
		const initializer = declaration.initializer;
		if (initializer === undefined || !ts.isCallExpression(initializer)) return;
		const callee = context.calleeName(initializer) ?? '';
		if (!/\.(?:findMany|findFirst|count)$/.test(callee)) return;
		// A query built outside `$derived` captures its parameters once and never re-reads them.
		const derived = context
			.ancestors(node)
			.some(
				(parent) =>
					ts.isCallExpression(parent) && /^\$derived/.test(context.calleeName(parent) ?? '')
			);
		if (!derived && ts.isIdentifier(declaration.name))
			context.report(node, `query=${callee} owner=plain-binding prefer=$derived`);
	}
});

const rawTransportCommand = defineRule({
	id: 'UI18',
	severity: 'error',
	summary: 'client UI sends a raw transport command instead of using the generated API',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'type-safety'],
	when: ['CallExpression'],
	// The summary says client UI, and the rule now means it. Transport implementations themselves
	// have to call `send`; a rule about callers of a layer does not describe the layer itself.
	files: ['**/ui/**', '**/*.svelte'],
	check(node, context) {
		const callee = context.calleeName(node) ?? '';
		if (!/\b(?:transport|connection|socket)\.(?:command|execute|send|invoke)$/.test(callee)) return;
		context.report(node, `api=${callee} prefer=generated-client`);
	}
});

const deprecatedDeclaration = defineRule({
	id: 'LEGACY1',
	severity: 'error',
	summary: 'authored declaration is explicitly deprecated',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'no-bloat'],
	when: [
		'FunctionDeclaration',
		'VariableStatement',
		'ClassDeclaration',
		'MethodDeclaration',
		'TypeAliasDeclaration',
		'InterfaceDeclaration'
	],
	check(node, context) {
		const ts = context.ts;
		// Real tags, not a regex over the leading trivia. Trivia runs back to the previous token, so
		// the pattern matched `@deprecated` written as prose in a doc comment — and matched a comment
		// about the declaration *above* this one. Three of this rule's findings in the realm were
		// documentation describing the tag rather than carrying it.
		if (!ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'deprecated')) return;
		const name = nameOf(node)?.text ?? 'declaration';
		context.report(node, `kind=${ts.SyntaxKind[node.kind]} name=${name}`);
	}
});

const compatibilityForwarder = defineRule({
	id: 'COMPAT1',
	severity: 'error',
	summary: 'explicit legacy or compatibility forwarding surface',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'colocation', 'no-bloat'],
	when: ['VariableStatement', 'FunctionDeclaration'],
	check(node, context) {
		const leading = context.source.slice(
			Math.max(0, node.getFullStart()),
			node.getStart(context.sourceFile)
		);
		if (
			!/\b(?:compatibility|compat|backwards[- ]compatible|legacy)\s+(?:forwarder|shim|alias|export)/i.test(
				leading
			)
		)
			return;
		context.report(node, 'marker=compatibility-forwarder');
	}
});

const removalMarker = defineRule({
	id: 'TRANS1',
	severity: 'error',
	summary: 'executable code carries an explicit removal or migration marker',
	principles: ['simplicity', 'straightforwardness', 'testability', 'no-bloat'],
	when: ['VariableStatement', 'FunctionDeclaration', 'ExpressionStatement', 'ReturnStatement'],
	check(node, context) {
		const leading = context.source.slice(
			Math.max(0, node.getFullStart()),
			node.getStart(context.sourceFile)
		);
		const marker =
			/\b(?:TODO|FIXME|HACK)\b[^\n]*\b(?:remove|delete|drop|migrat|temporar|once .* (?:lands|ships))/i.exec(
				leading
			);
		if (marker === null) return;
		context.report(node, `marker=${JSON.stringify(marker[0].slice(0, 40))}`);
	}
});

const legacyFieldFallback = defineRule({
	id: 'TRANS2',
	severity: 'error',
	summary: 'canonical data falls back to an explicit legacy field',
	principles: ['simplicity', 'straightforwardness', 'type-safety', 'no-bloat'],
	when: ['BinaryExpression'],
	check(node, context) {
		const ts = context.ts;
		const expression = node as import('typescript').BinaryExpression;
		if (
			expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
			expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken
		)
			return;
		const fallback = context.text(expression.right);
		if (!/(?:^|[._])(?:legacy|old|deprecated|v1|prev)[._A-Za-z]*$/i.test(fallback)) return;
		context.report(
			node,
			`canonical=${context.text(expression.left).slice(0, 30)} fallback=${fallback.slice(0, 30)}`
		);
	}
});

const legacyTenantRootOverride = defineRule({
	id: 'ROOT1',
	severity: 'error',
	summary: 'legacy tenant substrate root override bypasses the canonical one-root contract',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'testability', 'no-bloat'],
	when: ['Identifier', 'StringLiteral', 'NoSubstitutionTemplateLiteral'],
	check(node, context) {
		// The root owner must name the variables it refuses, and tests must be able to prove that
		// refusal. Everywhere else, either spelling recreates a second mutable-root vocabulary.
		if (/(?:^|\/)scripts\/tenant-substrate-root\.mjs$/u.test(context.file)) return;
		if (/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]s$/u.test(context.file)) return;
		const legacy = /\b(?:COLONY_DATA_DIRECTORY|COLONY_PACKAGE_STORE)\b/u.exec(
			context.text(node)
		)?.[0];
		if (legacy === undefined) return;
		context.report(node, `override=${legacy} owner=TENANT_SUBSTRATE_ROOT`);
	}
});

const envRevalidationWrapper = defineRule({
	id: 'E3',
	severity: 'error',
	summary: 'env get-or-throw or re-validation wrapper',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	rule: { any: ['process.env[$NAME] ?? $FALLBACK', 'process.env[$NAME] || $FALLBACK'] },
	examples: {
		bad: ["const url = process.env['SECRET_URL'] ?? '';"],
		good: ['const url = config.secretUrl;']
	}
});

const featureFlag = defineRule({
	id: 'E2',
	severity: 'hint',
	summary: 'feature flag declared in source',
	principles: ['straightforwardness', 'no-bloat'],
	when: ['VariableDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const declaration = node as import('typescript').VariableDeclaration;
		if (!ts.isIdentifier(declaration.name)) return;
		if (!/^(?:ENABLE_|FEATURE_|FLAG_|USE_)/.test(declaration.name.text)) return;
		const initializer = declaration.initializer;
		if (initializer === undefined) return;
		if (
			initializer.kind !== ts.SyntaxKind.TrueKeyword &&
			initializer.kind !== ts.SyntaxKind.FalseKeyword
		)
			return;
		context.report(node, `flag=${declaration.name.text}`);
	}
});

export const platformRules: ReadonlyArray<Rule> = [
	physicalNameVocabulary,
	authoredDdl,
	rawSql,
	imperativeQuery,
	queryRefreshSurface,
	pollingMechanism,
	nonSyncSse,
	frozenQueryParameters,
	rawTransportCommand,
	deprecatedDeclaration,
	compatibilityForwarder,
	removalMarker,
	legacyFieldFallback,
	legacyTenantRootOverride,
	envRevalidationWrapper,
	featureFlag
];

export const platformPack: Pack = definePack({ name: 'norbital/platform', rules: platformRules });
