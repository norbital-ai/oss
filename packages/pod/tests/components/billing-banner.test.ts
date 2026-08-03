import { describe, expect, it } from 'vitest';
import BillingBanner from '$lib/runtime/billing-banner.svelte';
import { render, settle } from '../support/component.js';

describe('billing banner', () => {
	it('keeps host billing inside the tenant shell route', async () => {
		const navigated: string[] = [];
		const { container, destroy } = render(BillingBanner, {
			billing: {
				status: 'trialing',
				currentPeriodEnd: '2026-09-01T00:00:00.000Z',
				hasPaymentMethod: false
			},
			isAdmin: true,
			billingHref: '/__host/core-organization?tab=billing',
			navigate: (href: string) => navigated.push(href)
		});
		await settle();

		const action = [...container.querySelectorAll('button')].find((button) =>
			button.textContent?.includes('Add payment method')
		);
		action?.click();
		expect(navigated).toEqual(['/__host/core-organization?tab=billing']);
		destroy();
	});

	it('does not offer a broken billing action when the host supplies no billing plugin', async () => {
		const { container, destroy } = render(BillingBanner, {
			billing: {
				status: 'trialing',
				currentPeriodEnd: '2026-09-01T00:00:00.000Z',
				hasPaymentMethod: false
			},
			isAdmin: true,
			billingHref: null,
			navigate: () => undefined
		});
		await settle();

		expect(container.textContent).toContain('Your free trial ends');
		expect(container.textContent).not.toContain('Add payment method');
		destroy();
	});
});
