import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	platformPackageKey,
	publicPackageDirectories,
	readPublicPackageEntries
} from './lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = readPublicPackageEntries(repositoryRoot);
const packageKey = platformPackageKey(entries);
const githubOutputIndex = process.argv.indexOf('--github-output');

if (githubOutputIndex >= 0) {
	const outputPath = process.argv[githubOutputIndex + 1];
	if (!outputPath) throw new Error('--github-output requires a path.');
	const versionByDirectory = new Map(
		publicPackageDirectories.map((directory) => [
			directory,
			entries.find((entry) => entry.name === `@norbital-ai/${directory}`)?.version
		])
	);
	appendFileSync(
		outputPath,
		[
			`package_key=${packageKey}`,
			`config_version=${versionByDirectory.get('config')}`,
			`platform_utils_version=${versionByDirectory.get('platform-utils')}`,
			`pod_version=${versionByDirectory.get('pod')}`,
			`std_version=${versionByDirectory.get('std')}`,
			`ui_version=${versionByDirectory.get('ui')}`
		].join('\n') + '\n'
	);
} else {
	console.log(`${JSON.stringify({ packageKey, entries }, null, 2)}\n`);
}
