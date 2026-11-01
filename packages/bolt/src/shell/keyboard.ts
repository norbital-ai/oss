const appleKeyboard = () =>
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Match the platform's primary shortcut modifier, including in embedded shells. */
export const commandKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean =>
	appleKeyboard() ? event.metaKey : event.ctrlKey;

export const shortcutLabel = (key: string): string => `${appleKeyboard() ? '⌘' : 'Ctrl+'}${key}`;
