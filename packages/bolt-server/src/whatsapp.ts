// The WhatsApp transport (rule 61, G12 (9)): a paired account over Baileys, one persistent socket owned by this adapter,
// not by an activation (§5.8 facility boundary). Pairing by QR or phone code, reconnect with progress after any drop but a
// logout, logout terminal until the next pairing. Messages go through the engine's `whatsappMessage` codec. Baileys is
// loaded only when a socket opens; tests pass a fake `open`.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { connection, whatsappMessage, type ChannelConnection, type Json, type TransportEvent, type TransportPort } from '@norbital-ai/bolt/engine';

/** The part of a Baileys socket this adapter uses, read structurally. */
export type WaSocket = {
	ev: { on(event: string, listener: (arg: never) => void): void };
	user?: { id: string; lid?: string } | undefined;
	/** The account's LID↔phone map. A group mention names our LID, and `user.lid` is optional and often absent. */
	signalRepository?: { getLIDForPN(pn: string): Promise<string | null> } | undefined;
	sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string | null } } | undefined>;
	requestPairingCode(phone: string): Promise<string>;
	/** A group's metadata; its `subject` is the group chat's name. */
	groupMetadata?(jid: string): Promise<{ subject?: string }>;
	logout(): Promise<void>;
	end(error: Error | undefined): void;
};
/** Opens one socket over the auth directory; `download` fetches a message's media (or `null`). */
export type WaOpen = (authDir: string) => Promise<{ socket: WaSocket; download(message: unknown): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> }>;
export type WaState =
	| { state: 'unpaired' }
	| { state: 'connecting'; attempt: number }
	| { state: 'pairing'; qr: string | null; code: string | null }
	| { state: 'connected'; as: string | null }
	| { state: 'reconnecting'; attempt: number; at: string; detail: string }
	| { state: 'loggedOut'; detail: string };
export type WhatsApp = TransportPort & {
	state(): WaState;
	/** The same state as the shell's one `ChannelConnection` (`connection.ts`), for the connection UI. */
	connection(channel: string): ChannelConnection;
	/** Progress: every state change, in order; returns the unsubscribe. */
	observe(listener: (s: WaState) => void): () => void;
	/** Resumes a stored pairing at activation; an unpaired account waits for `pair`. */
	start(): Promise<void>;
	/** A fresh pairing: a QR, or a code for `phone` (digits, country code first). */
	pair(phone?: string): Promise<void>;
	/** Terminal: the account is unlinked and its credentials removed; only `pair` opens it again. */
	logout(): Promise<void>;
	/** Closes the socket without unlinking (SIGTERM). */
	stop(): void;
};

const LOGGED_OUT = 401; // Baileys `DisconnectReason.loggedOut`
const MEDIA_MAX = 32 * 1024 * 1024;

