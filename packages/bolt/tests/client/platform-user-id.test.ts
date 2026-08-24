import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/**
 * That the id a workspace keys its own rows by is an id.
 *
 * `PlatformUser.id` was published as `user?.name`, and `name` is
 * `email.split('@')[0]`. So every authored query of the shape
 * `where: { user_id: { eq: user.id } }` sent `'dion.neo'` to a `uuid` column, Postgres
 * refused it as 22P02, and the surface rendered "Could not load your contractor profile."
 *
 * It read as a permissions problem and was reported as one. It was not: the same failure happened
 * for a contractor, for an administrator, and for anyone else, because the value was never an id at
 * all. The app had never worked for a single viewer.
 *
 * Asserted against the source rather than through a rendered shell because the defect is a single
 * assignment, and a component test that mounted the shell would have to supply the very prop whose
 * absence was the bug. This is deliberately narrow: it pins the one line, quoted, so a change to it
 * has to be made here too.
 */
describe('the id the platform context publishes', () => {
	it('is the viewer’s record key, never their display name', () => {
		const shell = read('../../src/client/ui/shell/shell.svelte');
		expect(shell).toMatch(/id: user\?\.id \?\? 'unknown'/);
		expect(shell).not.toMatch(/id: user\?\.name/);
	});

	it('is carried from the workspace view, which is where the real id lives', () => {
		const workspace = read('../../src/client/ui/shell/workspace.svelte');
		expect(workspace).toMatch(/user=\{\{\s*\n\s*id: view\.user\.id,/);
	});

	/**
	 * The forwarding prop has to declare it or the value is dropped in transit rather than refused —
	 * `app.svelte` sits between the view and the shell, and a prop it does not name does not arrive.
	 */
	it('is declared on both props it passes through', () => {
		for (const path of [
			'../../src/client/ui/shell/shell.svelte',
			'../../src/client/ui/shell/app.svelte'
		]) {
			const source = read(path);
			// Bounded by the two fields that open and close the shape rather than by braces: the doc
			// comment above `id` quotes `where: { user_id: { eq: … } }`, and a brace-matching regex
			// stops inside the prose. Which this test did, on its first run.
			const start = source.indexOf('user?:');
			const end = source.indexOf('teamLabels: string[];', start);
			expect(start, path).toBeGreaterThan(-1);
			expect(end, path).toBeGreaterThan(start);
			expect(source.slice(start, end), path).toMatch(/\bid: string;/);
		}
	});

	it('publishes no label under a key-shaped name', () => {
		const platform = readFileSync(
			new URL('../../src/client/ui/state/platform.ts', import.meta.url),
			'utf8'
		);
		const shell = readFileSync(
			new URL('../../src/client/ui/shell/shell.svelte', import.meta.url),
			'utf8'
		);
		// `team` published the sidebar's role label — the literal string `'Admin'` or `'Member'` —
		// under a name authored code would key a row by. It fails as an empty result, not an error,
		// which is why the type alone is not enough to keep it gone.
		expect(platform).not.toMatch(/readonly team\?: string;/);
		expect(shell).not.toMatch(/team: user\?\.role/);
		// Dead alongside it: nothing anywhere read either.
		expect(platform).not.toMatch(/readonly name\?: string;/);
		expect(platform).not.toMatch(/readonly organization: string;/);
	});
});

describe('workspace application loading', () => {
	it('keeps the stale-import counter outside reactive state', () => {
		const workspace = read('../../src/client/ui/shell/workspace.svelte');
		// A plain object rather than `$state`: the navigation effect increments it, and a reactive
		// counter would make that effect subscribe to the value it writes.
		expect(workspace).toMatch(/const appRequest = \{ latest: 0 \};/);
		expect(workspace).toMatch(/const request = \+\+appRequest\.latest;/);
		expect(workspace).not.toMatch(/\$state[^\n]*appRequest/);
		expect(workspace).not.toMatch(/appMount\.request/);
	});

	it('replaces an application route when a policy preview hides that app', () => {
		const workspace = read('../../src/client/ui/shell/workspace.svelte');
		expect(workspace).toMatch(/visible\.apps\.includes\(current\)/);
		expect(workspace).toMatch(/actions\.navigate\('\/'\, \{ replace: true \}\)/);
	});
});
