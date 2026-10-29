import {
	Config,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Redacted,
	Schema,
	Stream
} from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { stripVTControlCharacters } from 'node:util';
import { availableParallelism } from 'node:os';
import { TemplateManifest } from '@norbital-ai/bolt/engine';
import { readArtifact } from '@norbital-ai/bolt/artifact';
import { ReleaseJson, schemaSql } from '../compiler/artifact/index.ts';
import { workers } from './test.ts';

export const templateMetadataFile = 'norbital.template.json';
export type TemplateCounts = TemplateManifest['counts'];
export type Template = {
	slug: string;
	handle: string;
	directory: string;
	path: string;
	metadata: TemplateManifest;
	counts: TemplateCounts;
};
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const localDependency = /^(?:workspace|catalog|file|link|portal):/;
const Strings = Schema.Record(Schema.String, Schema.String);
const Package = Schema.Struct({
	private: Schema.optionalKey(Schema.Boolean),
	scripts: Schema.optionalKey(Strings),
	dependencies: Schema.optionalKey(Strings),
	devDependencies: Schema.optionalKey(Strings),
	optionalDependencies: Schema.optionalKey(Strings),
	peerDependencies: Schema.optionalKey(Strings)
});
export class TemplateError extends Schema.TaggedError<TemplateError>()('TemplateError', {
	message: Schema.String
}) {}
const fail = (message: string) => Effect.fail(new TemplateError({ message }));
const json = <A>(schema: Schema.Decoder<A>, file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
		Effect.mapError((error) => new TemplateError({ message: `${file}: ${error.message}` }))
	);
