import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { platformPackageKey, readPublicPackageEntries } from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const contractIdPattern = /^[0-9a-f]{64}$/;

function fail(message) {
	throw new Error(message);
}

function argumentsFrom(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) fail(`Unknown argument: ${argument}`);
		const key = argument.slice(2);
		const value = argv[++index];
		if (!value || value.startsWith('--')) fail(`${argument} requires a value.`);
		options[key] = value;
	}
	return options;
}

function git(...arguments_) {
	return execFileSync('git', arguments_, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
}

function required(options, key, environmentKey) {
	const value = options[key] ?? process.env[environmentKey];
	if (!value) fail(`Pass --${key} or set ${environmentKey}.`);
	return value;
}

const options = argumentsFrom(process.argv.slice(2));
const sourceRevision =
	options['source-revision'] ?? process.env.SOURCE_REVISION ?? git('rev-parse', 'HEAD');
if (!shaPattern.test(sourceRevision)) fail('source-revision must be a full 40-character Git SHA.');
const templateRevisionsPath = path.resolve(
	repositoryRoot,
	required(options, 'template-revisions', 'TEMPLATE_REVISIONS_FILE')
);
const templateRevisions = JSON.parse(readFileSync(templateRevisionsPath, 'utf8'));
if (templateRevisions.source?.revision !== sourceRevision) {
	fail('Template projections and platform release must resolve from the same source revision.');
}
for (const entry of templateRevisions.entries ?? []) {
	if (!shaPattern.test(entry.revision)) fail(`Template ${entry.key} has an invalid revision.`);
	if (!entry.ref?.startsWith('refs/heads/')) fail(`Template ${entry.key} has an invalid ref.`);
}
if (!Array.isArray(templateRevisions.entries) || templateRevisions.entries.length === 0) {
	fail('Template revisions file has no entries.');
}

const builderDigest = required(options, 'builder-digest', 'BUILDER_IMAGE_DIGEST');
const runtimeDigest = required(options, 'runtime-digest', 'RUNTIME_IMAGE_DIGEST');
if (!digestPattern.test(builderDigest)) fail('builder-digest must be a sha256 OCI digest.');
if (!digestPattern.test(runtimeDigest)) fail('runtime-digest must be a sha256 OCI digest.');
const packageEntries = readPublicPackageEntries(repositoryRoot);
const packageKey = platformPackageKey(packageEntries);
const pod = packageEntries.find((entry) => entry.name === '@norbital-ai/pod');
if (!pod) fail('The Pod package is required in every platform release.');

const createdAt =
	options['created-at'] ??
	process.env.SOURCE_DATE ??
	git('show', '-s', '--format=%cI', sourceRevision);
if (Number.isNaN(Date.parse(createdAt))) fail(`Invalid created-at timestamp: ${createdAt}`);

const packages = {
	registry: required(options, 'package-registry', 'PACKAGE_REGISTRY_URL').replace(/\/+$/, ''),
	packageKey,
	entries: packageEntries
};
const images = {
	builder: {
		reference: required(options, 'builder-image', 'BUILDER_IMAGE_REFERENCE'),
		digest: builderDigest
	},
	runtime: {
		reference: required(options, 'runtime-image', 'RUNTIME_IMAGE_REFERENCE'),
		digest: runtimeDigest
	}
};
const compatibility = {
	compilerContract: 1,
	node: '26',
	pod: pod.version
};

// Templates deliberately do not participate in this identity. A template ref can advance without
// scheduling a same-tree Pod rebuild for every tenant tracking the stable platform.
const buildContractId = createHash('sha256')
	.update(JSON.stringify({ packages, images, compilerContract: compatibility.compilerContract }))
	.digest('hex');
if (!contractIdPattern.test(buildContractId)) {
	fail(`Invalid generated platform build contract id: ${buildContractId}`);
}
const expectedBuildContractId =
	options['expected-build-contract-id'] ?? process.env.EXPECTED_PLATFORM_BUILD_CONTRACT_ID;
if (expectedBuildContractId && expectedBuildContractId !== buildContractId) {
	fail(
		`Expected platform build contract ${expectedBuildContractId}, generated ${buildContractId}.`
	);
}

const manifest = {
	$schema: './platform-release.schema.json',
	schemaVersion: 1,
	releaseId: buildContractId,
	buildContractId,
	createdAt: new Date(createdAt).toISOString(),
	source: {
		repository: required(options, 'source-repository', 'SOURCE_REPOSITORY_URL'),
		revision: sourceRevision
	},
	packages,
	templates: {
		repository: templateRevisions.source.repository,
		entries: templateRevisions.entries
	},
	images,
	compatibility
};

const outputPath = path.resolve(
	repositoryRoot,
	options.output ?? process.env.PLATFORM_RELEASE_OUTPUT ?? 'dist/platform-release.json'
);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
	`Wrote ${path.relative(repositoryRoot, outputPath)} for build contract ${buildContractId}.`
);
