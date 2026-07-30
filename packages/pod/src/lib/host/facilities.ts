import type {
	HostMessagingBinding,
	NotificationDelivery,
	NotificationDeliveryResult,
	TransportMessage,
	TransportSendResult
} from '@norbital-ai/platform-utils/runtime/binding';

export type NotificationProvider = {
	readonly channel: string;
	send(input: NotificationDelivery): Promise<NotificationDeliveryResult>;
};

/**
 * One conversational wire the host holds open — Telegram, WhatsApp, SMS.
 *
 * A channel declared in `src/channels/+<name>.channel.ts` names one of these by `transport`, and a
 * workspace naming a transport no host registered refuses to boot.
 */
export type MessagingTransport = {
	readonly transport: string;
	send(message: TransportMessage): Promise<TransportSendResult>;
};

/**
 * Assemble the `messaging` facility from the channels and transports this host actually has.
 *
 * The two lists stay separate because they answer different questions: a *channel* delivers to a
 * workspace user, whose address the host resolves from a user id; a *transport* carries a
 * conversation with someone who may have no user row at all, addressed the transport's own way.
 */
export function messagingProviders(input: {
	readonly channels?: readonly NotificationProvider[];
	readonly transports?: readonly MessagingTransport[];
}): HostMessagingBinding {
	const byChannel = new Map<string, NotificationProvider>();
	for (const provider of input.channels ?? []) {
		if (provider.channel === 'system') {
			throw new Error('A host cannot provide the Pod-owned system notification channel');
		}
		if (byChannel.has(provider.channel)) {
			throw new Error(`Duplicate notification provider: ${provider.channel}`);
		}
		byChannel.set(provider.channel, provider);
	}
	const byTransport = new Map<string, MessagingTransport>();
	for (const transport of input.transports ?? []) {
		if (!transport.transport.trim()) throw new Error('A messaging transport needs a name');
		if (byTransport.has(transport.transport)) {
			throw new Error(`Duplicate messaging transport: ${transport.transport}`);
		}
		byTransport.set(transport.transport, transport);
	}
	const transportNames = [...byTransport.keys()].sort();
	return {
		channels: [...byChannel.keys()].sort(),
		send(delivery) {
			const provider = byChannel.get(delivery.channel);
			if (!provider) {
				return Promise.resolve({
					sent: false,
					reason: `No provider for notification channel ${delivery.channel}`
				});
			}
			return provider.send(delivery);
		},
		listTransports() {
			return Promise.resolve(transportNames);
		},
		sendVia(name, message) {
			const transport = byTransport.get(name);
			if (!transport) {
				return Promise.resolve({ sent: false, reason: `No transport named ${name}` });
			}
			return transport.send(message);
		}
	};
}

/**
 * Messages written to the host log instead of delivered.
 *
 * Every channel and transport reports `sent: true`, because from the workspace's point of view the
 * message *was* handed to the host successfully — the host simply routes it to a console. Reporting
 * a failure here would make hooks take their delivery-failure branch during ordinary local work.
 */
export function consoleMessaging(input: {
	readonly channels: readonly string[];
	readonly transports?: readonly string[];
}): HostMessagingBinding {
	if (input.channels.length === 0) {
		throw new Error('consoleMessaging requires the external channels it handles');
	}
	if (input.channels.some((channel) => channel === '*' || channel === 'system')) {
		throw new Error('consoleMessaging accepts explicit external channel names only');
	}
	if ((input.transports ?? []).some((transport) => !transport.trim())) {
		throw new Error('consoleMessaging accepts explicit transport names only');
	}
	return messagingProviders({
		channels: [...new Set(input.channels)].sort().map((channel) => ({
			channel,
			send(delivery: NotificationDelivery) {
				console.log(
					`[pod:messaging] to=${delivery.recipientUserId} channel=${channel} subject=${delivery.subject}\n${delivery.message}`
				);
				return Promise.resolve({ sent: true });
			}
		})),
		transports: [...new Set(input.transports ?? [])].sort().map((transport) => ({
			transport,
			send(message: TransportMessage) {
				console.log(
					`[pod:messaging] via=${transport} conversation=${message.conversationId}\n${message.text}`
				);
				return Promise.resolve({ sent: true });
			}
		}))
	});
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
