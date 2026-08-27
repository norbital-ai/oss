import { describe, expect, it } from 'vitest';
import { mergeBoltAgentMessages } from '../../src/client/ui/agent/i18n.js';

describe('tenant i18n catalogs', () => {
	it('spreads tenant catalogs over ui and bolt without dropping English copy', () => {
		const merged = mergeBoltAgentMessages(
			{ en: { 'ui.ok': 'OK' }, zh: { 'ui.ok': '好' } },
			{ en: { 'app.people.workforce': 'Workforce' }, zh: {} }
		);
		expect(merged.en['app.people.workforce']).toBe('Workforce');
		expect(merged.en['ui.ok']).toBe('OK');
		expect(merged.en['bolt.shell.askAgent']).toBe('Ask agent');
		expect(merged.en['bolt.shell.approvals']).toBe('Approvals');
		expect(merged.zh['ui.ok']).toBe('好');
		expect(merged.zh['bolt.shell.approvals']).toBe('审批');
		expect(merged.zh['app.people.workforce']).toBeUndefined();
	});
});
