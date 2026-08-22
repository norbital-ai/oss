import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditImports } from '../../src/quality/audit.js';

const sourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory()
				? sourceFiles(join(root, entry.name))
				: Promise.resolve(
						entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')
							? [join(root, entry.name)]
							: []
					)
		)
	);
	return nested.flat();
};

describe('Bolt architecture boundaries', () => {
	it('does not import Core, Pod, Colony, bolt-server, or provider SDKs', async () => {
		const files = await sourceFiles(new URL('../../src', import.meta.url).pathname);
		const inspected = files.filter((file) => !file.endsWith('/quality/audit.ts'));
		const entries = await Promise.all(
			inspected.map(async (file) => [file, await readFile(file, 'utf8')] as const)
		);
		expect(auditImports(Object.fromEntries(entries))).toEqual([]);
	});

	/**
	 * The bot check belongs to the host, and no trace of it may exist in here.
	 *
	 * Not "bolt implements no check" — the stronger claim, that a tenant runtime does not carry the
	 * vocabulary either. Bolt's sign-in takes a snippet to render above its button and a boolean
	 * saying the host is not ready; it is told the answer and never the question. A prop, a comment
	 * or a copy key naming somebody's challenge vendor would make this component look like the place
	 * a bot check belongs, which is how one eventually gets written here — needing the host's secret
	 * in a guest environment that has no business holding one.
	 *
	 * Whoever gates a code request, and how, is answered in Colony, in front of the forward.
	 */
	it('carries no trace of a bot check, in any form', async () => {
		const traces = [
			// The vendors. Named outright rather than by mechanism, so a comment cannot reintroduce the
			// expectation that this is where such a thing lives.
			/turnstile/i,
			/captcha/i,
			/challenges\.cloudflare\.com/i,
			// The mechanism, for a vendor nobody has thought of yet: a server-side verification call,
			// the field a solved token is posted in, and the option that mounts a widget.
			/siteverify/i,
			/sitekey/i
		];
		const files = await sourceFiles(new URL('../../src', import.meta.url).pathname);
		const offenders = (
			await Promise.all(
				files.map(async (file) => {
					const source = await readFile(file, 'utf8');
					const matched = traces.filter((pattern) => pattern.test(source));
					return matched.length === 0 ? [] : [`${file}: ${matched.map(String).join(', ')}`];
				})
			)
		).flat();
		expect(offenders).toEqual([]);
	});
});

/**
 * Every `exports` subpath must name a file the build will actually emit.
 *
 * `./client/identity` was added to the client surface and consumed by Colony through a Vite alias
 * into this repository's `src`. The alias made it resolve, so nothing failed here — while the
 * package published no such subpath and `svelte-package` emitted no such file. Any consumer
 * without that alias, which is every real install, could not import it.
 *
 * Checked against `src` rather than `build` so the guard holds on a clean checkout: it asserts the
 * export is emittable, which is the half that a stale build cannot fake.
 */
describe('published surface', () => {
	/**
	 * The source files a build target could legitimately have come from.
	 *
	 * More than one, because `.svelte` is two things in the same namespace. `Thing.svelte` is a
	 * component and `svelte-package` copies it across as-is, emitting `Thing.svelte.d.ts` beside it.
	 * `thing.svelte.ts` is a *rune module* — ordinary TypeScript that may hold `$state` — which is
	 * transpiled to `thing.svelte.js` and declared as `thing.svelte.d.ts`. The two produce the
	 * identical declaration name from different sources, so a single mapping has to guess, and
	 * guessing "component" reported `./client/workspace` as unemittable while its real source,
	 * `src/client/ui/shell/mount.svelte.ts`, sat next to seven other rune modules that would each
	 * have tripped the same false positive on export.
	 *
	 * Answering with the set rather than one string keeps the assertion exactly as strong: a subpath
	 * still has to name a file that exists in `src`, and no target has more than one candidate
	 * actually present.
	 */
	const sourcesOf = (target: string): ReadonlyArray<string> => {
		const relative = target.replace(/^\.\/build\//, '');
		if (relative.endsWith('.svelte')) return [relative];
		if (relative.endsWith('.svelte.d.ts')) {
			const withoutDeclaration = relative.slice(0, -'.d.ts'.length);
			return [withoutDeclaration, `${withoutDeclaration}.ts`];
		}
		if (relative.endsWith('.d.ts')) return [`${relative.slice(0, -'.d.ts'.length)}.ts`];
		return [`${relative.replace(/\.js$/, '')}.ts`];
	};

	it('emits a source file for every exported subpath', async () => {
		const manifest: unknown = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8')
		);
		const exportsMap = (manifest as { exports: Record<string, Record<string, string>> }).exports;
		const subpaths = Object.entries(exportsMap);
		// A manifest read from the wrong place yields no entries and would pass every assertion below.
		expect(subpaths.length).toBeGreaterThanOrEqual(10);

		const missing: Array<string> = [];
		for (const [subpath, conditions] of subpaths) {
			for (const target of new Set(Object.values(conditions))) {
				if (!target.startsWith('./build/')) continue;
				const candidates = await Promise.all(
					sourcesOf(target).map((candidate) =>
						readFile(new URL(`../../src/${candidate}`, import.meta.url))
							.then(() => true)
							.catch(() => false)
					)
				);
				if (!candidates.includes(true)) missing.push(`${subpath} -> ${target}`);
			}
		}
		expect(missing).toEqual([]);
	});
});

/**
 * These names belonged to two disconnected authoring/client APIs. The environment declaration and
 * browser replica storage seam remain live, so assert those anchors before asserting that their
 * obsolete siblings cannot leak back into a public barrel or implementation unnoticed.
 */
describe('retired public surfaces', () => {
	it('keeps the duplicate environment helper and Replica service out of the package', async () => {
		const [authoring, root, client, localSql] = await Promise.all([
			readFile(new URL('../../src/authoring/index.ts', import.meta.url), 'utf8'),
			readFile(new URL('../../src/index.ts', import.meta.url), 'utf8'),
			readFile(new URL('../../src/client.ts', import.meta.url), 'utf8'),
			readFile(new URL('../../src/client/replica/pglite-sql.ts', import.meta.url), 'utf8')
		]);
		expect(authoring).toContain('defineEnvironment');
		expect(localSql).toContain('export type LocalSql');
		expect([authoring, root, client].join('\n')).not.toMatch(/defineEnvVars|\bReplica\b/);
		expect(localSql).not.toMatch(
			/settleOptimistic|ReplicaError|Context\.Service|export \* as Replica/
		);
	});
});
