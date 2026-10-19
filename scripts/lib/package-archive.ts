import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { Effect, FileSystem, Predicate, Result, Schema } from 'effect';
import { Manifest } from './package-release.ts';
import { PublicationFailed } from './error.ts';
import { capture } from './process.ts';
const localProtocol = /^(?:workspace|catalog|file|link|portal):/;
export const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PackReport = Schema.Union([
	Schema.Struct({ filename: Schema.NonEmptyString }),
	Schema.Array(Schema.Struct({ filename: Schema.NonEmptyString }))
]);
const report = Schema.decodeUnknownResult(Schema.fromJsonString(PackReport));
const fail = (message: string): never => {
	throw new PublicationFailed({ message });
};

/** Skip escaped quotes when locating a balanced JSON report after lifecycle output. */
const stringEnd = (output: string, start: number): number => {
	for (let index = start + 1; index < output.length; index += 1) {
		if (output[index] === '\\') {
			index += 1;
			continue;
		}
		if (output[index] === '"') return index;
	}
	return output.length;
};
const balancedEnd = (output: string, start: number): number | undefined => {
	let depth = 0;
	for (let index = start; index < output.length; index += 1) {
		const character = output[index];
		if (character === '"') {
			index = stringEnd(output, index);
			continue;
		}
		if (character === '{' || character === '[') {
			depth += 1;
			continue;
		}
		if (character !== '}' && character !== ']') continue;
		depth -= 1;
		if (depth === 0) return index + 1;
	}
	return undefined;
};
export function packedArchiveFilename(output: string, label = 'package pack'): string {
	for (const candidate of output.matchAll(/^[\t ]*[\[{]/gm)) {
		const start = candidate.index + candidate[0].search(/[\[{]/);
		const end = balancedEnd(output, start);
		if (end === undefined) continue;
		const decoded = report(output.slice(start, end));
		if (Result.isFailure(decoded)) continue;
		const filename =
			'filename' in decoded.success ? decoded.success.filename : decoded.success[0]?.filename;
		if (filename !== undefined) return filename;
	}
	return fail(`${label} did not report an archive filename.`);
}
export function sha512Integrity(bytes: Uint8Array): string {
	return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
export function assertSha512Integrity(
	bytes: Uint8Array,
	integrity: string,
	label = 'package archive'
): void {
	if (!sha512Pattern.test(integrity)) fail(`${label} has invalid sha512 integrity.`);
	const actual = Buffer.from(sha512Integrity(bytes));
	const expected = Buffer.from(integrity);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		fail(`${label} does not match its declared sha512 integrity.`);
}
function validatePublishedManifest(
	manifest: Manifest,
	directory: string,
	expected: { name?: string | undefined; version?: string | undefined } = {}
): void {
	if (manifest.private) fail(`${manifest.name} is marked private.`);
	if (manifest.name !== (expected.name ?? `@norbital-ai/${directory}`))
		fail(`${directory} has unexpected package name ${manifest.name}.`);
	if (!manifest.version) fail(`${manifest.name} has no version.`);
	if (expected.version && manifest.version !== expected.version)
		fail(`${manifest.name} archive is ${manifest.version}; expected ${expected.version}.`);
	if (manifest.license !== 'AGPL-3.0-only') fail(`${manifest.name} must declare AGPL-3.0-only.`);
	if (manifest.repository?.directory !== `packages/${directory}`)
		fail(`${manifest.name} has an invalid repository directory.`);
	if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig.provenance !== true)
		fail(`${manifest.name} must publish publicly with provenance.`);
	for (const section of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies'
	] as const) {
		for (const [name, version] of Object.entries(manifest[section] ?? {}))
			if (localProtocol.test(version))
				fail(`${manifest.name} publishes ${section}.${name} with local protocol ${version}.`);
	}
}
const importTargets = (value: unknown): string[] =>
	typeof value === 'string'
		? [value]
		: Predicate.isObject(value)
			? Object.values(value).flatMap(importTargets)
			: [];
const escapeRegularExpression = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (pattern: string, value: string): boolean =>
	pattern.includes('*')
		? new RegExp(`^${pattern.split('*').map(escapeRegularExpression).join('.+')}$`).test(value)
		: pattern === value;
function validatePackageTargets(manifest: Manifest, archiveEntries: ReadonlyArray<string>): void {
	for (const section of ['imports', 'exports'] as const) {
		const value = manifest[section];
		const map = typeof value === 'string' ? { '.': value } : (value ?? {});
		for (const [specifier, conditions] of Object.entries(map)) {
			for (const target of importTargets(conditions)) {
				if (
					target.startsWith('./') &&
					!archiveEntries.some((entry) => matches(`package/${target.slice(2)}`, entry))
				)
					fail(`${manifest.name} ${section.slice(0, -1)} ${specifier} targets missing ${target}.`);
			}
		}
	}
}
/** Module names belong to syntax, rather than arbitrary strings such as service identities. */
function moduleSpecifiers(file: string, text: string): readonly string[] {
	const scripts = file.endsWith('.svelte')
		? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
				.map((match) => match[1] ?? '')
				.join('\n')
		: text;
	const source = ts.createSourceFile(
		file,
		scripts,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith('.svelte') ? ts.ScriptKind.TS : undefined
	);
	const names: string[] = [];
	const factories = new Set(['createRequire']);
	const requires = new Set(['require']);
	const resolves = new Set<string>();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			!['node:module', 'module'].includes(statement.moduleSpecifier.text)
		)
			continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings !== undefined && ts.isNamedImports(bindings))
			for (const member of bindings.elements)
				if ((member.propertyName ?? member.name).text === 'createRequire')
					factories.add(member.name.text);
	}
	const isRequire = (expression: ts.Expression): boolean =>
		ts.isIdentifier(expression)
			? requires.has(expression.text)
			: ts.isCallExpression(expression) &&
				ts.isIdentifier(expression.expression) &&
				factories.has(expression.expression.text);
	const bindings = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer !== undefined &&
			isRequire(node.initializer)
		) {
			if (ts.isIdentifier(node.name)) requires.add(node.name.text);
			else if (ts.isObjectBindingPattern(node.name))
				for (const member of node.name.elements)
					if (
						ts.isIdentifier(member.name) &&
						(member.propertyName === undefined
							? member.name.text
							: member.propertyName.getText(source)) === 'resolve'
					)
						resolves.add(member.name.text);
		}
		ts.forEachChild(node, bindings);
	};
	bindings(source);
	const visit = (node: ts.Node): void => {
		let literal: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			literal = node.moduleSpecifier;
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			literal = node.moduleReference.expression;
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			literal = node.argument.literal;
		else if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (
				expression.kind === ts.SyntaxKind.ImportKeyword ||
				isRequire(expression) ||
				(ts.isIdentifier(expression) && resolves.has(expression.text)) ||
				(ts.isPropertyAccessExpression(expression) &&
					expression.name.text === 'resolve' &&
					isRequire(expression.expression))
			)
				literal = node.arguments[0];
		}
		if (
			literal !== undefined &&
			(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))
		)
			names.push(literal.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return names;
}

