import { expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import Sounds from './support/sounds.svelte';
import './support/filter-editor.css';

it('enables native browser audio from Test sound and keeps the settings usable on desktop and mobile', async () => {
	const oscillator = vi.spyOn(AudioContext.prototype, 'createOscillator');
	try {
		for (const width of [1200, 390]) {
			await page.viewport(width, 900);
			const target = document.createElement('div');
			document.body.append(target);
			const app = mount(Sounds, { target });
			try {
				await expect.element(page.getByRole('switch', { name: 'Play sounds' })).toBeVisible();
				const before = oscillator.mock.calls.length;
				await page.getByRole('button', { name: 'Test sound' }).click();
				await expect
					.element(page.getByRole('status'))
					.toHaveTextContent(
						'Browser audio is ready. If you hear nothing, check the tab’s mute setting and your device volume.'
					);
				expect(oscillator.mock.calls.length).toBe(before + 2);
				await page.getByRole('button', { name: 'Test sound' }).click();
				await expect.poll(() => oscillator.mock.calls.length).toBe(before + 4);
				await page.getByRole('switch', { name: 'Play sounds' }).click();
				await expect
					.element(page.getByRole('switch', { name: 'Play sounds' }))
					.toHaveAttribute('aria-checked', 'false');
				await expect.element(page.getByRole('button', { name: 'Test sound' })).toBeDisabled();
				await expect.element(page.getByRole('status')).toHaveTextContent('Sounds are off.');
				await page.getByRole('switch', { name: 'Play sounds' }).click();
				await expect.poll(() => oscillator.mock.calls.length).toBe(before + 6);
				expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
				await page.screenshot({ path: `../../../.vitest/sounds-${width}.png` });
			} finally {
				await unmount(app);
				target.remove();
			}
		}
	} finally {
		oscillator.mockRestore();
		await page.viewport(1200, 900);
	}
});