const environment = Config.all({
	PATH: Config.String('PATH'),
	HOME: Config.option(Config.String('HOME')),
	TMPDIR: Config.option(Config.String('TMPDIR')),
	CI: Config.option(Config.String('CI')),
	SSH_AUTH_SOCK: Config.option(Config.String('SSH_AUTH_SOCK')),
	GIT_SSH_COMMAND: Config.option(Config.String('GIT_SSH_COMMAND'))
}).pipe(
	Effect.map((config) => ({
		PATH: config.PATH,
		HOME: Option.getOrUndefined(config.HOME),
		TMPDIR: Option.getOrUndefined(config.TMPDIR),
		CI: Option.getOrUndefined(config.CI),
		SSH_AUTH_SOCK: Option.getOrUndefined(config.SSH_AUTH_SOCK),
		GIT_SSH_COMMAND: Option.getOrUndefined(config.GIT_SSH_COMMAND)
	}))
);
export const run = Effect.fn('bolt.templatesProcess')(function* (
	command: string,
	args: readonly string[],
	options: { cwd?: string } = {}
) {
	const env = yield* environment;
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(command, args, {
				cwd: options.cwd ?? process.cwd(),
				env
			});
			const [stdout, stderr, code] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: 3 }
			);
			if (code !== 0)
				return yield* fail(
					`${command} ${args.join(' ')} failed${[stdout, stderr].filter(Boolean).length ? `:\n${[stdout, stderr].filter(Boolean).join('\n').split('\n').slice(-80).join('\n')}` : ''}`
				);
			return stdout.trim();
		})
	);
});
/** The first-party registry and its token, if any. */
const registryAccess = Effect.gen(function* () {
	const registry = (yield* Config.String('NORBITAL_PACKAGE_REGISTRY').pipe(
		Config.withDefault('https://npm.pkg.github.com')
	)).trim();
	const token = yield* Config.option(Config.Redacted('NODE_AUTH_TOKEN'));
	return {
		registry,
		token:
			Option.isSome(token) && Redacted.value(token.value).trim() !== ''
				? Redacted.value(token.value).trim()
				: undefined
	};
});
export const registryConfiguration = Effect.gen(function* () {
	const { registry, token } = yield* registryAccess;
	const lines = [`@norbital-ai:registry=${registry}`];
	if (token !== undefined) lines.push(`//${new URL(registry).host}/:_authToken=${token}`);
	return `${lines.join('\n')}\n`;
});
export const actualCounts = Effect.fn('bolt.templateCounts')(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const count = Effect.fnUntraced(function* (folder: string, pattern: RegExp) {
		const dir = path.join(directory, folder);
		if (!(yield* fs.exists(dir))) return 0;
		let total = 0;
		for (const name of yield* fs.readDirectory(dir, { recursive: true }))
			if (
				pattern.test(name.split(path.sep).join('/')) &&
				(yield* fs.stat(path.join(dir, name))).type === 'File'
			)
				total += 1;
		return total;
	});
	const [models, apps, automations] = yield* Effect.all(
		[
			count('src/data/model', /^[^/]+\/\+model\.ts$/),
			count('src/app', /(?:^|\/)\+app\.ts$/),
			count('src/automation', /^\+[^/]+\.automation\.ts$/)
		],
		{ concurrency: 3 }
	);
	return { models, apps, automations };
});
export const discoverTemplates = Effect.fn('bolt.discoverTemplates')(function* (
	root: string = process.cwd(),
	filter?: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const templates: Template[] = [];
	for (const slug of (yield* fs.readDirectory(root)).sort()) {
		if (slug.startsWith('.')) continue;
		const directory = path.join(root, slug);
		if (
			(yield* fs.stat(directory)).type !== 'Directory' ||
			!(yield* fs.exists(path.join(directory, templateMetadataFile)))
		)
			continue;
		if (!slugPattern.test(slug)) return yield* fail(`Invalid template directory name: ${slug}`);
		const metadata = yield* json(TemplateManifest, path.join(directory, templateMetadataFile));
		if (!/^norbital_[a-z0-9_]+$/.test(metadata.key))
			return yield* fail(`Template ${slug} has an invalid organization handle: ${metadata.key}`);
		if (!(yield* fs.exists(path.join(directory, 'package.json'))))
			return yield* fail(`Template ${slug} has no package.json.`);
		templates.push({
			slug,
			handle: metadata.key,
			directory,
			path: slug,
			metadata,
			counts: metadata.counts
		});
	}
	if (templates.length === 0) return yield* fail('No templates found.');
	const selected = templates.filter(
		(template) => filter === undefined || template.slug === filter || template.handle === filter
	);
	if (selected.length === 0) return yield* fail(`No template matched ${filter}.`);
	return selected;
});
const BunLock = Schema.Struct({
	packages: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Unknown)))
});
/** bun.lock is JSON plus trailing commas. ponytail: the comma strip ignores strings; bun writes none that match. */
const bunJson = (lockfile: string) => lockfile.replace(/,(\s*[}\]])/g, '$1');
const parseBunLock = (lockfile: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
		bunJson(lockfile)
	).pipe(
		Effect.flatMap((raw) =>
			Schema.decodeUnknownEffect(BunLock)(raw).pipe(Effect.map((lock) => ({ raw, lock })))
		),
		Effect.mapError((error) => new TemplateError({ message: `bun.lock: ${error.message}` }))
	);
const identity = (entry: ReadonlyArray<unknown>) => {
	const id = typeof entry[0] === 'string' ? entry[0] : '';
	const at = id.lastIndexOf('@');
	return { name: id.slice(0, at), version: id.slice(at + 1) };
};
/** A bun lockfile without its `@norbital-ai/*` package entries; the workspace keeps its specifiers. */
export const withoutFirstParty = Effect.fnUntraced(function* (lockfile: string) {
	const { raw, lock } = yield* parseBunLock(lockfile);
	return JSON.stringify(
		{
			...raw,
			packages: Object.fromEntries(
				Object.entries(lock.packages ?? {}).filter(
					([, entry]) => !identity(entry).name.startsWith('@norbital-ai/')
				)
			)
		},
		null,
		2
	);
});
/** bun's node_modules lookup from the package at `key`: its own nest, each parent's, then the root. */
const resolveFrom = (packages: Readonly<Record<string, unknown>>, key: string, name: string) => {
	const parts = key.split('/'),
		scopes: string[] = [];
	for (let i = 0; i < parts.length; i++)
		scopes.push(parts[i]?.startsWith('@') ? `${parts[i]}/${parts[++i] ?? ''}` : (parts[i] ?? ''));
	for (let depth = scopes.length; depth >= 0; depth--) {
		const at = [...scopes.slice(0, depth), name].join('/');
		if (packages[at] !== undefined) return at;
	}
	return undefined;
};
const Meta = Schema.Struct({ peerDependencies: Schema.optionalKey(Strings) });
/** Each first-party package's exact peer pins against the version its install resolves for that peer. */
export const unsatisfiedFirstPartyPeers = Effect.fnUntraced(function* (lockfile: string) {
	const packages = (yield* parseBunLock(lockfile)).lock.packages ?? {};
	const problems: string[] = [];
	for (const [key, entry] of Object.entries(packages)) {
		const { name, version } = identity(entry);
		if (!name.startsWith('@norbital-ai/')) continue;
		const meta = Schema.decodeUnknownOption(Meta)(entry[2]);
		if (meta._tag === 'None') continue;
		for (const [peer, wanted] of Object.entries(meta.value.peerDependencies ?? {})) {
			if (!exactVersion.test(wanted)) continue;
			const at = resolveFrom(packages, key, peer),
				actual = at === undefined ? undefined : identity(packages[at] ?? []).version;
			if (actual !== undefined && actual !== wanted)
				problems.push(
					`${name}@${version} needs ${peer}@${wanted} but the install resolves ${peer}@${actual}`
				);
		}
	}
	return [...new Set(problems)];
});

