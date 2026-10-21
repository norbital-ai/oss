/// <reference types="node" />
// The workspace's type index (the agent's `workspace_type`, §5.9): what the TypeScript checker says each authored thing
// is — a collection's row, its write, action and query inputs and outputs, a custom field's value, a component's props —
// with its docs and where it is declared. `bolt build` answers every name by hovering one generated probe over the
// workspace's own program (svelte components through svelte2tsx, as svelte-check sees them), so the index is the
// compiler's answer, never a second model of the types. Written to `artifact/workspace/types.json`.
import { access, readFile } from 'node:fs/promises';
import { Effect, Predicate, Result, Schema } from 'effect';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type TS from 'typescript';
import type { EngineManifest } from '../../engine/manifest.ts';

type TypeEntry = { type: string; docs?: string; source?: string };
export type TypeIndex = {
	entries: { readonly [name: string]: TypeEntry };
	errors: readonly string[];
};
/** The program the index was read from, for the doctor's type-aware pass to reuse; `version` is its TypeScript's. */
export type TypeProgram = { readonly program: TS.Program; readonly version: string };

type Probe = {
	name: string;
	type: string;
	docs?: string | undefined;
	source?: string | undefined;
	/** The declaration to point at: `container` is a type whose property `prop` was authored (a spec literal). */
	site?: { container: string; prop: string };
};

const VERBS = ['create', 'update', 'delete'] as const;
const posix = (p: string) => p.split(sep).join('/');

/** The workspace's `.svelte` files under `src/`, relative to the root. */
function components(root: string, ts: typeof TS): string[] {
	return ts.sys
		.readDirectory(join(root, 'src'), ['.svelte'], undefined, undefined)
		.map((f) => posix(relative(root, f)))
		.sort();
}

/** `<!-- @component … -->` or the first `/** … *\/` of the instance script: a component's own doc. */
function componentDoc(text: string): string | undefined {
	const tag = /<!--\s*@component\s*([\s\S]*?)-->/.exec(text)?.[1];
	const js = /<script[^>]*>\s*\/\*\*([\s\S]*?)\*\//.exec(text)?.[1];
	const doc = (tag ?? js)
		?.split('\n')
		.map((l) => l.replace(/^\s*\*?\s?/, ''))
		.join('\n')
		.trim();
	return doc === undefined || doc === '' ? undefined : doc;
}

