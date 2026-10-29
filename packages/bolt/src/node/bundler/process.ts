/// <reference types="node" />
// The confined bundler process (compute model §3, "Running a file", P24): rolldown over a tree the kernel sends, one
// bundle per message. Every byte it bundles arrives over IPC and every import is answered by `resolver.ts`, so it reads
// nothing from disk but its own code and rolldown's; the kernel confines it so it cannot (`index.ts`). In:
// `{ id, entry, files }` (paths in the tree); out: `{ id, code, map }` or `{ id, errors }`. Its replies are untrusted.
import { posix } from 'node:path';
import { rolldown, type Plugin } from 'rolldown';
import { APP, array, record, resolver } from './resolver.ts';

const NODE = `globalThis[Symbol.for('norbital.node')]`;
const RUN = '\0run';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const rel = (id: string) => (id.startsWith(`${APP}/`) ? id.slice(APP.length + 1) : id);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What an error of rolldown's says: its message and, for a syntax or link error, where. */
type Log = {
	readonly message: string;
	readonly at?: { readonly file: string; readonly line: number; readonly column: number };
};
const logOf = (x: unknown): Log => {
	const message =
		record(x) && 'message' in x && typeof x.message === 'string' ? x.message : String(x);
	const loc = record(x) && 'loc' in x && record(x.loc) ? x.loc : undefined;
	return loc !== undefined &&
		'file' in loc &&
		typeof loc.file === 'string' &&
		'line' in loc &&
		typeof loc.line === 'number' &&
		'column' in loc &&
		typeof loc.column === 'number'
		? { message, at: { file: loc.file, line: loc.line, column: loc.column } }
		: { message };
};
/** A failed build's errors: rolldown's `BundleError.errors`, else the throw itself. */
const logsOf = (error: unknown): readonly Log[] => {
	const errors: unknown = record(error) && 'errors' in error ? error.errors : undefined;
	return array(errors) ? errors.map(logOf) : [logOf(error)];
};

function treePlugin(files: ReadonlyMap<string, Uint8Array>, entry: string) {
	const resolve = resolver(files);
	const text = (id: string) => decode(files.get(id) ?? new Uint8Array());
	const lineOf = (id: string, line: number) => text(id).split('\n')[line - 1] ?? '';
	// a resolver refusal carries no position in rolldown, so the import is found in its importer's text
	const where = (importer: string, specifier: string) => {
		const source = text(importer),
			at = source.search(new RegExp(`(['"])${escape(specifier)}\\1`));
		if (at < 0) return { at: rel(importer), line: '' };
		const lines = source.slice(0, at).split('\n');
		return {
			at: `${rel(importer)}:${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`,
			line: lineOf(importer, lines.length)
		};
	};
	const plugin: Plugin = {
		name: 'norbital-tree',
		resolveId(source, importer, extra) {
			if (source === RUN) return RUN;
			const r = resolve(
				source,
				importer ?? RUN,
				extra.kind === 'require-call' ? 'require' : 'import'
			);
			if ('builtin' in r) return `\0builtin:${r.builtin}`;
			if ('path' in r) return r.path;
			// Node fails a static import before any code runs, and a require() only when it is called
			if (extra.kind === 'require-call')
				return `\0refused:${JSON.stringify({ error: r.error, by: rel(importer ?? RUN) })}`;
			const { at, line } = where(importer ?? RUN, source);
			return this.error(`${at}: ${r.error}\n    ${line}`);
		},
		load(id) {
			if (id === RUN)
				return `export default { run: (input) => ${NODE}.run(input, () => import(${JSON.stringify(`${APP}/${entry}`)})) };`;
			if (id.startsWith('\0builtin:'))
				return `module.exports = ${NODE}.builtin(${JSON.stringify(id.slice('\0builtin:'.length))});`;
			if (id.startsWith('\0refused:')) {
				const refused: unknown = JSON.parse(id.slice('\0refused:'.length));
				const message =
					record(refused) && 'error' in refused && 'by' in refused
						? `${String(refused.error)} (required by ${String(refused.by)})`
						: 'a module is not available in run_js';
				return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: 'MODULE_NOT_FOUND' });`;
			}
			const bytes = files.get(id);
			if (bytes === undefined) return this.error(`Cannot find module '${rel(id)}'`);
			if (id.endsWith('.json')) return { code: decode(bytes), moduleType: 'json' };
			const code = decode(bytes);
			// the CommonJS names a bundle does not define per module, on the first line so its line numbers stay true
			return /\b__(dirname|filename)\b/.test(code)
				? `var __filename = ${JSON.stringify(id)}, __dirname = ${JSON.stringify(posix.dirname(id))}; ${code}`
				: code;
		}
	};
	const format = ({ message, at }: Log) => {
		const first = plain(message)
			.replace(/^\[[A-Z_]+\]\s*/, '')
			.replaceAll('"app/', '"');
		return at === undefined
			? first
			: `${rel(at.file)}:${at.line}:${at.column + 1}: ${first.split('\n')[0]}\n    ${lineOf(at.file, at.line)}`;
	};
	return { plugin, format };
}

const bundle = async (entry: string, files: ReadonlyMap<string, Uint8Array>) => {
	if (!files.has(`${APP}/${entry}`)) return { errors: [`Cannot find module '${entry}'`] };
	const tree = treePlugin(files, entry);
	try {
		const build = await rolldown({
			input: RUN,
			platform: 'neutral',
			plugins: [tree.plugin],
			logLevel: 'silent',
			onLog: () => {}
		});
		try {
			const { output } = await build.generate({
				format: 'esm',
				sourcemap: true,
				sourcemapExcludeSources: true,
				codeSplitting: false,
				file: `${APP}/.bundle.mjs`
			});
			const chunk = output[0];
			return chunk.map === null
				? { errors: ['the bundler made no source map'] }
				: { code: chunk.code, map: chunk.map.toString() };
		} finally {
			await build.close();
		}
	} catch (error) {
		return { errors: logsOf(error).map(tree.format) };
	}
};

process.on('message', (message: unknown) => {
	if (
		!record(message) ||
		!('id' in message) ||
		!('entry' in message) ||
		!('files' in message) ||
		typeof message.entry !== 'string' ||
		!array(message.files)
	)
		return;
	const id = message.id,
		sent: readonly unknown[] = message.files,
		files = new Map<string, Uint8Array>();
	for (const file of sent) {
		const [path, bytes] = array(file) ? file : [];
		if (typeof path === 'string' && bytes instanceof Uint8Array) files.set(`${APP}/${path}`, bytes);
	}
	void bundle(message.entry, files).then((reply) => process.send?.({ id, ...reply }));
});
