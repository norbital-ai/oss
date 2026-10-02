// WhatsApp, unofficial: a paired WhatsApp account over WhatsApp Web (Baileys), one persistent socket per channel owned
// by this link. Pairing by QR or phone code, reconnect with progress after any drop but a logout, logout terminal until
// the next pairing. The auth directory is a working copy; its files are the channel's credential, sealed by the host
// (`ctx.save`) a second after each `creds.update` and written back when the link opens. Baileys is an optional
// dependency, loaded only when a socket opens; tests pass a fake `open`.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	connection,
	type ChannelConnection,
	type ChannelProvider,
	type DeliveryReport,
	type Json
} from '@norbital-ai/bolt/engine';
import { isObj, str, type Obj } from '../util.ts';

/** The part of a Baileys socket this adapter uses, read structurally. */
export type WaSocket = {
	ev: { on(event: string, listener: (arg: never) => void): void };
	user?: { id: string; lid?: string } | undefined;
	/** The account's LID↔phone map. A group mention names our LID, and `user.lid` is optional and often absent. */
	signalRepository?: { getLIDForPN(pn: string): Promise<string | null> } | undefined;
	sendMessage(
		jid: string,
		content:
			| { text: string }
			| { image: Buffer; mimetype: string }
			| { document: Buffer; mimetype: string; fileName: string }
	): Promise<{ key?: { id?: string | null } } | undefined>;
	sendPresenceUpdate?(type: 'composing' | 'paused', jid: string): Promise<void>;
	requestPairingCode(phone: string): Promise<string>;
	groupMetadata?(jid: string): Promise<{ subject?: string }>;
	logout(): Promise<void>;
	end(error: Error | undefined): void;
};
/** Opens one socket over the auth directory; `download` fetches a message's media (or `null`). */
export type WaOpen = (
	authDir: string,
	syncOnly?: boolean,
	credentialsChanged?: () => void
) => Promise<{
	socket: WaSocket;
	flushAuth?(): Promise<void>;
	download(message: unknown): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
}>;
type WaState =
	| { state: 'unpaired' }
	| { state: 'connecting'; attempt: number }
	| { state: 'pairing'; qr: string | null; code: string | null }
	| { state: 'connected'; as: string | null }
	| { state: 'reconnecting'; attempt: number; detail: string }
	| { state: 'loggedOut'; detail: string };

const LOGGED_OUT = 401; // Baileys `DisconnectReason.loggedOut`
const MEDIA_MAX = 32 * 1024 * 1024;

export type BaileysOptions = {
	open?: WaOpen;
	workDir?: string;
	backoffMs?: (attempt: number) => number;
	sealMs?: number;
};

