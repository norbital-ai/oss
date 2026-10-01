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
	it("lists one automation's runs up to the limit", async () => {
		const urls: string[] = [];
		const api = shellApi(async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ value: [] }));
		});
		await api.runs({ automation: 'payroll_export', limit: 5 });
		expect(urls).toEqual(['/__bolt/shell/runs?automation=payroll_export&limit=5']);
	});
});

describe('channel accounts', () => {
	it('lists and registers accounts through the shared authenticated transport API', async () => {
		const calls: {
			url: string;
			method: string | undefined;
			credentials: RequestCredentials | undefined;
			body: string | undefined;
		}[] = [];
		const api = shellApi(async (input, init) => {
			calls.push({
				url: String(input),
				method: init?.method,
				credentials: init?.credentials,
				body: init?.body as string | undefined
			});
			return new Response(JSON.stringify({ value: [] }));
		});
		expect(await api.transport.accounts('sales_mail')).toEqual({ ok: true, value: [] });
		expect(await api.transport.addAccount('sales_mail', 'phone-1')).toEqual({
			ok: true,
			value: []
		});
		expect(calls).toEqual([
			{
				url: '/__bolt/transports/sales_mail/accounts',
				method: 'GET',
				credentials: 'same-origin',
				body: undefined
			},
			{
				url: '/__bolt/transports/sales_mail/accounts',
				method: 'POST',
				credentials: 'same-origin',
				body: '{"id":"phone-1"}'
			}
		]);
	});
});
