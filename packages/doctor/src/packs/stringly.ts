/**
 * Stringly-typed domain logic: deciding behaviour by comparing an open-domain identifier to a
 * literal written in the source.
 *
 * The industry names, from general to specific:
 *
 * - **Primitive obsession** (Fowler, *Refactoring*) — modelling a domain concept as a bare string
 *   instead of a type whose domain is closed. The prescribed fix is *Replace Type Code with
 *   Enum/Class*; in TypeScript, a string-literal union or a branded type.
 * - **Stringly typed** — the common name for the same thing when the string is then branched on.
 *   The literal itself is a **magic string**.
 * - **Hard-coded authorization** — the security-critical subclass, where the branch decides access.
 *   OWASP **A01:2021 Broken Access Control**; **CWE-863 Incorrect Authorization**. The prescribed
 *   fix is policy-based access control: ask whether the subject *may do the thing*, never whether
 *   it *is called something*.
 * - **Policy/mechanism separation** (Unix design, Levin et al. 1975) — the architectural framing.
 *   A decision that belongs to configuration has been compiled into the mechanism.
 *
 * The invariant these rules enforce:
 *
 * > A branch may compare an identifier against a literal only when that identifier's domain is
 * > closed — an enum or a string-literal union. An open domain is runtime data, and data does not
 * > belong in a conditional.
 *
 * So `message.role === 'assistant'` is fine: `role` is `'user' | 'assistant'`, the set is closed and
 * a new member is a compile error. `team.name === 'Engineering'` is not: somebody renames the team
 * in the product and the branch silently stops matching, with no compile error anywhere.
 *
 * Openness is a property of the *type*, so deciding it exactly needs the type checker. These rules
 * approximate it by property name, restricted to identifiers whose domain is open by construction —
 * a user or a tenant author supplies the value. Discriminants (`kind`, `type`, `status`, `variant`,
 * `role`) are deliberately excluded: those are usually closed unions, and flagging them would bury
 * the real findings. The type-aware form, which reads the declared type instead of guessing from
 * the name, is the correct long-run version of this.
 */
import ts from 'typescript';
import { defineRule } from '../pattern.js';
import { definePack, type Rule, type RuleContext } from '../rules.js';

/**
 * Identifiers whose value is supplied at runtime by a person or a tenant author.
 *
 * Every one of these is renameable in the product without a deployment, which is what makes a
 * source literal comparing against it a latent silent failure.
 */
const OPEN_DOMAIN = new Set([
	'name',
	'slug',
	'handle',
	'title',
	'label',
	'displayName',
	'email',
	'username',
	'teamName',
	'collectionName',
	'workspaceName'
]);

/**
 * Entities whose identifiers a *person* owns, defaulting to this product's nouns.
 *
 * The property name alone is not enough to decide openness, and measuring said so: across this
 * codebase `name` is overwhelmingly a closed registry key — Lezer node types, DOMException names,
 * Tiptap extensions, ProseMirror nodes, ESTree identifiers, tool names. Matching on the property
 * alone produced roughly nine false positives for every real one, which is a rule nobody would
 * keep.
 *
 * So the receiver has to be a domain entity as well. `team.name` is open because a person renames
 * a team in the product; `node.name` is closed because a parser defines its node types. Projects
 * declare their own nouns rather than inheriting these.
 */
const DEFAULT_ENTITIES = [
	'team',
	'teams',
	'collection',
	'collections',
	'workspace',
	'tenant',
	'policy',
	'policies',
	'app',
	'apps',
	'role',
	'group',
	'member',
	'organization',
	'org',
	'project'
];

/** Names that make a value's use plainly an access decision rather than presentation. */
const AUTHORIZATION_INTENT =
	/^(?:can|may|is|has|allow|deny|permit|authori[sz]|restrict|require|gate|admin|owner|superuser)/i;

/** The root identifier of `a.b.c` — `a` — so the receiver can be recognised as a domain entity. */
function receiverRoot(node: ts.PropertyAccessExpression): string | undefined {
	let current: ts.Expression = node.expression;
	while (ts.isPropertyAccessExpression(current)) current = current.expression;
	if (ts.isIdentifier(current)) return current.text;
	return undefined;
}

/** True when any part of `team.name` or `selectedTeam.name` names a configured entity. */
function namesEntity(node: ts.PropertyAccessExpression, entities: ReadonlySet<string>): boolean {
	const parts: Array<string> = [];
	let current: ts.Expression = node.expression;
	while (ts.isPropertyAccessExpression(current)) {
		parts.push(current.name.text);
		current = current.expression;
	}
	const root = receiverRoot(node);
	if (root !== undefined) parts.push(root);
	return parts.some((part) => {
		const normalized = part.replace(/^(?:selected|current|active|the)/i, '').toLowerCase();
		return entities.has(normalized) || entities.has(part.toLowerCase());
	});
}

