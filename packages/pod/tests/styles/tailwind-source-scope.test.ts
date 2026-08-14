import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `app.css` is the only thing that tells Tailwind which of Pod's own files to read.
 *
 * A tenant's stylesheet is generated from the class strings Tailwind finds by scanning the globs in
 * the packaged `app.css`. Pod's shell, agent sheet and settings surfaces are ordinary Svelte
 * components inside this package, so a glob that matches none of them does not fail: Tailwind
 * simply emits no rule for any utility those components alone use. Everything they share with
 * `@norbital-ai/ui` — which the second glob does scan — keeps working, so the workspace still looks
 * broadly right and only the class that nothing else happens to use goes missing.
 *
 * That is how the "Ask agent" button disappeared. `pod-shell.svelte` moved from `src/lib/runtime/`
 * to `src/ui/shell/` while `app.css` kept scanning `./{client,runtime}/**`, which by then matched
 * zero files. The button still rendered, still had `position: fixed`, and still had `right-4` and
 * `z-40` because other components use those — but `bottom-[calc(env(safe-area-inset-bottom)+1rem)]`
 * and `sm:bottom-6` existed nowhere else, so no rule set `bottom`, the fixed element fell back to
 * its static position after a `h-dvh` shell, and it sat 44px below the viewport on every workspace.
 *
 * This asserts against `src/` because `svelte-package` copies it to `build/` unchanged, which is
 * what a tenant install resolves. It is deliberately not a component test: the `components` project
 * mounts in happy-dom, which has no layout and no stylesheet resolution, so it renders this button
 * identically whether or not a single one of its utilities was ever generated.
 */
const SOURCE_ROOT = fileURLToPath(new URL('../../src', import.meta.url));
const APP_CSS = fileURLToPath(new URL('../../src/app.css', import.meta.url));

/** The `./…`-relative globs `app.css` points at its own packaged tree. */
function selfScopedSourceGlobs(): string[] {
	const declarations = readFileSync(APP_CSS, 'utf8').matchAll(/@source\s+'([^']+)'/g);
	return [...declarations].map((match) => match[1]).filter((glob) => glob.startsWith('./'));
}

describe('packaged app.css Tailwind scan scope', () => {
	it('points every self-scoped @source glob at files that exist', () => {
		const globs = selfScopedSourceGlobs();
		expect(globs.length).toBeGreaterThan(0);
		for (const glob of globs) {
			expect(globSync(glob, { cwd: SOURCE_ROOT }), `@source '${glob}' matches no file`).not.toEqual(
				[]
			);
		}
	});

	it("scans the shell that declares the workspace agent's launcher", () => {
		const scanned = new Set(
			selfScopedSourceGlobs().flatMap((glob) =>
				globSync(glob, { cwd: SOURCE_ROOT }).map((file) => file.replaceAll('\\', '/'))
			)
		);
		expect(scanned).toContain('ui/shell/pod-shell.svelte');
	});
});
