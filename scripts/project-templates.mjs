import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = path.join(repositoryRoot, 'release', 'templates.json');
const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function countMatchingFiles(directory, predicate) {
	if (!existsSync(directory)) return 0;
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) count += countMatchingFiles(entryPath, predicate);
		else if (entry.isFile() && predicate(entry.name)) count += 1;
	}
	return count;
}

function validateStandaloneManifest(template, directory) {
	const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
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
	if (manifest.dependencies?.['@norbital-ai/pod'] !== '0.0.1') {
		fail(`Template ${template.key} must pin @norbital-ai/pod to 0.0.1.`);
	}
	for (const dependency of ['prettier', 'prettier-plugin-svelte', 'svelte-check', 'typescript']) {
		if (typeof manifest.devDependencies?.[dependency] !== 'string') {
			fail(`Template ${template.key} needs standalone dev dependency ${dependency}.`);
		}
	}
}

function loadCatalogue() {
	const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
	if (catalogue.schemaVersion !== 1) fail('release/templates.json must use schemaVersion 1.');
	if (!/^refs\/heads\/[a-z0-9][a-z0-9._/-]*[a-z0-9]$/.test(catalogue.refNamespace)) {
		fail(`Invalid template ref namespace: ${catalogue.refNamespace}`);
	}
	if (!Array.isArray(catalogue.templates) || catalogue.templates.length === 0) {
		fail('release/templates.json must declare at least one active template.');
	}
	const keys = new Set();
	const paths = new Set();
	for (const template of catalogue.templates) {
		if (!keyPattern.test(template.key)) fail(`Invalid template key: ${template.key}`);
		const expectedPath = `template_workspaces/${template.key}`;
		if (template.path !== expectedPath) {
			fail(`Template ${template.key} must use path ${expectedPath}.`);
		}
		if (keys.has(template.key)) fail(`Duplicate template key: ${template.key}`);
		if (paths.has(template.path)) fail(`Duplicate template path: ${template.path}`);
		if (typeof template.description !== 'string' || template.description.trim() === '') {
			fail(`Template ${template.key} needs a description.`);
		}
		for (const field of ['name', 'industry']) {
			if (typeof template[field] !== 'string' || template[field].trim() === '') {
				fail(`Template ${template.key} needs ${field}.`);
			}
		}
		if (!['public', 'unlisted'].includes(template.visibility)) {
			fail(`Template ${template.key} has invalid visibility.`);
		}
		for (const count of ['collections', 'apps', 'automations']) {
			if (!Number.isInteger(template.counts?.[count]) || template.counts[count] < 0) {
				fail(`Template ${template.key} has invalid ${count} count.`);
			}
		}
		if (typeof template.compatiblePod !== 'string' || template.compatiblePod.trim() === '') {
			fail(`Template ${template.key} needs a compatiblePod range.`);
		}
		const directory = path.join(repositoryRoot, template.path);
		if (!existsSync(path.join(directory, 'package.json'))) {
			fail(`Template ${template.key} has no package.json at ${template.path}.`);
		}
		validateStandaloneManifest(template, directory);
		const actualCounts = {
			collections: countMatchingFiles(
				path.join(directory, 'src', 'collections'),
				(filename) => filename === '+model.ts'
			),
			apps: countMatchingFiles(
				path.join(directory, 'src', 'apps'),
				(filename) => filename.startsWith('+') && filename.endsWith('.svelte')
			),
			automations: countMatchingFiles(
				path.join(directory, 'src', 'automation'),
				(filename) => filename.startsWith('+') && filename.endsWith('.ts')
			)
		};
		for (const count of ['collections', 'apps', 'automations']) {
			if (template.counts[count] !== actualCounts[count]) {
				fail(
					`Template ${template.key} declares ${template.counts[count]} ${count}; found ${actualCounts[count]}.`
				);
			}
		}
		keys.add(template.key);
		paths.add(template.path);
	}
	const templatesRoot = path.join(repositoryRoot, 'template_workspaces');
	const actualDirectories = readdirSync(templatesRoot)
		.filter((entry) => statSync(path.join(templatesRoot, entry)).isDirectory())
		.map((entry) => `template_workspaces/${entry}`)
		.filter((directory) => existsSync(path.join(repositoryRoot, directory, 'package.json')))
		.sort();
	const undeclared = actualDirectories.filter((directory) => !paths.has(directory));
	if (undeclared.length > 0) fail(`Undeclared template directories: ${undeclared.join(', ')}`);
	return {
		...catalogue,
		templates: [...catalogue.templates].sort((left, right) => left.key.localeCompare(right.key))
	};
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
const catalogue = loadCatalogue();

if (options.check && !options.updateLocal && !options.pushRemote && !options.output) {
	console.log(`Validated ${catalogue.templates.length} active template declarations.`);
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
for (const template of catalogue.templates) {
	const revision = projectTemplate(template, sourceRevision);
	const ref = `${catalogue.refNamespace}/${template.key}`;
	if (options.updateLocal) runGit(['update-ref', ref, revision]);
	entries.push({
		key: template.key,
		ref,
		revision,
		name: template.name,
		industry: template.industry,
		description: template.description,
		visibility: template.visibility,
		counts: template.counts,
		compatiblePod: template.compatiblePod
	});
	console.log(`${template.key}: ${ref} -> ${revision}`);
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