/** `team.name` → `name`, but only when the receiver is an entity a person names. */
function openDomainProperty(node: ts.Node, entities: ReadonlySet<string>): string | undefined {
	if (!ts.isPropertyAccessExpression(node)) return undefined;
	const property = node.name.text;
	if (!OPEN_DOMAIN.has(property)) return undefined;
	return namesEntity(node, entities) ? property : undefined;
}

/** The enclosing declaration or property whose name reveals what the comparison is for. */
function decisionName(node: ts.Node, context: RuleContext): string | undefined {
	for (const parent of context.ancestors(node)) {
		if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
		if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
		if (
			(ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
			parent.name !== undefined &&
			ts.isIdentifier(parent.name)
		)
			return parent.name.text;
	}
	return undefined;
}

/** Evidence suffix marking the finding as an access decision rather than presentation. */
function intentOf(node: ts.Node, context: RuleContext): string {
	const owner = decisionName(node, context);
	return owner !== undefined && AUTHORIZATION_INTENT.test(owner)
		? ` decision=${owner} class=hardcoded-authorization`
		: '';
}

const buildRules = (entities: ReadonlySet<string>): ReadonlyArray<Rule> => {
	const comparison = defineRule({
		id: 'STR1',
		severity: 'error',
		summary: 'branches on an open-domain identifier compared to a source literal',
		principles: ['straightforwardness', 'type-safety', 'testability'],
		when: ['BinaryExpression'],
		check(node, context) {
			const expression = node as ts.BinaryExpression;
			const operator = expression.operatorToken.kind;
			if (
				operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
				operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
				operator !== ts.SyntaxKind.EqualsEqualsToken &&
				operator !== ts.SyntaxKind.ExclamationEqualsToken
			)
				return;

			for (const [subject, other] of [
				[expression.left, expression.right],
				[expression.right, expression.left]
			] as ReadonlyArray<readonly [ts.Expression, ts.Expression]>) {
				const property = openDomainProperty(subject, entities);
				if (property === undefined) continue;
				// Comparing two runtime values is not a hardcoded assumption about either of them.
				if (!ts.isStringLiteral(other) && !ts.isNoSubstitutionTemplateLiteral(other)) continue;
				// An empty-string comparison asks whether a value is set, not which value it is.
				if (other.text === '') continue;
				context.report(
					node,
					`property=${property} literal=${JSON.stringify(other.text)} prefer=capability-check|closed-union${intentOf(node, context)}`
				);
				return;
			}
		}
	});

	const membership = defineRule({
		id: 'STR2',
		severity: 'error',
		summary: 'tests an open-domain identifier against a literal allowlist',
		principles: ['straightforwardness', 'type-safety', 'testability'],
		when: ['CallExpression'],
		check(node, context) {
			const call = node as ts.CallExpression;
			if (!ts.isPropertyAccessExpression(call.expression)) return;
			if (!['includes', 'indexOf', 'has'].includes(call.expression.name.text)) return;

			const argument = call.arguments[0];
			if (argument === undefined) return;
			const property = openDomainProperty(argument, entities);
			if (property === undefined) return;

			// The receiver must be a literal set written here, not a value computed at runtime.
			const receiver = call.expression.expression;
			const literals = ts.isArrayLiteralExpression(receiver)
				? receiver.elements.filter((element) => ts.isStringLiteral(element))
				: [];
			if (literals.length === 0) return;

			context.report(
				node,
				`property=${property} allowlist=${literals.length} prefer=capability-check|closed-union${intentOf(node, context)}`
			);
		}
	});

	const dispatch = defineRule({
		id: 'STR3',
		severity: 'error',
		summary: 'dispatches on an open-domain identifier',
		principles: ['straightforwardness', 'type-safety', 'modularity'],
		when: ['SwitchStatement'],
		check(node, context) {
			const statement = node as ts.SwitchStatement;
			const property = openDomainProperty(statement.expression, entities);
			if (property === undefined) return;
			const cases = statement.caseBlock.clauses.filter((clause) => ts.isCaseClause(clause)).length;
			context.report(
				node,
				`property=${property} cases=${cases} prefer=capability-check|closed-union${intentOf(node, context)}`
			);
		}
	});

	return [comparison, membership, dispatch];
};

export type StringlyOptions = Readonly<{
	/** Entities whose identifiers a person owns. Replaces the defaults rather than extending them. */
	readonly entities?: ReadonlyArray<string> | undefined;
}>;

/** Build the pack for a project's own domain nouns. */
export function stringlyTyped(options: StringlyOptions = {}) {
	const entities = new Set(
		(options.entities ?? DEFAULT_ENTITIES).map((name) => name.toLowerCase())
	);
	return definePack({ name: 'norbital/stringly-typed', rules: buildRules(entities) });
}

export const stringlyPack = stringlyTyped();
