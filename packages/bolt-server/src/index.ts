export { main } from './main.ts';
export { Server, ServerLive, type ServeOptions } from './server.ts';
export {
	host,
	type AiModel,
	type Facility,
	type HostSettings,
	type Provider,
	type Transactional
} from './host.ts';
export { drivers, type DriversOptions } from './drivers.ts';
export { sqlServerDatabase } from './database.ts';
export { publicWeb, readPublicPage, type PublicPage } from './web.ts';
export { extractDocumentText } from './documents.ts';
export { apns, push } from './push.ts';
// this host's own facility adapters, for another host to reuse
export { resendMail, type ResendMail } from './resend.ts';
export { twilioMessages, twilioVerify } from './twilio.ts';
export {
	openRouterSpeech,
	SpeechFailure,
	type OpenRouterSpeechConfig,
	type SpeechDef,
	type SpeechServices
} from './speech.ts';
export type { PhoneVerifierDef, TransportDef } from './mail.ts';
