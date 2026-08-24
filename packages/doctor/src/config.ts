/**
 * Configuration discovery and loading.
 *
 * A repository configures norbital-doctor with a `doctor.config.ts` at its root. Rules and packs are ordinary
 * modules imported from it, so adding a rule is adding a file and a line — reviewable in a pull
 * request, with the type checker enforcing the shape before it ever runs.
 *
 * ```ts
 * // doctor.config.ts
 * import { defineConfig, preferOwner } from '@norbital-ai/doctor';
 * import noRawFetch from './dr/rules/no-raw-fetch.ts';
 *
 * export default defineConfig({
 *   rules: [noRawFetch],
 *   packs: ['./dr/packs/house-style.ts'],
 *   overlaps: [
 *     { shape: 'clamp', owner: 'es-toolkit', member: 'clamp' },
 *     { shape: 'chunk', owner: 'es-toolkit', member: 'chunk' }
 *   ]
 * });
 * ```
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { overlapRules, type OverlapBinding } from './overlaps.js';
import { norbitalRules } from './packs/norbital.js';
import { definePack, type Pack, type Rule } from './rules.js';

export type { OverlapBinding } from './overlaps.js';

export type ProbeConfig = Readonly<{
	/**
	 * Which built-in rule set to run beneath the authored ones.
	 *
	 * `norbital` is the ~140-rule detector this engine grew out of: Effect ownership, the generated
	 * collection client, the model compiler, Svelte runes, a specific design system's layout
	 * primitives. It encodes one product's architecture and is a *pack*, not a baseline — a project
	 * that is not Norbital should choose `none` and author its own.
	 *
	 * Defaults to `norbital` so existing gates keep their meaning; new repositories should say so
	 * explicitly either way.
	 */
	readonly base?: 'norbital' | 'none' | undefined;
	/** Rules authored inline or imported directly. */
	readonly rules?: ReadonlyArray<Rule> | undefined;
	/**
	 * Packs, either as values or as module specifiers resolved from the repository root.
	 * A specifier's default export must be a pack.
	 */
	readonly packs?: ReadonlyArray<Pack | string> | undefined;
	/**
	 * Which library owns which reimplementable primitive.
	 *
	 * The shape detectors are library-agnostic — `Math.min(Math.max(x, lo), hi)` is a clamp in any
	 * ecosystem — so the binding to an owner is configuration, not code. Point these at Effect,
	 * es-toolkit, remeda, lodash, or your own standard library.
	 */
	readonly overlaps?: ReadonlyArray<OverlapBinding> | undefined;
	/** Authored, pack, or overlap rule ids to switch off. Built-in rules remain additive. */
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
	readonly packs: ReadonlyArray<string>;
	readonly base: 'norbital' | 'none';
}>;

/**
 * Resolve a root's configuration into the flat rule list the runner executes.
 *
 * Node strips types on import, so a `.ts` config and `.ts` rules load with no build step. A config
 * that throws is reported as such rather than silently yielding zero rules — "no rules configured"
 * and "the config failed to load" must never look the same.
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
	const configPath = findConfig(root);
	if (configPath === undefined)
		// No config: the base pack is the rule set, which is what a repository that has not opted
		// out expects to be measured against.
		return {
			configPath: undefined,
			rules: [...norbitalRules],
			packs: ['norbital/base'],
			base: 'norbital'
		};

	let config: ProbeConfig;
	try {
		config = ((await importDefault(configPath, root)) ?? {}) as ProbeConfig;
	} catch (error) {
		throw new Error(
			`norbital-doctor: could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const packNames: Array<string> = [];
	const rules: Array<Rule> = [...(config.rules ?? [])];

	// Packs load concurrently and are consumed in declaration order: they are independent modules,
	// and awaiting them one at a time made startup scale with the number of packs for no reason.
	const loaded = await Promise.all(
		(config.packs ?? []).map(async (entry) => {
			if (typeof entry !== 'string') return definePack(entry);
			const module = await importDefault(entry, root);
			if (module === undefined)
				throw new Error(`norbital-doctor: pack "${entry}" has no default export`);
			return definePack(module as Pack);
		})
	);
	for (const pack of loaded) {
		packNames.push(pack.name);
		rules.push(...pack.rules);
	}

	rules.push(...overlapRules(config.overlaps ?? []));

	const disabled = new Set(config.disable ?? []);
	const seen = new Set<string>();
	const resolved = rules.filter((rule) => {
		if (disabled.has(rule.id)) return false;
		if (seen.has(rule.id))
			throw new Error(`norbital-doctor: rule ${rule.id} is declared more than once`);
		seen.add(rule.id);
		return true;
	});

	const base = config.base ?? 'norbital';
	// The base pack runs beneath the authored rules rather than instead of them: authored rules are
	// additive, and cannot suppress a base finding.
	const withBase = base === 'norbital' ? [...norbitalRules, ...resolved] : resolved;
	return {
		configPath,
		rules: withBase,
		packs: base === 'norbital' ? ['norbital/base', ...packNames] : packNames,
		base
	};
}
