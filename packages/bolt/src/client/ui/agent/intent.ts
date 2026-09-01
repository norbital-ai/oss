/** Parses canonical composer commands; anything else is an ordinary message. */
export function parseTaskSlashCommand(source: string):
	| { readonly kind: 'message'; readonly message: string }
	| {
			readonly kind: 'submission';
			readonly mode: 'plan' | 'compact';
			readonly message: string;
			readonly complete: boolean;
	  }
 {
	const match = /^\s*\/(plan|compact)(?:\s+([\s\S]*))?$/i.exec(source);
	if (!match) return { kind: 'message', message: source };
	const command = match[1]?.toLowerCase();
	if (command !== 'plan' && command !== 'compact') return { kind: 'message', message: source };
	const message = (match[2] ?? '').trim();
	return {
		kind: 'submission',
		mode: command,
		message,
		complete: message.length > 0
	};
}

/** Plain Tab toggles composer mode; mention menus and modified Tab retain precedence. */
export function isAgentModeShortcut(
	event: Pick<
		KeyboardEvent,
		'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing'
	>
): boolean {
	return (
		event.key === 'Tab' &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.isComposing
	);
}
