/** An integration instance's setup in the browser: its client, the generic setup view, and a definition's own setup contract. */
export { integration_client, integration_offers, type IntegrationClient } from './integrations.ts';
export { default as IntegrationSetup } from './IntegrationSetup.svelte';
export { default as IntegrationCard } from './IntegrationCard.svelte';
export type {
	IntegrationSetupEntry,
	IntegrationSetupLoader,
	IntegrationSetupProps
} from '../shell/integration/setup.ts';
export {
	local_text,
	type ImportStart,
	type ImportStartInput,
	type InstanceStatus,
	type IntegrationOffer,
	type LocalText,
	type ProviderChoice
} from '../protocol/instance-status.ts';
