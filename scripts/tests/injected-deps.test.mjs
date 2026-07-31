import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { auditTemplate, declaredPackages, restoreTemplate } from '../lib/injected-deps.mjs';

/** A throwaway template: a manifest, plus whichever `node_modules` entries the case needs. */
function template(dependencies, entries = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'norbital-injected-'));
	writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ dependencies }));
	for (const [name, shape] of Object.entries(entries)) {
		const entry = path.join(directory, 'node_modules', '@norbital-ai', name);
		if (shape === 'dangling') {
			mkdirSync(path.dirname(entry), { recursive: true });
			symlinkSync(path.join(directory, 'nowhere'), entry);
			continue;
		}
		mkdirSync(entry, { recursive: true });
		if (shape === 'built') mkdirSync(path.join(entry, 'build'));
	}
	return directory;
}

describe('injected template dependencies', () => {
	it('takes the expected set from the template manifest, not a list kept beside it', () => {
		const directory = template({});
		try {
			writeFileSync(
				path.join(directory, 'package.json'),
				JSON.stringify({
					dependencies: { '@norbital-ai/pod': '0.0.8', svelte: '^5.56.7' },
					devDependencies: { '@norbital-ai/std': '0.0.8', prettier: '^3.9.5' }
				})
			);
			// `config` is linked at the repository root only, so a template that does not depend on
			// it must not be reported as missing it.
			assert.deepEqual(declaredPackages(directory), ['pod', 'std']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('names the package a pruned template can no longer resolve', () => {
		// The failure this exists for: a stray `pnpm` run inside template_workspaces/<name> removes
		// the injected entries, and refreshing reports its usual success because it only ever
		// rewrites `build/` inside a copy that is now gone.
		const directory = template(
			{ '@norbital-ai/pod': '0.0.8', '@norbital-ai/ui': '0.0.8' },
			{ pod: 'built' }
		);
		try {
			assert.deepEqual(auditTemplate(directory), { missing: ['ui'], unbuilt: [] });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('counts a dangling link as missing rather than present', () => {
		const directory = template({ '@norbital-ai/pod': '0.0.8' }, { pod: 'dangling' });
		try {
			assert.deepEqual(auditTemplate(directory).missing, ['pod']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('separates a package that resolves but was never built, which needs a different fix', () => {
		const directory = template({ '@norbital-ai/pod': '0.0.8' }, { pod: 'unbuilt' });
		try {
			assert.deepEqual(auditTemplate(directory), { missing: [], unbuilt: ['pod'] });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('restores a pruned entry as a relative link into packages/', () => {
		// The recovery itself. `pnpm install` will not do this: with the lockfile unchanged it
		// answers "Already up to date" and leaves the template pruned.
		const directory = template({ '@norbital-ai/pod': '0.0.8' });
		const packagesRoot = path.join(directory, 'packages');
		try {
			mkdirSync(path.join(packagesRoot, 'pod', 'build'), { recursive: true });

			assert.deepEqual(restoreTemplate(directory, packagesRoot), {
				restored: ['pod'],
				unavailable: []
			});

			const entry = path.join(directory, 'node_modules', '@norbital-ai', 'pod');
			// Relative, so the link survives the tree being moved or copied — the depth is whatever
			// separates the entry from `packages/` (four levels for a real template_workspaces/<key>).
			assert.equal(readlinkSync(entry), path.join('..', '..', 'packages', 'pod'));
			assert.equal(realpathSync(entry), realpathSync(path.join(packagesRoot, 'pod')));
			// Restored means resolvable, so the audit that follows a restore must come back clean.
			assert.deepEqual(auditTemplate(directory), { missing: [], unbuilt: [] });
			// And a second run has nothing left to do.
			assert.deepEqual(restoreTemplate(directory, packagesRoot).restored, []);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('replaces a dangling link rather than failing on the name already existing', () => {
		const directory = template({ '@norbital-ai/pod': '0.0.8' }, { pod: 'dangling' });
		const packagesRoot = path.join(directory, 'packages');
		try {
			mkdirSync(path.join(packagesRoot, 'pod', 'build'), { recursive: true });
			assert.deepEqual(restoreTemplate(directory, packagesRoot).restored, ['pod']);
			assert.deepEqual(auditTemplate(directory), { missing: [], unbuilt: [] });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('reports a package it cannot restore instead of linking to nothing', () => {
		const directory = template({ '@norbital-ai/ghost': '0.0.8' });
		const packagesRoot = path.join(directory, 'packages');
		try {
			mkdirSync(packagesRoot, { recursive: true });
			assert.deepEqual(restoreTemplate(directory, packagesRoot), {
				restored: [],
				unavailable: ['ghost']
			});
			assert.deepEqual(auditTemplate(directory).missing, ['ghost']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('stays quiet when every declared package resolves with build output', () => {
		const directory = template(
			{ '@norbital-ai/pod': '0.0.8', '@norbital-ai/ui': '0.0.8' },
			{ pod: 'built', ui: 'built' }
		);
		try {
			assert.deepEqual(auditTemplate(directory), { missing: [], unbuilt: [] });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
