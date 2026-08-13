import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectShortcutModifier, formatShortcut } from '@norbital-ai/ui/keybindings';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('platform shortcut labels', () => {
	it('uses the command glyph on Apple user agents and Ctrl elsewhere', () => {
		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
		expect(detectShortcutModifier()).toBe('⌘');
		expect(formatShortcut('⌘', 'K')).toBe('⌘K');
		expect(formatShortcut('⌘', '/')).toBe('⌘/');

		vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
		expect(detectShortcutModifier()).toBe('Ctrl');
		expect(formatShortcut('Ctrl', 'K')).toBe('Ctrl+K');
		expect(formatShortcut('Ctrl', '/')).toBe('Ctrl+/');
	});
});
