import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
			const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	}
});

const { NorbitalManifestSchema } = await import('../src/manifest/types.ts');

const baseManifest = {
	version: 1,
	collections: {},
	relationships: {},
	automations: {}
} as const;

test('manifest env retains typed non-secret runtime values', () => {
	const parsed = NorbitalManifestSchema.parse({
		...baseManifest,
		env: { public: { REGION: 'ap-southeast-1' } }
	});

	assert.deepEqual(parsed.env, { public: { REGION: 'ap-southeast-1' } });
});

test('manifest env rejects the residual secret shape in favor of manifest.secrets', () => {
	const result = NorbitalManifestSchema.safeParse({
		...baseManifest,
		env: { secret: { API_KEY: '********' } }
	});

	assert.equal(result.success, false);
	assert.match(result.error?.message ?? '', /Unrecognized key.*secret/s);
});
