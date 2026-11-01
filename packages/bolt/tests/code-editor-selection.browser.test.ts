/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { mount, tick, unmount } from 'svelte';
import CodeEditor from '../../ui/src/editors/code-editor.svelte';
import './support/shell.css';

const source = 'const treasury = { balance: 1200, currency: "SGD" };';

const contrast = (foreground: string, background: string, canvasColor: string) => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('Canvas color conversion is unavailable');
	const luminance = (color: string, underlay?: string) => {
		context.fillStyle = canvasColor;
		context.fillRect(0, 0, 1, 1);
		if (underlay !== undefined) {
			context.fillStyle = underlay;
			context.fillRect(0, 0, 1, 1);
		}
		context.fillStyle = color;
		context.fillRect(0, 0, 1, 1);
		const rgb = context.getImageData(0, 0, 1, 1).data;
		return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
			const channel = (rgb[index] ?? 0) / 255;
			return (
				sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
			);
		}, 0);
	};
	const fg = luminance(foreground, background);
	const bg = luminance(background);
	return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
};

it.each([
	{ theme: 'light', readonly: false },
	{ theme: 'dark', readonly: false },
	{ theme: 'light', readonly: true },
	{ theme: 'dark', readonly: true }
])(
	'code selection and editable caret stay legible in $theme, readonly=$readonly, before and after blur',
	async ({ theme, readonly }) => {
		const target = document.body.appendChild(document.createElement('div'));
		target.className = theme === 'dark' ? 'dark' : '';
		target.style.backgroundColor = 'var(--background)';
		const blur = target.appendChild(document.createElement('button'));
		blur.textContent = 'Outside editor';
		let changes = 0;
		const component = mount(CodeEditor, {
			target,
			props: { value: source, language: 'javascript', readonly, onChange: () => changes++ }
		});
		try {
			await tick();
			const editor = target.querySelector<HTMLElement>('.cm-editor');
			if (editor === null) throw new Error('Code editor did not mount');
			const content = editor.querySelector<HTMLElement>('.cm-content');
			if (content === null) throw new Error('Code editing surface did not mount');
			const token = content.querySelector('span');
			if (token === null) throw new Error('Syntax highlighting did not render');
			const syntaxColor = getComputedStyle(token).color;
			if (!readonly) {
				content.focus();
				await expect.poll(() => document.activeElement).toBe(content);
				await expect.poll(() => editor.querySelector('.cm-cursor')).not.toBeNull();
				const cursor = editor.querySelector<HTMLElement>('.cm-cursor');
				if (cursor === null) throw new Error('Focused code has no editing caret');
				await expect.element(cursor).toBeVisible();
				const cursorStyle = getComputedStyle(cursor);
				expect(parseFloat(cursorStyle.borderLeftWidth)).toBeGreaterThan(0);
				expect(cursor.getBoundingClientRect().height).toBeGreaterThan(0);
				const activeLine = editor.querySelector('.cm-activeLine');
				expect(
					contrast(
						cursorStyle.borderLeftColor,
						getComputedStyle(activeLine ?? content).backgroundColor,
						getComputedStyle(target).backgroundColor
					)
				).toBeGreaterThanOrEqual(3);
			}
			const range = document.createRange();
			range.selectNodeContents(content);
			document.getSelection()?.removeAllRanges();
			document.getSelection()?.addRange(range);
			await expect.poll(() => document.getSelection()?.toString()).toBe(source);
			for (const focused of [true, false]) {
				if (!focused) {
					blur.focus();
					await expect.poll(() => document.activeElement).toBe(blur);
				}
				await expect.poll(() => editor.querySelector('.cm-selectionBackground')).not.toBeNull();
				const selected = editor.querySelector('.cm-selectionBackground');
				if (selected === null) throw new Error('Selected code has no selection background');
				expect(
					contrast(
						getComputedStyle(token, '::selection').color,
						getComputedStyle(selected).backgroundColor,
						getComputedStyle(target).backgroundColor
					)
				).toBeGreaterThanOrEqual(4.5);
				expect(getComputedStyle(token).color).toBe(syntaxColor);
				expect(content.textContent).toBe(source);
				expect(content.contentEditable).toBe(String(!readonly));
				expect(changes).toBe(0);
			}
		} finally {
			document.getSelection()?.removeAllRanges();
			await unmount(component);
			target.remove();
		}
	}
);
