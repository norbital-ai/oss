/**
 * Lack of Cohesion of Methods, Henderson–Sellers form (LCOM1*).
 *
 * Cohesion asks whether a class is one concept or a waiting room for strangers. Henderson–Sellers'
 * normalisation makes the answer a ratio: LCOM = |M − Σα(m)| / ((M−1)·a), where M counts methods,
 * a counts instance fields, and α(m) is 1 when method m touches at least one field. 0 means every
 * method shares state; 1 means the methods might as well be free functions.
 *
 * What counts, decided once so the merged analyzer cannot re-litigate it per call site:
 *
 * - Instance fields are non-static `PropertyDeclaration`s. `readonly` fields count — immutability
 *   does not make shared state less shared. Statics are excluded: they belong to the class as a
 *   module, not to its instances.
 * - Methods are non-static `MethodDeclaration`s plus arrow/function-valued properties (the common
 *   `handler = () => …` idiom). Constructors and accessors sit outside M; accessors are field
 *   plumbing by definition and would drag every accessor-heavy class toward fake cohesion.
 * - α(m) is conservative on purpose: only `this.X` references count. Resolving bare `x` against
 *   parameters, locals, imports, and shadowing without a type checker produces plausible wrong
 *   answers, and a cohesion number that is sometimes wrong in both directions is worse than one
 *   that under-counts predictably. Parameter properties (`constructor(private x)`) are likewise
 *   invisible — the declaration never appears as a property node.
 *
 * Null comes back whenever the fraction has no meaning: zero or one method (nothing to cohere),
 * or no instance fields (the formula divides by a). Values above 1 occur when most methods touch
 * nothing; they clamp to 1, which is what "no shared state" means anyway.
 */
import ts from 'typescript';

function hasStaticModifier(member: ts.ClassElement): boolean {
	if (!ts.canHaveModifiers(member)) return false;
	return (
		ts.getModifiers(member)?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
		) ?? false
	);
}

function isInstanceField(member: ts.ClassElement): member is ts.PropertyDeclaration {
	return ts.isPropertyDeclaration(member) && !hasStaticModifier(member);
}

/** A callable instance member: a method, or a property whose initializer is a function. */
function isInstanceMethod(member: ts.ClassElement): member is ts.MethodDeclaration | ts.PropertyDeclaration {
	if (hasStaticModifier(member)) return false;
	if (ts.isMethodDeclaration(member)) return true;
	return (
		ts.isPropertyDeclaration(member) &&
		member.initializer !== undefined &&
		(ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
	);
}

/** Whether the body references at least one of `fields` through an explicit `this.` access. */
function touchesInstanceFields(
	body: ts.Node,
	fields: ReadonlySet<string>
): boolean {
	let touched = false;
	const walk = (node: ts.Node): void => {
		if (touched) return;
		if (
			ts.isPropertyAccessExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ThisKeyword &&
			fields.has(node.name.text)
		) {
			touched = true;
			return;
		}
		ts.forEachChild(node, walk);
	};
	walk(body);
	return touched;
}

/** LCOM ∈ [0, 1], or null when the class has ≤1 instance methods or no instance fields. */
export function lcomHendersonSellers(classDecl: ts.ClassDeclaration): number | null {
	if (!ts.isClassDeclaration(classDecl))
		throw new Error('norbital-doctor: lcomHendersonSellers expects a class declaration');
	const fields = classDecl.members.filter(isInstanceField);
	const methods = classDecl.members.filter(isInstanceMethod);
	const methodCount = methods.length;
	const fieldCount = fields.length;
	if (methodCount <= 1 || fieldCount === 0) return null;
	const fieldNames = new Set(
		fields.map((field) =>
			ts.isIdentifier(field.name) ? field.name.text : field.name.getText()
		)
	);
	const connected = methods.filter((method) => {
		const body = ts.isMethodDeclaration(method) ? method.body : method.initializer;
		return body !== undefined && touchesInstanceFields(body, fieldNames);
	}).length;
	const raw =
		Math.abs(methodCount - connected) / ((methodCount - 1) * fieldCount);
	return Math.min(1, Math.max(0, raw));
}
