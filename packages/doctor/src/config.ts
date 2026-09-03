/**
 * Configuration discovery and loading.
 *
 * A repository configures norbital-doctor under `.norbital/config/doctor/`. The surface is
 * deliberately small: curated `packs` by name and YAML extensions beside the config. Everything
 * else — the neutral baseline of graph, type-aware and metric analysis — runs whether or not a
 * config exists.
 *
 * ```ts
 * // .norbital/config/doctor/doctor.config.ts
 * import { defineConfig } from '@norbital-ai/doctor';
 *
 * export default defineConfig({
 *   packs: ['norbital'],
 * });
 * ```
 *
 * YAML extensions in the same directory join automatically. A root-level `doctor.config.*` is
 * still found so fixture tests and older checkouts keep loading.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	LANGUAGE_HEALTH_PROFILE,
	mergeHealthProfile,
	type HealthProfile
} from './health-profile.js';
import { loadRegisteredPack } from './packs/registry.js';
import { loadPatternFiles } from './patterns-yaml.js';
import { definePack, type Pack, type Rule } from './rules.js';

/** Authored doctor extensions for any Norbital workspace or repository. */
export const DOCTOR_CONFIG_DIRECTORY = '.norbital/config/doctor';

/** Globs probed when a repository states no patterns of its own. */
const DEFAULT_PATTERN_GLOBS: ReadonlyArray<string> = [
	`${DOCTOR_CONFIG_DIRECTORY}/**/*.yaml`,
	`${DOCTOR_CONFIG_DIRECTORY}/**/*.yml`
];

export type ProbeConfig = Readonly<{
	/**
	 * Curated rule sets to run beside the neutral baseline, by registry name (`'norbital'`) or as
	 * module specifiers resolved from the repository root. A specifier's default export must be a
	 * pack. Registered names always win over same-named local files.
	 */
	readonly packs?: ReadonlyArray<Pack | string> | undefined;
	/** YAML rule files, repository-relative globs. Defaults to every `.yaml` file under `.norbital/config/doctor`. */
	readonly patterns?: string | ReadonlyArray<string> | undefined;
	/** Authored, pack, or pattern rule ids to switch off. */
	readonly disable?: ReadonlyArray<string> | undefined;
	/**
	 * Health-tier opinions layered on the language default: framework entry paths, service
	 * heritage, and extra generic call labels. Absent means language vocabulary only.
	 */
	readonly profile?: Partial<HealthProfile> | undefined;
}>;

/** Identity with inference. Every `doctor.config.ts` goes through this. */
export function defineConfig(config: ProbeConfig): ProbeConfig {
	return config;
}

const CONFIG_NAMES = [
	'doctor.config.ts',
	'doctor.config.mts',
	'doctor.config.js',
	'doctor.config.mjs'
];

/** The config file a root uses, if it has one. */
export function findConfig(root: string): string | undefined {
	const directories = [join(root, DOCTOR_CONFIG_DIRECTORY), root];
	for (const directory of directories) {
		for (const name of CONFIG_NAMES) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Let a config `import '@norbital-ai/doctor'` even where the package is not installed.
 *
 * A template's config imports the doctor by name, because that is how it reads once the template is
 * a tenant workspace with the package as a real dependency. In this checkout the package is not
 * installed anywhere but `oss`, so every template config failed to load — and the alternative,
 * pinning `file:.yalc/...` into a template, breaks every deployed host.
 *
 * The tool loading the config can always satisfy an import of itself, so it does.
 */
const registerSelfResolution = (() => {
	// The once-only flag lives in this closure rather than at module scope. Module-scoped mutable
	// state has a lifetime nothing declares and no test can reset; here the only thing that can
	// reach it is the function that owns it.
	let registered = false;
	return (): void => {
		if (registered) return;
		registered = true;
		const self = new URL('./index.js', import.meta.url).href;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				const url = selfSpecifier(specifier, self);
				return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true };
			}
		});
	};
})();