export const checkTemplates = Effect.fn('bolt.templatesCheck')(function* (
	root: string = process.cwd(),
	filter?: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const all = yield* discoverTemplates(root);
	const selected = filter === undefined ? all : yield* discoverTemplates(root, filter);
	for (const template of selected) {
		const manifest = yield* json(Package, path.join(template.directory, 'package.json'));
		if (manifest.private !== true)
			return yield* fail(`Template ${template.slug} must remain a private application package.`);
		for (const name of ['build', 'test'])
			if (!manifest.scripts?.[name]?.trim())
				return yield* fail(`Template ${template.slug} needs a ${name} script.`);
		if (!exactVersion.test(manifest.dependencies?.['@norbital-ai/bolt'] ?? ''))
			return yield* fail(
				`Template ${template.slug} must pin @norbital-ai/bolt to an exact version.`
			);
		// bun config lives in package.json; a template carries no other package-manager settings
		for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc'])
			if (yield* fs.exists(path.join(template.directory, file)))
				return yield* fail(`${template.slug}: ${file} has no place in a bun template.`);
		for (const section of [
			'dependencies',
			'devDependencies',
			'optionalDependencies',
			'peerDependencies'
		] as const)
			for (const [name, version] of Object.entries(manifest[section] ?? {})) {
				if (localDependency.test(version))
					return yield* fail(
						`Template ${template.slug} cannot project ${section}.${name} with local protocol ${version}.`
					);
				if (name.startsWith('@norbital-ai/') && !exactVersion.test(version))
					return yield* fail(
						`${template.slug} depends on ${name}@${version} but does not exactly pin it`
					);
			}
		const lock = path.join(template.directory, 'bun.lock');
		if (!(yield* fs.exists(lock))) return yield* fail(`${template.slug}: missing bun.lock`);
		const problems = yield* unsatisfiedFirstPartyPeers(yield* fs.readFileString(lock));
		if (problems.length)
			return yield* fail(
				`Template ${template.slug} does not satisfy first-party peer pins:\n  ${problems.join('\n  ')}`
			);
		const counts = yield* actualCounts(template.directory);
		for (const key of ['models', 'apps', 'automations'] as const)
			if (template.counts[key] !== counts[key])
				return yield* fail(
					`Template ${template.slug} declares ${template.counts[key]} ${key} in ${templateMetadataFile}; found ${counts[key]}.`
				);
		const forbidden = [
			'seed_bank',
			...all
				.filter((other) => other.slug !== template.slug)
				.flatMap((other) => [`templates/${other.slug}`, `../${other.slug}`, `../../${other.slug}`])
		];
		for (const folder of ['src', 'tests']) {
			const dir = path.join(template.directory, folder);
			if (!(yield* fs.exists(dir))) continue;
			for (const name of yield* fs.readDirectory(dir, { recursive: true })) {
				if (
					!/\.(?:[cm]?[jt]sx?|svelte)$/.test(name) ||
					name
						.split(path.sep)
						.some((segment) => ['node_modules', '.git', '.norbital', 'build'].includes(segment))
				)
					continue;
				const file = path.join(dir, name);
				if ((yield* fs.stat(file)).type !== 'File') continue;
				const source = (yield* fs.readFileString(file))
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/(^|[^:])\/\/.*$/gm, '$1');
				for (const match of source.matchAll(
					/(?:\b(?:import|export)[^;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g
				)) {
					const specifier = (match[1] ?? '').replaceAll('\\', '/');
					if (
						specifier.startsWith('apps/') ||
						specifier.includes('/apps/') ||
						forbidden.some(
							(fragment) =>
								specifier === fragment ||
								specifier.startsWith(`${fragment}/`) ||
								specifier.includes(`/${fragment}/`) ||
								specifier.endsWith(`/${fragment}`)
						)
					)
						return yield* fail(`${template.slug} ${name} -> ${specifier}`);
				}
			}
		}
		for (const value of [
			...Object.values(manifest.dependencies ?? {}),
			...Object.values(manifest.devDependencies ?? {}),
			...Object.values(manifest.scripts ?? {})
		])
			if (
				['file:../../oss', 'file:../oss', 'file:.yalc', 'node ../../oss'].some((fragment) =>
					value.includes(fragment)
				)
			)
				return yield* fail(
					`${template.slug} package.json contains forbidden local dependency: ${value}`
				);
		if (yield* fs.exists(path.join(template.directory, '.norbital', 'migrations')))
			return yield* fail(
				`${template.slug}: committed migrations belong in migrations/, beside src/`
			);
		const artifactDir = path.join(template.directory, '.norbital', 'bundle');
		if (yield* fs.exists(artifactDir)) {
			const sql = (yield* fs.readDirectory(artifactDir)).filter((file) => file.endsWith('.sql'));
			if (sql.length !== 1 || sql[0] !== 'schema.sql')
				return yield* fail(`${template.slug}: the artifact holds one generated initial schema`);
			const artifact = yield* readArtifact(artifactDir);
			if (
				(yield* fs.readFileString(path.join(artifactDir, 'schema.sql'))) !==
				schemaSql(artifact.manifest)
			)
				return yield* fail(
					`${template.slug}: generated schema differs from the native initial plan`
				);
		}
	}
	yield* Console.log(`Validated ${selected.length} template declarations.`);
});
export type TemplateRunner = (
	command: string,
	args: readonly string[],
	options?: { cwd?: string }
) => Effect.Effect<
	string,
	| Effect.Error<ReturnType<typeof run>>
	| Effect.Error<ReturnType<FileSystem.FileSystem['readFileString']>>,
	Effect.Services<ReturnType<typeof run>> | FileSystem.FileSystem | Path.Path
>;
export const resolveLockfile = Effect.fn('bolt.resolveTemplateLock')(function* (
	template: Template,
	execute: TemplateRunner = run,
	/** One run's store and metadata cache, shared by its templates: fresh per run, fetched once instead of per template. */
	shared?: string
) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: `norbital-lock-${template.slug}-` });
			for (const file of ['package.json', 'bunfig.toml'])
				if (yield* fs.exists(path.join(template.directory, file)))
					yield* fs.copyFile(path.join(template.directory, file), path.join(dir, file));
			// first-party entries always re-resolve from the registry: a version republished under the same number keeps
			// its locked integrity otherwise, and the stale lock surfaces only when a host installs it
			const committed = path.join(template.directory, 'bun.lock');
			if (yield* fs.exists(committed))
				yield* fs.writeFileString(
					path.join(dir, 'bun.lock'),
					yield* withoutFirstParty(yield* fs.readFileString(committed))
				);
			yield* fs.writeFileString(path.join(dir, '.npmrc'), yield* registryConfiguration);
			yield* execute(
				'bun',
				[
					'install',
					'--lockfile-only',
					'--ignore-scripts',
					`--cache-dir=${path.join(shared ?? dir, '.bun-cache')}`
				],
				{ cwd: dir }
			);
			if (!(yield* fs.exists(path.join(dir, 'bun.lock'))))
				return yield* fail(`Resolving ${template.slug} produced no bun.lock.`);
			return yield* fs.readFileString(path.join(dir, 'bun.lock'));
		})
	);
});
const Toolchain = Schema.Struct({
	firstParty: Schema.Struct({
		dependencies: Schema.Array(Schema.String),
		devDependencies: Schema.Array(Schema.String)
	}),
	dependencies: Strings,
	devDependencies: Strings
});
const Packument = Schema.Struct({
	versions: Schema.Record(
		Schema.String,
		Schema.Struct({ dist: Schema.Struct({ tarball: Schema.String }) })
	)
});
/** The `toolchain.json` a published Bolt release carries, read from its registry tarball. */
const publishedToolchain = Effect.fn('bolt.publishedToolchain')(
	function* (version: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const http = yield* HttpClient.HttpClient;
		const { registry, token } = yield* registryAccess;
		const get = (url: string) =>
			HttpClientRequest.get(url).pipe(
				token === undefined ? (request) => request : HttpClientRequest.bearerToken(token),
				http.execute,
				Effect.flatMap(HttpClientResponse.filterStatusOk)
			);
		const packument = yield* get(`${registry.replace(/\/$/, '')}/@norbital-ai%2fbolt`).pipe(
			Effect.flatMap(HttpClientResponse.schemaBodyJson(Packument))
		);
		const release = packument.versions[version];
		if (release === undefined)
			return yield* fail(`@norbital-ai/bolt@${version} is not published on ${registry}`);
		const bytes = yield* get(release.dist.tarball).pipe(
			Effect.flatMap((response) => response.arrayBuffer)
		);
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: `norbital-bolt-${version}-` });
		yield* fs.writeFile(path.join(dir, 'bolt.tgz'), new Uint8Array(bytes));
		yield* run('tar', ['-xzf', 'bolt.tgz', 'package/toolchain.json'], { cwd: dir });
		return yield* json(Toolchain, path.join(dir, 'package', 'toolchain.json'));
	},
	Effect.scoped,
	Effect.provide(FetchHttpClient.layer),
	Effect.catchTags({
		HttpClientError: (error) => fail(`fetching @norbital-ai/bolt: ${error.message}`),
		SchemaError: (error) => fail(`@norbital-ai/bolt packument: ${error.message}`)
	})
);
/**
 * A template's toolchain: the `toolchain.json` its own exact `@norbital-ai/bolt` pin publishes (exact third-party
 * versions; first-party packages at that release's version), read from its installed Bolt at that pin, else fetched
 * for that exact release. Templates on different Bolt releases each get their own release's set.
 */
