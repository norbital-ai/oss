// `@norbital-ai/providers`: the provider adapters behind Bolt's host ports. Bolt and workspaces name only transports
// and ports; a host (bolt-server or a platform host) builds these from its own configuration and injects them.
export { twilioMessages, type TwilioAccount } from './twilio/messages.ts';
export { twilioVerify } from './twilio/verify.ts';
export { resendMail, type ResendMail } from './resend/mail.ts';
export { SINCH_REGIONS, sinchMail, sinchSms, sinchVerification, type SinchRegion } from './sinch/index.ts';
export { transactional, type TransactionalConfig } from './transactional.ts';
// channel providers (rule 61): the operator picks one per channel at setup; the host registers the list
export { baileys, baileysSocket, whatsappMessage, type BaileysOptions, type WaOpen, type WaSocket } from './baileys/index.ts';
export { twilioWhatsapp, twilioSignature } from './twilio/whatsapp.ts';
export { telegram, telegramUpdate } from './telegram/index.ts';
export { slack, slackVerified } from './slack/index.ts';
export { discord, type DiscordOptions, type GatewaySocket } from './discord/index.ts';
export { wechat, wechatSignature } from './wechat/index.ts';
export { mailbox, type MailboxOptions } from './imap-smtp/index.ts';
// host AI capabilities (`ctx.ai.transcribe`, `ctx.ai.speak`)
export { openRouterSpeech, SpeechFailure, type OpenRouterSpeechConfig } from './openrouter/speech.ts';
