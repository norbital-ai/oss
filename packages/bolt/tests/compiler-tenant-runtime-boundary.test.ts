import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'vite';
import {
	lowerLiteralDynamicImports,
	tenantRuntimeBoundary
} from '../src/compiler/workspace-build.js';

const virtualTenant = (source: string): Plugin => ({
	name: 'virtual-tenant-fixture',
	resolveId(id) {
		return id === 'virtual:tenant-artifact' ? `\0${id}` : null;
	},
	load(id) {
		return id === '\0virtual:tenant-artifact' ? source : null;
	}
});

describe('tenant runtime compilation boundary', () => {
	it('lowers only literal dynamic imports across nested and attributed syntax', async () => {
		const source = [
			"const nested = () => import('./nested.js').then(() => import('./nested.js'));",
			"const attributed = import('./data.json', { with: { type: 'json' } });",
			"const computed = import('./' + name + '.js');",
			"const metadata = import.meta.url;",
			"const prose = 'import(\\\"./false-positive.js\\\")';",
			"// import('./commented.js')"
		].join('\n');
		const lowered = await lowerLiteralDynamicImports(source);
		expect(lowered).not.toBeNull();
		expect(lowered).toContain("import * as __bolt_static_import_0 from \"./nested.js\";");
		expect(lowered).toContain("import * as __bolt_static_import_1 from \"./data.json\";");
		expect(lowered?.match(/Promise\.resolve\(__bolt_static_import_0\)/g)).toHaveLength(2);
		expect(lowered).toContain('Promise.resolve(__bolt_static_import_1)');
		expect(lowered).not.toContain("with: { type: 'json' }");
		expect(lowered).toContain("import('./' + name + '.js')");
		expect(lowered).toContain('import.meta.url');
		expect(lowered).toContain('false-positive.js');
		expect(lowered).toContain("// import('./commented.js')");
	});

	it('rejects executable node:crypto before Vite can emit a createHash external', async () => {
		const compilation = build({
			configFile: false,
			logLevel: 'silent',
			plugins: [
				virtualTenant("import { createHash } from 'node:crypto'; export default createHash"),
				tenantRuntimeBoundary()
			],
			build: {
				write: false,
				rollupOptions: { input: 'virtual:tenant-artifact' }
			}
		});

		await expect(compilation).rejects.toThrow(/imports Node builtin "node:crypto"/);
		await expect(compilation).rejects.toThrow(/portable isolate/);
	});

	it('still bundles portable WebCrypto tenant code', async () => {
		const output = await build({
			configFile: false,
			logLevel: 'silent',
			plugins: [
				virtualTenant("crypto.subtle.digest('SHA-256', new Uint8Array()); export default true"),
				tenantRuntimeBoundary()
			],
			build: {
				write: false,
				rollupOptions: { input: 'virtual:tenant-artifact' }
			}
		});
		const results = Array.isArray(output) ? output : [output];
		const chunks = results
			.flatMap((result) => ('output' in result ? result.output : []))
			.filter((item) => item.type === 'chunk');
		const code = chunks.map((chunk) => chunk.code).join('\n');

		expect(code).toContain('crypto.subtle.digest');
		expect(code).not.toContain('node:crypto');
		expect(code).not.toContain('__vite-browser-external');
	});

	it('keeps portable hashing on a leaf export without loading the server-only CEL runtime', async () => {
		const output = await build({
			configFile: false,
			logLevel: 'silent',
			plugins: [
				virtualTenant(
					"import { sha256Text } from '@norbital-ai/std/reckon/hash'; export default sha256Text('tenant')"
				),
				tenantRuntimeBoundary()
			],
			build: {
				write: false,
				rollupOptions: { input: 'virtual:tenant-artifact' }
			}
		});
		const results = Array.isArray(output) ? output : [output];
		const code = results
			.flatMap((result) => ('output' in result ? result.output : []))
			.filter((item) => item.type === 'chunk')
			.map((chunk) => chunk.code)
			.join('\n');

		expect(code).toContain('TextEncoder');
		expect(code).not.toContain('@marcbachmann/cel-js');
		expect(code).not.toContain('createEnvironment');
	});
});