export const toolchainOf = Effect.fn('bolt.templateToolchain')(function* (template: Template) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const manifest = yield* json(Package, path.join(template.directory, 'package.json'));
	const version = manifest.dependencies?.['@norbital-ai/bolt'] ?? '';
	if (!exactVersion.test(version))
		return yield* fail(`Template ${template.slug} must pin @norbital-ai/bolt to an exact version.`);
	const installed = path.join(template.directory, 'node_modules', '@norbital-ai', 'bolt');
	const local =
		(yield* fs.exists(path.join(installed, 'toolchain.json'))) &&
		(yield* json(Schema.Struct({ version: Schema.String }), path.join(installed, 'package.json')))
			.version === version;
	const set = local
		? yield* json(Toolchain, path.join(installed, 'toolchain.json'))
		: yield* publishedToolchain(version);
	const pinned = (names: ReadonlyArray<string>) =>
		Object.fromEntries(names.map((name) => [name, version]));
	return {
		version,
		dependencies: { ...pinned(set.firstParty.dependencies), ...set.dependencies },
		devDependencies: { ...pinned(set.firstParty.devDependencies), ...set.devDependencies }
	};
});
/** A template's package.json with the toolchain written in: each toolchain package in its section, at its version. */
export const withToolchain = Effect.fnUntraced(function* (
	slug: string,
	text: string,
	set: Effect.Success<ReturnType<typeof toolchainOf>>
) {
	const raw = yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
	)(text).pipe(
		Effect.mapError((error) => new TemplateError({ message: `${slug}: ${error.message}` }))
	);
	const manifest = yield* Schema.decodeUnknownEffect(Package)(raw).pipe(
		Effect.mapError((error) => new TemplateError({ message: `${slug}: ${error.message}` }))
	);
	const section = (
		wanted: Record<string, string>,
		other: Record<string, string>,
		current: Record<string, string> = {}
	) => ({
		...Object.fromEntries(Object.entries(current).filter(([name]) => !(name in other))),
		...wanted
	});
	return `${JSON.stringify(
		{
			...raw,
			dependencies: section(set.dependencies, set.devDependencies, manifest.dependencies),
			devDependencies: section(set.devDependencies, set.dependencies, manifest.devDependencies)
		},
		null,
		'\t'
	)}\n`;
});
export const lockTemplates = Effect.fn('bolt.templatesLock')(function* (options: {
	root?: string;
	filter?: string;
	check: boolean;
}) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = options.root ?? process.cwd();
			const templates = yield* discoverTemplates(root, options.filter);
			const drifted: string[] = [];
			const resolution = yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-lock-shared-' });
			// network-bound resolutions sharing one store and metadata cache
			yield* Effect.forEach(
				templates,
				Effect.fnUntraced(function* (template) {
					const manifestPath = path.join(template.directory, 'package.json'),
						manifest = yield* fs.readFileString(manifestPath),
						set = yield* toolchainOf(template),
						tooled = yield* withToolchain(template.slug, manifest, set);
					if (options.check && tooled !== manifest)
						drifted.push(
							`${template.slug}: package.json differs from the toolchain set of its @norbital-ai/bolt@${set.version}`
						);
					else if (!options.check && tooled !== manifest)
						yield* fs.writeFileString(manifestPath, tooled);
					const committedPath = path.join(template.directory, 'bun.lock');
					const resolved = yield* resolveLockfile(template, run, resolution);
					const committed = (yield* fs.exists(committedPath))
						? yield* fs.readFileString(committedPath)
						: undefined;
					if (options.check && committed !== resolved)
						drifted.push(
							`${template.slug}: ${committed === undefined ? 'missing bun.lock' : 'bun.lock does not match resolved dependencies'}`
						);
					else if (!options.check && committed !== resolved)
						yield* fs.writeFileString(committedPath, resolved);
				}),
				{ concurrency: 4, discard: true }
			);
			if (drifted.length)
				return yield* fail(
					`Template lockfiles are stale. Run \`bun run templates:lock\`.\n  ${drifted.join('\n  ')}`
				);
		})
	);
});

