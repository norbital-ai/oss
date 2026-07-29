import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Template discovery.
 *
 * There is no separate over-Git catalogue. A template declares itself by carrying
 * `norbital.template.json` at the root of its own tree, so the metadata travels with the
 * `git subtree split` projection and lands in every tenant fork. Core reads it from the
 * projected ref; nothing has to stay in sync across two files.
 */

export const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..'
);
const templatesRoot = path.join(repositoryRoot, 'template_workspaces');
export const templateRefNamespace = 'refs/heads/templates';
export const templateMetadataFile = 'norbital.template.json';

const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const countKeys = ['collections', 'apps', 'automations'];

function fail(message) {
	throw new Error(message);
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

/** Counts derived from the tree, so declared picker metadata cannot drift from reality. */
export function actualCounts(directory) {
	return {
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
}

function readMetadata(directoryName) {
	const directory = path.join(templatesRoot, directoryName);
	const metadataPath = path.join(directory, templateMetadataFile);
	if (!existsSync(metadataPath)) {
		fail(`Template directory ${directoryName} has no ${templateMetadataFile}.`);
	}
	const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
	if (metadata.schemaVersion !== 1) {
		fail(`${directoryName}/${templateMetadataFile} must use schemaVersion 1.`);
	}
	if (!keyPattern.test(metadata.key)) fail(`Invalid template key: ${metadata.key}`);
	if (metadata.key !== directoryName) {
		fail(`Template ${metadata.key} must live in template_workspaces/${metadata.key}.`);
	}
	for (const field of ['name', 'industry', 'description']) {
		if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
			fail(`Template ${metadata.key} needs ${field}.`);
		}
	}
	if (!['public', 'unlisted'].includes(metadata.visibility)) {
		fail(`Template ${metadata.key} has invalid visibility.`);
	}
	for (const key of countKeys) {
		if (!Number.isInteger(metadata.counts?.[key]) || metadata.counts[key] < 0) {
			fail(`Template ${metadata.key} has invalid ${key} count.`);
		}
	}
	if (!existsSync(path.join(directory, 'package.json'))) {
		fail(`Template ${metadata.key} has no package.json.`);
	}
	return {
		key: metadata.key,
		path: `template_workspaces/${metadata.key}`,
		directory,
		ref: `${templateRefNamespace}/${metadata.key}`,
		name: metadata.name,
		industry: metadata.industry,
		description: metadata.description,
		visibility: metadata.visibility,
		counts: { ...metadata.counts }
	};
}

/**
 * Every template workspace on disk, sorted by key. Presence on disk is the source of truth —
 * adding a template is adding a directory, not editing a list somewhere else.
 */
export function discoverTemplates(filter) {
	const directories = readdirSync(templatesRoot)
		.filter((entry) => statSync(path.join(templatesRoot, entry)).isDirectory())
		.filter((entry) => existsSync(path.join(templatesRoot, entry, 'package.json')))
		.sort();
	if (directories.length === 0) fail('No template workspaces found.');
	const templates = directories
		.map((entry) => readMetadata(entry))
		.filter((template) => filter === undefined || template.key === filter);
	if (templates.length === 0) fail(`No template matched ${filter}.`);
	return templates;
}
