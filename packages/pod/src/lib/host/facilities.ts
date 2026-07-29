import type {
	HostMapsBinding,
	HostNotificationsBinding
} from '@norbital-ai/platform-utils/runtime/binding';

/**
 * Notifications written to the host log instead of delivered.
 *
 * Every channel reports `sent: true`, because from the workspace's point of view the notification
 * *was* handed to the host successfully — the host simply routes it to a console. Reporting a
 * failure here would make hooks take their delivery-failure branch during ordinary local work.
 */
export function consoleNotifications(): HostNotificationsBinding {
	return {
		send(input) {
			console.log(
				`[pod:notifications] to=${input.recipientUserId} channels=${input.channels.join(',')} subject=${input.subject}\n${input.message}`
			);
			return Promise.resolve(
				Object.fromEntries(input.channels.map((channel) => [channel, { sent: true }]))
			);
		}
	};
}

/**
 * A maps facility that satisfies the requirement without holding a provider credential.
 *
 * Autocomplete returns nothing rather than throwing: an address field that offers no suggestions
 * still accepts a typed address, so a workspace with geolocation fields stays usable. Static map
 * rendering has no such degraded form — there is no image to return — so it fails with a message
 * that says what to configure.
 */
export function stubMaps(): HostMapsBinding {
	return {
		autocompleteGeolocation() {
			return Promise.resolve([]);
		},
		renderStaticMap() {
			return Promise.reject(
				new Error(
					'This host has no maps provider configured. Supply `maps` in pod.config.ts to render static maps.'
				)
			);
		}
	};
}

/*
 * There is deliberately no AI adapter here.
 *
 * `ai` is the one facility with no open implementation: the model credentials, the agent adapter,
 * and the spend they represent belong to the trusted host, so Core supplies it and this package
 * only declares the contract. A standalone workspace that needs `ai` is therefore rejected at
 * startup, naming the facility — which is the honest outcome, because no configuration of this
 * host could have satisfied it.
 */
