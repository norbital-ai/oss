import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { discoverTemplates, repositoryRoot } from './lib/templates.mjs';

const podCli = path.join(
	repositoryRoot,
	'packages',
	'pod',
	'build',
	'bin',
	'invocation',
	'index.js'
);

for (const template of discoverTemplates()) {
	console.log(`Synchronizing ${template.key}...`);
	execFileSync(process.execPath, [podCli, 'sync'], {
		cwd: template.directory,
		stdio: 'inherit'
	});
}
