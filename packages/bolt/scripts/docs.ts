/// <reference types="node" />
// The API reference generator, run by bolt's build after the package compiles: `node scripts/docs.ts`.
// It walks every public entry (`exports`, `./tooling` aside) of bolt, ui and bolt-cli, reads each entry's
// declarations with the TypeScript checker (no TypeDoc) and writes one JSON document per namespace plus `index.json`
// to `build/docs/`, where `@norbital-ai/bolt/docs` reads them. bolt and its dependencies are read from their built
// `.d.ts`; bolt-cli builds after bolt, so its entries are read from source, and its `bolt` command's verbs become the
// `bolt-cli/cli` namespace (each `Command.make` const's doc comment, its flags' and arguments' descriptions).
// Output is sorted and carries no time, so a build of the same sources is byte-identical. Svelte components are read
// through svelte-package's `.svelte.d.ts`: their props are the second parameter of the component's call signature,
// and a prop of an object type lists its fields. Each symbol carries its `group`, the source folder it lives in under
// the entry. `index.json`'s `missing` lists every symbol and component prop without a doc comment; `tests/docs.test.ts`
// fails on it.
// `oss/skills/` (the one source of authoring skills, which realm agents read by path) compiles beside it:
// one `skill.<name>.json` per skill folder holding every Markdown file, listed in `index.json`'s `skills`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Effect, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { skill_file } from '../src/engine/docs-corpus.ts';
import type {
	DocIndex,
	DocKind,
	DocMember,
	DocNamespace,
	DocParam,
	DocSkill,
	DocSymbol
} from '../src/engine/docs-corpus.ts';