export function baileys(o: BaileysOptions = {}): ChannelProvider {
	const open = o.open ?? baileysSocket,
		backoffMs = o.backoffMs ?? ((n: number) => Math.min(60_000, 1_000 * 2 ** n));
	return {
		transport: 'whatsapp',
		supportsSync: true,
		id: 'baileys',
		name: 'WhatsApp',
		icon: 'simple-icons:whatsapp',
		description: { en: 'Sync messages from your phone', zh: '同步手机中的消息' },
		label: { en: 'Unofficial (WhatsApp Web)', zh: '非官方（WhatsApp 网页版）' },
		setup: {
			kind: 'qr',
			steps: [
				{
					text: {
						en: 'Use a WhatsApp account for this channel only: linking it here is how WhatsApp Web works, and WhatsApp may restrict accounts it sees automating.',
						zh: '请为此渠道单独使用一个 WhatsApp 账号：在此关联即 WhatsApp 网页版的工作方式，WhatsApp 可能限制其判定为自动化的账号。'
					}
				},
				{
					text: {
						en: 'On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR shown here.',
						zh: '在手机上：WhatsApp → 设置 → 已关联的设备 → 关联新设备，然后扫描此处显示的二维码。'
					}
				},
				{
					text: {
						en: 'No camera at hand? Enter the phone number instead and type the code shown here on the phone.',
						zh: '手边没有摄像头？请改为输入手机号码，并在手机上输入此处显示的代码。'
					}
				}
			],
			fields: [
				{
					name: 'phone',
					label: { en: 'Phone number', zh: '手机号码' },
					optional: true,
					hint: {
						en: 'Digits, country code first — to pair with a code instead of the QR',
						zh: '仅数字，国家代码在前——用代码代替二维码配对'
					}
				}
			]
		},
		// a message to the connected account itself: "Message yourself" on the phone
		test: {},
		async open(ctx) {
			const dir = join(
				o.workDir ?? tmpdir(),
				'norbital-baileys',
				createHash('sha256')
					.update(`${ctx.channel}\u0000${randomUUID()}`)
					.digest('hex')
					.slice(0, 16)
			);
			let current: WaState = { state: 'unpaired' };
			let socket: WaSocket | undefined,
				timer: ReturnType<typeof setTimeout> | undefined,
				sealing: ReturnType<typeof setTimeout> | undefined;
			let closed = false,
				attempt = 0,
				lid: string | undefined;
			const set = (s: WaState) => {
				current = s;
				ctx.changed();
			};
			let sealingWork = Promise.resolve();
			const persist = () => {
				sealingWork = sealingWork.catch(() => undefined).then(async () => {
					const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
					const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')] as const)));
					await ctx.save({ files });
				});
				return sealingWork;
			};
			let deliveries = Promise.resolve();
			let flushAuth = async () => {};
			const seal = () => {
				if (closed) return;
				clearTimeout(sealing);
				sealing = setTimeout(() => {
					sealing = undefined;
					void persist().catch((e: unknown) => console.error('[providers] whatsapp credentials not sealed', e));
				}, o.sealMs ?? 1_000);
			};

			async function connect(phone?: string): Promise<void> {
				clearTimeout(timer);
				set({ state: 'connecting', attempt });
				await mkdir(dir, { recursive: true, mode: 0o700 });
				const opened = await open(dir, ctx.syncOnly, seal);
				flushAuth = opened.flushAuth ?? (async () => {});
				const s = opened.socket;
				socket = s;
				let codeAsked = false;
				const on = <T>(event: string, fn: (x: T) => void) =>
					s.ev.on(event, fn as (arg: never) => void);
				on<unknown>('creds.update', seal);
				on<{
					connection?: string;
					qr?: string;
					lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string } };
				}>('connection.update', (u) => {
					if (socket !== s) return; // a late event from a replaced socket
					if (typeof u.qr === 'string') {
						if (phone !== undefined && !codeAsked) {
							codeAsked = true;
							const qr = u.qr;
							s.requestPairingCode(phone).then(
								(code) => set({ state: 'pairing', qr: null, code }),
								() => set({ state: 'pairing', qr, code: null })
							);
						} else if (phone === undefined) set({ state: 'pairing', qr: u.qr, code: null });
					}
					if (u.connection === 'open') {
						attempt = 0;
						void (async () => {
							lid =
								s.user?.lid ??
								(await s.signalRepository?.getLIDForPN(s.user?.id ?? '').catch(() => null)) ??
								undefined;
						})();
						set({ state: 'connected', as: s.user?.id ?? null });
					}
					if (u.connection === 'close') {
						socket = undefined;
						const code = u.lastDisconnect?.error?.output?.statusCode,
							detail = `${code ?? 'no status'}: ${u.lastDisconnect?.error?.message ?? 'closed'}`;
						if (code === LOGGED_OUT) {
							clearTimeout(sealing);
							sealing = undefined;
							void rm(dir, { recursive: true, force: true });
							void ctx.save(null).catch(() => undefined);
							set({ state: 'loggedOut', detail });
							return;
						}
						if (closed || current.state === 'loggedOut') return;
						const wait = backoffMs(attempt++);
						set({ state: 'reconnecting', attempt, detail });
						timer = setTimeout(
							() =>
								void connect().catch((e: unknown) =>
									console.error('[providers] whatsapp reconnect failed', e)
								),
							wait
						);
					}
				});
				// a group's name, read once per group per socket; a failed read names nothing
				const subjects = new Map<string, Promise<string | null>>();
				const subjectOf = (jid: string) => {
					let got = subjects.get(jid);
					if (got === undefined)
						subjects.set(
							jid,
							(got = (s.groupMetadata?.(jid) ?? Promise.resolve<{ subject?: string }>({})).then(
								(g) => g.subject?.trim() || null,
								() => null
							))
						);
					return got;
				};
				const deliver = async (messages: readonly unknown[], history: boolean) => {
					for (const raw of messages) {
						const found = whatsappMessage(raw, s.user?.id, {
							history,
							includeSent: ctx.syncOnly === true,
							...(lid === undefined ? {} : { lid })
						});
						if (found === null) continue;
						const title = found['group'] === true ? await subjectOf(String(found['thread'])) : null;
						const message = title === null ? found : { ...found, title };
						const media = history ? null : await opened.download(raw).catch(() => null);
						// a key distribution or a context stub rides beside a real message with nothing to say: no row for it
						if (found['text'] === '' && media === null && found['deleted'] !== true) continue;
						const bins = media !== null && media.bytes.byteLength <= MEDIA_MAX ? [media.bytes] : [];
						const event = {
								kind: 'inbound',
								channel: ctx.channel,
								message: (bins.length === 0
									? message
									: {
											...message,
											attachments: [
												{
													fileName: media!.name,
													mimeType: media!.mime,
													byteLength: media!.bytes.byteLength,
													bin: 0
												}
											]
										}) as Json,
								...(bins.length === 0 ? {} : { bins })
						} as const;
						let failures = 0;
						while (!closed) {
							try { await ctx.emit(event); break; }
							catch (e) {
								console.error('[providers] whatsapp message retrying', e);
								await new Promise((resolve) => setTimeout(resolve, backoffMs(failures++)));
							}
						}
					}
				};
				const enqueue = (messages: readonly unknown[], history: boolean) => {
					deliveries = deliveries.catch((e: unknown) => console.error('[providers] whatsapp import failed', e)).then(() => closed ? undefined : deliver(messages, history));
				};
				on<{ type: string; messages: unknown[] }>('messages.upsert' , (p) => {
					if (p.type === 'notify' || p.type === 'append') enqueue(p.messages, false);
				});
				on<{ messages: unknown[] }>('messaging-history.set', (p) => enqueue(p.messages, true));
				// receipts on what we sent: the server's ack, the phone's delivery, the blue ticks, an error
				on<unknown[]>('messages.update', (updates) => {
					for (const u of updates) {
						const report = baileysReceipt(u);
						if (report !== null)
							void ctx
								.emit({ kind: 'delivery', channel: ctx.channel, ...report })
								.catch((e: unknown) => console.error('[providers] whatsapp receipt not stored', e));
					}
				});
			}

			// resume what the host sealed
			const files =
				isObj(ctx.credential) && isObj(ctx.credential['files']) ? ctx.credential['files'] : null;
			if (files !== null) {
				await mkdir(dir, { recursive: true, mode: 0o700 });
				for (const [name, content] of Object.entries(files))
					if (/^[\w.-]+\.json$/.test(name) && typeof content === 'string')
						await writeFile(join(dir, name), content);
				if (files['creds.json'] !== undefined) await connect();
			}

			const stop = () => {
				closed = true;
				clearTimeout(timer);
				socket?.end(new Error('host stopping'));
				socket = undefined;
			};
			return {
				connection(): ChannelConnection {
					const c = (
						state: Parameters<typeof connection>[2],
						more: Parameters<typeof connection>[3] = {}
					) => connection(ctx.channel, 'whatsapp', state, more);
					switch (current.state) {
						case 'connecting':
							return c('connecting', {
								detail: `opening the socket (attempt ${current.attempt + 1})`
							});
						case 'pairing':
							return c('pairing', {
								pairing:
									current.qr === null
										? { kind: 'code', value: current.code }
										: { kind: 'qr', value: current.qr }
							});
						case 'connected':
							return c('connected', {
								pairedAs: current.as,
								stored: true,
								about:
									current.as === null ? {} : { account: current.as.split(':')[0]!.split('@')[0]! }
							});
						case 'reconnecting':
							return c('reconnecting', { detail: current.detail, stored: true });
						case 'loggedOut':
							return c('error', { error: `${current.detail} — pair again`, stored: false });
						default:
							return c('unpaired');
					}
				},
				async pair(input) {
					const phone = isObj(input) ? str(input['phone'])?.replace(/\D/g, '') : undefined;
					if (phone !== undefined && phone !== null && !/^\d{6,15}$/.test(phone))
						throw new Error('a pairing phone is digits, country code first');
					closed = false;
					socket?.end(new Error('re-pairing'));
					socket = undefined;
					await rm(dir, { recursive: true, force: true });
					attempt = 0;
					await connect(phone ?? undefined);
				},
				async unpair() {
					clearTimeout(timer);
					clearTimeout(sealing);
					sealing = undefined;
					await sealingWork.catch(() => undefined);
					const s = socket;
					socket = undefined;
					closed = true;
					await s?.logout().catch(() => undefined);
					s?.end(undefined);
					await rm(dir, { recursive: true, force: true });
					await ctx.save(null);
					set({ state: 'unpaired' });
				},
				async close() {
					stop();
					await flushAuth();
					clearTimeout(sealing);
					sealing = undefined;
					if (current.state !== 'unpaired' && current.state !== 'loggedOut') await persist();
					else await sealingWork;
					await rm(dir, { recursive: true, force: true });
				},
				async send(_channel, message, _signal, files = []) {
					const m = message as { to: string; text: string };
					if (socket === undefined || current.state !== 'connected')
						throw new Error('the WhatsApp session is not open');
					const sent = await socket.sendMessage(m.to, { text: m.text });
					// each attachment follows as its own message: a picture as an image, anything else a document with its file name
					for (const f of files)
						await socket.sendMessage(
							m.to,
							f.mime.startsWith('image/')
								? { image: Buffer.from(f.bytes), mimetype: f.mime }
								: { document: Buffer.from(f.bytes), mimetype: f.mime, fileName: f.name }
						);
					const id = sent?.key?.id;
					if (typeof id !== 'string') throw new Error('WhatsApp returned no message id');
					return { providerId: id };
				},
				async typing(_channel, to) {
					if (socket !== undefined && current.state === 'connected')
						await socket.sendPresenceUpdate?.('composing', to);
				}
			};
		}
	};
}

