import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { safeParse } from '@norbital-ai/std/json';

const localProtocol = /^(?:workspace|catalog|file|link|portal):/;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

function fail(message) {
	throw new Error(message);
}

function parseJsonFragment(text, label) {
	const parsed = safeParse(text);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		fail(`${label} is not a JSON object.`);
	}
	return parsed;
}

/** The index of the quote closing the JSON string literal that opens at `start`. */
const stringEnd = (output, start) => {
	for (let index = start + 1; index < output.length; index += 1) {
		// A backslash escapes whatever follows it, including a quote that would otherwise close here.
		if (output[index] === '\\') {
			index += 1;
			continue;
		}
		if (output[index] === '"') return index;
	}
	return output.length;
};

/** The index just past the balanced object or array opening at `start`, or `undefined` if unclosed. */
const balancedEnd = (output, start) => {
	let depth = 0;
	for (let index = start; index < output.length; index += 1) {
		const character = output[index];
		// Braces and brackets inside a string are text, so a string is skipped whole.
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

const reportCandidateFilename = (output, start) => {
	const end = balancedEnd(output, start);
	if (end === undefined) return undefined;
	const result = safeParse(output.slice(start, end));
	if (result === null || typeof result !== 'object') {
		// Lifecycle scripts may write JSON-like output before the pack report.
		return undefined;
	}
	const filename = Array.isArray(result) ? result[0]?.filename : result.filename;
	return filename ?? undefined;
};

export function packedArchiveFilename(output, label = 'package pack') {
	const candidatePattern = /^[\t ]*[\[{]/gm;
	for (const candidate of output.matchAll(candidatePattern)) {
		const start = candidate.index + candidate[0].search(/[\[{]/);
		const filename = reportCandidateFilename(output, start);
		if (filename) return filename;
	}
	fail(`${label} did not report an archive filename.`);
}

export function sha512Integrity(bytes) {
	return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function assertSha512Integrity(bytes, integrity, label = 'package archive') {
	if (!sha512Pattern.test(integrity)) fail(`${label} has invalid sha512 integrity.`);
	const actual = Buffer.from(sha512Integrity(bytes));
	const expected = Buffer.from(integrity);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		fail(`${label} does not match its declared sha512 integrity.`);
	}
}

function validatePublishedManifest(manifest, directory, expected = {}) {
	if (manifest.private) fail(`${manifest.name} is marked private.`);
	if (manifest.name !== (expected.name ?? `@norbital-ai/${directory}`)) {
		fail(`${directory} has unexpected package name ${manifest.name}.`);
	}
	if (!manifest.version) fail(`${manifest.name} has no version.`);
	if (expected.version && manifest.version !== expected.version) {
		fail(`${manifest.name} archive is ${manifest.version}; expected ${expected.version}.`);
	}
	if (manifest.license !== 'AGPL-3.0-only') {
		fail(`${manifest.name} must declare AGPL-3.0-only.`);
	}
	if (manifest.repository?.directory !== `packages/${directory}`) {
		fail(`${manifest.name} has an invalid repository directory.`);
	}
	if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
		fail(`${manifest.name} must publish publicly with provenance.`);
	}
	for (const section of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies'
	]) {
		for (const [name, version] of Object.entries(manifest[section] ?? {})) {
			if (localProtocol.test(version)) {
				fail(`${manifest.name} publishes ${section}.${name} with local protocol ${version}.`);
			}
		}
	}
}

const importTargets = (value) => {
	if (typeof value === 'string') return [value];
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	return Object.values(value).flatMap(importTargets);
};

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every relative package-import branch must name content that is actually in the archive. */
function validatePackageImports(manifest, archiveEntries) {
	for (const [specifier, conditions] of Object.entries(manifest.imports ?? {})) {
		for (const target of importTargets(conditions)) {
			if (!target.startsWith('./')) continue;
			const archivedTarget = `package/${target.slice(2)}`;
			const present = archivedTarget.includes('*')
				? archiveEntries.some((entry) =>
						new RegExp(
							`^${archivedTarget.split('*').map(escapeRegularExpression).join('.+')}$`
						).test(entry)
					)
				: archiveEntries.includes(archivedTarget);
			if (!present) fail(`${manifest.name} import ${specifier} targets missing ${target}.`);
		}
	}
}

export function inspectPackageArchive(
	archivePath,
	{ directory, expectedName, expectedVersion, repositoryLicense }
) {
	const archiveEntries = execFileSync('tar', ['-tzf', archivePath], {
		encoding: 'utf8'
	})
		.trim()
		.split('\n')
		.filter(Boolean);
	const nestedArchives = archiveEntries.filter((entry) => /\.(?:tgz|tar|tar\.gz)$/i.test(entry));
	if (nestedArchives.length > 0) {
		fail(`${directory} publishes generated package archives: ${nestedArchives.join(', ')}.`);
	}
	const manifestText = execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], {
		encoding: 'utf8'
	});
	const packagedLicense = execFileSync('tar', ['-xOf', archivePath, 'package/LICENSE'], {
		encoding: 'utf8'
	});
	if (packagedLicense !== repositoryLicense) {
		fail(`${directory} does not publish the repository license.`);
	}
	const manifest = parseJsonFragment(manifestText, `${directory} packed package manifest`);
	validatePublishedManifest(manifest, directory, {
		name: expectedName,
		version: expectedVersion
	});
	validatePackageImports(manifest, archiveEntries);
	return {
		manifest,
		integrity: sha512Integrity(readFileSync(archivePath))
	};
}
