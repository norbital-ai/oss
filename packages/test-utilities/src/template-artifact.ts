import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema } from 'effect';

export type ReleaseBundle = {
	readonly bundlePath: string;
	readonly schemaFingerprint: string;
};

const TEMPLATE_MANIFEST = Schema.Struct({
	seed: Schema.optionalKey(Schema.Struct({ stages: Schema.Unknown }))
});

const RELEASE_MANIFEST = Schema.Struct({
	code: Schema.optionalKey(Schema.Struct({ entrypoint: Schema.optionalKey(Schema.String) })),
	requiredFacilities: Schema.optionalKey(Schema.Array(Schema.String)),
	schema: Schema.optionalKey(Schema.Struct({ fingerprint: Schema.optionalKey(Schema.String) }))
});

type TemplateManifest = Schema.Schema.Type<typeof TEMPLATE_MANIFEST>;
type ReleaseManifest = Schema.Schema.Type<typeof RELEASE_MANIFEST>;

const isString = Schema.is(Schema.String);
const isStringArray = Schema.is(Schema.Array(Schema.String));

const flattenSeedStages = (stages: unknown): readonly string[] => {
	if (stages === undefined) throw new Error('template manifest seed.stages is missing');
	if (!Array.isArray(stages)) return [];
	const names: string[] = [];
	for (const stage of stages) {
		if (isString(stage)) {
			names.push(stage);
			continue;
		}
		if (!isStringArray(stage)) {
			throw new Error(`seed.stages entry is not a collection name: ${JSON.stringify(stage)}`);
		}
		for (const name of stage as ReadonlyArray<string>) names.push(name);
	}
	return names;
};

/** Manifest stages that have a public `<stage>.json` in the seed directory. */
export const authoredSeedStages = (
	manifestPath: string,
	seedDirectory: string
): readonly string[] => {
	// repository-health:allow IO1 -- sync manifest probe in the test-harness setup path; the loaders' public API is synchronous by contract.
	const manifest = Schema.decodeUnknownSync(TEMPLATE_MANIFEST)(
		JSON.parse(readFileSync(manifestPath, 'utf8')) // repository-health:allow IO1 -- same sync probe contract.
	);
	// repository-health:allow IO1 -- same sync probe contract.
	return flattenSeedStages(manifest.seed?.stages).filter((stage) =>
		existsSync(join(seedDirectory, `${stage}.json`)) // repository-health:allow IO1 -- same sync probe contract.
	);
};

/** Every named stage from the manifest, including collections with no public rows file. */
export const manifestSeedStages = (manifestPath: string): readonly string[] => {
	// repository-health:allow IO1 -- same sync probe contract.
	const manifest = Schema.decodeUnknownSync(TEMPLATE_MANIFEST)(
		JSON.parse(readFileSync(manifestPath, 'utf8')) // repository-health:allow IO1 -- same sync probe contract.
	);
	return flattenSeedStages(manifest.seed?.stages);
};

export const requireReleaseBundle = (
	artifactDirectory: string,
	requiredFacilities?: readonly string[]
): ReleaseBundle => {
	const path = join(artifactDirectory, 'release.json');
	// repository-health:allow IO1 -- same sync probe contract.
	if (!existsSync(path)) {
		throw new Error(`compiled artifact is missing ${path}`);
	}
	// repository-health:allow IO1 -- same sync probe contract.
	const release = Schema.decodeUnknownSync(RELEASE_MANIFEST)(JSON.parse(readFileSync(path, 'utf8')));
	const entrypoint = release.code?.entrypoint;
	if (entrypoint === undefined || entrypoint.length === 0) {
		throw new Error('release.json code.entrypoint must name the bundle');
	}
	const bundlePath = join(artifactDirectory, entrypoint);
	// repository-health:allow IO1 -- same sync probe contract.
	if (!existsSync(bundlePath)) {
		throw new Error(`compiled entrypoint is missing: ${bundlePath}`);
	}
	const schemaFingerprint = release.schema?.fingerprint ?? '';
	if (schemaFingerprint.length === 0) {
		throw new Error('release.json schema.fingerprint is required');
	}
	if (requiredFacilities !== undefined) {
		const facilities = [...(release.requiredFacilities ?? [])].sort();
		const expected = [...requiredFacilities].sort();
		if (facilities.join(',') !== expected.join(',')) {
			throw new Error(
				`release.json requiredFacilities must be ${expected.join('/')}, got ${JSON.stringify(release.requiredFacilities)}`
			);
		}
	}
	return { bundlePath, schemaFingerprint };
};
