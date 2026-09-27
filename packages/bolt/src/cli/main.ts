#!/usr/bin/env node
/// <reference types="node" />
// The bolt CLI (§3.7, §5.1): `bolt dev | check | build | test | start`. Exit 0 ok, 1 author error, 2 tool failure.
//   bolt check [dir]                         rule 7: every error of every stage, then tsc and svelte-check
//   bolt build [dir] [--bank=<bank checkout>] check + `.norbital/artifact/` + seed packs in `.norbital/seed/`
//   bolt dev   [dir] [--port=<n>] [--seed=base|sample|none|<pack dir>] [--bank=…] [--founder=<email>] [--db=<dir>]
//   bolt test  [dir] [-- vitest args]
//   bolt start [flags]                       bolt-server's `bolt start` (§5.11.6)
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Plugin, UserConfig } from 'vite';
import { check, type CheckDiagnostic } from '../compiler/check/index.ts';
import { writeTypeSetup } from '../compiler/names.ts';
import { AuthorErrors, buildWorkspace, types, type Log } from './build.ts';

export { AuthorErrors, buildWorkspace, types, type Log } from './build.ts';

/** `bolt start` is bolt-server's (§5.11.6): the same argv and environment, run by `@norbital-ai/bolt-server`'s `main`. */
async function start(argv: readonly string[]): Promise<number> {
	let mod: { main?: (argv: readonly string[]) => Promise<number> };
	try {
		const from = [join(process.cwd(), 'package.json'), fileURLToPath(import.meta.url)];
		const path = from.map((b) => { try { return createRequire(b).resolve('@norbital-ai/bolt-server'); } catch { return undefined; } }).find((p) => p !== undefined);
		if (path === undefined) throw new Error('@norbital-ai/bolt-server is not installed');
		mod = await import(pathToFileURL(path).href) as typeof mod;
	} catch (e) {
		console.error(`bolt start: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
	if (typeof mod.main !== 'function') {
		console.error('bolt start: @norbital-ai/bolt-server exports no main(argv)');
		return 2;
	}
	return mod.main(argv);
}

/** This copy of the kit (src or build), so `/test`, `/test/browser` and pages' `$bolt` share one shell and one client. */
const own = (path: string) => join(dirname(fileURLToPath(import.meta.url)), '..', `${path}${extname(fileURLToPath(import.meta.url))}`);

/**
 * `bolt test`: the workspace's vitest, in process, with the kit preconfigured: the type setup written, svelte compiled,
 * `@norbital-ai/bolt/test(/browser)` and `$bolt` on this copy, DOM environments resolving the browser builds, and the
 * kit's timeouts. The workspace's own vitest config still loads, and wins where it sets a value.
 */
async function test(dir: string, args: readonly string[]): Promise<number> {
	const root = realpathSync(dir);
	let vitest: typeof import('vitest/node');
	try {
		vitest = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('vitest/node')).href) as typeof vitest;
	} catch {
		console.error('bolt test: vitest is not installed');
		return 2;
	}
	writeTypeSetup(root);   // the workspace tsconfig extends it
	process.chdir(root);   // tests name their workspace `process.cwd()`
	const { svelte } = await import('@sveltejs/vite-plugin-svelte');
	const { filter, options } = vitest.parseCLI(['vitest', 'run', ...args]);
	// svelte compiles once: the kit's plugin stands down when the workspace config brings its own
	const mine: Plugin[] = svelte().map((p) => ({ ...p, apply: (c, env) => !theirs(c) && (p.apply === undefined || (typeof p.apply === 'function' ? p.apply(c, env) : p.apply === env.command)) }));
	const theirs = (c: UserConfig) => [c.plugins].flat(Infinity as 1).some((p) => typeof p === 'object' && p !== null && !(p instanceof Promise)
		&& 'name' in p && p.name === 'vite-plugin-svelte' && !mine.includes(p));
	const kit: Plugin = {
		name: 'bolt:test',
		config(c) {
			const t = (c as { test?: { testTimeout?: number; hookTimeout?: number; fileParallelism?: boolean; setupFiles?: string | string[]; projects?: unknown[] } }).test ??= {};
			t.testTimeout ??= 180_000;
			t.hookTimeout ??= 60_000;
			t.fileParallelism ??= false;
			t.setupFiles = [...new Set([own('test/dom'), ...[t.setupFiles ?? []].flat()])];
			// the kit, and a linked bolt or ui, live outside the workspace; nothing is served to a network
			((c.server ??= {}).fs ??= {}).strict ??= false;
			// the shell's Svelte dependencies ship `.svelte` sources node cannot load: compile them like the workspace's
			const deps = ((t as { server?: { deps?: { inline?: unknown } } }).server ??= {}).deps ??= {};
			if (deps.inline !== true) deps.inline = [...[deps.inline ?? []].flat() as (string | RegExp)[], '@xyflow/svelte'];
			// a project inherits nothing from the root config: each inline or file project gets the kit itself
			if (t.projects !== undefined) t.projects = t.projects.map((p) => typeof p === 'string' && !/[*?{[]/.test(p) && /\.[cm]?[jt]s$/.test(p) ? { extends: p, plugins: [...mine, kit] }
				: typeof p === 'object' && p !== null ? { ...p, plugins: [...(p as { plugins?: unknown[] }).plugins ?? [], ...mine, kit] } : p);
			return { resolve: { alias: [
				{ find: /^@norbital-ai\/bolt\/test\/browser$/, replacement: own('test/browser') },
				{ find: /^@norbital-ai\/bolt\/test$/, replacement: own('test/index') },
				{ find: /^\$bolt$/, replacement: own('client/index') },
			], conditions: ['svelte', 'browser'] } };   // the client environment's: DOM tests get svelte's browser build
		},
	};
	await vitest.startVitest('test', filter, { ...options, root }, { plugins: [...mine, kit] });
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	return code === 0 ? 0 : code === 1 ? 1 : 2;
}

const print = (errors: readonly CheckDiagnostic[]) => {
	for (const e of errors) console.error(`${e.code} ${e.message}${e.help === undefined ? '' : `\n${e.help}`}`);
	console.error(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
};

export async function main(argv: readonly string[]): Promise<number> {
	const [verb, ...rest] = argv;
	const log: Log = (line) => console.log(line);
	try {
		if (verb === 'start') return await start(rest);
		if (verb === 'test') {
			const split = rest.indexOf('--');
			return await test(resolve(split === 0 ? '.' : rest[0] ?? '.'), split < 0 ? [] : rest.slice(split + 1));
		}
		const { values, positionals } = parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: {
			bank: { type: 'string' }, json: { type: 'boolean' }, port: { type: 'string' }, seed: { type: 'string' }, founder: { type: 'string' }, db: { type: 'string' },
		} });
		const root = resolve(positionals[0] ?? '.');
		if (verb === 'check') {
			const c = await check(root);
			const errors = [...c.errors, ...(c.manifest === undefined ? [] : types(realpathSync(root)))];
			if (errors.length > 0) { print(errors); return 1; }
			log(`ok (${c.stages.join(' → ')} → types)`);
			return 0;
		}
		if (verb === 'build') {
			try {
				await buildWorkspace(root, { ...(values.bank === undefined ? {} : { bank: values.bank }), log });
			} catch (e) {
				if (!(e instanceof AuthorErrors) || values.json !== true) throw e;
				// `--json`: the diagnostics as the last stderr line, for a host that shows them (a workbench's validate tool)
				print(e.errors);
				console.error(JSON.stringify({ errors: e.errors }));
				return 1;
			}
			return 0;
		}
		if (verb === 'dev') {
			const { dev } = await import('./dev.ts');
			await dev(root, { ...(values.port === undefined ? {} : { port: Number(values.port) }), ...(values.seed === undefined ? {} : { seed: values.seed }),
				...(values.bank === undefined ? {} : { bank: values.bank }), ...(values.founder === undefined ? {} : { founder: values.founder }),
				...(values.db === undefined ? {} : { db: values.db }), log });
			return await new Promise<number>(() => {}); // serves until the process is stopped
		}
		console.error('usage: bolt <dev | check | build | test | start> [dir] [flags]');
		return 2;
	} catch (e) {
		if (e instanceof AuthorErrors) { print(e.errors); return 1; }
		console.error(e instanceof Error ? e.stack ?? e.message : String(e));
		return 2;
	}
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exit(await main(process.argv.slice(2)));
