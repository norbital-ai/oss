// WhatsApp, official: the channel's own Twilio account and WhatsApp sender (never the host's CPaaS keys). Pairing takes
// the account SID, auth token and the sender number and reads the account to prove them. Inbound messages and status
// callbacks arrive on this channel's webhook, verified by `X-Twilio-Signature` (HMAC-SHA1 under the auth token over the
// URL Twilio called plus the sorted form parameters). Sends are the Messages API from `whatsapp:<from>`, each carrying
// this webhook as its status callback; each attachment follows the text as its own media message, Twilio fetching it
// from the host's signed file link (a host with no file links refuses such a send). A chat is the sender's `whatsapp:+<digits>`.
import { createHmac } from 'node:crypto';
import { connection, type ChannelProvider, type DeliveryReport, type Json } from '@norbital-ai/bolt/engine';
import { field, isObj, linkOf, refusal, same, str, type Obj } from '../util.ts';
import { twilio } from './messages.ts';

const API = 'https://api.twilio.com/2010-04-01';
const MEDIA_MAX = 16 * 1024 * 1024;
// `queued`, `accepted`, `sending` are Twilio's own queue: bolt already holds `queued`; `undelivered` reached the network and was not delivered
const STATUS: { readonly [s: string]: DeliveryReport['kind'] } = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'bounced' };
const TWIML = () => new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });

