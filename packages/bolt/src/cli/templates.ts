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
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess } from 'effect/unstable/process';
import { availableParallelism } from 'node:os';
import { TemplateManifest } from '../protocol/schema.ts';
import { readArtifact } from '../engine/artifact/read.ts';
import { schemaSql } from '../compiler/artifact/index.ts';

export const templateMetadataFile = 'norbital.template.json';
export const templateRefNamespace = 'refs/heads/templates';
export type TemplateCounts = TemplateManifest['counts'];
export type Template = {
	slug: string;
	handle: string;
	directory: string;
	path: string;
	ref: string;
	metadata: TemplateManifest;
	counts: TemplateCounts;
};
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const revisionPattern = /^[0-9a-f]{40}$/;
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
	PATH: Config.string('PATH'),
	HOME: Config.option(Config.string('HOME')),
	TMPDIR: Config.option(Config.string('TMPDIR')),
	CI: Config.option(Config.string('CI')),
	SSH_AUTH_SOCK: Config.option(Config.string('SSH_AUTH_SOCK')),
	GIT_SSH_COMMAND: Config.option(Config.string('GIT_SSH_COMMAND'))
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
export const registryConfiguration = Effect.gen(function* () {
	const registry = (yield* Config.string('NORBITAL_PACKAGE_REGISTRY').pipe(
		Config.withDefault('https://npm.pkg.github.com')
	)).trim();
	const token = yield* Config.option(Config.redacted('NODE_AUTH_TOKEN'));
	const lines = [`@norbital-ai:registry=${registry}`];
	if (Option.isSome(token) && Redacted.value(token.value).trim() !== '')
		lines.push(`//${new URL(registry).host}/:_authToken=${Redacted.value(token.value).trim()}`);
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
	const [collections, apps, automations] = yield* Effect.all(
		[
			count('src/data/model', /^\+[^/]+\.model\.ts$/),
			count('src/app', /(?:^|\/)\+app\.ts$/),
			count('src/automation', /^\+[^/]+\.automation\.ts$/)
		],
		{ concurrency: 3 }
	);
	return { collections, apps, automations };
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
			ref: `${templateRefNamespace}/${slug}`,
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
/** A pnpm lockfile without its `@norbital-ai/*` package and snapshot entries; importers keep their specifiers. */
export const withoutFirstParty = (lockfile: string): string =>
	lockfile
		.split(/\n(?=\S|  \S)/)
		.filter((block) => !/^  '?@norbital-ai\//.test(block))
		.join('\n');
export const unsatisfiedFirstPartyPeers = (lockfile: string): string[] => {
	const declared = new Map<string, Map<string, string>>();
	for (const block of lockfile.split(/\n(?=  '@norbital-ai\/)/)) {
		const header = /^ {2}'(@norbital-ai\/[^@']+@[^(':]+)':\n/.exec(block);
		const peers = /\n {4}peerDependencies:\n((?: {6}.+\n?)+)/.exec(block);
		if (header?.[1] === undefined || peers?.[1] === undefined) continue;
		const exact = new Map<string, string>();
		for (const line of peers[1].split('\n')) {
			const peer = /^ {6}'?([^':]+)'?: (\S+)$/.exec(line);
			if (peer?.[1] !== undefined && peer[2] !== undefined && exactVersion.test(peer[2]))
				exact.set(peer[1], peer[2]);
		}
		if (exact.size > 0) declared.set(header[1], exact);
	}
	const problems: string[] = [];
	for (const match of lockfile.matchAll(/^ {2}'(@norbital-ai\/[^@']+@[^(':]+)(\(.*\))':$/gm)) {
		const exact = declared.get(match[1] ?? '');
		if (exact === undefined) continue;
		// Top-level `(name@version)` groups only; nested groups are the peers' own peers.
		const resolved = new Map<string, string>();
		let depth = 0;
		let start = 0;
		for (const [index, character] of [...(match[2] ?? '')].entries()) {
			if (character === '(' && depth++ === 0) start = index + 1;
			if (character === ')' && --depth === 0) {
				const group = (match[2] ?? '').slice(start, index).replace(/\(.*$/, '');
				const at = group.lastIndexOf('@');
				if (at > 0) resolved.set(group.slice(0, at), group.slice(at + 1));
			}
		}
		for (const [peer, version] of exact) {
			const actual = resolved.get(peer);
			if (actual !== undefined && actual !== version)
				problems.push(
					`${match[1]} needs ${peer}@${version} but the install resolves ${peer}@${actual}`
				);
		}
	}
	return [...new Set(problems)];
};

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
		for (const name of ['lint', 'check', 'build', 'test'])
			if (!manifest.scripts?.[name]?.trim())
				return yield* fail(`Template ${template.slug} needs a ${name} script.`);
		for (const name of ['prettier', 'prettier-plugin-svelte', 'svelte-check', 'typescript'])
			if (manifest.devDependencies?.[name] === undefined)
				return yield* fail(`Template ${template.slug} needs standalone dev dependency ${name}.`);
		if (!exactVersion.test(manifest.dependencies?.['@norbital-ai/bolt'] ?? ''))
			return yield* fail(
				`Template ${template.slug} must pin @norbital-ai/bolt to an exact version.`
			);
		const policy = yield* fs.readFileString(path.join(template.directory, 'pnpm-workspace.yaml'));
		const exempted = new Map(
			[...policy.matchAll(/'(@[^']+?)@([^']*)'/g)].flatMap((match) =>
				match[1] === undefined || match[2] === undefined
					? []
					: [[match[1], match[2].split('||').map((entry) => entry.trim())] as const]
			)
		);
		if (/@norbital-ai\/\*/.test(policy))
			return yield* fail(`${template.slug}: first-party exemptions must name exact versions.`);
		if (
			!/supportedArchitectures:/.test(policy) ||
			['darwin', 'linux', 'win32', 'x64', 'arm64', 'glibc', 'musl'].some(
				(architecture) => !new RegExp(`- ${architecture}`).test(policy)
			)
		)
			return yield* fail(`${template.slug}: declare every supported architecture.`);
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
				if (
					name.startsWith('@norbital-ai/') &&
					(!exactVersion.test(version) || !exempted.get(name)?.includes(version))
				)
					return yield* fail(
						`${template.slug} depends on ${name}@${version} but does not exactly pin and exempt it`
					);
			}
		const lock = path.join(template.directory, 'pnpm-lock.yaml');
		if (!(yield* fs.exists(lock))) return yield* fail(`${template.slug}: missing pnpm-lock.yaml`);
		const problems = unsatisfiedFirstPartyPeers(yield* fs.readFileString(lock));
		if (problems.length)
			return yield* fail(
				`Template ${template.slug} does not satisfy first-party peer pins:\n  ${problems.join('\n  ')}`
			);
		const counts = yield* actualCounts(template.directory);
		for (const key of ['collections', 'apps', 'automations'] as const)
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
				`${template.slug}: schema comes from the manifest, not maintained migrations`
			);
		const artifactDir = path.join(template.directory, '.norbital', 'artifact');
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
			for (const file of ['package.json', 'pnpm-workspace.yaml', 'isolated-vm.patch'])
				if (yield* fs.exists(path.join(template.directory, file)))
					yield* fs.copyFile(path.join(template.directory, file), path.join(dir, file));
			// first-party entries always re-resolve from the registry: a version republished under the same number keeps
			// its locked integrity otherwise, and the stale lock surfaces only when a host installs it
			const committed = path.join(template.directory, 'pnpm-lock.yaml');
			if (yield* fs.exists(committed))
				yield* fs.writeFileString(
					path.join(dir, 'pnpm-lock.yaml'),
					withoutFirstParty(yield* fs.readFileString(committed))
				);
			yield* fs.writeFileString(path.join(dir, '.npmrc'), yield* registryConfiguration);
			const stores = [
				'--store-dir',
				path.join(shared ?? dir, '.pnpm-store'),
				'--cache-dir',
				path.join(shared ?? dir, '.pnpm-cache')
			];
			yield* execute('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', ...stores], {
				cwd: dir
			});
			// `install` skips resolution while the importers still match, so the dropped first-party entries need `update`
			yield* execute('pnpm', ['update', '@norbital-ai/*', '--lockfile-only', ...stores], {
				cwd: dir
			});
			if (!(yield* fs.exists(path.join(dir, 'pnpm-lock.yaml'))))
				return yield* fail(`Resolving ${template.slug} produced no pnpm-lock.yaml.`);
			return yield* fs.readFileString(path.join(dir, 'pnpm-lock.yaml'));
		})
	);
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
					const committedPath = path.join(template.directory, 'pnpm-lock.yaml');
					const resolved = yield* resolveLockfile(template, run, resolution);
					const committed = (yield* fs.exists(committedPath))
						? yield* fs.readFileString(committedPath)
						: undefined;
					if (options.check && committed !== resolved)
						drifted.push(
							`${template.slug}: ${committed === undefined ? 'missing pnpm-lock.yaml' : 'pnpm-lock.yaml does not match resolved dependencies'}`
						);
					else if (!options.check && committed !== resolved)
						yield* fs.writeFileString(committedPath, resolved);
				}),
				{ concurrency: 4, discard: true }
			);
			if (drifted.length)
				return yield* fail(
					`Template lockfiles are stale. Run \`pnpm templates:lock\`.\n  ${drifted.join('\n  ')}`
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
/**
 * Each template as a tenant receives it: its tracked files alone, installed offline from its committed lock (fetched
 * once into the shared store, so a lock that cannot install without the network fails here), built, then its suite.
 * `NORBITAL_TEMPLATES_SINCE` (default `origin/main`; `all` for every template) limits it to the templates changed
 * since that revision. A `check` or `lint` script that the build or the repository's own format check already runs is
 * not run twice.
 */
export const verifyTemplates = Effect.fn('bolt.templatesVerify')(function* (
	root: string = process.cwd(),
	filter?: string
) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const keep = yield* Config.string('KEEP_TEMPLATE_PROJECTIONS').pipe(Config.withDefault('0'));
			const since = yield* Config.string('NORBITAL_TEMPLATES_SINCE').pipe(
				Config.withDefault('origin/main')
			);
			const dir =
				keep === '1'
					? yield* fs.makeTempDirectory({ prefix: 'norbital-template-projections-' })
					: yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-template-projections-' });
			if (keep === '1')
				yield* Effect.addFinalizer(() => Console.log(`Kept standalone projections at ${dir}.`));
			const all = yield* discoverTemplates(root, filter);
			const changed =
				filter !== undefined || since === 'all' ? Option.none() : yield* changedSince(root, since);
			const templates = Option.match(changed, {
				onNone: () => all,
				onSome: (paths) => all.filter((template) => paths.has(template.path))
			});
			if (templates.length < all.length)
				yield* Console.log(
					`Verifying ${templates.length} of ${all.length} templates changed since ${since} (NORBITAL_TEMPLATES_SINCE=all for every one).`
				);
			const credentials = yield* registryConfiguration;
			const verify = Effect.fnUntraced(function* (template: Template) {
				const destination = path.join(dir, template.slug);
				yield* fs.makeDirectory(destination, { recursive: true });
				yield* materializeCandidate(root, template, destination);
				const npmrc = path.join(destination, '.npmrc');
				yield* fs.writeFileString(npmrc, credentials);
				const pnpm = (label: string, args: readonly string[]) =>
					run('pnpm', args, { cwd: destination }).pipe(
						Effect.mapError(
							(error) =>
								new TemplateError({
									message: `${template.slug} standalone ${label} failed: ${error.message}`
								})
						)
					);
				yield* pnpm('fetch', ['fetch', '--frozen-lockfile']);
				yield* fs.remove(npmrc);
				yield* pnpm('install', ['install', '--frozen-lockfile', '--offline']);
				const scripts =
					(yield* json(Package, path.join(destination, 'package.json'))).scripts ?? {};
				const suite = scripts['test'] ?? '';
				const banked = suite.includes('--bank');
				if (scripts['check'] !== 'bolt check') yield* pnpm('check', ['check']);
				if (banked || !/\bbolt build\b/.test(suite))
					yield* pnpm('build', ['exec', 'bolt', 'build']);
				if (scripts['lint'] !== 'prettier --check .') yield* pnpm('lint', ['lint']);
				if (banked)
					yield* Console.log(
						`${template.slug}: its suite reads the seed bank; the local gate runs it.`
					);
				else yield* pnpm('test', ['test']);
				const artifact = path.join(destination, '.norbital', 'artifact', 'artifact.json');
				if (!(yield* fs.exists(artifact)))
					return yield* fail(`${template.slug} bolt build emitted no ${artifact}.`);
				yield* Console.log(`Validated clean standalone projection: ${template.slug}.`);
			});
			// ponytail: a fixed bound; each projection peaks near 1 GB (vitest + svelte-check), so half the cores, at most 3
			yield* Effect.forEach(templates, verify, {
				concurrency: Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2))),
				discard: true
			});
		})
	);
});
export const publishTemplates = Effect.fn('bolt.templatesPublish')(function* (options: {
	root?: string;
	output?: string;
	push?: string;
	updateLocal: boolean;
	sourceRevision: string;
	repository?: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = options.root ?? process.cwd();
	const git = (args: readonly string[]) => run('git', args, { cwd: root });
	const sourceRevision = yield* git([
		'rev-parse',
		'--verify',
		`${options.sourceRevision}^{commit}`
	]);
	const sourceRepository =
		options.repository ??
		(yield* git(['config', '--get', 'remote.origin.url']).pipe(
			Effect.catchTag('TemplateError', () => Effect.succeed(undefined))
		));
	if (options.output !== undefined && sourceRepository === undefined)
		return yield* fail('A source repository is required for output; pass --repository <url>.');
	const entries: {
		slug: string;
		handle: string;
		ref: string;
		revision: string;
		name: TemplateManifest['name'];
		industry: TemplateManifest['industry'];
		description: TemplateManifest['description'];
		visibility: TemplateManifest['visibility'];
		counts: TemplateCounts;
	}[] = [];
	for (const template of yield* discoverTemplates(root)) {
		const revision = (yield* git(['subtree', 'split', `--prefix=${template.path}`, sourceRevision]))
			.split(/\s+/)
			.at(-1);
		if (revision === undefined || !revisionPattern.test(revision))
			return yield* fail(`Projection for ${template.slug} did not produce a commit revision.`);
		if (options.updateLocal) {
			const previous = yield* git(['rev-parse', '--verify', template.ref]).pipe(
				Effect.catchTag('TemplateError', () => Effect.succeed(undefined))
			);
			if (previous !== undefined) yield* git(['merge-base', '--is-ancestor', previous, revision]);
			yield* git([
				'update-ref',
				template.ref,
				revision,
				...(previous === undefined ? [] : [previous])
			]);
		}
		if (options.push !== undefined) {
			const remote = yield* git(['ls-remote', '--refs', options.push, template.ref]);
			const previous = remote.split(/\s+/)[0];
			if (previous !== undefined && previous !== '')
				yield* git(['merge-base', '--is-ancestor', previous, revision]);
		}
		yield* Console.log(`${template.slug}: ${template.ref} -> ${revision}`);
		const metadata = template.metadata;
		entries.push({
			slug: template.slug,
			handle: template.handle,
			ref: template.ref,
			revision,
			name: metadata.name,
			industry: metadata.industry,
			description: metadata.description,
			visibility: metadata.visibility,
			counts: metadata.counts
		});
	}
	if (options.push !== undefined)
		yield* git([
			'push',
			'--atomic',
			options.push,
			...entries.map((entry) => `${entry.revision}:${entry.ref}`)
		]);
	if (options.output !== undefined) {
		const outputPath = path.resolve(root, options.output);
		yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
		yield* fs.writeFileString(
			outputPath,
			`${JSON.stringify({ schemaVersion: 1, source: { repository: sourceRepository, revision: sourceRevision }, entries }, null, 2)}\n`
		);
		yield* Console.log(`Wrote ${outputPath}.`);
	}
});
const optional = (name: string) => Flag.string(name).pipe(Flag.optional);
const boolean = (name: string) => Flag.boolean(name).pipe(Flag.withDefault(false));
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
const verifyCommand = Command.make('verify', { filter: optional('filter') }, ({ filter }) =>
	verifyTemplates(process.cwd(), Option.getOrUndefined(filter))
);
const publishCommand = Command.make(
	'publish',
	{
		sourceRevision: Flag.string('source-revision').pipe(Flag.withDefault('HEAD')),
		repository: optional('repository'),
		output: optional('output'),
		push: optional('push'),
		updateLocal: boolean('update-local')
	},
	({ sourceRevision, repository, output, push, updateLocal }) =>
		publishTemplates({
			sourceRevision,
			updateLocal,
			...(Option.isSome(repository) ? { repository: repository.value } : {}),
			...(Option.isSome(output) ? { output: output.value } : {}),
			...(Option.isSome(push) ? { push: push.value } : {})
		})
);
export const templatesCommand = Command.make('templates').pipe(
	Command.withSubcommands([checkCommand, lockCommand, verifyCommand, publishCommand])
);