class TypeIndexError extends Schema.TaggedError<TypeIndexError>()('TypeIndexError', {
	cause: Schema.Defect()
}) {}
export const typeIndex = Effect.fn('bolt.typeIndex')(function* (root: string, m: EngineManifest) {
	// the workspace's own toolchain, else the kit's (a linked or scratch workspace)
	const { ts, parsed, where, svelteFiles } = yield* Effect.try({
		try: () => {
			const reqs = [createRequire(join(root, 'package.json')), createRequire(import.meta.url)];
			const where = (id: string) => {
				for (const r of reqs) {
					const resolved = Result.try({
						try: () => r.resolve(id),
						catch: (cause) => new TypeIndexError({ cause })
					});
					if (Result.isSuccess(resolved)) return resolved.success;
				}
				throw new Error(`${id} is not installed`);
			};
			const ts = createRequire(import.meta.url)(where('typescript')) as typeof TS;
			// TypeScript's config parser and compiler host require synchronous filesystem callbacks.
			const parsed = ts.getParsedCommandLineOfConfigFile(
				join(root, 'tsconfig.json'),
				{},
				{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
			);
			return { ts, parsed, where, svelteFiles: parsed === undefined ? [] : components(root, ts) };
		},
		catch: (cause) => new TypeIndexError({ cause })
	});
	if (parsed === undefined)
		return { index: { entries: {}, errors: ['tsconfig.json could not be read'] } };
	const errors: string[] = [];
	const virtual = new Map<string, string>();
	const sources = new Map<string, string>();

	// svelte components as svelte-check sees them: svelte2tsx's TS, one virtual `<file>.__c.ts` each
	const shims: string[] = [];
	if (svelteFiles.length > 0) {
		const converted = yield* Effect.gen(function* () {
			const { svelte2tsx, dir } = yield* Effect.try({
				try: () => {
					const s2t = createRequire(where('svelte2tsx/package.json'));
					const { svelte2tsx } = s2t('svelte2tsx') as {
						svelte2tsx: (
							code: string,
							o: {
								filename: string;
								isTsFile: boolean;
								mode: 'ts';
								emitOnTemplateError: boolean;
								version?: string;
							}
						) => { code: string };
					};
					return { svelte2tsx, dir: dirname(s2t.resolve('svelte2tsx/package.json')) };
				},
				catch: (cause) => new TypeIndexError({ cause })
			});
			const versionResult = yield* Effect.gen(function* () {
				const path = yield* Effect.try({
					try: () => where('svelte/package.json'),
					catch: (cause) => new TypeIndexError({ cause })
				});
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(path, { encoding: 'utf8', signal }),
					catch: (cause) => new TypeIndexError({ cause })
				});
				return (yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
				)(text)).version;
			}).pipe(Effect.result);
			const version = Result.getOrElse(versionResult, () => undefined);
			for (const name of ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts']) {
				const path = join(dir, name);
				if (
					yield* Effect.tryPromise({
						try: () => access(path),
						catch: (cause) => new TypeIndexError({ cause })
					}).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
				)
					shims.push(path);
			}
			for (const f of svelteFiles) {
				const abs = join(root, f);
				const component = yield* Effect.gen(function* () {
					const text = yield* Effect.tryPromise({
						try: (signal) => readFile(abs, { encoding: 'utf8', signal }),
						catch: (cause) => new TypeIndexError({ cause })
					});
					sources.set(f, text);
					return yield* Effect.try({
						try: () =>
							svelte2tsx(text, {
								filename: abs,
								isTsFile: true,
								mode: 'ts',
								emitOnTemplateError: true,
								...(version === undefined ? {} : { version })
							}).code,
						catch: (cause) => new TypeIndexError({ cause })
					});
				}).pipe(Effect.result);
				if (Result.isSuccess(component)) virtual.set(`${abs}.__c.ts`, component.success);
				else
					errors.push(
						`${f}: ${component.failure.cause instanceof Error ? component.failure.cause.message : String(component.failure.cause)}`
					);
			}
		}).pipe(Effect.result);
		if (Result.isFailure(converted))
			errors.push(
				`svelte2tsx component indexing failed: ${converted.failure.cause instanceof Error ? converted.failure.cause.message : String(converted.failure.cause)}`
			);
	}
	return yield* Effect.try({
		try: () =>
			compileTypeIndex(root, m, { ts, parsed, svelteFiles, shims, virtual, sources, errors }),
		catch: (cause) => new TypeIndexError({ cause })
	});
});

