/// <reference types="node" />
// The API reference generator (§7.3), run by bolt's build after the package compiles: `node scripts/docs.ts`.
// It walks the `exports` of bolt and of the packages it builds on (ui, std), reads each entry's built
// declarations with the TypeScript checker (no TypeDoc) and writes one JSON document per namespace plus `index.json`
// to `build/docs/`, where `@norbital-ai/bolt/docs` reads them. Output is sorted and carries no time, so a build of
// the same sources is byte-identical. Svelte components are read through svelte-package's `.svelte.d.ts`: their
// props are the second parameter of the component's call signature. `index.json` marks the reference namespaces an
// author reads, and `missing` lists every symbol of them with no doc comment; `tests/docs.test.ts` fails on it. A docs page (`docs/*.md`) naming a call the corpus does not declare fails the build. bolt-server and bolt-cli build after bolt: only bolt-cli's test kit (`@norbital-ai/bolt-cli/test`) joins the corpus, read from its source; `./tooling` is bolt-cli's, not an author's.
// `oss/skills/` (the one source of authoring skills, which realm agents read by path) compiles beside it:
// one `skill.<name>.json` per skill folder holding every Markdown file, listed in `index.json`'s `skills`.
// `docs/hosts.md` is generated from the `Facilities` type (`src/facilities/index.ts`): what a host supplies.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Effect, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { skillFile } from '../src/engine/docs-corpus.ts';
import type {
	DocIndex,
	DocKind,
	DocMember,
	DocNamespace,
	DocParam,
	DocSkill,
	DocSymbol
} from '../src/docs/index.ts';

