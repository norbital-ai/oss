import { createTransport } from 'nodemailer';
import type { SocketOptions } from 'nodemailer/lib/mailer';
import { createStreamsTransport } from 'imapflow';
import { Effect } from 'effect';
import type { OutboundAttachment, TcpSocket } from '@norbital-ai/bolt/engine';
import { ProviderRefused } from '../errors.ts';
import {
	mailCall,
	streamsSocket,
	type Login,
	type Mailbox,
	type MailNet,
	type Server,
	type Wire
} from './model.ts';

const msgid = (value: string | undefined): value is string =>
	value !== undefined && /^<[^<>\s]+>$/.test(value);

const encoder = new TextEncoder();
/**
 * RFC 3207's cleartext part over the port (greeting, EHLO, STARTTLS), then TLS through the port. nodemailer speaks over
 * the TLS socket as if the greeting had come over it, and opens its session with a fresh EHLO; anything the server sent
 * after its 220 is discarded.
 */
const startTls = async (plain: TcpSocket, name: string, signal: AbortSignal): Promise<TcpSocket> => {
	const reader = plain.readable.getReader(),
		writer = plain.writable.getWriter(),
		decoder = new TextDecoder();
	let buffered = '';
	const expect = async (code: string, command?: string) => {
		if (command !== undefined) await writer.write(encoder.encode(`${command}\r\n`));
		let text = '';
		for (;;) {
			const end = buffered.indexOf('\n');
			if (end < 0) {
				const { done, value } = await reader.read();
				if (done) throw new Error('The SMTP server closed the connection before STARTTLS.');
				buffered += decoder.decode(value, { stream: true });
				continue;
			}
			const line = buffered.slice(0, end + 1);
			buffered = buffered.slice(end + 1);
			text += line;
			if (line[3] !== '-') break;
		}
		if (!text.startsWith(code))
			throw Object.assign(new Error(text.trim()), {
				responseCode: Number(text.slice(0, 3)),
				response: text.trim()
			});
		return text;
	};
	const greeting = await expect('220');
	if (!/^250[ -]STARTTLS\b/im.test(await expect('250', `EHLO ${name}`)))
		throw new Error('The SMTP server does not offer STARTTLS.');
	await expect('220', 'STARTTLS');
	reader.releaseLock();
	writer.releaseLock();
	const secure = await plain.startTls(signal);
	return {
		readable: secure.readable.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				start: (controller) => controller.enqueue(encoder.encode(greeting))
			})
		),
		writable: secure.writable,
		close: () => secure.close(),
		startTls: (again) => secure.startTls(again)
	};
};

/** A connection to `server` through the port: TLS on 465, STARTTLS elsewhere, cleartext only when `net.plain`. */
const connect = async (server: Server, name: string, net: MailNet, signal: AbortSignal) => {
	const socket = await net.tcp.connect(
		{ host: server.host, port: server.port, tls: !net.plain && server.port === 465 },
		signal
	);
	return net.plain || server.port === 465
		? socket
		: startTls(socket, name, signal).catch((error: unknown) =>
				socket.close().then(() => Promise.reject(error))
			);
};

export const smtp = (box: Mailbox, auth: Login, net: MailNet) =>
	Effect.gen(function* () {
		if (box.smtp === undefined)
			return yield* Effect.fail(
				new ProviderRefused({
					message: 'This mailbox only synchronizes messages.',
					permanent: true
				})
			);
		const server = box.smtp,
			name = box.address.slice(box.address.lastIndexOf('@') + 1);
		const signal = yield* Effect.abortSignal;
		const sockets = new Set<TcpSocket>();
		return yield* Effect.acquireRelease(
			Effect.sync(() =>
				createTransport({
					host: server.host,
					port: server.port,
					getSocket: (_options, callback) => {
						connect(server, name, net, signal).then(
							(socket) => {
								sockets.add(socket);
								const connection = createStreamsTransport({
									open: () => streamsSocket(Promise.resolve(socket))
								}).connect({ host: server.host, port: server.port, secure: !net.plain }, () => {});
								// nodemailer drives any Duplex with net.Socket's timeouts (its type says net.Socket), as imapflow's streams
								// transport makes one; `secured`: TLS is already up, so nodemailer starts none
								const answer: SocketOptions = { secured: !net.plain };
								callback(null, Object.assign(answer, { connection }));
							},
							(error: unknown) =>
								callback(error instanceof Error ? error : new Error('SMTP connection failed.'))
						);
					},
					secure: !net.plain,
					ignoreTLS: net.plain,
					connectionTimeout: 30000,
					greetingTimeout: 30000,
					socketTimeout: 60000,
					auth:
						auth.accessToken === undefined
							? { user: auth.user, pass: auth.pass ?? '' }
							: { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
				})
			),
			(transport) =>
				Effect.promise(() => Promise.all([...sockets].map((socket) => socket.close()))).pipe(
					Effect.ensuring(Effect.sync(() => transport.close()))
				)
		);
	});

export const submit = (
	box: Mailbox,
	auth: Login,
	net: MailNet,
	wire: Wire,
	mid: string,
	headers: Record<string, string> = {},
	files: readonly OutboundAttachment[] = []
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const transport = yield* smtp(box, auth, net);
			const inReplyTo = msgid(wire.inReplyTo) ? wire.inReplyTo : undefined,
				references = (wire.references ?? []).filter(msgid);
			yield* mailCall(`SMTP ${box.smtp?.host}`, () =>
				transport.sendMail({
					from: { name: box.fromName ?? '', address: box.address },
					to: [...wire.to],
					...(wire.cc === undefined ? {} : { cc: [...wire.cc] }),
					subject: wire.subject,
					...(wire.text === undefined ? {} : { text: wire.text }),
					...(wire.html === undefined ? {} : { html: wire.html }),
					messageId: mid,
					headers,
					...(inReplyTo === undefined ? {} : { inReplyTo }),
					...(references.length === 0 ? {} : { references }),
					...(files.length === 0
						? {}
						: {
								attachments: files.map((file) => ({
									filename: file.name,
									contentType: file.mime,
									content: Buffer.from(file.bytes)
								}))
							}),
					dsn: {
						id: wire.id,
						return: 'headers',
						notify: ['success', 'failure', 'delay'],
						recipient: box.address
					}
				})
			);
		})
	);
