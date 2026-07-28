import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(
	readFileSync(path.join(repositoryRoot, 'release', 'templates.json'), 'utf8')
);
const podCli = path.join(
	repositoryRoot,
	'packages',
	'pod',
	'build',
	'bin',
	'invocation',
	'index.js'
);

for (const template of catalogue.templates ?? []) {
	const directory = path.join(repositoryRoot, template.path);
	console.log(`Synchronizing ${template.key}...`);
	execFileSync(process.execPath, [podCli, 'sync'], {
		cwd: directory,
		stdio: 'inherit'
	});
}
