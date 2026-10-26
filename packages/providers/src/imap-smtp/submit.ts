import { createTransport } from 'nodemailer';
import { Effect, FiberSet, Scope } from 'effect';
import type { OutboundAttachment } from '@norbital-ai/bolt/engine';
import { connectPublic } from '@norbital-ai/bolt/node';
import type { Socket } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { ProviderRefused } from '../errors.ts';
import { mailCall, type Login, type Mailbox, type Wire } from './model.ts';

const msgid = (value: string | undefined): value is string =>
	value !== undefined && /^<[^<>\s]+>$/.test(value);

export const smtp = (box: Mailbox, auth: Login, plain: boolean) =>
	Effect.gen(function* () {
		if (box.smtp === undefined)
			return yield* Effect.fail(
				new ProviderRefused({
					message: 'This mailbox only synchronizes messages.',
					permanent: true
				})
			);
		const server = box.smtp;
		const scope = yield* Scope.Scope;
		const run = yield* FiberSet.makeRuntimePromise();
		return yield* Effect.acquireRelease(
			Effect.sync(() =>
				createTransport({
					host: server.host,
					port: server.port,
					servername: server.host,
					tls: {
						servername: server.host,
						rejectUnauthorized: true,
						checkServerIdentity: (_hostname, certificate) =>
							checkServerIdentity(server.host, certificate)
					},
					getSocket: (
						_options: unknown,
						callback: (error: Error | null, answer?: { connection: Socket }) => void
					) => {
						void run(
							connectPublic(server.host, server.port).pipe(
								Effect.provideService(Scope.Scope, scope)
							)
						).then(
							(connection) => callback(null, { connection }),
							(error: unknown) =>
								callback(error instanceof Error ? error : new Error('SMTP connection failed.'))
						);
					},
					secure: !plain && server.port === 465,
					requireTLS: !plain && server.port !== 465,
					ignoreTLS: plain,
					connectionTimeout: 30000,
					greetingTimeout: 30000,
					socketTimeout: 60000,
					auth:
						auth.accessToken === undefined
							? { user: auth.user, pass: auth.pass ?? '' }
							: { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
				})
			),
			(transport) => Effect.sync(() => transport.close())
		);
	});

export const submit = (
	box: Mailbox,
	auth: Login,
	plain: boolean,
	wire: Wire,
	mid: string,
	headers: Record<string, string> = {},
	files: readonly OutboundAttachment[] = []
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const transport = yield* smtp(box, auth, plain);
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
