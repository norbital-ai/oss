// Packaging gaps found migrating the 0.0.1 templates (§3.5): `$bolt` is read on use, never at import, and a page's
// `bolt.runs` asks `/runs` for its one automation.
import { describe, expect, it } from 'vitest';
import { setCurrentBolt, shellApi, type ShellBolt } from '../src/shell/runtime.ts';

describe('$bolt', () => {
	it('imports before the shell boots and reads the booted client on use', async () => {
		const { bolt } = await import('../src/client/index.ts');
		expect(() => bolt.locale).toThrow('before the workspace shell booted');
		setCurrentBolt({ locale: 'ms', t: (k: string) => `ms:${k}` } as unknown as ShellBolt);
		expect(bolt.locale).toBe('ms');
		expect((bolt as { t(key: string): string }).t('x')).toBe('ms:x'); // the fixture-free program declares no messages
	});
});

describe('bolt.runs', () => {
	it('lists one automation\'s runs up to the limit', async () => {
		const urls: string[] = [];
		const api = shellApi(async (input) => { urls.push(String(input)); return new Response(JSON.stringify({ value: [] })); });
		await api.runs({ automation: 'payroll_export', limit: 5 });
		expect(urls).toEqual(['/__bolt/shell/runs?automation=payroll_export&limit=5']);
	});
});