/** WhatsApp's `WebMessageInfo.Status`: ERROR, PENDING, SERVER_ACK, DELIVERY_ACK, READ, PLAYED. */
const RECEIPT: { readonly [status: number]: DeliveryReport['kind'] } = {
	0: 'failed',
	2: 'sent',
	3: 'delivered',
	4: 'read',
	5: 'read'
};
/** One `messages.update` entry on a message we sent → its delivery report, or `null` (someone else's message, no status change). */
export function baileysReceipt(u: unknown): { providerId: string; report: DeliveryReport } | null {
	if (!isObj(u) || !isObj(u['key']) || u['key']['fromMe'] !== true || !isObj(u['update']))
		return null;
	const id = str(u['key']['id']),
		status = u['update']['status'];
	const kind = typeof status === 'number' ? RECEIPT[status] : undefined;
	if (id === null || kind === undefined) return null;
	return {
		providerId: id,
		report: {
			kind,
			at: new Date().toISOString(),
			provider: 'baileys',
			...(kind === 'failed' ? { reason: 'WhatsApp reported an error' } : {})
		}
	};
}

/** One Baileys `WAMessage` (read structurally) → the wire message, or `null` (our own echo, a receipt, an empty message). */
export function whatsappMessage(
	msg: unknown,
	self: string | undefined,
	options: { history?: boolean; lid?: string; includeSent?: boolean } = {}
): Obj | null {
	if (
		!isObj(msg) ||
		!isObj(msg['key']) ||
		(msg['key']['fromMe'] === true && options.includeSent !== true)
	)
		return null;
	const key = msg['key'],
		jid = str(key['remoteJid']),
		id = str(key['id']),
		content = msg['message'];
	const ts = Number(msg['messageTimestamp']);
	if (jid === null || id === null || !isObj(content) || !Number.isFinite(ts)) return null;
	const group = jid.endsWith('@g.us');
	const sentAt = new Date(ts * 1000).toISOString();
	const from = {
		handle: group ? (str(key['participant']) ?? jid) : jid,
		name: str(msg['pushName'])?.trim() ?? null
	};
	const base = {
		thread: jid,
		sentAt,
		from,
		group,
		attachments: [],
		...(options.includeSent === true
			? { direction: key['fromMe'] === true ? 'outbound' : 'inbound' }
			: {}),
		...(options.history === true ? { history: true } : {})
	};
	// a sender's revoke tombstones the message; an edit converges its text (the target id is the edited message's)
	const protocol = content['protocolMessage'];
	if (isObj(protocol)) {
		const target = isObj(protocol['key']) ? str(protocol['key']['id']) : null;
		if (target === null) return null;
		if (Number(protocol['type']) === 0)
			return { ...base, id: target, text: '', deleted: true, invocation: 'ambient' };
		if (Number(protocol['type']) !== 14 || !isObj(protocol['editedMessage'])) return null;
		return {
			...base,
			id: target,
			text: whatsappText(protocol['editedMessage']),
			version: sentAt,
			invocation: 'ambient'
		};
	}
	const text = whatsappText(content);
	const context = [
		content['extendedTextMessage'],
		content['imageMessage'],
		content['documentMessage'],
		content['videoMessage']
	].find((x) => isObj(x) && isObj(x['contextInfo'])) as Obj | undefined;
	const info = context?.['contextInfo'] as Obj | undefined;
	// Both of our identities: WhatsApp addresses a linked device by LID in `mentionedJid`, so matching only the phone
	// JID the number prints as reads every real mention as ambient. Either form, with or without a device suffix.
	const ours = [self, options.lid].flatMap((x) => {
		const bare = x?.split(':')[0]?.split('@')[0];
		return bare === undefined || bare === '' ? [] : [bare];
	});
	const isOurs = (j: string): boolean => ours.some((b) => j.startsWith(b));
	const mentioned =
		Array.isArray(info?.['mentionedJid']) &&
		info['mentionedJid'].some((j) => typeof j === 'string' && isOurs(j));
	// a reply to anybody is not a reply to us: only a quote of our own message counts, which `participant` names
	const repliedToUs = typeof info?.['participant'] === 'string' && isOurs(info['participant']);
	return {
		...base,
		id,
		text,
		replyTo: str(info?.['stanzaId']),
		invocation: !group ? 'direct' : mentioned ? 'mention' : repliedToUs ? 'reply' : 'ambient'
	};
}
function whatsappText(content: Obj): string {
	for (const [k, f] of [
		['conversation', null],
		['extendedTextMessage', 'text'],
		['imageMessage', 'caption'],
		['videoMessage', 'caption'],
		['documentMessage', 'caption']
	] as const) {
		const v = f === null ? content[k] : isObj(content[k]) ? content[k][f] : undefined;
		if (typeof v === 'string') return v;
	}
	return '';
}

