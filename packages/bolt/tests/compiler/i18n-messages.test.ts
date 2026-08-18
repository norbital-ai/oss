import { describe, expect, it } from 'vitest';
import { mergeBoltAgentMessages } from '../../src/client/ui/agent/i18n.js';
import { renderI18nMessages } from '../../src/compiler/sync.js';

describe('tenant i18n catalogs', () => {
	it('emits a known tenant key into generated JS', () => {
		const emitted = renderI18nMessages({
			en: { 'app.people.workforce': 'Workforce' },
			zh: {}
		});
		expect(emitted).toContain('export const tenantMessages');
		expect(emitted).toContain('app.people.workforce');
		expect(emitted).toContain('Workforce');
	});

	it('spreads tenant catalogs over ui and bolt without dropping English copy', () => {
		const merged = mergeBoltAgentMessages(
			{ en: { 'ui.ok': 'OK' }, zh: { 'ui.ok': '好' } },
			{ en: { 'app.people.workforce': 'Workforce' }, zh: {} }
		);
		expect(merged.en['app.people.workforce']).toBe('Workforce');
		expect(merged.en['ui.ok']).toBe('OK');
		expect(merged.en['bolt.shell.askAgent']).toBe('Ask agent');
		expect(merged.zh['ui.ok']).toBe('好');
		expect(merged.zh['app.people.workforce']).toBeUndefined();
	});
});
