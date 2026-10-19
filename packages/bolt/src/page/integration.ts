/** An integration instance's setup in the browser: its client, the generic setup view, and a definition's own setup contract. */
export { integrationClient, type IntegrationClient } from './integrations.ts';
export { default as IntegrationSetup } from './IntegrationSetup.svelte';
export type {
	IntegrationSetupEntry,
	IntegrationSetupLoader,
	IntegrationSetupProps
} from '../shell/integration/setup.ts';
export {
	localText,
	type InstanceStatus,
	type LocalText,
	type ProviderChoice
} from '../protocol/instance-status.ts';