const inside = Effect.fnUntraced(function* (root: string, candidate: string, label: string) {
	const path = yield* Path.Path;
	const relative = path.relative(root, candidate);
	if (
		relative === '' ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		return yield* fail(`${label} escapes ${root}: ${candidate}`);
	return relative;
});
export const materializeCandidate = Effect.fn('bolt.templateProjection')(function* (
	root: string,
	template: Template,
	destination: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (
		(yield* fs.realPath(template.directory)) !== path.resolve(template.directory) ||
		(yield* fs.stat(template.directory)).type !== 'Directory'
	)
		return yield* fail(`Template root must be a real directory: ${template.directory}`);
	const candidates = [
		...new Set(
			(yield* run(
				'git',
				['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', template.path],
				{ cwd: root }
			)).split('\0')
		)
	].filter(Boolean);
	let copied = 0;
	for (const candidate of candidates) {
		const source = path.resolve(root, candidate);
		const relative = yield* inside(template.directory, source, 'Template candidate');
		if (!(yield* fs.exists(source))) continue;
		if ((yield* fs.realPath(source)) !== source)
			return yield* fail(`Template projection refuses symbolic link: ${source}`);
		if ((yield* fs.stat(source)).type !== 'File')
			return yield* fail(`Template projection refuses non-regular file: ${source}`);
		const target = path.resolve(destination, relative);
		yield* inside(destination, target, 'Template projection target');
		yield* fs.makeDirectory(path.dirname(target), { recursive: true });
		yield* fs.copyFile(source, target);
		copied += 1;
	}
	if (copied === 0) return yield* fail(`Template ${template.slug} has no candidate files.`);
});
/** Template directories with changes since `since` (the working tree and untracked files included); none when git
 * cannot resolve it (a first push, a rewritten history), so every template is verified. */
export const changedSince = Effect.fn('bolt.templatesChanged')(function* (
	root: string,
	since: string
) {
	const listed = yield* Effect.all([
		run('git', ['diff', '--name-only', since, '--', '.'], { cwd: root }),
		run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root })
	]).pipe(Effect.option);
	return Option.map(
		listed,
		(outputs) =>
			new Set(
				outputs
					.join('\n')
					.split('\n')
					.filter(Boolean)
					.map((file) => file.split('/')[0])
			)
	);
});
// ponytail: a fixed bound; each template's build or projection peaks near 1 GB (the compiler, the checker), so half the
// cores, at most 3
const bound = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));
/** A run's `Test Files` and `Tests` lines, one line. */
const summary = (output: string) =>
	stripVTControlCharacters(output)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^(Test Files|Tests)\s/.test(line))
		.join('; ');
