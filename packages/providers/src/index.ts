// `@norbital-ai/providers`: Bolt's built-in integration drivers. Bolt and workspaces name only drivers; a host
// (bolt-server's `drivers()`, which every host uses) registers these. Facility adapters belong to the host that writes them.
import type { ProviderDef } from './abi.ts';
export { toDrivers } from './abi.ts';
import { baileys } from './baileys/index.ts';
import { twilioWhatsapp } from './twilio/whatsapp.ts';
import { telegram } from './telegram/index.ts';
import { slack } from './slack/index.ts';
import { discord } from './discord/index.ts';
import { wechat } from './wechat/index.ts';
import { mailbox } from './imap-smtp/index.ts';
import { googleCalendar } from './google-calendar/index.ts';

/** Every conversation and calendar provider; each instance still pairs with its own account. OAuth apps come from the workspace's secrets. */
export function defaultProviders(): readonly ProviderDef[] {
	return [
		baileys(),
		twilioWhatsapp(),
		telegram(),
		slack(),
		discord(),
		wechat(),
		...mailbox(),
		googleCalendar()
	];
}
export { OAuthRefused, ProviderRefused, ProviderUnavailable } from './errors.ts';
// a host's own HTTP adapters answer and fail as these drivers do
export { decodeMessage, Email, invalid, providerJson, strings, Text } from './transport.ts';
export { twilio, type TwilioAccount } from './twilio/whatsapp.ts';
// the shared OAuth grant (PKCE S256, a `state` that lives `STATE_MS`) a host's own oauth driver signs in with (bolt-server's `http`)
export {
	attempt,
	authorizeUrl,
	grant,
	tokenHolder,
	Tokens,
	STATE_MS,
	type OAuthApp
} from './oauth.ts';
export { same, field, hostCall, withFetch } from './util.ts';
