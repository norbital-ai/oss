// `@norbital-ai/providers`: the providers behind Bolt's driver kinds and host ports. Bolt and workspaces name only
// drivers and ports; a host (bolt-server's `drivers()`, which every host uses) registers these and injects them.
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
export { twilioMessages, type TwilioAccount } from './twilio/messages.ts';
export { twilioVerify } from './twilio/verify.ts';
export { resendMail, type ResendMail } from './resend/mail.ts';
export {
	SINCH_REGIONS,
	sinchMail,
	sinchSms,
	sinchVerification,
	type SinchRegion
} from './sinch/index.ts';
export { transactional, type TransactionalConfig, type TransactionalDef } from './transactional.ts';
// host AI capabilities (`ctx.ai.transcribe`, `ctx.ai.speak`)
export {
	openRouterSpeech,
	type OpenRouterSpeechConfig,
	type SpeechDef,
	type SpeechServices
} from './openrouter/speech.ts';
export { OAuthRefused, SpeechFailure } from './errors.ts';
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
export type { TransportDef, PhoneVerifierDef } from './transport.ts';
