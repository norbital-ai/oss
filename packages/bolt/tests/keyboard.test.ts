import { expect, it, vi } from 'vitest';
import { commandKey, shortcutLabel } from '../src/shell/keyboard.ts';

it.each([
	['MacIntel', '⌘K', true],
	['iPad', '⌘K', true],
	['Win32', 'Ctrl+K', false],
	['Linux x86_64', 'Ctrl+K', false]
])('uses the primary shortcut modifier on %s', (platform, label, apple) => {
	vi.stubGlobal('navigator', { platform });
	expect(shortcutLabel('K')).toBe(label);
	expect(commandKey({ metaKey: true, ctrlKey: false })).toBe(apple);
	expect(commandKey({ metaKey: false, ctrlKey: true })).toBe(!apple);
	expect(commandKey({ metaKey: false, ctrlKey: false })).toBe(false);
});

it('can render shortcut labels without a browser', () => {
	vi.stubGlobal('navigator', undefined);
	expect(shortcutLabel('K')).toBe('Ctrl+K');
});