/** TypeScript's synchronous compiler host consumes the preloaded component sources. */
function compileTypeIndex(
	root: string,
	m: EngineManifest,
	{
		ts,
		parsed,
		svelteFiles,
		shims,
		virtual,
		sources,
		errors
	}: {
		ts: typeof TS;
		parsed: TS.ParsedCommandLine;
		svelteFiles: string[];
		shims: string[];
		virtual: Map<string, string>;
		sources: ReadonlyMap<string, string>;
		errors: string[];
	}
): { index: TypeIndex; program?: TypeProgram } {
	const probeFile = join(root, '.norbital', '__types_probe.ts');
	// the probes: one exported alias per name
	const probes: Probe[] = [];
	const spec = (c: string) => `Names['collections'][${JSON.stringify(c)}]['spec']`;
	for (const [c, s] of Object.entries(m.collections)) {
		const model = m.models[c];
		probes.push({
			name: `collections.${c}.row`,
			type: `Row<${JSON.stringify(c)}>`,
			docs: model?.description,
			source: `src/data/model/+${c}.model.ts`
		});
		for (const v of VERBS)
			if (s[v] !== undefined)
				probes.push({
					name: `collections.${c}.${v}`,
					type: `{ input: ActInput<${JSON.stringify(`${c}.${v}`)}> }`,
					source: `src/data/collection/${c}/+collection.ts`,
					site: { container: spec(c), prop: v }
				});
		for (const [a, x] of Object.entries(s.actions ?? {}))
			probes.push({
				name: `collections.${c}.actions.${a}`,
				type: `{ input: ActInput<${JSON.stringify(`${c}.${a}`)}>; output: ActOutput<${JSON.stringify(`${c}.${a}`)}> }`,
				docs: x.description,
				site: { container: `${spec(c)}['actions']`, prop: a }
			});
		for (const [q, x] of Object.entries(s.queries ?? {})) {
			const qs = `${spec(c)}['queries'][${JSON.stringify(q)}]`;
			probes.push({
				name: `collections.${c}.queries.${q}`,
				type: `{ input: InputOf<${qs}['input']>; output: ValueOf<${qs}['output']> }`,
				docs: x.description,
				site: { container: `${spec(c)}['queries']`, prop: q }
			});
		}
	}
	for (const name of Object.keys(m.integrations))
		probes.push({
			name: `integrations.${name}`,
			type: `Names['integrations'][${JSON.stringify(name)}]['spec']`,
			source: `src/integration/${name}/+integration.ts`
		});
	for (const f of Object.keys(m.customFields ?? {}))
		probes.push({
			name: `customFields.${f}`,
			type: `ValueOf<Names['customFields'][${JSON.stringify(f)}]['spec']['shape']>`,
			docs: m.customFields[f]?.description,
			source: `src/data/custom_field/${f}/+definition.ts`
		});
	for (const f of svelteFiles)
		if (virtual.has(join(root, `${f}.__c.ts`)))
			probes.push({
				name: `components.${f.replace(/^src\//, '').replace(/\.svelte$/, '')}`,
				type: `ComponentProps<typeof import(${JSON.stringify(`../${f}.__c.ts`)}).default>`,
				docs: componentDoc(sources.get(f) ?? ''),
				source: f
			});

	virtual.set(
		probeFile,
		[
			`import type { ActInput, ActOutput, InputOf, Names, Row, ValueOf } from '@norbital-ai/bolt';`,
			svelteFiles.length > 0 ? `import type { ComponentProps } from 'svelte';` : '',
			...probes.flatMap((p, i) => [
				`export type __t${i} = ${p.type};`,
				...(p.site === undefined ? [] : [`export type __s${i} = ${p.site.container};`])
			])
		].join('\n')
	);

	const options = { ...parsed.options, noEmit: true, allowArbitraryExtensions: true };
	const host = ts.createCompilerHost(options, true);
	const read = host.readFile.bind(host),
		exists = host.fileExists.bind(host),
		get = host.getSourceFile.bind(host);
	host.readFile = (f) => virtual.get(resolve(f)) ?? read(f);
	host.fileExists = (f) => virtual.has(resolve(f)) || exists(f);
	host.getSourceFile = (f, lang, onError, fresh) => {
		const text = virtual.get(resolve(f));
		return text === undefined
			? get(f, lang, onError, fresh)
			: ts.createSourceFile(f, text, lang, true);
	};
	const cache = ts.createModuleResolutionCache(root, (x) => x, options);
	host.resolveModuleNameLiterals = (literals, containing, redirected, o) =>
		literals.map((l) => {
			const name = l.text;
			// `import X from './x.svelte'` is the component's svelte2tsx module
			if (name.endsWith('.svelte') && name.startsWith('.')) {
				const target = `${resolve(dirname(containing), name)}.__c.ts`;
				if (virtual.has(target))
					return {
						resolvedModule: {
							resolvedFileName: target,
							extension: ts.Extension.Ts,
							isExternalLibraryImport: false
						}
					};
			}
			return ts.resolveModuleName(name, containing, o, host, cache, redirected);
		});
	const program = ts.createProgram({
		rootNames: [...parsed.fileNames, ...shims, ...[...virtual.keys()]],
		options,
		host
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(probeFile);
	const shared = { program, version: ts.version };
	if (source === undefined)
		return {
			index: { entries: {}, errors: [...errors, 'the type probe did not load'] },
			program: shared
		};
	const aliases = new Map<string, TS.TypeAliasDeclaration>();
	source.forEachChild((n) => {
		if (ts.isTypeAliasDeclaration(n)) aliases.set(n.name.text, n);
	});

	const F = ts.TypeFormatFlags.NoTruncation;
	const docOf = (s: TS.Symbol) =>
		ts.displayPartsToString(s.getDocumentationComment(checker)).trim();
	/** Top level expanded (`InTypeAlias`), with each member's own doc inline as the hover shows it. */
	const print = (t: TS.Type, at: TS.Node): string => {
		const props =
			t.isUnion() || t.isIntersection() || !(t.flags & ts.TypeFlags.Object)
				? []
				: checker.getPropertiesOfType(t);
		if (props.length === 0 || checker.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0)
			return checker.typeToString(t, at, F | ts.TypeFormatFlags.InTypeAlias);
		const lines = props.map((p) => {
			const d = docOf(p),
				optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
			const flags: unknown =
				'getCheckFlags' in ts && Predicate.isFunction(ts.getCheckFlags)
					? ts.getCheckFlags(p)
					: undefined;
			const readonly =
				(Predicate.isNumber(flags) && (flags & 8) !== 0) ||
				p.declarations?.some((x) => ts.getCombinedModifierFlags(x) & ts.ModifierFlags.Readonly);
			const text = checker.typeToString(checker.getTypeOfSymbolAtLocation(p, at), at, F);
			return `${d === '' ? '' : `\t/** ${d.replaceAll('\n', ' ')} */\n`}\t${readonly ? 'readonly ' : ''}${p.name}${optional ? '?' : ''}: ${text};`;
		});
		return `{\n${lines.join('\n')}\n}`;
	};
	const site = (i: number, prop: string): { source?: string; docs?: string } => {
		const alias = aliases.get(`__s${i}`);
		if (alias === undefined) return {};
		const p = checker.getPropertyOfType(checker.getTypeAtLocation(alias.name), prop);
		const d = p?.declarations?.[0];
		if (p === undefined || d === undefined) return {};
		const file = d.getSourceFile(),
			line = file.getLineAndCharacterOfPosition(d.getStart()).line + 1;
		const doc = docOf(p);
		return {
			source: `${posix(relative(root, file.fileName))}:${line}`,
			...(doc === '' ? {} : { docs: doc })
		};
	};

	const diagnostics = ts
		.getPreEmitDiagnostics(program, source)
		.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
	if (diagnostics.length > 0) errors.push(...diagnostics.slice(0, 20).map((d) => `probe: ${d}`));
	const entries: { [name: string]: TypeEntry } = {};
	probes.forEach((p, i) => {
		const alias = aliases.get(`__t${i}`)!;
		const t = checker.getTypeAtLocation(alias.name);
		const at = p.site === undefined ? {} : site(i, p.site.prop);
		const docs = [p.docs, at.docs]
			.filter((d): d is string => d !== undefined && d !== '')
			.filter((d, k, all) => all.indexOf(d) === k)
			.join('\n\n');
		const src = at.source ?? p.source;
		// `import("@norbital-ai/bolt").Instant` reads as the author writes it: `Instant`
		entries[p.name] = {
			type: print(t, alias).replace(/import\("[^"]+"\)\./g, ''),
			...(docs === '' ? {} : { docs }),
			...(src === undefined ? {} : { source: src })
		};
	});
	return { index: { entries, errors }, program: shared };
}
