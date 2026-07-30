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

	it('trusts only the exact first-party v0.0.1 package release before the age gate', () => {
		const expected = [
			'@norbital-ai/config@0.0.1',
			'@norbital-ai/platform-utils@0.0.1',
			'@norbital-ai/pod@0.0.1',
			'@norbital-ai/std@0.0.1',
			'@norbital-ai/ui@0.0.1'
		];
		for (const template of discoverTemplates()) {
			const policy = readFileSync(path.join(template.directory, 'pnpm-workspace.yaml'), 'utf8');
			for (const release of expected) assert.match(policy, new RegExp(`'${release}'`));
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
