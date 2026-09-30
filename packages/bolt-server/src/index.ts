// `@norbital-ai/bolt-server` (§3.3.10, Appendix D.2): `bolt start` and the self-host adapters of the engine's host ports.
export { main } from './main.ts';
export { start, type Server as RunningServer } from './server.ts';
export type { Config as ServerConfig } from './config.ts';
export { localFiles, publicWeb, s3Files, timekeeper as inProcessDeadlines } from './ports.ts';
export { mailTransport as emailTransport } from './mail.ts';
// the transactional providers, for a host that pins this package and not `@norbital-ai/providers`
export { transactional, type TransactionalConfig } from '@norbital-ai/providers';
export { openRouterSpeech, type OpenRouterSpeechConfig } from '@norbital-ai/providers'; // `ctx.ai.transcribe` / `ctx.ai.speak`
// the channel providers an administrator chooses at setup, for the same host
export { baileys, discord, mailbox, slack, telegram, twilioWhatsapp, wechat, type WaOpen } from '@norbital-ai/providers';
export { push as webPush } from './push.ts';
export { readPublicPage, type PublicPage } from './web.ts';
