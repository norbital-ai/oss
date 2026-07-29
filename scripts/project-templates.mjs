import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
	actualCounts,
	discoverTemplates,
	repositoryRoot,
	templateMetadataFile
} from './lib/templates.mjs';

const revisionPattern = /^[0-9a-f]{40}$/;
const localDependencyProtocol = /^(?:workspace|catalog|file|link|portal):/;
const dependencySections = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies'
];

function fail(message) {
	throw new Error(message);
}

function readArguments(argv) {
	const options = {
		check: false,
		updateLocal: false,
		pushRemote: undefined,
		output: undefined,
		sourceRevision: 'HEAD',
		repository: undefined
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--update-local') options.updateLocal = true;
		else if (argument === '--push') options.pushRemote = argv[++index];
		else if (argument === '--output') options.output = argv[++index];
		else if (argument === '--source-revision') options.sourceRevision = argv[++index];
		else if (argument === '--repository') options.repository = argv[++index];
		else fail(`Unknown argument: ${argument}`);
	}
	if (!options.check && !options.updateLocal && !options.pushRemote && !options.output) {
		fail('Choose --check, --update-local, --push <remote>, or --output <path>.');
	}
	if (options.pushRemote === '') fail('--push requires a remote name or URL.');
	if (options.output === '') fail('--output requires a path.');
	return options;
}

function runGit(arguments_, options = {}) {
	try {
		return execFileSync('git', arguments_, {
			cwd: repositoryRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
			...options
		}).trim();
	} catch (cause) {
		const detail = cause?.stderr?.toString().trim();
		fail(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`);
	}
}

function validateStandaloneManifest(template) {
	const manifest = JSON.parse(readFileSync(path.join(template.directory, 'package.json'), 'utf8'));
	if (!manifest.private)
		fail(`Template ${template.key} must remain a private application package.`);
	for (const script of ['build', 'lint', 'sync']) {
		if (typeof manifest.scripts?.[script] !== 'string' || manifest.scripts[script] === '') {
			fail(`Template ${template.key} needs a ${script} script.`);
		}
	}
	for (const section of dependencySections) {
		for (const [name, version] of Object.entries(manifest[section] ?? {})) {
			if (localDependencyProtocol.test(version)) {
				fail(
					`Template ${template.key} cannot project ${section}.${name} with local protocol ${version}.`
				);
			}
		}
	}
	// A template pins its own pod version. Nothing propagates a bump into it; a developer
	// commits one when they choose to. The only requirement here is that the pin is exact,
	// so the projected tree resolves to the same bytes the committed lockfile describes.
	const podVersion = manifest.dependencies?.['@norbital-ai/pod'];
	if (typeof podVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(podVersion)) {
		fail(`Template ${template.key} must pin @norbital-ai/pod to an exact version.`);
	}
	for (const dependency of ['prettier', 'prettier-plugin-svelte', 'svelte-check', 'typescript']) {
		if (typeof manifest.devDependencies?.[dependency] !== 'string') {
			fail(`Template ${template.key} needs standalone dev dependency ${dependency}.`);
		}
	}
}

function validate(template) {
	validateStandaloneManifest(template);
	const actual = actualCounts(template.directory);
	for (const key of ['collections', 'apps', 'automations']) {
		if (template.counts[key] !== actual[key]) {
			fail(
				`Template ${template.key} declares ${template.counts[key]} ${key} in ${templateMetadataFile}; found ${actual[key]}.`
			);
		}
	}
}

function projectTemplate(template, sourceRevision) {
	const output = runGit(['subtree', 'split', `--prefix=${template.path}`, sourceRevision]);
	const revision = output.split(/\s+/).at(-1);
	if (!revisionPattern.test(revision)) {
		fail(`Projection for ${template.key} did not produce a commit revision.`);
	}
	return revision;
}

const options = readArguments(process.argv.slice(2));
const templates = discoverTemplates();
for (const template of templates) validate(template);

if (options.check && !options.updateLocal && !options.pushRemote && !options.output) {
	console.log(`Validated ${templates.length} template declarations.`);
	process.exit(0);
}

const sourceRevision = runGit(['rev-parse', '--verify', `${options.sourceRevision}^{commit}`]);
const sourceRepository =
	options.repository ??
	runGit(['config', '--get', 'remote.origin.url'], { stdio: ['ignore', 'pipe', 'ignore'] });
if (!sourceRepository && options.output) {
	fail('A source repository is required for output; pass --repository <url>.');
}

const entries = [];
for (const template of templates) {
	const revision = projectTemplate(template, sourceRevision);
	if (options.updateLocal) runGit(['update-ref', template.ref, revision]);
	entries.push({
		key: template.key,
		ref: template.ref,
		revision,
		name: template.name,
		industry: template.industry,
		description: template.description,
		visibility: template.visibility,
		counts: template.counts
	});
	console.log(`${template.key}: ${template.ref} -> ${revision}`);
}

if (options.pushRemote) {
	runGit([
		'push',
		'--atomic',
		options.pushRemote,
		...entries.map((entry) => `${entry.revision}:${entry.ref}`)
	]);
}

if (options.output) {
	const outputPath = path.resolve(repositoryRoot, options.output);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(
		outputPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				source: { repository: sourceRepository, revision: sourceRevision },
				entries
			},
			null,
			2
		)}\n`
	);
	console.log(`Wrote ${path.relative(repositoryRoot, outputPath)}.`);
}