export function twilioWhatsapp(o: { api?: string } = {}): ChannelProvider {
	const api = o.api ?? API;
	return {
		transport: 'whatsapp', id: 'twilio', label: { en: 'Official (Twilio)', zh: '官方（Twilio）' },
		setup: { kind: 'form', webhook: true, steps: [
			{ text: { en: 'In the Twilio Console, register a WhatsApp sender for this channel (Messaging → Senders → WhatsApp senders), or use the sandbox to try it.',
				zh: '在 Twilio 控制台为此渠道注册 WhatsApp 发送方（Messaging → Senders → WhatsApp senders），或先用沙盒试用。' }, href: 'https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders' },
			{ text: { en: 'On the sender, set "Webhook URL for incoming messages" to this URL (HTTP POST).', zh: '在该发送方上，将 “Webhook URL for incoming messages” 设为此 URL（HTTP POST）。' }, copy: 'webhookUrl' },
			{ text: { en: 'Paste this account\'s SID and auth token and the sender\'s number below. They are this channel\'s own, sealed for it alone.',
				zh: '在下方粘贴此账号的 SID、Auth Token 和发送方号码。它们仅属于此渠道，并为其单独加密保存。' } },
		], fields: [
			{ name: 'accountSid', label: { en: 'Account SID', zh: '账号 SID' }, hint: 'AC…' },
			{ name: 'authToken', label: { en: 'Auth token', zh: 'Auth Token' }, secret: true },
			{ name: 'from', label: { en: 'WhatsApp sender number', zh: 'WhatsApp 发送方号码' }, hint: { en: '+ and the digits, country code first', zh: '+ 加数字，国家代码在前' } },
		] },
		test: { to: { name: 'to', label: { en: 'Send to', zh: '发送至' }, hint: { en: 'A WhatsApp number, + and the digits', zh: 'WhatsApp 号码，+ 加数字' } } },
		async open(ctx) {
			type Cred = { accountSid: string; authToken: string; from: string; account: string };
			let cred: Cred | null = isObj(ctx.credential) && typeof ctx.credential['accountSid'] === 'string' ? ctx.credential as unknown as Cred : null;
			const account = (c: Cred) => ({ accountSid: c.accountSid, authToken: c.authToken, fetch: ctx.fetch });
			return {
				connection: () => cred === null ? connection(ctx.channel, 'whatsapp', 'unpaired')
					: connection(ctx.channel, 'whatsapp', 'connected', { stored: true, pairedAs: cred.from, about: { from: cred.from, account: cred.account } }),
				async pair(input) {
					const c = { accountSid: field(input, 'accountSid', 'The account SID', /^AC[0-9a-f]{32}$/i), authToken: field(input, 'authToken', 'The auth token', /^[0-9a-f]{32}$/i),
						from: field(input, 'from', 'The sender number', /^\+?[1-9]\d{7,14}$/).replace(/^\+?/, '+') };
					const got = await twilio<{ friendly_name?: string }>({ ...c, fetch: ctx.fetch }, `${api}/Accounts/${c.accountSid}.json`, AbortSignal.timeout(30_000));
					cred = { ...c, account: got.body.friendly_name ?? c.accountSid };
					await ctx.save(cred);
					ctx.changed();
				},
				async unpair() { cred = null; await ctx.save(null); },
				async close() {},
				async send(_channel, message, signal, files = []) {
					if (cred === null) throw new Error('the WhatsApp (Twilio) channel is not connected');
					const c = cred, m = message as { to: string; text: string };
					const to = m.to.startsWith('whatsapp:') ? m.to : `whatsapp:+${m.to.replace(/\D/g, '')}`;
					const links = await Promise.all(files.map(linkOf)); // before anything is sent: no text goes without its files
					const post = (body: { Body: string } | { MediaUrl: string }) => twilio<{ sid: string }>(account(c), `${api}/Accounts/${c.accountSid}/Messages.json`, signal,
						{ From: `whatsapp:${c.from}`, To: to, ...body, StatusCallback: ctx.webhookUrl })
						.catch((e: unknown) => { const status: unknown = isObj(e) ? e['status'] : undefined; throw e instanceof Error && typeof status === 'number' ? refusal(e.message, status) : e; });
					const sent = await post({ Body: m.text });
					// ponytail: WhatsApp takes one media per message; only the text's status reaches the row
					for (const MediaUrl of links) await post({ MediaUrl });
					return { providerId: sent.body.sid };
				},
				async webhook(request) {
					if (cred === null) return new Response(null, { status: 404 });
					const params = Object.fromEntries(new URLSearchParams(await request.text()));
					const url = ctx.webhookUrl + new URL(request.url).search; // the URL Twilio called, not the one behind the proxy
					if (!same(request.headers.get('x-twilio-signature') ?? '', twilioSignature(cred.authToken, url, params))) return new Response(null, { status: 403 });
					const status = params['MessageStatus'];
					if (status !== undefined && params['Body'] === undefined) {
						const kind = STATUS[status];
						if (kind !== undefined && params['MessageSid'] !== undefined) await ctx.emit({ kind: 'delivery', channel: ctx.channel, providerId: params['MessageSid'],
							report: twilioReport(kind, params) });
						return TWIML();
					}
					const message = twilioInbound(params);
					if (message === null) return TWIML();
					const bins: Uint8Array[] = [], attachments: Json[] = [];
					for (let i = 0; i < Number(params['NumMedia'] ?? 0); i++) {
						const at = params[`MediaUrl${i}`], mime = params[`MediaContentType${i}`] ?? 'application/octet-stream';
						if (at === undefined) continue;
						try {
							const res = await ctx.fetch(at, { headers: { authorization: `Basic ${Buffer.from(`${cred.accountSid}:${cred.authToken}`).toString('base64')}` } });
							const bytes = new Uint8Array(await res.arrayBuffer());
							if (!res.ok || bytes.byteLength > MEDIA_MAX) continue;
							attachments.push({ fileName: `whatsapp-${i}.${mime.split('/')[1] ?? 'bin'}`, mimeType: mime, byteLength: bytes.byteLength, bin: bins.length });
							bins.push(bytes);
						} catch { /* the message still lands; the media is absent */ }
					}
					await ctx.emit({ kind: 'inbound', channel: ctx.channel, message: { ...message, attachments }, ...(bins.length === 0 ? {} : { bins }) });
					return TWIML();
				},
			};
		},
	};
}

/** A status callback → the report: Twilio's `ErrorCode` (e.g. 63016, outside the 24-hour window) and message as code and reason. */
export function twilioReport(kind: DeliveryReport['kind'], p: { readonly [k: string]: string }): DeliveryReport {
	const code = str(p['ErrorCode']);
	return { kind, at: new Date().toISOString(), provider: 'twilio', raw: p,
		...(code === null ? {} : { code, reason: str(p['ErrorMessage']) ?? `Twilio error ${code}`, permanent: true }) };
}

/** `X-Twilio-Signature`: base64 HMAC-SHA1 under the auth token over the URL and each form parameter's name and value, sorted by name. */
export const twilioSignature = (authToken: string, url: string, params: { readonly [k: string]: string }): string =>
	createHmac('sha1', authToken).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');

/** One incoming-message webhook's form → the wire message, or `null` without a sender or a message id. */
export function twilioInbound(p: { readonly [k: string]: string }): Obj | null {
	const from = str(p['From']), id = str(p['MessageSid']);
	if (from === null || id === null) return null;
	return { id, thread: from, sentAt: new Date().toISOString(), from: { handle: from, name: str(p['ProfileName']) }, text: p['Body'] ?? '',
		group: false, invocation: 'direct', replyTo: str(p['OriginalRepliedMessageSid']) };
}