/** Check source literal module imports, including runtime createRequire/resolve paths. */
export function unexportedSpecifiers(
	sources: ReadonlyArray<readonly [string, string]>,
	manifests: ReadonlyMap<string, Pick<Manifest, 'exports'>>
): string[] {
	const offenders: string[] = [];
	for (const [file, text] of sources) {
		for (const specifier of moduleSpecifiers(file, text)) {
			const [, name, sub] = /^(@norbital-ai\/[a-z0-9-]+)(\/[^\s$]*)?$/.exec(specifier) ?? [];
			if (name === undefined) continue;
			const manifest = manifests.get(name);
			if (manifest === undefined || sub?.endsWith('/')) continue;
			const exports =
				typeof manifest.exports === 'string' ? ['.'] : Object.keys(manifest.exports ?? { '.': '' });
			if (!exports.some((pattern) => matches(pattern, `.${sub ?? ''}`)))
				offenders.push(`${file}: ${name}${sub ?? ''}`);
		}
	}
	return offenders;
}
export const inspectPackageArchive = Effect.fn('Publication.inspectArchive')(function* (
	archivePath: string,
	{
		directory,
		expectedName,
		expectedVersion,
		repositoryLicense
	}: {
		readonly directory: string;
		readonly expectedName?: string | undefined;
		readonly expectedVersion?: string | undefined;
		readonly repositoryLicense: string;
	}
) {
	const fs = yield* FileSystem.FileSystem;
	const file = path.resolve(archivePath);
	const cwd = path.dirname(file);
	const entries = (yield* capture('tar', ['-tzf', file], cwd)).trim().split('\n').filter(Boolean);
	const nested = entries.filter((entry) => /\.(?:tgz|tar|tar\.gz)$/i.test(entry));
	if (nested.length > 0)
		return yield* new PublicationFailed({
			message: `${directory} publishes generated package archives: ${nested.join(', ')}.`
		});
	const [manifestText, license] = yield* Effect.all(
		[
			capture('tar', ['-xOf', file, 'package/package.json'], cwd),
			capture('tar', ['-xOf', file, 'package/LICENSE'], cwd)
		],
		{ concurrency: 'unbounded' }
	);
	if (license !== repositoryLicense)
		return yield* new PublicationFailed({
			message: `${directory} does not publish the repository license.`
		});
	const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
		manifestText
	).pipe(
		Effect.mapError(
			() =>
				new PublicationFailed({
					message: `${directory} packed package manifest is not a JSON object.`
				})
		)
	);
	yield* Effect.try({
		try: () => {
			validatePublishedManifest(manifest, directory, {
				name: expectedName,
				version: expectedVersion
			});
			validatePackageTargets(manifest, entries);
		},
		catch: PublicationFailed.from
	});
	return { manifest, integrity: sha512Integrity(yield* fs.readFile(file)) };
}, Effect.mapError(PublicationFailed.from));