export function whatsapp(authDir: string, channel: string, open: WaOpen = baileys, backoffMs = (n: number) => Math.min(60_000, 1_000 * 2 ** n)): WhatsApp {
	const sinks = new Set<(e: TransportEvent) => Promise<void>>();
	const listeners = new Set<(s: WaState) => void>();
	let current: WaState = { state: 'unpaired' };
	let socket: WaSocket | undefined, timer: ReturnType<typeof setTimeout> | undefined, stopped = false, attempt = 0;
	const set = (s: WaState) => { current = s; for (const l of listeners) l(s); };
	/** Our own LID, the identity a group mention names. `user.lid` is optional, so it is resolved through the map. */
	let lid: string | undefined;
	const resolveLid = async (s: WaSocket): Promise<void> => {
		const pn = s.user?.id;
		if (pn === undefined) return;
		lid = s.user?.lid ?? await s.signalRepository?.getLIDForPN(pn).catch(() => null) ?? undefined;
	};
	const emit = async (event: TransportEvent) => {
		for (const s of sinks) await s(event).catch((e: unknown) => console.error('[bolt] whatsapp message not stored', e));
	};

	async function connect(phone?: string): Promise<void> {
		clearTimeout(timer);
		set({ state: 'connecting', attempt });
		await mkdir(authDir, { recursive: true });
		const opened = await open(authDir);
		const s = opened.socket;
		socket = s;
		let codeAsked = false;
		const on = <T>(event: string, fn: (x: T) => void) => s.ev.on(event, fn as (arg: never) => void);
		on<{ connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string } } }>('connection.update', (u) => {
			if (socket !== s) return; // a late event from a replaced socket
			if (typeof u.qr === 'string') {
				if (phone !== undefined && !codeAsked) {
					codeAsked = true;
					const qr = u.qr;
					s.requestPairingCode(phone).then((code) => set({ state: 'pairing', qr: null, code }),
						(e: unknown) => { console.error('[bolt] whatsapp pairing code failed; showing the QR', e); set({ state: 'pairing', qr, code: null }); });
				} else if (phone === undefined) set({ state: 'pairing', qr: u.qr, code: null });
			}
			if (u.connection === 'open') { attempt = 0; void resolveLid(s); set({ state: 'connected', as: s.user?.id ?? null }); }
			if (u.connection === 'close') {
				socket = undefined;
				const code = u.lastDisconnect?.error?.output?.statusCode, detail = `${code ?? 'no status'}: ${u.lastDisconnect?.error?.message ?? 'closed'}`;
				if (code === LOGGED_OUT) { void rm(authDir, { recursive: true, force: true }); set({ state: 'loggedOut', detail }); return; }
				if (stopped || current.state === 'loggedOut') return;
				const wait = backoffMs(attempt++);
				set({ state: 'reconnecting', attempt, at: new Date(Date.now() + wait).toISOString(), detail });
				timer = setTimeout(() => void connect().catch((e: unknown) => console.error('[bolt] whatsapp reconnect failed', e)), wait);
			}
		});
		// a group's name, read once per group per socket (the provider's `subject`); a failed read names nothing
		const subjects = new Map<string, Promise<string | null>>();
		const subjectOf = (jid: string) => {
			let got = subjects.get(jid);
			if (got === undefined) subjects.set(jid, got = (s.groupMetadata?.(jid) ?? Promise.resolve<{ subject?: string }>({})).then((g) => g.subject?.trim() || null, () => null));
			return got;
		};
		const deliver = async (messages: readonly unknown[], history: boolean) => {
			for (const raw of messages) {
				const found = whatsappMessage(raw, s.user?.id, { history, ...(lid === undefined ? {} : { lid }) });
				if (found === null) continue;
				const title = found['group'] === true ? await subjectOf(String(found['thread'])) : null;
				const message = title === null ? found : { ...found, title };
				const media = history ? null : await opened.download(raw).catch(() => null);
				// a key distribution or a context stub rides beside a real message with nothing to say: no row for it
				if (found['text'] === '' && media === null && found['deleted'] !== true) continue;
				const bins = media !== null && media.bytes.byteLength <= MEDIA_MAX ? [media.bytes] : [];
				await emit({ kind: 'inbound', channel, message: (bins.length === 0 ? message
					: { ...message, attachments: [{ fileName: media!.name, mimeType: media!.mime, byteLength: media!.bytes.byteLength, bin: 0 }] }) as Json,
					...(bins.length === 0 ? {} : { bins }) });
			}
		};
		on<{ type: string; messages: unknown[] }>('messages.upsert', (p) => { if (p.type === 'notify' || p.type === 'append') void deliver(p.messages, false); });
		on<{ messages: unknown[] }>('messaging-history.set', (p) => void deliver(p.messages, true));
	}

	return {
		state: () => current,
		/** This adapter's state as the shell's one contract, so the shell never learns what a WhatsApp session is. */
		connection: (channel: string): ChannelConnection => {
			switch (current.state) {
				case 'connecting': return connection(channel, 'whatsapp', 'connecting', { detail: `opening the socket (attempt ${current.attempt + 1})` });
				case 'pairing': return connection(channel, 'whatsapp', 'pairing', {
					pairing: current.qr === null
						? { kind: 'code', value: current.code }
						// a phone-less pair asks for a QR; with a phone the provider answers a code, and either is drawn from here
						: { kind: 'qr', value: current.qr }
				});
				case 'connected': return connection(channel, 'whatsapp', 'connected', { pairedAs: current.as, stored: true });
				case 'reconnecting': return connection(channel, 'whatsapp', 'reconnecting', { detail: current.detail, stored: true });
				case 'loggedOut': return connection(channel, 'whatsapp', 'error', { error: current.detail, stored: false });
				default: return connection(channel, 'whatsapp', 'unpaired', { stored: false });
			}
		},
		observe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
		async start() {
			const stored = await readdir(authDir).then((f) => f.includes('creds.json'), () => false);
			if (stored) await connect();
		},
		async pair(phone) {
			if (phone !== undefined && !/^\d{6,15}$/.test(phone)) throw new Error('a pairing phone is digits, country code first');
			stopped = false;
			socket?.end(new Error('re-pairing'));
			socket = undefined;
			await rm(authDir, { recursive: true, force: true });
			attempt = 0;
			await connect(phone);
		},
		async logout() {
			clearTimeout(timer);
			const s = socket;
			socket = undefined;
			await s?.logout().catch(() => undefined);
			s?.end(undefined);
			await rm(authDir, { recursive: true, force: true });
			set({ state: 'loggedOut', detail: 'logged out by an administrator' });
		},
		stop() { stopped = true; clearTimeout(timer); socket?.end(new Error('host stopping')); socket = undefined; },
		async send(_channel, message) {
			const m = message as { to: string; text: string };
			if (socket === undefined || current.state !== 'connected') throw new Error('the WhatsApp session is not open');
			const sent = await socket.sendMessage(m.to, { text: m.text });
			const id = sent?.key?.id;
			if (typeof id !== 'string') throw new Error('WhatsApp returned no message id');
			return { providerId: id };
		},
		subscribe(sink) { sinks.add(sink); return () => { sinks.delete(sink); }; },
	};
}

