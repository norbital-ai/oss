import { expect, it } from '@effect/vitest';
import { createRawSnippet, mount, unmount } from 'svelte';
import { Button } from '@norbital-ai/ui';
import { page } from 'vitest/browser';
import { theme_css } from '../src/decl/theme.ts';
import './support/shell.css';

it('applies workspace colour, font and radius overrides to native controls in both modes', async () => {
	const root = document.documentElement;
	const wasDark = root.classList.contains('dark');
	const target = document.body.appendChild(document.createElement('div'));
	const pointer = document.body.appendChild(document.createElement('div'));
	pointer.dataset.testid = 'theme-pointer-boundary';
	pointer.style.cssText = 'position:fixed;right:0;bottom:0;width:16px;height:16px';
	const style = document.head.appendChild(document.createElement('style'));
	style.textContent = theme_css({
		light: {
			primary: '#124c8c',
			'primary-foreground': '#ffffff',
			'font-sans': 'Arial, sans-serif',
			radius: '1rem'
		},
		dark: { primary: '#9cc4ff', 'primary-foreground': '#101218', radius: '0rem' }
	});
	const view = mount(Button, {
		target,
		props: { children: createRawSnippet(() => ({ render: () => '<span>Action</span>' })) }
	});
	try {
		// A previous browser test can leave the pointer over this newly mounted button.
		await page.getByTestId('theme-pointer-boundary').hover();
		root.classList.remove('dark');
		const button = target.querySelector('button');
		if (button === null) throw new Error('Missing native button');
		await expect.poll(() => getComputedStyle(button).backgroundColor).toBe('rgb(18, 76, 140)');
		expect(getComputedStyle(button).color).toBe('rgb(255, 255, 255)');
		expect(getComputedStyle(button).borderRadius).toBe('8px');
		expect(getComputedStyle(button).fontFamily).toContain('Arial');
		root.classList.add('dark');
		await expect.poll(() => getComputedStyle(button).backgroundColor).toBe('rgb(156, 196, 255)');
		expect(getComputedStyle(button).color).toBe('rgb(16, 18, 24)');
		expect(getComputedStyle(button).borderRadius).toBe('0px');
	} finally {
		await unmount(view);
		target.remove();
		pointer.remove();
		style.remove();
		root.classList.toggle('dark', wasDark);
	}
});
