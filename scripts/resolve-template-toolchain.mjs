import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = path.join(repositoryRoot, 'release', 'templates.json');
const outputPath = path.join(repositoryRoot, 'release', 'template-toolchain.package.json');
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
	throw new Error(message);
}

function argumentsFrom(argv) {
	const options = { check: false, write: false, githubOutput: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--write') options.write = true;
		else if (argument === '--github-output') options.githubOutput = argv[++index];
		else fail(`Unknown argument: ${argument}`);
	}
	if (options.check === options.write) fail('Choose exactly one of --check or --write.');
	if (options.githubOutput === '') fail('--github-output requires a path.');
	return options;
}

function resolvedTemplateDependencies(packageName) {
	const result = JSON.parse(
		execFileSync('pnpm', ['--filter', packageName, 'list', '--depth', '0', '--json'], {
			cwd: repositoryRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		})
	);
	if (!Array.isArray(result) || result.length !== 1 || result[0]?.name !== packageName) {
		fail(`Could not resolve installed dependencies for ${packageName}.`);
	}
	return {
		dependencies: result[0].dependencies ?? {},
		devDependencies: result[0].devDependencies ?? {}
	};
}

export function resolveTemplateToolchain() {
	const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
	if (catalogue.schemaVersion !== 1 || !Array.isArray(catalogue.templates)) {
		fail('release/templates.json has an invalid template catalogue.');
	}
	const exactByName = new Map();
	const templates = [];
	for (const template of [...catalogue.templates].sort((left, right) =>
		left.key.localeCompare(right.key)
	)) {
		const manifestPath = path.join(repositoryRoot, template.path, 'package.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		const installed = resolvedTemplateDependencies(manifest.name);
		const namesByKind = {};
		for (const kind of ['dependencies', 'devDependencies']) {
			const names = [];
			for (const name of Object.keys(manifest[kind] ?? {}).sort()) {
				if (name.startsWith('@norbital-ai/')) continue;
				const exactVersion = installed[kind][name]?.version;
				if (typeof exactVersion !== 'string' || !exactVersionPattern.test(exactVersion)) {
					fail(`${manifest.name} ${kind} entry ${name} did not resolve to an exact version.`);
				}
				const previous = exactByName.get(name);
				if (previous && previous !== exactVersion) {
					fail(
						`Active templates resolve ${name} inconsistently (${previous} and ${exactVersion}).`
					);
				}
				exactByName.set(name, exactVersion);
				names.push(name);
			}
			namesByKind[kind] = names;
		}
		templates.push({ key: template.key, ...namesByKind });
	}
	const dependencies = Object.fromEntries(
		[...exactByName.entries()].sort(([left], [right]) => left.localeCompare(right))
	);
	const dependencyKey = createHash('sha256')
		.update(JSON.stringify(dependencies))
		.digest('hex')
		.slice(0, 16);
	return {
		name: '@norbital-ai/template-toolchain',
		version: '0.0.0',
		private: true,
		description: 'Exact external packages required by active Norbital template workspaces.',
		engines: { node: '>=26.0.0' },
		norbitalTemplateToolchain: {
			schemaVersion: 1,
			dependencyKey,
			templates
		},
		dependencies
	};
}

async function main() {
	const options = argumentsFrom(process.argv.slice(2));
	const resolved = resolveTemplateToolchain();
	const serialized = await format(JSON.stringify(resolved), {
		parser: 'json',
		useTabs: true,
		printWidth: 100
	});
	if (options.write) {
		writeFileSync(outputPath, serialized);
		console.log(
			`Wrote ${path.relative(repositoryRoot, outputPath)} (${resolved.norbitalTemplateToolchain.dependencyKey}).`
		);
	} else if (readFileSync(outputPath, 'utf8') !== serialized) {
		fail('release/template-toolchain.package.json is stale; run pnpm template-toolchain:write.');
	} else {
		console.log(
			`Validated ${resolved.norbitalTemplateToolchain.templates.length} template dependency sets (${resolved.norbitalTemplateToolchain.dependencyKey}).`
		);
	}
	if (options.githubOutput) {
		appendFileSync(
			options.githubOutput,
			`template_dependency_key=${resolved.norbitalTemplateToolchain.dependencyKey}\n`
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
