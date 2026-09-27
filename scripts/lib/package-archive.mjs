import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { parseJson } from '@norbital-ai/std/json';

const isObject = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);
const isString = Schema.is(Schema.String);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const localProtocol = /^(?:workspace|catalog|file|link|portal):/;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

function fail(message) {
	throw new Error(message);
}

function parseJsonFragment(text, label) {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) {
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
	const result = parseJson(output.slice(start, end));
	if (!isObject(result)) {
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
	if (isString(value)) return [value];
	if (!isRecord(value)) return [];
	return Object.values(value).flatMap(importTargets);
};

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const matches = (pattern, value) =>
	pattern.includes('*')
		? new RegExp(`^${pattern.split('*').map(escapeRegularExpression).join('.+')}$`).test(value)
		: pattern === value;

/** Every relative `imports` and `exports` branch must name content that is actually in the archive. */
function validatePackageTargets(manifest, archiveEntries) {
	for (const section of ['imports', 'exports']) {
		const map = isString(manifest[section]) ? { '.': manifest[section] } : (manifest[section] ?? {});
		for (const [specifier, conditions] of Object.entries(map)) {
			for (const target of importTargets(conditions)) {
				if (!target.startsWith('./')) continue;
				const archivedTarget = `package/${target.slice(2)}`;
				if (!archiveEntries.some((entry) => matches(archivedTarget, entry))) {
					fail(`${manifest.name} ${section.slice(0, -1)} ${specifier} targets missing ${target}.`);
				}
			}
		}
	}
}

/**
 * Every `@norbital-ai/<pkg>[/<sub>]` string literal in first-party source must name an export of that package
 * (L-BOLT-1002): a `createRequire().resolve('@norbital-ai/bolt-server/next')` compiles and packs, and fails only when a
 * user runs it. `sources` is `[file, text][]`; `manifests` maps a package name to its manifest. Returns the offenders.
 */
export function unexportedSpecifiers(sources, manifests) {
	const offenders = [];
	for (const [file, text] of sources) {
		for (const [, name, sub] of text.matchAll(/['"](@norbital-ai\/[a-z0-9-]+)(\/[^'"`\s$]*)?['"]/g)) {
			const manifest = manifests.get(name);
			// a package we do not publish, or a prefix test (`id.startsWith('@norbital-ai/ui/')`), is no specifier
			if (manifest === undefined || sub?.endsWith('/')) continue;
			const exports = isString(manifest.exports) ? ['.'] : Object.keys(manifest.exports ?? { '.': '' });
			const key = `.${sub ?? ''}`;
			if (!exports.some((pattern) => matches(pattern, key))) offenders.push(`${file}: ${name}${sub ?? ''}`);
		}
	}
	return offenders;
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
	validatePackageTargets(manifest, archiveEntries);
	return {
		manifest,
		integrity: sha512Integrity(readFileSync(archivePath))
	};
}
