/** Provider-authored pairing UI, reusable by tenant account configuration surfaces. */
export { default as ChannelSetup } from './shell/channels/Setup.svelte';
export type { ChannelConnection } from './engine/channels/connection.ts';
export { localText, type ProviderChoice } from './engine/channels/connection.ts';
import { shellApi } from './shell/runtime.ts';
/** Session-authenticated account operations, using the host's tenant base path. */
export const channelAccounts = shellApi().transport;