/** The real socket. Baileys is an optional dependency, so it is imported by name at first use. */
export const baileysSocket: WaOpen = async (authDir, syncOnly, credentialsChanged = () => {}) => {
	const name = '@whiskeysockets/baileys';
	type Baileys = {
		default: (o: object) => WaSocket;
		useMultiFileAuthState(d: string): Promise<{ state: { creds: object; keys: { set(data: object): Promise<void> } }; saveCreds(): Promise<void> }>;
		fetchLatestWaWebVersion(): Promise<{ version: number[] }>;
		Browsers: { ubuntu(n: string): unknown };
		downloadMediaMessage(m: unknown, t: 'buffer', o: object): Promise<Buffer>;
	};
	const b = (await import(name)) as Baileys;
	const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
	const setKeys = state.keys.set.bind(state.keys);
	let authWrites = Promise.resolve();
	state.keys.set = (data) => {
		authWrites = authWrites.catch(() => undefined).then(async () => {
			await setKeys(data);
			credentialsChanged();
		});
		return authWrites;
	};
	const { version } = await b.fetchLatestWaWebVersion();
	const quiet = {
		level: 'silent',
		child: () => quiet,
		trace() {},
		debug() {},
		info() {},
		warn() {},
		error: (m: unknown) => console.error('[baileys]', m)
	};
	const socket = b.default({
		version,
		auth: state,
		browser: b.Browsers.ubuntu('Bolt'),
		logger: quiet,
		syncFullHistory: syncOnly === true
	});
	// Baileys writes the files first; the link seals them on the same event, a second later
	socket.ev.on('creds.update', (() => {
		authWrites = authWrites.catch(() => undefined).then(async () => { await saveCreds(); credentialsChanged(); });
		void authWrites.catch((e: unknown) => console.error('[providers] whatsapp auth write failed', e));
	}) as (arg: never) => void);
	return {
		socket,
		flushAuth: () => authWrites,
		async download(message) {
			const content =
				(
					message as {
						message?: {
							[k: string]:
								{ mimetype?: string; fileName?: string; fileLength?: number | string } | undefined;
						};
					}
				).message ?? {};
			const kind = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'].find(
				(k) => content[k] !== undefined
			);
			if (kind === undefined || Number(content[kind]!.fileLength ?? 0) > MEDIA_MAX) return null;
			const bytes = await b.downloadMediaMessage(message, 'buffer', {});
			const mime = content[kind]!.mimetype ?? 'application/octet-stream';
			return {
				bytes: new Uint8Array(bytes),
				mime,
				name: content[kind]!.fileName ?? `whatsapp.${mime.split('/')[1] ?? 'bin'}`
			};
		}
	};
};