/**
 * Every template (or those `only` names, by directory or handle) through its own `test` script, its own `bolt test`:
 * standalone, on its own pins and its own Vitest. `bound` run at once and share the machine's workers.
 */
export const testTemplates = Effect.fn('bolt.templatesTest')(function* (
	root: string = process.cwd(),
	only?: readonly string[],
	args: readonly string[] = []
) {
	const all = yield* discoverTemplates(root);
	const unmatched = (only ?? []).filter(
		(name) => !all.some((template) => template.slug === name || template.handle === name)
	);
	if (unmatched.length > 0) return yield* fail(`No template matched ${unmatched.join(', ')}.`);
	const templates =
		only === undefined
			? all
			: all.filter((template) => only.includes(template.slug) || only.includes(template.handle));
	const concurrency = Math.min(bound, workers);
	const share = `--maxWorkers=${Math.max(1, Math.floor(workers / concurrency))}`;
	const failed = yield* Effect.forEach(
		templates,
		(template) =>
			run('bun', ['run', 'test', '.', share, ...args], { cwd: template.directory }).pipe(
				Effect.flatMap((output) => Console.log(`${template.slug}: ${summary(output)}`)),
				Effect.as(undefined),
				Effect.catchTag('TemplateError', (error) =>
					Console.error(`${template.slug} failed: ${error.message}`).pipe(Effect.as(template.slug))
				)
			),
		{ concurrency }
	);
	const names = failed.filter((slug) => slug !== undefined);
	if (names.length > 0) return yield* fail(`Template suites failed: ${names.join(', ')}.`);
});
export type TemplateTester = (
	root: string,
	only: readonly string[]
) => Effect.Effect<
	void,
	Effect.Error<ReturnType<typeof testTemplates>>,
	Effect.Services<ReturnType<typeof testTemplates>>
