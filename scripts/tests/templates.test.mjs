import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	actualCounts,
	discoverTemplates,
	templateMetadataFile,
	templateRefNamespace
} from '../lib/templates.mjs';

describe('template discovery', () => {
	it('discovers every template from its own tree, with no separate catalogue', () => {
		const templates = discoverTemplates();
		assert.ok(templates.length > 0);
		for (const template of templates) {
			assert.ok(
				existsSync(path.join(template.directory, templateMetadataFile)),
				`${template.key} must carry ${templateMetadataFile} in its own tree so the metadata projects with it`
			);
			assert.equal(template.ref, `${templateRefNamespace}/${template.key}`);
		}
	});

	it('keeps declared picker counts equal to what the tree actually contains', () => {
		for (const template of discoverTemplates()) {
			assert.deepEqual(template.counts, actualCounts(template.directory), template.key);
		}
	});

	it('pins its own pod version, exactly', () => {
		// A template's pod version lives in its own manifest and its own lockfile. Nothing
		// outside the tree declares which pod versions it works with, and nothing propagates
		// a bump into it.
		for (const template of discoverTemplates()) {
			const manifest = JSON.parse(
				readFileSync(path.join(template.directory, 'package.json'), 'utf8')
			);
			assert.match(manifest.dependencies['@norbital-ai/pod'], /^\d+\.\d+\.\d+/);
		}
	});

	it('commits a lockfile per template, so nothing outside the tree pins its dependencies', () => {
		for (const template of discoverTemplates()) {
			assert.ok(
				existsSync(path.join(template.directory, 'pnpm-lock.yaml')),
				`${template.key} must commit pnpm-lock.yaml`
			);
		}
	});

	/**
	 * Every first-party version a template actually depends on must be named in its release-age
	 * exemption, and named exactly.
	 *
	 * Derived from the template's own dependencies rather than a hardcoded version list. A literal
	 * list turns this into a version pin that fails on every release and says nothing about the
	 * property being protected — which is that publishing a package means admitting it here
	 * deliberately, one line per reviewed release.
	 *
	 * The wildcard check is the other half. A scope-wide exemption would defeat the gate in exactly
	 * the case it exists for: a stolen publish credential, whose release would then install the
	 * moment it appeared.
	 */
	it('exempts each first-party version a template depends on, and only by exact version', () => {
		for (const template of discoverTemplates()) {
			const manifest = JSON.parse(
				readFileSync(path.join(template.directory, 'package.json'), 'utf8')
			);
			const dependencies = {
				...(manifest.dependencies ?? {}),
				...(manifest.devDependencies ?? {})
			};
			const firstParty = Object.entries(dependencies).filter(([name]) =>
				name.startsWith('@norbital-ai/')
			);
			assert.ok(firstParty.length > 0, `${template.key} declares no first-party dependencies`);

			const policy = readFileSync(path.join(template.directory, 'pnpm-workspace.yaml'), 'utf8');
			for (const [name, version] of firstParty) {
				assert.match(
					policy,
					new RegExp(`'${name}@${String(version).replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')}'`),
					`${template.key} depends on ${name}@${version} but does not exempt it`
				);
			}
			assert.doesNotMatch(policy, /@norbital-ai\/\*/);
		}
	});

	it('materializes host and Linux/musl guest native dependencies on every developer OS', () => {
		for (const template of discoverTemplates()) {
			const policy = readFileSync(path.join(template.directory, 'pnpm-workspace.yaml'), 'utf8');
			assert.match(policy, /supportedArchitectures:/);
			for (const architecture of ['current', 'linux', 'x64', 'arm64', 'glibc', 'musl']) {
				assert.match(policy, new RegExp(`- ${architecture}`), `${template.key}: ${architecture}`);
			}
		}
	});

	it('rejects a filter that matches no template', () => {
		assert.throws(() => discoverTemplates('no-such-template'), /No template matched/);
	});
});