/** This build's URL for a specifier naming the package itself, or `undefined` for anything else. */
function selfSpecifier(specifier: string, self: string): string | undefined {
	if (specifier === PACKAGE_NAME) return self;
	if (specifier.startsWith(`${PACKAGE_NAME}/`))
		return new URL(`./${specifier.slice(PACKAGE_NAME.length + 1)}`, self).href;
	return undefined;
}

/** This package's own name, as a config written for a published install imports it. */
const PACKAGE_NAME = '@norbital-ai/doctor';

async function importDefault(specifier: string, root: string): Promise<unknown> {
	registerSelfResolution();
	const target = isAbsolute(specifier) ? specifier : resolve(root, specifier);
	const url = existsSync(target) ? pathToFileURL(target).href : specifier;
	const module = (await import(url)) as { default?: unknown };
	return module.default;
}

export type LoadedConfig = Readonly<{
	readonly configPath: string | undefined;
	readonly rules: ReadonlyArray<Rule>;
	readonly packs: ReadonlyArray<string>;
	readonly profile: HealthProfile;
}>;

/**
 * Resolve a root's configuration into the flat rule list the runner executes.
 *
 * Node strips types on import, so a `.ts` config loads with no build step. A config that throws
 * is reported as such rather than silently yielding zero rules — "no rules configured" and "the
 * config failed to load" must never look the same.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
	const configPath = findConfig(root);
	if (configPath === undefined) {
		// No config: the neutral baseline is the whole audit. YAML extensions under
		// `.norbital/config/doctor/` join implicitly when present; their absence is normal, not a typo.
		const patterns = await loadPatternFiles(root, DEFAULT_PATTERN_GLOBS, { implicit: true });
		return {
			configPath: undefined,
			rules: patterns.rules,
			packs: [],
			profile: LANGUAGE_HEALTH_PROFILE
		};
	}

	let config: ProbeConfig;
	const outcome = await Effect.runPromise(
		Effect.result(Effect.tryPromise(() => importDefault(configPath, root)))
	);
	if (Result.isFailure(outcome))
		throw new Error(
			`norbital-doctor: could not load ${configPath}: ${Result.match(outcome, { onFailure: (error) => String(error), onSuccess: () => '' })}`
		);
	config = (Result.getOrElse(outcome, () => undefined) ?? {}) as ProbeConfig;

	const packNames: Array<string> = [];
	const rules: Array<Rule> = [];

	// Packs resolve concurrently and are consumed in declaration order: they are independent
	// modules, and awaiting them one at a time made startup scale with pack count for no reason.
	const loaded = await Promise.all(
		(config.packs ?? []).map(async (entry) => {
			if (typeof entry !== 'string') return { name: definePack(entry).name, rules: definePack(entry).rules };
			const registered = await loadRegisteredPack(entry);
			if (registered !== undefined) return { name: registered.name, rules: registered.rules };
			const module = await importDefault(entry, root);
			if (module === undefined)
				throw new Error(`norbital-doctor: pack "${entry}" has no default export`);
			const pack = definePack(module as Pack);
			return { name: pack.name, rules: pack.rules };
		})
	);
	for (const pack of loaded) {
		packNames.push(pack.name);
		rules.push(...pack.rules);
	}

	const implicitPatterns = config.patterns === undefined;
	const patterns = await loadPatternFiles(
		root,
		config.patterns ?? DEFAULT_PATTERN_GLOBS,
		{ implicit: implicitPatterns }
	);
	rules.push(...patterns.rules);

	const disabled = new Set(config.disable ?? []);
	const seen = new Set<string>();
	const resolved = rules.filter((rule) => {
		if (disabled.has(rule.id)) return false;
		if (seen.has(rule.id))
			throw new Error(`norbital-doctor: rule ${rule.id} is declared more than once`);
		seen.add(rule.id);
		return true;
	});

	return {
		configPath,
		rules: resolved,
		packs: packNames,
		profile: mergeHealthProfile(LANGUAGE_HEALTH_PROFILE, config.profile)
	};
}
