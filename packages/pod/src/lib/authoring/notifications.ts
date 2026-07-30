export type NotificationDefinition<TChannels extends readonly string[]> = {
	readonly channels: TChannels;
};

/** Declare external notification channels. `system` is always available and cannot be shadowed. */
export function defineNotifications<const TChannels extends readonly string[]>(
	definition: NotificationDefinition<TChannels>
): NotificationDefinition<TChannels> {
	const seen = new Set<string>();
	for (const channel of definition.channels) {
		if (!/^[a-z][a-z0-9_-]*$/.test(channel)) {
			throw new Error(`Invalid notification channel: ${channel}`);
		}
		if (channel === 'system') {
			throw new Error('The system notification channel belongs to Pod and must not be declared');
		}
		if (seen.has(channel)) throw new Error(`Duplicate notification channel: ${channel}`);
		seen.add(channel);
	}
	return Object.freeze({
		channels: Object.freeze([...definition.channels])
	}) as NotificationDefinition<TChannels>;
}