class DocsFailed extends Schema.TaggedError<DocsFailed>()('DocsFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}

const PACKAGES = ['bolt', 'ui', 'bolt-cli'];
/** Packages read from source: they build after bolt. */
const FROM_SOURCE = new Set(['bolt-cli']);
/** What an author reads for each role: these symbols' shapes, generated into `bolt-contract` so a card cannot drift. */
const CONTRACT: { readonly [role: string]: { readonly [namespace: string]: readonly string[] } } = {
	model: {
		bolt: ['CreateInput', 'UpdateInput', 'WriteCtx', 'CarriedWrites', 'Kind'],
		'bolt/declarations': ['ModelDeclaration', 'ModelLiteral']
	},
	access: { bolt: ['team', 'policy', 'PolicyCtx', 'StoredTree', 'ApprovalFlow', 'Verdict'] },
	automation: {
		bolt: ['automation', 'AutomationCtx', 'browser_start', 'ReadRequestBase', 'Outcome'],
		'bolt/errors': ['Refusal']
	},
	sync: { bolt: ['RemoteSync', 'SyncCtx', 'SyncRow', 'Health', 'FileSyncCtx'] },
	integration: {
		bolt: ['InstanceId', 'instance_id', 'is_instance'],
		'bolt/declarations': ['IntegrationDeclaration', 'IntegrationLiteral', 'Integration'],
		'bolt/page': ['IntegrationSetup']
	},
	page: {
		bolt: ['app', 'Page', 'group'],
		'bolt/page': ['PageBolt', 'PageSnapshotHost'],
		ui: ['Table', 'Col', 'Form', 'Field', 'Section', 'RecordShell', 'Board', 'Chart']
	},
	test: {
		'bolt-cli/test': [
			'TestWorkspace', 'Kit', 'Caller', 'TestOptions', 'JobResult', 'NativeReadRow', 'NativeReadAnswer', 'NativeActAnswer'
		]
	}
};
/** Each role's first file, appended to the primer so one read starts a build; the cards hold only the symbols' shapes. */
const CONTRACT_HEAD: { readonly [role: string]: string } = {
	automation: `An automation runs under its declared \`policies\`. They must read every model it reads or links to, \`sys_user\` included:

\`\`\`ts
// src/automation/+<name>.automation.ts
import { automation } from '@norbital-ai/bolt';

export default automation({
	description: '<what it does>',
	on: [{ cron: '0 2 * * *' }], // integrations own webhooks; row writes run their model's effect
	policies: ['<policy>'],
	run: function* (input, ctx) {
		const { rows } = (yield* ctx.query({ <model>: { fields: ['<field>'] } })).<model>;
		yield* ctx.act({ '<model>.create': [{ <field>: <value> }] });
	}
});
\`\`\`

The default mode is a durable job. \`mode: 'call'\` returns its typed \`output\` in the request; a positive \`cache\` duration shares read-only answers. \`agent: 'direct'\`, \`'confirm'\` or \`'never'\` controls its use as an agent tool. Jobs alone accept cron triggers and retries.

A model answers \`yield* ctx.ai.sys_2.infer({ system: '<role>', prompt: '<task>', output: { kind: 'object', fields: { <field>: { kind: 'text' } } } })\` with the \`output\`'s value (text when absent).

Runtime accounts are durable \`sys_integration\` rows, created in Settings or through \`sys_integration.create\`; source declares no connection slots. \`yield* ctx.notify({ title: '<title>', to: [{ team: '<team>' }], via: [instance_id('<integration>', account)] })\` reaches each recipient in the app and on the selected account. Built-in conversation definitions need no duplicate source declaration.

For a daily channel message, read the intended active workspace account (\`owner\` null, with its intended \`envoy\`) and use \`yield* ctx.send(instance_id('whatsapp', account), { to: '<recipient handle or conversation id>', text: '<message>' })\` in the cron body. Import \`instance_id\` from \`@norbital-ai/bolt\`. Refuse when the account is missing or ambiguous; never silently choose another account. Sends are durably queued, and the provider's acknowledgement and retry outcome appear on the message. Retries of an automation may repeat committed sends: do not promise exactly-once delivery. The recipient's later replies use that account's envoy and the same conversation, with delivered messages in context.

Time is \`ctx.today\`, a \`PlainDate\`, and \`ctx.now\`, an ISO instant string; do date and duration math with Effect's \`DateTime\` and \`Duration\` (\`DateTime.add(DateTime.makeUnsafe(ctx.today), { months: 1 })\`, \`DateTime.formatIsoDateUtc\`). A model's \`effect\` has the same two.

In a test, \`t.clock.set('<instant>')\` then \`const { failed } = yield* t.run_due()\` fires what is due at that instant. Assert \`expect(failed).toEqual([])\` first: a run that failed says why there, and nothing else will.`,
	model: `\`src/data/model/<name>/+model.ts\`. A model takes only the writes it declares:

\`\`\`ts
import { model } from '../../../../.norbital/models/<name>.ts';

export default model({
	description: '<what one record is>',
	icon: 'lucide:<icon>',
	record_label: 'record.<field>',
	fields: {
		<field>: { kind: 'text' },
		<other>: { kind: 'ref', to: '<model>', inverse: '<field on it>', on_delete: 'restrict' }
	},
	outputs: { default: { fields: 'all' } },
	// columns use the same nested tree as outputs: fields, then child-relation keys
	create: { columns: { fields: ['<field>', '<other>'] } },
	update: { columns: { fields: ['<field>', '<other>'] } }
});
\`\`\`

A required field added to a model with rows needs a data step in its generated migration, filling them.`,
	integration: `A definition lives at \`src/integration/<name>/+integration.ts\` and uses that folder's generated binding. Read the definition's exported types before authoring it. Built-in conversation definitions already exist.

Accounts and envoys are runtime records: \`sys_envoy\` holds the assistant's name, task and policies; \`sys_integration\` holds one account, its configuration, optional envoy and durable sealed pairing. Create any number of workspace accounts with no owner. Settings → Envoys creates an envoy then pairs its provider; Settings → Connections creates and configures other workspace accounts. Keep a supplied \`+integration.svelte\` companion.

For native setup in a root web conversation, read \`describe_workspace { names: ['system'] }\`; use the returned capability and account id with \`page { path, configure }\`. The native form collects credentials directly from the person. Envoys and delegated agents have no user tab. Never ask for a secret in chat or invent an envoy source file. Cron jobs send through a concrete paired workspace account with \`ctx.send\`; see the automation card.`,
	access: `A policy is one file; a grant names only verbs its model declares. Every team is in the one team file:

\`\`\`ts
// src/access_control/policy/+<policy>.policy.ts
import { policy } from '@norbital-ai/bolt';

export default policy({
	description: '<what holders may do>',
	grants: { <model>: { outputs: { default: {} }, create: {}, update: {} } }
});

// src/access_control/team/+team.ts
import { team } from '@norbital-ai/bolt';

export default team({ <team>: { name: '<Team name>', policies: ['<policy>'] } });
\`\`\``,
	page: `An app is its folder: \`+app.ts\` and one \`+<page>.page.svelte\` per page. A list of records needs nothing else:

\`\`\`ts
// src/app/<app>/+app.ts
import { app } from '@norbital-ai/bolt';

export default app({
	title: '<Title>',
	description: '<what it is for>',
	icon: 'lucide:<icon>',
	pages: { <page>: { title: '<Title>', icon: 'lucide:<icon>' } }
});
\`\`\`

\`\`\`svelte
<!-- src/app/<app>/+<page>.page.svelte -->
<script lang="ts">
	import { Table } from '@norbital-ai/ui';
</script>

<Table of="<model>" />
\`\`\``,
	test: `Tests are \`tests/<name>.test.ts\`. Everything comes from the kit, and \`workspace_test\` runs them:

\`\`\`ts
import { Effect, Exit } from 'effect';
import { TestWorkspace, expect, it } from '@norbital-ai/bolt-cli/test';

it.layer(TestWorkspace.layer({ root: new URL('..', import.meta.url).pathname }))('<model>', (it) => {
	it.effect('<what it proves>', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const caller = yield* t.as(t.member(['<policy>'])); // or yield* t.as(t.admin)
			yield* caller.act({ '<model>.create': [{ <field>: <value> }] });
			const refused = yield* Effect.exit(caller.act({ '<model>.create': [{ <field>: <bad value> }] }));
			expect(Exit.isFailure(refused)).toBe(true);
			const { rows } = (yield* caller.query({ <model>: { fields: ['<field>'] } })).<model>;
			expect(rows).toHaveLength(1);
			const [row] = rows;
			if (row === undefined) throw new Error('Expected the created row.');
			yield* caller.act({ '<model>.update': [{ target: row, set: { <field>: <value> } }] });
		})
	);
});
\`\`\`

A file shares one workspace: rows stay between its tests, so assert on your own rows.`
};
const CONTRACT_SKILL = 'bolt-contract';
const PRIMER_SKILL = 'bolt-primer';
const CARDED = new Set(Object.values(CONTRACT).flatMap((named) => Object.values(named).flat()));
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // oss/packages
const out = join(root, 'bolt', 'build', 'docs');
const SKILLS = join(root, '..', 'skills'); // oss/skills: the authoring skills
const CLI = join(root, 'bolt-cli', 'src', 'cli');
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
						file: join(
							root,
							pkg,
							FROM_SOURCE.has(pkg)
								? types.replace(/^\.\/build\//, 'src/').replace(/\.d\.ts$/, '.ts')
								: types
						)
					}
				];
			});
		}).sort((a, b) => byCode(a.namespace, b.namespace));

		const program = ts.createProgram(entries.map((e) => e.file), {
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
			const tags = [
				...sym.getJsDocTags(checker),
				...(sym === alias ? [] : alias.getJsDocTags(checker))
			];
			const examples = tags
				.filter((t) => t.name === 'example')
				.map((t) => ts.displayPartsToString(t.text).trim())
				.filter(Boolean);
			const guidance = [
				...new Set(
					tags
						.filter((tag) => !['param', 'example'].includes(tag.name))
						.map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text).trim()}`)
				)
			];
			return {
				text: [text, ...guidance].filter(Boolean).join('\n\n'),
				examples: [...new Set(examples)]
			};
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

		const isObjectLike = (t: ts.Type) =>
			!!(t.flags & ts.TypeFlags.Object) ||
			(t.isIntersection() && t.types.every((x) => !!(x.flags & ts.TypeFlags.Object)));
		/** The first-party properties of a type, with their docs; at most 80. `expand`: an object-typed one lists its fields. */
		function membersOf(type: ts.Type, at: ts.Node, expand = false): DocParam[] {
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
					const { text, examples } = comment(p, p);
					const summary = first(text);
					// a prop of one object shape (`false | { … }` included) lists that shape's fields
					const own = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, at));
					const shapes = (own.isUnion() ? own.types : [own]).filter(
						(t) => isObjectLike(t) && checker.getSignaturesOfType(t, ts.SignatureKind.Call).length === 0
					);
					const shape = shapes.length === 1 ? shapes[0] : undefined;
					const fields = expand && shape !== undefined ? membersOf(shape, at) : [];
					return {
						name: p.name,
						type: typeText(p, at),
						...(p.flags & ts.SymbolFlags.Optional ? { optional: true as const } : {}),
						...(summary === '' ? {} : { summary }),
						...(text.replace(/\s+/g, ' ').trim() === summary ? {} : { docs: text }),
						...(examples.length === 0 ? {} : { examples }),
						...(fields.length === 0 ? {} : { fields })
					};
				});
		}

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

		function declarationText(d: ts.Declaration, name: string): string {
			const text = d.getText().replace(/^\s*(export\s+)?(declare\s+)?/, '');
			return clip(text, CARDED.has(name) ? 4000 : 1500);
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
				props: DocParam[] | undefined,
				members: DocMember[] | undefined;
			if (f & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
				const type = checker.getTypeOfSymbolAtLocation(sym, d);
				const propsType = componentProps(type);
				const sigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
				if (propsType !== undefined) {
					kind = 'component';
					props = membersOf(propsType, d, true);
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
				signature = declarationText(d, name);
				const key = checker.getTypeOfSymbolAtLocation(sym, d);
				const service =
					key.getProperty('~effect/Context/Service') === undefined
						? undefined
						: key.getProperty('Service');
				// Effect keys carry their implementation on the static Service type,
				// not the class instance. Authors need that shape to supply a test layer.
				members = membersOf(
					service === undefined
						? checker.getDeclaredTypeOfSymbol(sym)
						: checker.getTypeOfSymbolAtLocation(service, d),
					d
				);
			} else if (f & ts.SymbolFlags.Interface) {
				kind = 'interface';
				signature = declarationText(d, name);
				const type = checker.getDeclaredTypeOfSymbol(sym);
				members = membersOf(type, d);
				const call = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
				if (call !== undefined) params = paramsOf(call, d);
			} else if (f & ts.SymbolFlags.TypeAlias) {
				kind = 'type';
				signature = declarationText(d, name);
				const t = checker.getDeclaredTypeOfSymbol(sym);
				if (isObjectLike(t) && !(ts.isTypeAliasDeclaration(d) && ts.isMappedTypeNode(d.type))) {
					const m = membersOf(t, d);
					if (m.length > 0) members = m;
				}
			} else if (f & ts.SymbolFlags.Enum) {
				kind = 'enum';
				signature = declarationText(d, name);
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

		/** The entry source's leading comment: what the entry is for (`// @norbital-ai/ui: …`). */
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

		/** Each symbol's `group`: its source folder under the entry, past the folders all its symbols share. */
		function grouped(symbols: DocSymbol[]): DocSymbol[] {
			const paths = symbols.map((s) => {
				const file = s.source.replace(/:\d+$/, '');
				const vendor = [...file.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop()?.[1];
				return vendor !== undefined
					? null
					: file
							.replace(/^packages\/[^/]+\/(src\/)?/, '')
							.replace(/(\.svelte)?\.(ts|js)$|\.svelte$/, '')
							.split('/');
			});
			const own = paths.filter((p): p is string[] => p !== null);
			let shared = 0;
			while (
				own.length > 0 &&
				own.every((p) => shared < p.length - 1 && p[shared] === own[0]?.[shared])
			)
				shared++;
			return symbols.map((s, i) => ({
				...s,
				group:
					paths[i]?.[shared] ??
					[...s.source.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop()?.[1] ??
					''
			}));
		}

		/**
		 * The `bolt` command's verbs, read from bolt-cli's source: each `const x = Command.make('verb', { …config }, …)`
		 * with the doc comment above it, its flags and arguments (`Flag.String('name')`, `Argument.String('name')`, through
		 * a local const or helper) with their `withDescription` text, and its parents through `Command.withSubcommands`.
		 */
		function cliNamespace(): DocNamespace {
			type Verb = { file: string; name: string; at: ts.VariableDeclaration; make: ts.CallExpression };
			const files = readdirSync(CLI)
				.filter((f) => f.endsWith('.ts'))
				.sort(byCode)
				.map((f) => ts.createSourceFile(join(CLI, f), readFileSync(join(CLI, f), 'utf8'), ts.ScriptTarget.ESNext, true));
			const consts = new Map<string, ts.VariableDeclaration>();
			for (const sf of files)
				for (const st of sf.statements)
					if (ts.isVariableStatement(st))
						for (const d of st.declarationList.declarations)
							if (ts.isIdentifier(d.name)) consts.set(`${sf.fileName}#${d.name.text}`, d);
			/** A const by name, in its own file or the file exporting it. */
			const lookup = (sf: ts.SourceFile, name: string) =>
				consts.get(`${sf.fileName}#${name}`) ??
				[...consts.entries()].find(
					([key, d]) =>
						key.endsWith(`#${name}`) &&
						(d.parent.parent.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
				)?.[1];
			const calls = (node: ts.Node): ts.CallExpression[] => {
				const found: ts.CallExpression[] = [];
				const visit = (n: ts.Node): void => {
					if (ts.isCallExpression(n)) found.push(n);
					n.forEachChild(visit);
				};
				visit(node);
				return found;
			};
			const callee = (c: ts.CallExpression) => c.expression.getText();
			const literal = (n: ts.Node | undefined) =>
				n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
			const verbs: Verb[] = [];
			for (const d of consts.values()) {
				const make =
					d.initializer === undefined
						? undefined
						: calls(d.initializer).find((c) => callee(c) === 'Command.make');
				if (make !== undefined && ts.isIdentifier(d.name))
					verbs.push({ file: d.getSourceFile().fileName, name: d.name.text, at: d, make });
			}
			const parent = new Map<ts.VariableDeclaration, ts.VariableDeclaration>();
			for (const v of verbs)
				for (const c of calls(v.at).filter((c) => callee(c) === 'Command.withSubcommands'))
					for (const id of c.arguments[0] !== undefined && ts.isArrayLiteralExpression(c.arguments[0])
						? c.arguments[0].elements
						: [])
						if (ts.isIdentifier(id)) {
							const child = lookup(v.at.getSourceFile(), id.text);
							if (child !== undefined) parent.set(child, v.at);
						}
			const verbName = (v: Verb): string => literal(v.make.arguments[0]) ?? v.name;
			const path = (d: ts.VariableDeclaration): string[] => {
				const v = verbs.find((x) => x.at === d);
				const up = parent.get(d);
				return [...(up === undefined ? [] : path(up)), ...(v === undefined ? [] : [verbName(v)])];
			};
			/** One flag or argument: its kind, name and description, through a local const or helper. */
			const option = (sf: ts.SourceFile, key: string, expr: ts.Expression): DocParam => {
				const all = calls(expr);
				const ref = ts.isIdentifier(expr) ? lookup(sf, expr.text) : undefined;
				const helpers = [
					...all.flatMap((c) => (ts.isIdentifier(c.expression) ? [lookup(sf, c.expression.text)] : [])),
					ref
				].flatMap((d) => (d?.initializer === undefined ? [] : [d.initializer]));
				const chain = [...all, ...helpers.flatMap(calls)];
				const base = chain.find((c) => /^(Flag|Argument)\.(String|Boolean|Integer|Float|Choice|Path|File|Directory)$/.test(callee(c)));
				const named =
					literal(base?.arguments[0]) ?? literal(all.find((c) => ts.isIdentifier(c.expression))?.arguments[0]) ?? key;
				const flag = base === undefined ? true : callee(base).startsWith('Flag.');
				const kind = base === undefined ? 'String' : callee(base).split('.')[1];
				const variadic = chain.some((c) => callee(c) === 'Argument.variadic');
				const optional =
					variadic ||
					kind === 'Boolean' ||
					[expr, ...helpers].some((n) => /\b(Flag|Argument)\.(optional|withDefault)\b/.test(n.getText()));
				const description = chain
					.filter((c) => /\.withDescription$/.test(callee(c)))
					.map((c) => literal(c.arguments[0]))
					.find((t) => t !== undefined);
				return {
					name: flag ? `--${named}` : `<${named}${variadic ? '…' : ''}>`,
					type: kind === 'Boolean' ? 'boolean' : kind === 'Integer' || kind === 'Float' ? 'number' : 'string',
					...(optional ? { optional: true as const } : {}),
					...(description === undefined ? {} : { summary: description })
				};
			};
			const symbols = verbs.map((v): DocSymbol => {
				const sf = v.at.getSourceFile();
				const config = v.make.arguments[1];
				const params =
					config !== undefined && ts.isObjectLiteralExpression(config)
						? config.properties.flatMap((p) =>
								ts.isPropertyAssignment(p)
									? [option(sf, p.name.getText(), p.initializer)]
									: ts.isShorthandPropertyAssignment(p)
										? [option(sf, p.name.text, p.name)]
										: []
							)
						: [];
				const text = ts
					.getJSDocCommentsAndTags(v.at.parent.parent)
					.filter(ts.isJSDoc)
					.map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '')
					.join('\n')
					.trim();
				const name = ['bolt', ...path(v.at)].filter((w, i) => i === 0 || w !== 'bolt').join(' ');
				const usage = params
					.map((p) => (p.optional === true ? `[${p.name}]` : p.name))
					.join(' ');
				const summary = first(text);
				return {
					name,
					kind: 'command',
					signature: `${name}${usage === '' ? '' : ` ${usage}`}`,
					summary,
					...(text.replace(/\s+/g, ' ').trim() !== summary ? { docs: text } : {}),
					...(params.length === 0 ? {} : { params }),
					source: `packages/${posix(relative(root, sf.fileName))}:${sf.getLineAndCharacterOfPosition(v.at.getStart()).line + 1}`,
					group: path(v.at)[0] === 'templates' ? 'templates' : 'workspace'
				};
			});
			return {
				namespace: 'bolt-cli/cli',
				module: 'bolt',
				summary:
					"The `bolt` command (`@norbital-ai/bolt-cli`'s bin): a workspace's verbs, run inside it or given its directory, and the template repository's `bolt templates` CI verbs. Exit 0 ok, 1 author errors, 2 tool failure.",
				symbols: symbols.sort((a, b) => byCode(a.name, b.name))
			};
		}

		mkdirSync(out, { recursive: true });
		const index: DocIndex = { namespaces: [], missing: [], skills: [] };
		const contractSymbols = new Map<string, DocSymbol>();
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
			const files = paths.map((path) => {
				const text = readFileSync(join(SKILLS, name, path), 'utf8');
				return {
					path,
					text:
						name === PRIMER_SKILL && path === 'SKILL.md'
							? `${text.trimEnd()}\n\n## Starters\n\nEach role's first file. Its symbols field by field, for a field a starter does not show: \`skill { name: '${CONTRACT_SKILL}', file: '<role>.md' }\`, roles ${Object.keys(CONTRACT).join(', ')}.\n\n${Object.keys(CONTRACT)
									.flatMap((role) => CONTRACT_HEAD[role] === undefined ? [] : [`### ${role}\n\n${CONTRACT_HEAD[role]}`])
									.join('\n\n')}\n`
							: text
				};
			});
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
			writeFileSync(join(out, skill_file(name)), `${JSON.stringify(skill, null, '\t')}\n`);
			index.skills.push({ name, description, files: paths });
		}
		const namespaces: DocNamespace[] = entries.map((e) => {
			const sf = program.getSourceFile(e.file);
			const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
			if (sf === undefined || mod === undefined)
				throw new Error(`[docs] ${e.namespace}: ${posix(relative(root, e.file))} is not built`);
			return {
				namespace: e.namespace,
				module: e.module,
				summary: entrySummary(e),
				symbols: grouped(
					checker
						.getExportsOfModule(mod)
						.map(symbolOf)
						.filter((s): s is DocSymbol => s !== null)
						.sort((a, b) => byCode(a.name, b.name))
				)
			};
		});
		namespaces.push(cliNamespace());
		namespaces.sort((a, b) => byCode(a.namespace, b.namespace));
		for (const ns of namespaces) {
			for (const s of ns.symbols) contractSymbols.set(`${ns.namespace}#${s.name}`, s);
			writeFileSync(
				join(out, `${ns.namespace.replaceAll('/', '.')}.json`),
				`${JSON.stringify(ns, null, '\t')}\n`
			);
			index.namespaces.push({
				namespace: ns.namespace,
				module: ns.module,
				summary: ns.summary,
				symbols: ns.symbols.length
			});
			for (const s of ns.symbols) {
				if (s.summary === '') index.missing.push(`${ns.namespace}#${s.name}`);
				for (const p of s.props ?? [])
					if (p.summary === undefined) index.missing.push(`${ns.namespace}#${s.name}.${p.name}`);
			}
		}

		const sentence = (text: string) =>
			clip(/^.*?(?<!e\.g|i\.e)\.(?=\s|$)/s.exec(text)?.[0] ?? text, 200);
		const line = (m: DocMember) =>
			`- ${m.name}${m.optional === true ? '?' : ''}: ${clip(m.type, 240)}${m.summary === undefined ? '' : ` — ${sentence(m.summary)}`}`;
		const card = (s: DocSymbol) => {
			const shape = [
				...(s.params ?? []).flatMap((p) => p.fields ?? []),
				...(s.props ?? []),
				...(s.members ?? [])
			];
			return [
				`## ${s.name}`,
				sentence(s.summary),
				...(s.kind === 'function' ? [clip(s.signature, 300)] : []),
				...(shape.length > 0
					? shape.map(line)
					: s.kind === 'function'
						? []
						: [s.signature.replace(/\s+/g, ' ')])
			]
				.filter((part) => part !== '')
				.join('\n');
		};
		const roles = Object.entries(CONTRACT).map(([role, named]) => ({
			path: `${role}.md`,
			text: `# ${role}\n\n${Object.entries(
				named
			)
				.flatMap(([namespace, names]) =>
					names.map((name) => {
						const found = contractSymbols.get(`${namespace}#${name}`);
						if (found === undefined) throw new Error(`[docs] no ${namespace}#${name} for a card`);
						return card(found);
					})
				)
				.join('\n\n')}\n`
		}));
		const description = "Bolt's authoring contract: one card per role, generated from its types.";
		const contract: DocSkill = {
			name: CONTRACT_SKILL,
			description,
			files: [
				{
					path: 'SKILL.md',
					text: `---\ndescription: ${description}\n---\n\n# Bolt contract\n\nOne card per role, read with \`file\`: ${roles.map((r) => r.path).join(', ')}.\n`
				},
				...roles
			]
		};
		writeFileSync(
			join(out, skill_file(CONTRACT_SKILL)),
			`${JSON.stringify(contract, null, '\t')}\n`
		);
		index.skills.push({
			name: CONTRACT_SKILL,
			description,
			files: contract.files.map((file) => file.path)
		});
		writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
		console.log(
			`[docs] ${index.namespaces.map((n) => `${n.namespace} ${n.symbols}`).join(', ')}; ${index.missing.length} reference symbols without a summary; skills ${index.skills.map((k) => k.name).join(', ')}`
		);
	},
	catch: (cause) =>
		new DocsFailed({ message: cause instanceof Error ? cause.message : String(cause), cause })
});

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1])
	NodeRuntime.runMain(generateDocs);