>;
/**
 * Each template as a tenant receives it: its tracked files alone, installed from its frozen lock, checked and built
 * once; then each projection's own `bolt test` through `bolt templates test`, against that build.
 * Unfiltered, it verifies the templates changed since `origin/main`.
 */
export const verifyTemplates = Effect.fn('bolt.templatesVerify')(function* (
	root: string = process.cwd(),
	filter?: string,
	test: TemplateTester = testTemplates
) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const since = 'origin/main';
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-template-projections-' });
			const all = yield* discoverTemplates(root, filter);
			const changed = filter !== undefined ? Option.none() : yield* changedSince(root, since);
			const templates = Option.match(changed, {
				onNone: () => all,
				onSome: (paths) => all.filter((template) => paths.has(template.path))
			});
			if (templates.length < all.length)
				yield* Console.log(
					`Verifying ${templates.length} of ${all.length} templates changed since ${since} (name one to verify it alone).`
				);
			const credentials = yield* registryConfiguration;
			const prepare = Effect.fnUntraced(function* (template: Template) {
				const destination = path.join(dir, template.slug);
				yield* fs.makeDirectory(destination, { recursive: true });
				yield* materializeCandidate(root, template, destination);
				const npmrc = path.join(destination, '.npmrc');
				yield* fs.writeFileString(npmrc, credentials);
				const step = (label: string, command: string, args: readonly string[]) =>
					run(command, args, { cwd: destination }).pipe(
						Effect.mapError(
							(error) =>
								new TemplateError({
									message: `${template.slug} standalone ${label} failed: ${error.message}`
								})
						)
					);
				yield* step('install', 'bun', ['install', '--frozen-lockfile']);
				yield* fs.remove(npmrc);
				const bolt = path.join(destination, 'node_modules', '.bin', 'bolt');
				yield* step('check', bolt, ['check', '.']);
				// the one build: the tests below run against it
				yield* step('build', bolt, ['build', '.']);
			});
			yield* Effect.forEach(templates, prepare, { concurrency: bound, discard: true });
			if (templates.length > 0)
				yield* test(
					dir,
					templates.map((template) => template.slug)
				);
			for (const template of templates) {
				const artifact = path.join(dir, template.slug, '.norbital', 'release.json');
				if (!(yield* fs.exists(artifact)))
					return yield* fail(`${template.slug} bolt build emitted no ${artifact}.`);
				yield* Console.log(`Validated clean standalone projection: ${template.slug}.`);
			}
		})
	);
});
/**
 * `bolt templates publish --out=<dir>`: each built template's release (`.norbital/release.json`) as the objects CI
 * uploads under the release store's `releases/`: `bundle/<b>.tar.gz`, `source/<s>.tar.gz`, `seed/<p>.tar.gz` and
 * `template/<directory>/<b>.json`, named by the digests `bolt build` recorded. `env deploy promote` names the bundle.
 */
