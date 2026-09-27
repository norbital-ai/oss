/// <reference types="node" />
// `bolt check`'s type stage and `bolt build` (rule 7): check, tsc, svelte-check and doctor, then the artifact and the seed packs.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPacks, readArtifact, templateMeta, writeArtifact, type Artifact, type PackJson } from '../compiler/artifact/index.ts';
import { check, seedPack, type CheckDiagnostic } from '../compiler/check/index.ts';
import { discover } from '../compiler/discover.ts';
import { typeIndex } from '../compiler/artifact/types.ts';
import { writeTypeSetup } from '../compiler/names.ts';

export type Log = (line: string) => void;
const TYPES_MS = 120_000;
const require = createRequire(import.meta.url);

/** An author error: exit 1 with every diagnostic printed. */
export class AuthorErrors extends Error {
	readonly errors: readonly CheckDiagnostic[];
	constructor(errors: readonly CheckDiagnostic[]) {
		super(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
		this.errors = errors;
	}
}

export function bin(pkg: string, name: string, from: string): string | undefined {
	for (const base of [join(from, 'package.json'), fileURLToPath(import.meta.url)]) {
		try {
			const manifest = createRequire(base).resolve(`${pkg}/package.json`);
			const b = (require(manifest) as { bin?: string | { [k: string]: string } }).bin;
			const rel = typeof b === 'string' ? b : b?.[name];
			if (rel !== undefined) return join(dirname(manifest), rel);
		} catch { /* not installed there */ }
	}
	return undefined;
}

/** `@norbital-ai/doctor`'s one export, typed here so bolt's own types need not reach the package. */
type Doctor = (o: { root: string }) => readonly { rule: string; summary: string; location: string }[];

/** Rule 7's last stage: doctor's four workspace packs over the sources; every finding is an error. */
export function doctorFindings(root: string): CheckDiagnostic[] {
	// bolt's own dependency first (they release together), then one the workspace installs
	const base = [fileURLToPath(import.meta.url), join(root, 'package.json')].find((b) => {
		try { createRequire(b).resolve('@norbital-ai/doctor'); return true; } catch { return false; }
	});
	if (base === undefined) return [{ code: 'types/doctor', path: 'package.json', message: 'doctor is not installed' }];
	const { doctor } = createRequire(base)('@norbital-ai/doctor') as { doctor: Doctor };
	return doctor({ root }).map((f) => {
		const m = /^(.+?):(\d+): ([\s\S]*)$/.exec(f.location);
		return m === null
			? { code: `doctor/${f.rule}`, path: f.location, message: `${f.location}: ${f.summary}` }
			: { code: `doctor/${f.rule}`, path: m[1]!, line: Number(m[2]), message: `${m[1]}:${m[2]}: ${f.summary} — ${m[3]!.trim()}` };
	});
}

/** Rule 7's type stage: `tsc` over the workspace project, `svelte-check` when it has components, then doctor. Bounded. */
export function types(root: string): CheckDiagnostic[] {
	writeTypeSetup(root);   // `types` also runs without `check` (tests)
	if (!existsSync(join(root, 'tsconfig.json'))) return [];
	const out: CheckDiagnostic[] = [];
	const run = (tool: string, file: string | undefined, args: string[], parse: (line: string) => CheckDiagnostic | null) => {
		if (file === undefined) return out.push({ code: `types/${tool}`, path: 'tsconfig.json', message: `${tool} is not installed` });
		const r = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', timeout: TYPES_MS, maxBuffer: 64 * 1024 * 1024 });
		if (r.error !== undefined) return out.push({ code: `types/${tool}`, path: 'tsconfig.json', message: `${tool}: ${r.error.message}` });
		// an indented line continues the diagnostic above it (tsc's elaboration, ending in its "Did you mean" line)
		const found = `${r.stdout}\n${r.stderr}`.split(/\n(?![ \t])/).map(parse).filter((d) => d !== null);
		out.push(...found);
		if (r.status !== 0 && found.length === 0) out.push({ code: `types/${tool}`, path: 'tsconfig.json', message: `${tool} exited ${r.status}: ${`${r.stdout}${r.stderr}`.trim().slice(0, 2000)}` });
	};
	run('tsc', bin('typescript', 'tsc', root), ['-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], (line) => {
		const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): ([\s\S]*?)\s*$/.exec(line);
		return m === null ? null : { code: `types/${m[4]}`, path: m[1]!, line: Number(m[2]), message: `${m[1]}:${m[2]}:${m[3]}: ${m[5]}` };
	});
	const svelte = readdirSync(join(root, 'src'), { recursive: true }).some((f) => String(f).endsWith('.svelte'));
	if (svelte) run('svelte-check', bin('svelte-check', 'svelte-check', root), ['--tsconfig', './tsconfig.json', '--output', 'machine', '--fail-on-warnings'], (line) => {
		const m = /^\d+ (ERROR|WARNING) "(.+?)" (\d+):(\d+) "(.*)"$/.exec(line);
		return m === null ? null : { code: 'types/svelte', path: m[2]!, line: Number(m[3]), message: `${m[2]}:${m[3]}:${m[4]}: ${m[5]}` };
	});
	out.push(...doctorFindings(root));
	return out;
}

/** `bolt build` (rule 7): `check` plus the artifact and the seed packs; author errors throw `AuthorErrors`. */
export async function buildWorkspace(dir: string, o: { bank?: string; types?: boolean; log?: Log } = {}): Promise<{ artifact: Artifact; packs: { [pack: string]: PackJson } }> {
	const root = realpathSync(dir);
	const c = await check(root);
	const errors = [...c.errors];
	if (o.types !== false) errors.push(...types(root));
	if (errors.length > 0 || c.manifest === undefined || c.guest === undefined) throw new AuthorErrors(errors);
	const { files } = discover(root);
	const out = join(root, '.norbital', 'artifact');
	const index = o.types === false ? undefined : typeIndex(root, c.manifest);
	for (const e of index?.errors ?? []) o.log?.(`warning: types.json: ${e}`);
	const a = await writeArtifact(root, { ...c, manifest: c.manifest, guest: c.guest }, files, out, index, (line) => o.log?.(`warning: ${line}`));
	const packErrors: CheckDiagnostic[] = [];
	const packs = await buildPacks(root, c.manifest, seedPack(root, []), join(root, '.norbital', 'seed'),
		{ ...(o.bank === undefined ? {} : { bank: resolve(o.bank) }), ...(templateMeta(root).bank === undefined ? {} : { tree: templateMeta(root).bank! }),
			cache: join(root, '.norbital', 'cache') }, packErrors);
	if (packErrors.length > 0) throw new AuthorErrors(packErrors);
	o.log?.(`built ${a.handle} ${a.hash.slice(0, 12)} (schema ${a.schema.slice(0, 12)}) → ${out}`);
	for (const [name, p] of Object.entries(packs)) o.log?.(`  seed pack ${name} ${p.hash.slice(0, 12)}: ${Object.entries(p.rows).map(([k, n]) => `${k}=${n}`).join(' ') || 'empty'}${p.start.length > 0 ? `; start ${p.start.join(', ')}` : ''}`);
	return { artifact: readArtifact(out), packs };
}

