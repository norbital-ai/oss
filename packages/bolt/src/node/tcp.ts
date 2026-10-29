/// <reference types="node" />
// Outbound TCP/TLS (`TcpPort`) over Node's sockets: the destination checked first (the public guard pins the resolved
// addresses; the test kit's reaches this machine only), TLS verified against the endpoint's name.
import { Effect } from 'effect';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { FacilityFailure } from '../decl/errors.ts';
import type { TcpEndpoint, TcpPort, TcpSocket } from '../engine/contracts.ts';
import { pinnedLookup, publicDestination, type Address } from './net.ts';

const failed = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'the connection failed'
	});

/** `socket` once it emits `ready`; an error or `signal` destroys it. */
const opened = <S extends Socket>(
	socket: S,
	ready: 'connect' | 'secureConnect',
	signal: AbortSignal
) =>
	new Promise<S>((resolve, reject) => {
		const done = () => {
			socket.off(ready, ok).off('error', fail);
			signal.removeEventListener('abort', abort);
		};
		const ok = () => {
			done();
			resolve(socket);
		};
		const fail = (error: Error) => {
			done();
			socket.destroy();
			reject(failed(error));
		};
		const abort = () => fail(new Error('The connection was aborted.'));
		socket.once(ready, ok).once('error', fail);
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
	});

const secure = (socket: Socket, endpoint: TcpEndpoint, signal: AbortSignal) => {
	const servername = endpoint.servername ?? endpoint.host;
	return opened(
		tlsConnect({
			socket,
			host: servername,
			...(isIP(servername) === 0 ? { servername } : {}),
			rejectUnauthorized: true
		}),
		'secureConnect',
		signal
	).then((tls) => web(tls, endpoint));
};

const web = (socket: Socket, endpoint: TcpEndpoint): TcpSocket => {
	let detach = () => {},
		handedOver = false;
	// a TLS socket made over this one reports its errors; the plain one must not crash the process meanwhile
	socket.on('error', () => {});
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			let ended = false;
			const end = (error?: Error) => {
				if (ended) return;
				ended = true;
				socket.off('data', data).off('end', closed).off('error', end);
				if (error === undefined) controller.close();
				else controller.error(failed(error));
			};
			const closed = () => end();
			const data = (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
				if ((controller.desiredSize ?? 0) <= 0) socket.pause();
			};
			socket.on('data', data).once('end', closed).on('error', end);
			detach = () => {
				socket.pause();
				end();
			};
		},
		pull: () => void socket.resume(),
		cancel: () => void (handedOver || socket.destroy())
	});
	const writable = new WritableStream<Uint8Array>({
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				socket.write(chunk, (error) => (error == null ? resolve() : reject(failed(error))));
			}),
		close: () => new Promise<void>((resolve) => void socket.end(resolve)),
		abort: () => void socket.destroy()
	});
	return {
		readable,
		writable,
		close: () => Promise.resolve(void socket.destroy()),
		startTls: (signal) => {
			handedOver = true;
			detach();
			return secure(socket, endpoint, signal);
		}
	};
};

type Destination = Effect.Effect<
	{ readonly hostname: string; readonly addresses: readonly Address[] },
	unknown
>;
const tcpOver = (check: (host: string, port: number) => Destination): TcpPort => ({
	connect: (endpoint, signal) =>
		Effect.runPromise(check(endpoint.host, endpoint.port), { signal })
			.then((destination) =>
				opened(
					netConnect({
						host: destination.hostname,
						port: endpoint.port,
						lookup: pinnedLookup(destination.addresses),
						autoSelectFamily: true
					}),
					'connect',
					signal
				)
			)
			.then((socket) => (endpoint.tls ? secure(socket, endpoint, signal) : web(socket, endpoint)))
});

/** Outbound TCP/TLS under the public guard: DNS resolved once, every address public, the checked set pinned. */
export const tcpPort: TcpPort = tcpOver((host, port) => publicDestination(host, port));

const LOOPBACK: Readonly<Record<string, Address>> = {
	localhost: { address: '127.0.0.1', family: 4 },
	'127.0.0.1': { address: '127.0.0.1', family: 4 },
	'::1': { address: '::1', family: 6 }
};
/** Outbound TCP/TLS to this machine only (the test kit's fake servers); any other host is refused. */
export const loopbackTcpPort: TcpPort = tcpOver((host) => {
	const address = LOOPBACK[host];
	return address === undefined
		? Effect.fail(
				new FacilityFailure({
					kind: 'invalid',
					message: 'The test host connects to this machine only.'
				})
			)
		: Effect.succeed({ hostname: address.address, addresses: [address] });
});
