/** Decodes persisted bolt_agent_messages content into plain panel text. */
export function decodeMessageText(content: unknown): string {
	if (typeof content === 'string') {
		try {
			const parsed: unknown = JSON.parse(content);
			if (typeof parsed === 'string') return parsed;
			if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
				const text = Reflect.get(parsed, 'text');
				if (typeof text === 'string') return text;
			}
			return content;
		} catch {
			return content;
		}
	}
	if (content !== null && typeof content === 'object' && 'text' in content) {
		const text = Reflect.get(content, 'text');
		if (typeof text === 'string') return text;
	}
	return content == null ? '' : String(content);
}
