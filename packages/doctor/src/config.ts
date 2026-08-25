/**
 * Configuration discovery and loading.
 *
 * A repository configures norbital-doctor with a `doctor.config.ts` at its root. The surface is
 * deliberately small: curated `packs` by name, YAML `patterns` by glob, and the semantic tier's
 * provider settings. Everything else — the neutral baseline of graph, type-aware and metric
 * analysis — runs whether or not a config exists, so the easiest config to write is no config.
 *
 * ```ts
 * // doctor.config.ts
 * import { defineConfig } from '@norbital-ai/doctor';
 *
 * export default defineConfig({
 *   packs: ['norbital'],        // registered name; or './dr/packs/house.ts'
 *   patterns: 'dr/rules.yml',  // any repository-relative glob over .yml files
 * });
 * ```
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegisteredPack } from './packs/registry.js';
import { overlapRules, type OverlapBinding } from './overlaps.js';
import { loadPatternFiles, type SemanticQuery } from './patterns-yaml.js';
import type { EmbedKind } from './semantic/embedder.js';
import { definePack, type Pack, type Rule } from './rules.js';

export type { OverlapBinding } from './overlaps.js';

/** The glob probed when a repository states no patterns of its own. */
const DEFAULT_PATTERN_GLOB = 'dr/**/*.yml';

/**
 * The semantic tier's configuration.
 *
 * Only names live here. The credential is the NAME of an environment variable, never its value —
 * a config file is committed, an environment is not, and the two must never swap roles. Values
 * are resolved from the invoking environment at audit time, which is why a template repository
 * can ship this file anywhere without shipping anyone's key with it.
 */
type ProbeSemanticConfig = Readonly<{
	/** `'openrouter'` today; or an inline `(texts, kind) => vectors` function for anything else. */
	readonly provider?: string | ((texts: ReadonlyArray<string>, kind: EmbedKind) => Promise<number[][]>);
	/** Defaults to `qwen/qwen3-embedding-8b`. */
	readonly model?: string | undefined;
	/** Defaults to 4096 (the model's native width). */
	readonly dimensions?: number | undefined;
	/** Environment variable NAME holding the API key. Defaults to `NORBITAL_AI_CREDENTIAL`. */
	readonly credential?: string | undefined;
	/** Endpoint override for proxies and tests. */
	readonly endpoint?: string | undefined;
	/** Decline the semantic tier explicitly. Absent means it runs and fails loudly if it cannot. */
	readonly disabled?: boolean | undefined;
}>;

export type ProbeConfig = Readonly<{
	/**
	 * Curated rule sets to run beside the neutral baseline, by registry name (`'norbital'`) or as
	 * module specifiers resolved from the repository root. A specifier's default export must be a
	 * pack. Registered names always win over same-named local files.
	 */
	readonly packs?: ReadonlyArray<Pack | string> | undefined;
	/** YAML rule files, repository-relative globs. Defaults to the conventional `dr` tree. */
	readonly patterns?: string | ReadonlyArray<string> | undefined;
	/** Rules authored inline or imported directly — the pack-maintainer surface, not the public one. */
	readonly rules?: ReadonlyArray<Rule> | undefined;
	/** Semantic-tier settings. Omit for defaults; set `{ disabled: true }` to decline the tier. */
	readonly semantic?: ProbeSemanticConfig | undefined;
	/** Authored, pack, or pattern rule ids to switch off. */
	readonly disable?: ReadonlyArray<string> | undefined;
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
	for (const name of CONFIG_NAMES) {
		const candidate = join(root, name);
		if (existsSync(candidate)) return candidate;
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
	/** Pseudocode halves from YAML patterns, awaiting the embedding pass. */
	readonly queries: ReadonlyArray<SemanticQuery>;
	readonly packs: ReadonlyArray<string>;
	readonly semantic: ProbeSemanticConfig | undefined;
}>;

/**
 * Resolve a root's configuration into the flat rule list the runner executes.
 *
 * Node strips types on import, so a `.ts` config loads with no build step. A config that throws
 * is reported as such rather than silently yielding zero rules — "no rules configured" and "the
 * config failed to load" must never look the same.
 *
 * Legacy keys (`base`, `overlaps`) still work through a shim that rewrites them onto the current
 * surface and says so once on stderr; they stop resolving entirely in the next minor.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
	const configPath = findConfig(root);
	if (configPath === undefined) {
		// No config: the neutral baseline is the whole audit. Rule files under the conventional
		// `dr/` directory join implicitly when present; their absence is normal, not a typo.
		const patterns = await loadPatternFiles(root, DEFAULT_PATTERN_GLOB, { implicit: true });
		return {
			configPath: undefined,
			rules: patterns.rules,
			queries: patterns.queries,
			packs: [],
			// Absent configuration is a decision too: the tier runs on defaults and fails loudly
			// when no credential resolves. Declining it is always one explicit line away.
			semantic: {}
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
	config = (Result.match(outcome, { onSuccess: (v) => v, onFailure: () => undefined }) ?? {}) as ProbeConfig;

	const warnings: Array<string> = [];
	// Read through a partial view: the legacy keys are off the declared surface, but a shim that
	// could not see them would break every config written before it existed.
	const legacy = config as Partial<{ base: 'norbital' | 'none'; overlaps: ReadonlyArray<OverlapBinding> }>;

	const packNames: Array<string> = [];
	const rules: Array<Rule> = [...(config.rules ?? [])];

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

	// Legacy shim: `base: 'norbital'` spelled what is now `packs: ['norbital']`.
	if (legacy.base === 'norbital' && !packNames.includes('norbital/base')) {
		const pack = await loadRegisteredPack('norbital');
		if (pack !== undefined) {
			packNames.push(pack.name);
			rules.push(...pack.rules);
		}
		warnings.push(`config key "base" is retired; add packs: ['norbital'] instead`);
	} else if (legacy.base === 'none') {
		warnings.push(`config key "base" is retired; omitting it already gives the neutral baseline`);
	}
	if (legacy.overlaps !== undefined && legacy.overlaps.length > 0) {
		rules.push(...overlapRules(legacy.overlaps));
		warnings.push(`config key "overlaps" is retired; express bindings as YAML detect/prefer rules`);
	}
	for (const warning of warnings)
		process.stderr.write(`norbital-doctor: ${configPath}: ${warning}\n`);

	const implicitPatterns = config.patterns === undefined;
	const patterns = await loadPatternFiles(
		root,
		config.patterns ?? DEFAULT_PATTERN_GLOB,
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
		queries: patterns.queries.filter((query) => !disabled.has(query.ruleId)),
		packs: packNames,
		semantic: config.semantic ?? {}
	};
}
