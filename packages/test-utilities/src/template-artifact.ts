import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type ReleaseManifest = {
	readonly code?: { readonly entrypoint?: string };
	readonly requiredFacilities?: ReadonlyArray<string>;
	readonly schema?: { readonly fingerprint?: string };
};

type TemplateManifest = {
	readonly seed?: { readonly stages?: unknown };
};

export type ReleaseBundle = {
	readonly bundlePath: string;
	readonly schemaFingerprint: string;
};

const flattenSeedStages = (stages: unknown): readonly string[] => {
	if (stages === undefined) throw new Error('template manifest seed.stages is missing');
	if (!Array.isArray(stages)) return [];
	const names: string[] = [];
	for (const stage of stages) {
		if (typeof stage === 'string') {
			names.push(stage);
			continue;
		}
		if (!Array.isArray(stage) || !stage.every((name) => typeof name === 'string')) {
			throw new Error(`seed.stages entry is not a collection name: ${JSON.stringify(stage)}`);
		}
		for (const name of stage) names.push(name);
	}
	return names;
};

/** Manifest stages that have a public `<stage>.json` in the seed directory. */
export const authoredSeedStages = (
	manifestPath: string,
	seedDirectory: string
): readonly string[] => {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TemplateManifest;
	return flattenSeedStages(manifest.seed?.stages).filter((stage) =>
		existsSync(join(seedDirectory, `${stage}.json`))
	);
};

/** Every named stage from the manifest, including collections with no public rows file. */
export const manifestSeedStages = (manifestPath: string): readonly string[] => {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TemplateManifest;
	return flattenSeedStages(manifest.seed?.stages);
};

export const requireReleaseBundle = (
	artifactDirectory: string,
	requiredFacilities?: readonly string[]
): ReleaseBundle => {
	const path = join(artifactDirectory, 'release.json');
	if (!existsSync(path)) {
		throw new Error(`compiled artifact is missing ${path}`);
	}
	const release = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
	const entrypoint = release.code?.entrypoint;
	if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
		throw new Error('release.json code.entrypoint must name the bundle');
	}
	const bundlePath = join(artifactDirectory, entrypoint);
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
