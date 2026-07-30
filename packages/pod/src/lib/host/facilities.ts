import type {
	HostNotificationsBinding,
	NotificationDelivery,
	NotificationDeliveryResult
} from '@norbital-ai/platform-utils/runtime/binding';

export type NotificationProvider = {
	readonly channel: string;
	send(input: NotificationDelivery): Promise<NotificationDeliveryResult>;
};

export function notificationProviders(
	...providers: readonly NotificationProvider[]
): HostNotificationsBinding {
	const byChannel = new Map<string, NotificationProvider>();
	for (const provider of providers) {
		if (provider.channel === 'system') {
			throw new Error('A host cannot provide the Pod-owned system notification channel');
		}
		if (byChannel.has(provider.channel)) {
			throw new Error(`Duplicate notification provider: ${provider.channel}`);
		}
		byChannel.set(provider.channel, provider);
	}
	return {
		channels: [...byChannel.keys()].sort(),
		send(input) {
			const provider = byChannel.get(input.channel);
			if (!provider) {
				return Promise.resolve({
					sent: false,
					reason: `No provider for notification channel ${input.channel}`
				});
			}
			return provider.send(input);
		}
	};
}

/**
 * Notifications written to the host log instead of delivered.
 *
 * Every channel reports `sent: true`, because from the workspace's point of view the notification
 * *was* handed to the host successfully — the host simply routes it to a console. Reporting a
 * failure here would make hooks take their delivery-failure branch during ordinary local work.
 */
export function consoleNotifications(...channels: readonly string[]): HostNotificationsBinding {
	if (channels.length === 0) {
		throw new Error('consoleNotifications requires the external channels it handles');
	}
	if (channels.some((channel) => channel === '*' || channel === 'system')) {
		throw new Error('consoleNotifications accepts explicit external channel names only');
	}
	return {
		channels: [...new Set(channels)].sort(),
		send(input) {
			console.log(
				`[pod:notifications] to=${input.recipientUserId} channel=${input.channel} subject=${input.subject}\n${input.message}`
			);
			return Promise.resolve({ sent: true });
		}
	};
}

/*
 * There is deliberately no AI adapter here.
 *
 * `ai` is the one facility with no built-in implementation: the model credentials, provider,
 * and the spend they represent belong to the trusted host, so Core supplies it and this package
 * only declares the contract. A standalone workspace that needs `ai` is therefore rejected at
 * startup, naming the facility — which is the honest outcome, because no configuration of this
 * host could have satisfied it.
 */
