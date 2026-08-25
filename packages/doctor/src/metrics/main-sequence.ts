/**
 * Distance from the Main Sequence (Robert C. Martin's package-quality plane).
 *
 * The main sequence is the diagonal A + I = 1: stable packages should be abstract (they are
 * depended on, so they had better promise interfaces), unstable packages should be concrete
 * (nothing depends on them yet, so they can afford implementation). Distance measures how far a
 * package sits off that line — `|A + I − 1|` — with the two zones of pain named by the sign:
 * too rigid when A + I > 1 (abstract but depended-upon-for-nothing... rather, stable and
 * abstractless), too useless when A + I < 1 (abstract and nobody cares).
 *
 * Abstractness counts InterfaceDeclarations, TypeAliasDeclarations, and members declared
 * `abstract`; everything else declared in a file is concrete. Instability is efferent over
 * total coupling — how much of a package's coupling it inflicts outward rather than receives.
 * Both helpers return null at zero denominators because an isolated package is unmeasurable,
 * not perfectly balanced.
 */
import ts from 'typescript';

/** A / (A + C); null when the package declares nothing measurable. */
export function abstractness(input: Readonly<{ abstractCount: number; concreteCount: number }>): number | null {
	const total = input.abstractCount + input.concreteCount;
	return total === 0 ? null : input.abstractCount / total;
}

/** Ce / (Ca + Ce); null when the package neither imports nor is imported. */
export function instability(input: Readonly<{ efferent: number; afferent: number }>): number | null {
	const total = input.efferent + input.afferent;
	return total === 0 ? null : input.efferent / total;
}

/** |A + I − 1|: perpendicular distance from the main-sequence diagonal (√2-scaled). */
export function distanceFromMainSequence(point: Readonly<{
	abstractness: number;
	instability: number;
}>): number {
	return Math.abs(point.abstractness + point.instability - 1);
}

/**
 * Abstract declarations in one file: interfaces, type aliases, and `abstract`-modified class
 * members. An `abstract class` head itself counts only through its abstract members — the
 * keyword promises nothing about instantiability that those members do not already say.
 */
export function countAbstractDeclarations(sourceFile: ts.SourceFile): number {
	let count = 0;
	const walk = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			count += 1;
			return;
		}
		if (
			(ts.isMethodDeclaration(node) ||
				ts.isPropertyDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node)) &&
			ts.canHaveModifiers(node) &&
			ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword)
		) {
			count += 1;
			return;
		}
		ts.forEachChild(node, walk);
	};
	walk(sourceFile);
	return count;
}
