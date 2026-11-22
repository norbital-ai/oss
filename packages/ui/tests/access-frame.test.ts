import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { AccessFrame } from '../src/brand/index.ts';

const card = createRawSnippet(() => ({
	render: () => '<p>Sign in card</p>'
}));

const labels = {
	switchLanguage: 'Switch language',
	lightMode: 'Switch to light mode',
	darkMode: 'Switch to dark mode',
	secureAccess: 'Secure access'
};

const settle = async () => {
	await tick();
	flushSync();
};

describe('AccessFrame language picker', () => {
	it('renders the Globe dropdown when multiple languages exist and invokes on_locale on select', async () => {
		const on_locale = vi.fn();
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(AccessFrame, {
			target,
			props: {
				languages: [
					{ code: 'en', label: 'English' },
					{ code: 'zh', label: '中文' },
					{ code: 'ja', label: '日本語' }
				],
				locale: 'en-SG',
				on_locale,
				dark: false,
				on_theme: () => {},
				labels,
				children: card
			}
		});
		try {
			flushSync();
			const trigger = target.querySelector<HTMLButtonElement>('[data-testid="access-language-trigger"]');
			expect(trigger).not.toBeNull();
			expect(trigger?.getAttribute('aria-label')).toBe('Switch language');
			trigger?.click();
			await settle();

			const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
			expect(items.map((el) => el.textContent?.trim())).toEqual(['English', '中文', '日本語']);
			expect(items[0]?.getAttribute('aria-checked')).toBe('true');
			expect(items[1]?.getAttribute('aria-checked')).toBe('false');
			expect(items[2]?.getAttribute('aria-checked')).toBe('false');

			items[2]?.click();
			await settle();
			expect(on_locale).toHaveBeenCalledWith('ja');
		} finally {
			await unmount(view);
			target.remove();
		}
	});

	it('hides the language switcher when only one language is offered', async () => {
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(AccessFrame, {
			target,
			props: {
				languages: [{ code: 'en', label: 'English' }],
				locale: 'en',
				on_locale: () => {},
				dark: false,
				on_theme: () => {},
				labels,
				children: card
			}
		});
		try {
			flushSync();
			expect(target.querySelector('[data-testid="access-language-trigger"]')).toBeNull();
		} finally {
			await unmount(view);
			target.remove();
		}
	});
});
