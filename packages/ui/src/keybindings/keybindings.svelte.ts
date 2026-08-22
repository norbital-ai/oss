import { createAttachmentKey } from 'svelte/attachments';

export type Options = {
	/** Event to use to detect the shortcut @default 'keydown' */
	event?: 'keydown' | 'keyup' | 'keypress';
	/** Function to be called when the shortcut is pressed */
	callback: (e: KeyboardEvent) => void;
	/** Should the `Shift` key be pressed */
	shift?: boolean;
	/** Should the `Ctrl` / `Command` key be pressed */
	ctrl?: boolean;
	/** Should the `Alt` key be pressed */
	alt?: boolean;
	/** Which key should be pressed */
	key: Key;
	/** Control whether or not the shortcut prevents default behavior @default true */
	preventDefault?: boolean;
	/** Control whether or not the shortcut stops propagation @default false */
	stopPropagation?: boolean;
	/** Control whether only the exact specified keys should be pressed (no additional modifiers) @default true */
	exactMatch?: boolean;
};

/** Allows you to configure one or more shortcuts based on the key events of an element.
 *
 * ## Usage
 * ```svelte
 * <!-- Single shortcut -->
 * <svelte:window use:shortcut={{
 * 		ctrl: true,
 * 		key: 'k',
 * 		callback: commandMenu.toggle,
 * 		exactMatch: true
 * }} />
 *
 * <!-- Multiple shortcuts -->
 * <svelte:window use:shortcut={[
 * 		{
 * 			ctrl: true,
 * 			key: 'k',
 * 			callback: openAgent,
 * 			exactMatch: true
 * 		},
 * 		{
 * 			ctrl: true,
 * 			key: 'forward slash',
 * 			callback: openNavigation,
 * 			exactMatch: true
 * 		}
 * ]} />
 *
 * <!-- From array of configs -->
 * <svelte:window use:shortcut={hotkeys.map(h => h.shortcutConfig)} />
 * ```
 */
// Map descriptive key names to actual browser key values
const keyMapping: Record<string, string> = {
	backspace: 'Backspace',
	tab: 'Tab',
	enter: 'Enter',
	'shift(left)': 'Shift',
	'shift(right)': 'Shift',
	'ctrl(left)': 'Control',
	'ctrl(right)': 'Control',
	'alt(left)': 'Alt',
	'alt(right)': 'Alt',
	'pause/break': 'Pause',
	'caps lock': 'CapsLock',
	escape: 'Escape',
	space: ' ',
	'page up': 'PageUp',
	'page down': 'PageDown',
	end: 'End',
	home: 'Home',
	'left arrow': 'ArrowLeft',
	'up arrow': 'ArrowUp',
	'right arrow': 'ArrowRight',
	'down arrow': 'ArrowDown',
	'print screen': 'PrintScreen',
	insert: 'Insert',
	delete: 'Delete',
	'0': '0',
	'1': '1',
	'2': '2',
	'3': '3',
	'4': '4',
	'5': '5',
	'6': '6',
	'7': '7',
	'8': '8',
	'9': '9',
	a: 'a',
	b: 'b',
	c: 'c',
	d: 'd',
	e: 'e',
	f: 'f',
	g: 'g',
	h: 'h',
	i: 'i',
	j: 'j',
	k: 'k',
	l: 'l',
	m: 'm',
	n: 'n',
	o: 'o',
	p: 'p',
	q: 'q',
	r: 'r',
	s: 's',
	t: 't',
	u: 'u',
	v: 'v',
	w: 'w',
	x: 'x',
	y: 'y',
	z: 'z',
	'left window key': 'Meta',
	'right window key': 'Meta',
	'select key (Context Menu)': 'ContextMenu',
	'numpad 0': '0',
	'numpad 1': '1',
	'numpad 2': '2',
	'numpad 3': '3',
	'numpad 4': '4',
	'numpad 5': '5',
	'numpad 6': '6',
	'numpad 7': '7',
	'numpad 8': '8',
	'numpad 9': '9',
	multiply: '*',
	add: '+',
	subtract: '-',
	'decimal point': '.',
	divide: '/',
	f1: 'F1',
	f2: 'F2',
	f3: 'F3',
	f4: 'F4',
	f5: 'F5',
	f6: 'F6',
	f7: 'F7',
	f8: 'F8',
	f9: 'F9',
	f10: 'F10',
	f11: 'F11',
	f12: 'F12',
	'num lock': 'NumLock',
	'scroll lock': 'ScrollLock',
	'audio volume mute': 'AudioVolumeMute',
	'audio volume down': 'AudioVolumeDown',
	'audio volume up': 'AudioVolumeUp',
	'media player': 'MediaPlayPause',
	'launch application 1': 'LaunchApplication1',
	'launch application 2': 'LaunchApplication2',
	'semi-colon': ';',
	'equal sign': '=',
	comma: ',',
	dash: '-',
	period: '.',
	'forward slash': '/',
	'Backquote/Grave accent': '`',
	'open bracket': '[',
	'back slash': '\\',
	'close bracket': ']',
	'single quote': "'"
};

