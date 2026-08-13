export type ShortcutModifier = '⌘' | 'Ctrl';

export function detectShortcutModifier(): ShortcutModifier {
	if (typeof navigator === 'undefined') return 'Ctrl';
	return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
}

export function formatShortcut(modifier: ShortcutModifier, key: string): string {
	return modifier === '⌘' ? `⌘${key}` : `Ctrl+${key}`;
}