/** The real socket. Baileys is not a dependency of every install, so it is imported by name at first use. A host wraps it
 * to observe the socket (e.g. to persist the auth directory on `creds.update`). */
export const baileys: WaOpen = async (authDir) => {
	const name = '@whiskeysockets/baileys';
	type Baileys = { default: (o: object) => WaSocket; useMultiFileAuthState(d: string): Promise<{ state: object; saveCreds(): Promise<void> }>;
		fetchLatestWaWebVersion(): Promise<{ version: number[] }>; Browsers: { ubuntu(n: string): unknown };
		downloadMediaMessage(m: unknown, t: 'buffer', o: object): Promise<Buffer> };
	const b = await import(name) as Baileys;
	const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
	const { version } = await b.fetchLatestWaWebVersion();
	const quiet = { level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error: (m: unknown) => console.error('[baileys]', m) };
	const socket = b.default({ version, auth: state, browser: b.Browsers.ubuntu('Bolt'), logger: quiet, syncFullHistory: false });
	socket.ev.on('creds.update', (() => void saveCreds()) as (arg: never) => void);
	return {
		socket,
		async download(message) {
			const content = (message as { message?: { [k: string]: { mimetype?: string; fileName?: string; fileLength?: number | string } | undefined } }).message ?? {};
			const kind = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'].find((k) => content[k] !== undefined);
			if (kind === undefined || Number(content[kind]!.fileLength ?? 0) > MEDIA_MAX) return null;
			const bytes = await b.downloadMediaMessage(message, 'buffer', {});
			const mime = content[kind]!.mimetype ?? 'application/octet-stream';
			return { bytes: new Uint8Array(bytes), mime, name: content[kind]!.fileName ?? `whatsapp.${mime.split('/')[1] ?? 'bin'}` };
		},
	};
};
