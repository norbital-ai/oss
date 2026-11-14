import { createHash } from 'node:crypto';
import path from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';
import { FIRST_PARTY_PACKAGES } from '../../packages/host-api/src/first-party.ts';
import { PublicationFailed } from './error.ts';
const StringMap = Schema.Record(Schema.String, Schema.String);
export const Manifest = Schema.StructWithRest(
	Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		version: Schema.optionalKey(Schema.String),
		private: Schema.optionalKey(Schema.Boolean),
		license: Schema.optionalKey(Schema.String),
		repository: Schema.optionalKey(
			Schema.StructWithRest(Schema.Struct({ directory: Schema.optionalKey(Schema.String) }), [
				Schema.Record(Schema.String, Schema.Json)
			])
		),
		publishConfig: Schema.optionalKey(
			Schema.StructWithRest(
				Schema.Struct({
					access: Schema.optionalKey(Schema.String),
					provenance: Schema.optionalKey(Schema.Boolean)
				}),
				[Schema.Record(Schema.String, Schema.Json)]
			)
		),
		scripts: Schema.optionalKey(StringMap),
		dependencies: Schema.optionalKey(StringMap),
		devDependencies: Schema.optionalKey(StringMap),
		optionalDependencies: Schema.optionalKey(StringMap),
		peerDependencies: Schema.optionalKey(StringMap),
		peerDependenciesMeta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
		imports: Schema.optionalKey(Schema.Json),
		exports: Schema.optionalKey(Schema.Json)
	}),
	[Schema.Record(Schema.String, Schema.Json)]
);
export type Manifest = typeof Manifest.Type;
export const readManifest = Effect.fn('Publication.readManifest')(function* (filePath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.readFileString(filePath).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
		Effect.mapError(() => new PublicationFailed({ message: `${filePath} is not a JSON object.` }))
	);
});
/** Each published package's directory under `packages/`, named after it. */
export const publicPackageDirectories = FIRST_PARTY_PACKAGES.map((name) =>
	name.slice('@norbital-ai/'.length)
);
export type PackageEntry = {
	readonly name: string;
	readonly version: string;
	readonly integrity?: string | undefined;
};
export const readPublicPackageEntries = Effect.fn('Publication.entries')(function* (
	repositoryRoot: string
) {
	const releaseVersion = (yield* readManifest(path.join(repositoryRoot, 'package.json'))).version;
	if (releaseVersion === undefined || releaseVersion === '')
		return yield* new PublicationFailed({
			message: 'The workspace package.json has no release version.'
		});
	const entries = yield* Effect.forEach(
		publicPackageDirectories,
		(directory) =>
			Effect.gen(function* () {
				const manifest = yield* readManifest(
					path.join(repositoryRoot, 'packages', directory, 'package.json')
				);
				if (manifest.private)
					return yield* new PublicationFailed({ message: `${manifest.name} is private.` });
				if (manifest.name !== `@norbital-ai/${directory}`)
					return yield* new PublicationFailed({
						message: `Unexpected public package name in packages/${directory}.`
					});
				if (manifest.version === undefined || manifest.version === '')
					return yield* new PublicationFailed({ message: `${manifest.name} has no version.` });
				if (manifest.version !== releaseVersion)
					return yield* new PublicationFailed({
						message: `${manifest.name}@${manifest.version} does not match the workspace release ${releaseVersion}.`
					});
				for (const section of [
					'dependencies',
					'peerDependencies',
					'optionalDependencies'
				] as const) {
					for (const [name, range] of Object.entries(manifest[section] ?? {})) {
						if (
							name.startsWith('@norbital-ai/') &&
							!range.startsWith('workspace:') &&
							range !== releaseVersion
						)
							return yield* new PublicationFailed({
								message: `${manifest.name} ${section}.${name} is ${range}; the release is ${releaseVersion}.`
							});
					}
				}
				return { name: manifest.name, version: manifest.version };
			}),
		{ concurrency: 'unbounded' }
	);
	// a public package FIRST_PARTY_PACKAGES does not name would ship outside every host's and template's first-party set
	const fs = yield* FileSystem.FileSystem;
	for (const directory of yield* fs.readDirectory(path.join(repositoryRoot, 'packages'))) {
		const file = path.join(repositoryRoot, 'packages', directory, 'package.json');
		if (publicPackageDirectories.includes(directory) || !(yield* fs.exists(file))) continue;
		if (!(yield* readManifest(file)).private)
			return yield* new PublicationFailed({
				message: `packages/${directory} is public but not in @norbital-ai/host-api FIRST_PARTY_PACKAGES.`
			});
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
});
export function platformPackageKey(entries: ReadonlyArray<PackageEntry>): string {
	const identity = entries
		.map(({ name, version, integrity }) => {
			if (integrity === undefined || !integrity.startsWith('sha512-'))
				throw new PublicationFailed({ message: `${name}@${version} has no sha512 integrity.` });
			return { name, version, integrity };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}