class DocsFailed extends Schema.TaggedError<DocsFailed>()('DocsFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

const PACKAGES = ['bolt', 'ui', 'std'];
/** The reference a workspace author reads (§7.3): bolt's root and `/page`, bolt-cli's test kit, ui's authoring entries and std. */
const REFERENCE = (ns: string) =>
	['bolt', 'bolt/page', 'bolt-cli/test', 'ui', 'ui/layout', 'ui/capture'].includes(ns) ||
	ns.startsWith('std/');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // oss/packages
const out = join(root, 'bolt', 'build', 'docs');
const SKILLS = join(root, '..', 'skills'); // oss/skills: the authoring skills
const FACILITIES = join(root, 'bolt', 'build', 'facilities', 'index.d.ts');
const HOSTS = join(root, 'bolt', 'docs', 'hosts.md');
const writeIfChanged = (file: string, text: string) => {
	if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
};
const posix = (p: string) => p.split(sep).join('/');
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** Code-unit order: the same on every machine, whatever its locale. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Entry = { namespace: string; module: string; file: string };
export const generateDocs = Effect.try({
	try: () => {
		const entries: Entry[] = PACKAGES.flatMap((pkg) => {
			const manifest = Schema.decodeUnknownSync(
				Schema.fromJsonString(
					Schema.Struct({
						exports: Schema.Record(
							Schema.String,
							Schema.Union([
								Schema.String,
								Schema.Struct({ types: Schema.optionalKey(Schema.String) })
							])
						)
					})
				)
			)(readFileSync(join(root, pkg, 'package.json'), 'utf8'));
			return Object.entries(manifest.exports).flatMap(([key, target]) => {
				const types = typeof target === 'string' ? undefined : target.types;
				if (
					types === undefined ||
					!types.endsWith('.d.ts') ||
					key.includes('*') ||
					key.startsWith('./tooling')
				)
					return [];
				return [
					{
						namespace: key === '.' ? pkg : `${pkg}/${key.slice(2)}`,
						module: `@norbital-ai/${pkg}${key.slice(1)}`,
						file: join(root, pkg, types)
					}
				];
			});
		})
			// bolt-cli builds after bolt: its test kit, which a workspace's tests import, is read from source
			.concat({
				namespace: 'bolt-cli/test',
				module: '@norbital-ai/bolt-cli/test',
				file: join(root, 'bolt-cli', 'src', 'test', 'index.ts')
			})
			.sort((a, b) => byCode(a.namespace, b.namespace));

		const program = ts.createProgram([...entries.map((e) => e.file), FACILITIES], {
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			allowArbitraryExtensions: true,
			allowImportingTsExtensions: true,
			types: []
		});
		const checker = program.getTypeChecker();
		const FORMAT =
			ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

		/** Declared in a first-party package, not a dependency (a prop spread from `HTMLAttributes` is not ours to list). */
		const ours = (d: ts.Declaration) => !d.getSourceFile().fileName.includes('/node_modules/');

		/** `packages/ui/build/chart/Chart.svelte.d.ts` → `packages/ui/src/chart/Chart.svelte:<line>`. */
		function sourceOf(d: ts.Declaration, name: string): string {
			const built = posix(relative(root, d.getSourceFile().fileName));
			const base = built.replace('/build/', '/src/').replace(/\.d\.ts$/, '');
			const file = [`${base}.ts`, base, `${base}.js`].find((f) => existsSync(join(root, f)));
			if (file === undefined) return `packages/${built}`;
			const lines = readFileSync(join(root, file), 'utf8').split('\n');
			const at = lines.findIndex((l) =>
				new RegExp(
					`\\b(function|const|let|type|interface|class|enum|namespace)\\s+${name}\\b`
				).test(l)
			);
			return `packages/${file}:${at + 1 || 1}`;
		}

		/** The comment of a symbol, else of the alias that re-exported it. */
		function comment(sym: ts.Symbol, alias: ts.Symbol): { text: string; examples: string[] } {
			// `/** … */ export * as Dialog from …`: the comment sits on the export statement
			const ns = alias.declarations?.find(ts.isNamespaceExport);
			const nsText =
				ns === undefined
					? ''
					: ts
							.getJSDocCommentsAndTags(ns.parent)
							.filter(ts.isJSDoc)
							.map((d) => ts.getTextOfJSDocComment(d.comment) ?? '')
							.join('\n');
			const exportText =
				alias.declarations
					?.flatMap((declaration) => {
						if (!ts.isExportSpecifier(declaration)) return [];
						return ts
							.getJSDocCommentsAndTags(declaration.parent.parent)
							.filter(ts.isJSDoc)
							.map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '');
					})
					.join('\n') ?? '';
			const text =
				ts.displayPartsToString(sym.getDocumentationComment(checker)).trim() ||
				ts.displayPartsToString(alias.getDocumentationComment(checker)).trim() ||
				nsText.trim() ||
				exportText.trim();
			const examples = [
				...sym.getJsDocTags(checker),
				...(sym === alias ? [] : alias.getJsDocTags(checker))
			]
				.filter((t) => t.name === 'example')
				.map((t) => ts.displayPartsToString(t.text).trim())
				.filter(Boolean);
			return { text, examples: [...new Set(examples)] };
		}
		const first = (text: string) =>
			(text.split(/\n\s*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim();

		function typeText(s: ts.Symbol, at: ts.Node): string {
			const d = s.valueDeclaration ?? s.declarations?.[0];
			const node =
				d !== undefined &&
				(ts.isPropertySignature(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d))
					? d.type
					: undefined;
			return clip(
				node !== undefined
					? node.getText().replace(/\s+/g, ' ')
					: checker.typeToString(checker.getTypeOfSymbolAtLocation(s, at), at, FORMAT),
				400
			);
		}

		/** The first-party properties of a type, with their docs; at most 80. */
		function membersOf(type: ts.Type, at: ts.Node): DocMember[] {
			return checker
				.getPropertiesOfType(type)
				.filter(
					(p) =>
						(p.declarations ?? []).some(ours) &&
						!p.name.startsWith('__') &&
						!p.name.startsWith('$$')
				)
				.slice(0, 80)
				.map((p) => {
					const summary = first(ts.displayPartsToString(p.getDocumentationComment(checker)));
					return {
						name: p.name,
						type: typeText(p, at),
						...(p.flags & ts.SymbolFlags.Optional ? { optional: true as const } : {}),
						...(summary === '' ? {} : { summary })
					};
				});
		}
		const isObjectLike = (t: ts.Type) =>
			!!(t.flags & ts.TypeFlags.Object) ||
			(t.isIntersection() && t.types.every((x) => !!(x.flags & ts.TypeFlags.Object)));

		function paramsOf(sig: ts.Signature, at: ts.Node): DocParam[] {
			const tags = new Map(
				sig
					.getJsDocTags()
					.filter((t) => t.name === 'param')
					.map((t) => {
						const text = ts.displayPartsToString(t.text).trim();
						const m = /^(\S+)\s*(?:-\s*)?([\s\S]*)$/.exec(text);
						return [m?.[1] ?? '', first(m?.[2] ?? '')] as const;
					})
			);
			return sig.getParameters().map((p) => {
				const declaration = p.valueDeclaration;
				const d =
					declaration !== undefined && ts.isParameter(declaration) ? declaration : undefined;
				// a declaration function's `spec: S & Checked<Base, S, …>` lists its constraint's fields: `Base` is the option shape
				const declared = checker.getTypeOfSymbolAtLocation(p, at);
				const tp = (declared.isIntersection() ? declared.types : [declared]).find(
					(x) => !!(x.flags & ts.TypeFlags.TypeParameter)
				);
				const type =
					tp === undefined ? declared : (checker.getBaseConstraintOfType(tp) ?? declared);
				const fields =
					isObjectLike(type) &&
					checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0
						? membersOf(type, at)
						: [];
				const summary = tags.get(p.name) ?? '';
				return {
					name: p.name,
					type: typeText(p, at),
					...(d?.questionToken !== undefined || d?.initializer !== undefined
						? { optional: true as const }
						: {}),
					...(summary === '' ? {} : { summary }),
					...(fields.length === 0 ? {} : { fields })
				};
			});
		}

		/** svelte-package's component shape: `(internal, props)`, with or without a constructor beside it. */
		function componentProps(type: ts.Type): ts.Type | undefined {
			const sig = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
			const ps = sig?.getParameters() ?? [];
			const first = ps[0],
				props = ps[1];
			return ps.length === 2 &&
				first !== undefined &&
				props !== undefined &&
				/^internals?$/.test(first.name)
				? checker.getTypeOfSymbol(props)
				: undefined;
		}

		function declarationText(d: ts.Declaration): string {
			const text = d.getText().replace(/^\s*(export\s+)?(declare\s+)?/, '');
			return clip(text, 1500);
		}

		/** Whether any hop of the re-export chain is `export type`. */
		function typeOnly(exported: ts.Symbol): boolean {
			for (
				let s: ts.Symbol | undefined = exported;
				s !== undefined && s.flags & ts.SymbolFlags.Alias;
				s = checker.getImmediateAliasedSymbol(s)
			)
				if ((s.declarations ?? []).some((d) => ts.isTypeOnlyImportOrExportDeclaration(d)))
					return true;
			return false;
		}

		function symbolOf(exported: ts.Symbol): DocSymbol | null {
			const sym =
				exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
			const d = sym.valueDeclaration ?? sym.declarations?.[0];
			if (d === undefined) return null;
			const name = exported.name;
			// `export type { PlainDate }` of a function-and-type pair documents the type
			const f = typeOnly(exported)
				? sym.flags & ~(ts.SymbolFlags.Function | ts.SymbolFlags.Variable)
				: sym.flags;
			const { text, examples } = comment(sym, exported);
			let kind: DocKind,
				signature: string,
				params: DocParam[] | undefined,
				props: DocMember[] | undefined,
				members: DocMember[] | undefined;
			if (f & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
				const type = checker.getTypeOfSymbolAtLocation(sym, d);
				const propsType = componentProps(type);
				const sigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
				if (propsType !== undefined) {
					kind = 'component';
					props = membersOf(propsType, d);
					signature = `component ${name}(props: ${clip(checker.typeToString(propsType, d, FORMAT), 600)})`;
				} else if (
					sigs[0] !== undefined &&
					checker.getPropertiesOfType(type).filter((p) => (p.declarations ?? []).some(ours))
						.length === 0
				) {
					kind = 'function';
					signature = sigs
						.map((s) => `function ${name}${checker.signatureToString(s, d, FORMAT)}`)
						.join('\n');
					params = paramsOf(sigs[0], d);
				} else {
					kind = 'const';
					signature = `const ${name}: ${clip(checker.typeToString(type, d, FORMAT), 600)}`;
					const m = membersOf(type, d);
					if (m.length > 0) members = m;
				}
			} else if (f & ts.SymbolFlags.Class) {
				kind = 'class';
				signature = declarationText(d);
				members = membersOf(checker.getDeclaredTypeOfSymbol(sym), d);
			} else if (f & ts.SymbolFlags.Interface) {
				kind = 'interface';
				signature = declarationText(d);
				members = membersOf(checker.getDeclaredTypeOfSymbol(sym), d);
			} else if (f & ts.SymbolFlags.TypeAlias) {
				kind = 'type';
				signature = declarationText(d);
				const t = checker.getDeclaredTypeOfSymbol(sym);
				if (isObjectLike(t) && !(ts.isTypeAliasDeclaration(d) && ts.isMappedTypeNode(d.type))) {
					const m = membersOf(t, d);
					if (m.length > 0) members = m;
				}
			} else if (f & ts.SymbolFlags.Enum) {
				kind = 'enum';
				signature = declarationText(d);
			} else {
				kind = 'namespace';
				signature = `namespace ${name}`;
			}
			const summary = first(text);
			return {
				name,
				kind,
				signature,
				summary,
				...(text.replace(/\s+/g, ' ').trim() !== summary ? { docs: text } : {}),
				...(params === undefined || params.length === 0 ? {} : { params }),
				...(props === undefined ? {} : { props }),
				...(members === undefined ? {} : { members }),
				...(examples.length === 0 ? {} : { examples }),
				source: sourceOf(d, name)
			};
		}

		/** The entry source's leading comment: what the entry is for (`// @norbital-ai/ui (§3.6): …`). */
		function entrySummary(e: Entry): string {
			const src = e.file.replace(`${sep}build${sep}`, `${sep}src${sep}`).replace(/\.d\.ts$/, '.ts');
			if (!existsSync(src)) return '';
			const lines: string[] = [];
			for (const l of readFileSync(src, 'utf8').split('\n')) {
				if (l.startsWith('///')) continue;
				const m = /^\s*(?:\/\/|\/\*\*?|\*\/?)\s?(.*)$/.exec(l);
				if (m === null) break;
				if (/^(hook:|ponytail:)/.test((m[1] ?? '').trim())) break;
				lines.push((m[1] ?? '').replace(/\*\/\s*$/, '').trim());
			}
			return lines.join(' ').replace(/\s+/g, ' ').trim();
		}

		mkdirSync(out, { recursive: true });
		const index: DocIndex = { namespaces: [], missing: [], skills: [] };
		const corpusSymbols: DocSymbol[] = [];
		for (const name of readdirSync(SKILLS)
			.filter((n) => existsSync(join(SKILLS, n, 'SKILL.md')))
			.sort(byCode)) {
			const markdown = (dir: string): string[] =>
				readdirSync(join(SKILLS, name, dir), { withFileTypes: true }).flatMap((d) =>
					d.isDirectory()
						? markdown(posix(join(dir, d.name)))
						: d.name.endsWith('.md')
							? [posix(join(dir, d.name))]
							: []
				);
			const paths = [
				'SKILL.md',
				...markdown('.')
					.filter((p) => p !== 'SKILL.md')
					.sort(byCode)
			];
			const files = paths.map((path) => ({
				path,
				text: readFileSync(join(SKILLS, name, path), 'utf8')
			}));
			const description = (
				/^---\n[\s\S]*?^description:\s*(?:>-?\n)?([\s\S]*?)\n(?:\S[^\n]*:|---)/m.exec(
					files[0]?.text ?? ''
				)?.[1] ?? ''
			)
				.replace(/\s+/g, ' ')
				.trim();
			if (description === '')
				throw new Error(`[docs] oss/skills/${name}/SKILL.md has no description`);
			const skill: DocSkill = { name, description, files };
			writeFileSync(join(out, skillFile(name)), `${JSON.stringify(skill, null, '\t')}\n`);
			index.skills.push({ name, description, files: paths });
		}
		for (const e of entries) {
			const sf = program.getSourceFile(e.file);
			const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
			if (sf === undefined || mod === undefined)
				throw new Error(`[docs] ${e.namespace}: ${posix(relative(root, e.file))} is not built`);
			const symbols = checker
				.getExportsOfModule(mod)
				.map(symbolOf)
				.filter((s): s is DocSymbol => s !== null)
				.sort((a, b) => byCode(a.name, b.name));
			corpusSymbols.push(...symbols);
			const ns: DocNamespace = {
				namespace: e.namespace,
				module: e.module,
				summary: entrySummary(e),
				symbols
			};
			writeFileSync(
				join(out, `${e.namespace.replaceAll('/', '.')}.json`),
				`${JSON.stringify(ns, null, '\t')}\n`
			);
			index.namespaces.push({
				namespace: ns.namespace,
				module: ns.module,
				summary: ns.summary,
				symbols: symbols.length,
				reference: REFERENCE(e.namespace)
			});
			if (REFERENCE(e.namespace))
				index.missing.push(
					...symbols.filter((s) => s.summary === '').map((s) => `${e.namespace}#${s.name}`)
				);
		}
		writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);

		// every call a docs page names (`` `ctx.allow()` ``, `` `model(name, spec)` ``) names something the corpus declares:
		// a symbol, a member, a parameter or an identifier of their types
		const declared = new Set<string>(),
			words = (text: string) => text.match(/[A-Za-z_$][\w$]*/g) ?? [];
		const member = (m: DocParam): void => {
			declared.add(m.name);
			for (const w of words(m.type)) declared.add(w);
			for (const f of m.fields ?? []) member(f);
		};
		for (const s of corpusSymbols) {
			declared.add(s.name);
			for (const w of words(s.signature)) declared.add(w);
			for (const m of [...(s.params ?? []), ...(s.props ?? []), ...(s.members ?? [])]) member(m);
		}
		const pages = join(root, 'bolt', 'docs');
		const unknown = readdirSync(pages)
			.filter((f) => f.endsWith('.md'))
			.sort(byCode)
			.flatMap((f) =>
				[
					...readFileSync(join(pages, f), 'utf8').matchAll(
						/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\([^`]*\)`/g
					)
				]
					.filter((m) => !declared.has(m[1]?.split('.').pop() ?? ''))
					.map((m) => `docs/${f}: ${m[0]}`)
			);
		if (unknown.length > 0)
			throw new Error(
				`[docs] pages name calls the corpus does not declare:\n  ${unknown.join('\n  ')}`
			);

		// docs/hosts.md: each facility group and member of `Facilities`, from its declared type and that type's comment
		const facilitiesFile = program.getSourceFile(FACILITIES);
		const facilities =
			facilitiesFile === undefined
				? undefined
				: facilitiesFile.statements
						.filter(ts.isTypeAliasDeclaration)
						.find((d) => d.name.text === 'Facilities');
		if (facilities === undefined || !ts.isTypeLiteralNode(facilities.type))
			throw new Error(`[docs] ${posix(relative(root, FACILITIES))} declares no Facilities type`);
		const row = (member: ts.TypeElement) => {
			if (!ts.isPropertySignature(member) || member.type === undefined) return [];
			const declared = member.type;
			const optional =
				ts.isTypeReferenceNode(declared) &&
				declared.typeName.getText() === 'Optional' &&
				declared.typeArguments?.[0] !== undefined;
			const inner = optional ? (declared.typeArguments?.[0] ?? declared) : declared;
			const target = ts.isTypeReferenceNode(inner)
				? checker.getSymbolAtLocation(inner.typeName)
				: undefined;
			const summary =
				target === undefined
					? ''
					: first(
							ts.displayPartsToString(
								(target.flags & ts.SymbolFlags.Alias
									? checker.getAliasedSymbol(target)
									: target
								).getDocumentationComment(checker)
							)
						);
			return [
				`| \`${member.name.getText()}\` | \`${inner.getText()}\` | ${optional ? 'or `off`' : 'required'} | ${summary.replaceAll('|', '\\|')} |`
			];
		};
		const table = (members: readonly ts.TypeElement[]) => [
			'| Member | Interface | Supply | What it is |',
			'| --- | --- | --- | --- |',
			...members.flatMap(row)
		];
		const groups = facilities.type.members.filter(
			(m): m is ts.PropertySignature =>
				ts.isPropertySignature(m) && m.type !== undefined && ts.isTypeLiteralNode(m.type)
		);
		const single = facilities.type.members.filter((m) => !groups.some((g) => g === m));
		// written only when it changes: the overlay watch counts any write under the package as a fresh edit
		writeIfChanged(
			HOSTS,
			[
				'# Host facilities',
				'',
				'Generated by `scripts/docs.ts` from the `Facilities` type in `src/facilities/index.ts`; do not edit.',
				'',
				'A host wraps a bundle and supplies every member below. Without a host file, Colony supplies them all (tethered, the',
				"default). A workspace's `norbital.host.ts`, or the file `--host=<file>` names, makes `bolt dev` and bolt-server serve it",
				'untethered: its default export is this `Facilities` record (`satisfies Facilities`), and an optional `serving` export',
				"adds the parts served around it (`Serving`). The host file is never part of the release's source. `off` is the only",
				'way to leave an optional member out; `mail` has none. Activation refuses a bundle whose recorded needs name a member',
				'left `off`, naming each one. The guest runner is no facility: each host owns its own (`HostPorts.guests`; bolt-server',
				"and `bolt dev` run bolt-cli's `nodeGuests`, Colony its isolated-vm runner).",
				...groups.flatMap((g) =>
					g.type !== undefined && ts.isTypeLiteralNode(g.type)
						? ['', `## ${g.name.getText()}`, '', ...table(g.type.members)]
						: []
				),
				'',
				'## Host-wide',
				'',
				...table(single),
				''
			].join('\n')
		);
		console.log(
			`[docs] ${index.namespaces.map((n) => `${n.namespace} ${n.symbols}`).join(', ')}; ${index.missing.length} reference symbols without a summary; skills ${index.skills.map((k) => k.name).join(', ')}`
		);
	},
	catch: (cause) =>
		new DocsFailed({ message: cause instanceof Error ? cause.message : String(cause), cause })
});

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1])
	NodeRuntime.runMain(generateDocs);