export const publishTemplates = Effect.fn('bolt.templatesPublish')(function* (options: {
	root?: string;
	out: string;
	filter?: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = options.root ?? process.cwd(),
		out = path.resolve(root, options.out);
	for (const template of yield* discoverTemplates(root, options.filter)) {
		const built = path.join(template.directory, '.norbital');
		if (!(yield* fs.exists(path.join(built, 'release.json'))))
			return yield* fail(`${template.slug} has no .norbital/release.json; run bolt build`);
		const release = yield* json(ReleaseJson, path.join(built, 'release.json'));
		const parts: ReadonlyArray<readonly [string, string]> = [
			['bundle', release.bundle],
			['source', release.source],
			// the `test` pack is the template's own test data: built and digested, never published
			...Object.entries(release.seed)
				.filter(([pack]) => pack !== 'test')
				.map(([pack, digest]) => [`seed/${pack}`, digest] as const)
		];
		for (const [part, digest] of parts) {
			const object = path.join(out, part.startsWith('seed/') ? 'seed' : part, `${digest}.tar.gz`);
			yield* fs.makeDirectory(path.dirname(object), { recursive: true });
			if (!(yield* fs.exists(object)))
				// a part's files and directories only: macOS tar would add `._*` entries for extended attributes
				yield* run(
					'env',
					['COPYFILE_DISABLE=1', 'tar', '-czf', object, '-C', path.join(built, part), '.'],
					{
						cwd: root
					}
				);
		}
		const record = path.join(out, 'template', template.slug, `${release.bundle}.json`);
		yield* fs.makeDirectory(path.dirname(record), { recursive: true });
		yield* fs.copyFile(path.join(built, 'release.json'), record);
		yield* Console.log(`${template.slug}: bundle ${release.bundle.slice(0, 12)}`);
	}
});
const optional = (name: string) => Flag.String(name).pipe(Flag.optional);
const boolean = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false));
const checkCommand = Command.make('check', { filter: optional('filter') }, ({ filter }) =>
	checkTemplates(process.cwd(), Option.getOrUndefined(filter))
);
const lockCommand = Command.make(
	'lock',
	{ filter: optional('filter'), check: boolean('check') },
	({ filter, check }) =>
		lockTemplates({
			check,
			...(Option.isSome(filter) ? { filter: filter.value } : {})
		})
);
const testCommand = Command.make(
	'test',
	{
		only: optional('only').pipe(
			Flag.withDescription(
				'comma-separated template directories or handles; every template when absent'
			)
		),
		args: Argument.variadic(Argument.String('args'))
	},
	({ only, args }) =>
		testTemplates(
			process.cwd(),
			Option.match(only, {
				onNone: () => undefined,
				onSome: (names) =>
					names
						.split(',')
						.map((name) => name.trim())
						.filter(Boolean)
			}),
			args
		)
);
const verifyCommand = Command.make('verify', { filter: optional('filter') }, ({ filter }) =>
	verifyTemplates(process.cwd(), Option.getOrUndefined(filter))
);
const publishCommand = Command.make(
	'publish',
	{ out: Flag.String('out'), filter: optional('filter') },
	({ out, filter }) =>
		publishTemplates({ out, ...(Option.isSome(filter) ? { filter: filter.value } : {}) })
);
export const templatesCommand = Command.make('templates').pipe(
	Command.withSubcommands([checkCommand, lockCommand, testCommand, verifyCommand, publishCommand])
);