export const shortcut = (node: HTMLElement, options: Options[] | Options) => {
	const checkShortcutMatch = (e: KeyboardEvent, option: Options): boolean => {
		const hasCtrl = e.ctrlKey || e.metaKey;
		const hasAlt = e.altKey;
		const hasShift = e.shiftKey;

		// Check if required modifiers are pressed
		if (option.ctrl && !hasCtrl) return false;
		if (option.alt && !hasAlt) return false;
		if (option.shift && !hasShift) return false;

		// Get the expected key value from mapping, fallback to option.key if not found
		const expectedKey = keyMapping[option.key.toLowerCase()] || option.key;

		// Check the main key (case-insensitive comparison)
		if (e.key.toLowerCase() !== expectedKey.toLowerCase()) return false;

		// Sequence validation: ensure no unwanted modifiers are pressed
		const exactMatch = option.exactMatch ?? true;

		if (exactMatch) {
			// Check if any unwanted modifiers are pressed
			if (!option.ctrl && hasCtrl) return false;
			if (!option.alt && hasAlt) return false;
			if (!option.shift && hasShift) return false;
		}

		return true;
	};

	const handleKeyEvent = (e: KeyboardEvent, eventType: string, optionsArray: Options[]) => {
		// Find all matching shortcuts for this event type
		const matchingShortcuts = optionsArray.filter(
			(option) => (option.event ?? 'keydown') === eventType && checkShortcutMatch(e, option)
		);

		// Execute all matching shortcuts
		for (const option of matchingShortcuts) {
			// Handle preventDefault and stopPropagation
			if (option.preventDefault === undefined || option.preventDefault) {
				e.preventDefault();
			}

			if (option.stopPropagation) {
				e.stopPropagation();
			}
			// Execute the callback
			option.callback(e);
		}
	};

	// Convert single option to array for consistent handling
	let optionsArray = Array.isArray(options) ? options : [options];

	// Group options by event type to avoid duplicate listeners
	const eventGroups = new Map<string, Options[]>();

	for (const option of optionsArray) {
		const eventType = option.event ?? 'keydown';
		let eventOptions = eventGroups.get(eventType);
		if (eventOptions === undefined) {
			eventOptions = [];
			eventGroups.set(eventType, eventOptions);
		}
		eventOptions.push(option);
	}

	// Create event listeners for each event type
	const handlers = new Map<string, (e: Event) => void>();

	for (const [eventType] of Array.from(eventGroups.entries())) {
		const handler = (e: Event) => handleKeyEvent(e as KeyboardEvent, eventType, optionsArray);
		handlers.set(eventType, handler);
		node.addEventListener(eventType, handler);
	}

	return {
		update(newOptions: Options[] | Options) {
			// Update the options array
			optionsArray = Array.isArray(newOptions) ? newOptions : [newOptions];
		},
		destroy() {
			// Clean up all event listeners
			for (const [eventType, handler] of Array.from(handlers.entries())) {
				node.removeEventListener(eventType, handler);
			}
			handlers.clear();
		}
	};
};

/** Allows you to configure one or more shortcuts based on the key events of an element.
 *
 * ## Usage
 * ```svelte
 * <!-- Single shortcut -->
 * <svelte:window
 * 	  {...attachShortcut({
 * 		  ctrl: true,
 * 		  key: 'k',
 * 		  callback: commandMenu.toggle,
 * 		  exactMatch: true
 * 	  })}
 * />
 *
 * <!-- Multiple shortcuts -->
 * <svelte:window
 * 	  {...attachShortcut([
 * 		  {
 * 			  ctrl: true,
 * 			  key: 'k',
 * 			  callback: openAgent,
 * 			  exactMatch: true
 * 		  },
 * 		  {
 * 			  ctrl: true,
 * 			  key: 'forward slash',
 * 			  callback: openNavigation,
 * 			  exactMatch: true
 * 		  }
 * 	  ])}
 * />
 * ```
 */
function attachShortcut(opts: Options[] | Options) {
	return {
		[createAttachmentKey()]: (node: HTMLElement) => shortcut(node, opts)
	};
}

export type Key =
	| 'backspace'
	| 'tab'
	| 'enter'
	| 'shift(left)'
	| 'shift(right)'
	| 'ctrl(left)'
	| 'ctrl(right)'
	| 'alt(left)'
	| 'alt(right)'
	| 'pause/break'
	| 'caps lock'
	| 'escape'
	| 'space'
	| 'page up'
	| 'page down'
	| 'end'
	| 'home'
	| 'left arrow'
	| 'up arrow'
	| 'right arrow'
	| 'down arrow'
	| 'print screen'
	| 'insert'
	| 'delete'
	| '0'
	| '1'
	| '2'
	| '3'
	| '4'
	| '5'
	| '6'
	| '7'
	| '8'
	| '9'
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z'
	| 'left window key'
	| 'right window key'
	| 'select key (Context Menu)'
	| 'numpad 0'
	| 'numpad 1'
	| 'numpad 2'
	| 'numpad 3'
	| 'numpad 4'
	| 'numpad 5'
	| 'numpad 6'
	| 'numpad 7'
	| 'numpad 8'
	| 'numpad 9'
	| 'multiply'
	| 'add'
	| 'subtract'
	| 'decimal point'
	| 'divide'
	| 'f1'
	| 'f2'
	| 'f3'
	| 'f4'
	| 'f5'
	| 'f6'
	| 'f7'
	| 'f8'
	| 'f9'
	| 'f10'
	| 'f11'
	| 'f12'
	| 'num lock'
	| 'scroll lock'
	| 'audio volume mute'
	| 'audio volume down'
	| 'audio volume up'
	| 'media player'
	| 'launch application 1'
	| 'launch application 2'
	| 'semi-colon'
	| 'equal sign'
	| 'comma'
	| 'dash'
	| 'period'
	| 'forward slash'
	| 'Backquote/Grave accent'
	| 'open bracket'
	| 'back slash'
	| 'close bracket'
	| 'single quote';

export type ShortcutModifier = '⌘' | 'Ctrl';

export function detectShortcutModifier(): ShortcutModifier {
	if (typeof navigator === 'undefined') return 'Ctrl';
	return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
}

export function formatShortcut(modifier: ShortcutModifier, key: string): string {
	return modifier === '⌘' ? `⌘${key}` : `Ctrl+${key}`;
}
