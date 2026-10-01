// Local fake IMAP and SMTP servers for the mailbox channel's tests: plain TCP on 127.0.0.1, just enough of each
// protocol for imapflow and nodemailer (IMAP: LOGIN, AUTHENTICATE XOAUTH2, SELECT/EXAMINE, UID FETCH, UID SEARCH, IDLE;
// SMTP: EHLO with DSN, AUTH, MAIL/RCPT with their parameters, DATA). Never a real mailbox.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

const listen = async (server: Server) => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as AddressInfo).port;
};
const closer = (server: Server, sockets: Set<Socket>) => async () => {
	for (const s of sockets) s.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
};

/** `accept`: whether a login is good (`pass` for LOGIN/PLAIN, `token` for XOAUTH2). */
export async function fakeImap(o: { accept: (user: string, secret: { pass?: string; token?: string }) => boolean; validity?: number }) {
	const messages: { uid: number; raw: string }[] = [];
	const idlers = new Set<(n: number) => void>();
	const sockets = new Set<Socket>();
	const logins: string[] = [];
	const fetches: number[] = [];
	let next = 1;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => undefined);
		let buffer = '', idling: { tag: string } | null = null, sasl: { tag: string; mech: string } | null = null;
		const say = (s: string) => { if (!socket.destroyed) socket.write(`${s}\r\n`); };
		say('* OK [CAPABILITY IMAP4rev1 IDLE UIDPLUS SASL-IR AUTH=PLAIN AUTH=XOAUTH2] fake ready');
		const uidsOf = (set: string): number[] => {
			const max = messages.at(-1)?.uid ?? 0;
			return messages.map((m) => m.uid).filter((uid) => set.split(',').some((part) => {
				const [a, b = a] = part.split(':').map((x) => x === '*' ? max : Number(x));
				const [lo, hi] = [Math.min(a!, b!), Math.max(a!, b!)];
				return uid >= lo && uid <= hi;
			}));
		};
		const command = (line: string) => {
			if (sasl !== null) { const { tag, mech } = sasl; sasl = null; return command(`${tag} AUTHENTICATE ${mech} ${line}`); }
			if (idling !== null) {
				if (line.trim().toUpperCase() === 'DONE') { say(`${idling.tag} OK IDLE done`); idling = null; }
				return;
			}
			const [tag = '*', verb = '', ...rest] = line.split(' ');
			const args = rest.join(' ');
			switch (verb.toUpperCase()) {
				case 'CAPABILITY': say('* CAPABILITY IMAP4rev1 IDLE UIDPLUS SASL-IR AUTH=PLAIN AUTH=XOAUTH2'); return say(`${tag} OK done`);
				case 'LOGIN': {
					const [user = '', pass = ''] = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'));
					logins.push(`LOGIN ${user}`);
					return o.accept(user, { pass }) ? say(`${tag} OK logged in`) : say(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
				}
				case 'AUTHENTICATE': {
					const [mech = '', initial = ''] = args.split(' ');
					if (initial === '') { sasl = { tag, mech }; return say('+ '); }
					const decoded = Buffer.from(initial, 'base64').toString();
					if (mech.toUpperCase() === 'PLAIN') {
						const [, user = '', pass = ''] = decoded.split('\u0000');
						logins.push(`PLAIN ${user}`);
						return o.accept(user, { pass }) ? say(`${tag} OK authenticated`) : say(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials`);
					}
					const user = /user=([^\x01]*)/.exec(decoded)?.[1] ?? '', token = /auth=Bearer ([^\x01]*)/.exec(decoded)?.[1] ?? '';
					logins.push(`XOAUTH2 ${user} ${token}`);
					return o.accept(user, { token }) ? say(`${tag} OK authenticated`) : say(`${tag} NO [AUTHENTICATIONFAILED] invalid token`);
				}
				case 'SELECT': case 'EXAMINE': {
					if (!/INBOX|Support/i.test(args)) return say(`${tag} NO no such mailbox`);
					// a selected session hears new mail at once (servers do while idling; this fake need not wait for IDLE)
					const notify = (n: number) => say(`* ${n} EXISTS`);
					idlers.add(notify);
					socket.on('close', () => idlers.delete(notify));
					say(`* ${messages.length} EXISTS`);
					say('* FLAGS (\\Seen \\Answered)');
					say(`* OK [UIDVALIDITY ${o.validity ?? 7}] ok`);
					say(`* OK [UIDNEXT ${next}] ok`);
					return say(`${tag} OK [${verb.toUpperCase() === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done`);
				}
				case 'UID': {
					const [sub = '', ...more] = args.split(' ');
					if (sub.toUpperCase() === 'FETCH') {
						const found = uidsOf(more[0] ?? '');
						fetches.push(found.length);
						for (const uid of found) {
							const m = messages.find((x) => x.uid === uid)!, seq = messages.indexOf(m) + 1;
							say(`* ${seq} FETCH (UID ${uid} BODY[] {${Buffer.byteLength(m.raw)}}\r\n${m.raw})`);
						}
						return say(`${tag} OK fetched`);
					}
					if (sub.toUpperCase() === 'SEARCH') {
						const id = /HEADER Message-ID "?([^"\s]+)"?/i.exec(args)?.[1];
						const range = /UID ([\d:*]+)/i.exec(more.join(' '))?.[1];
						const hits = range !== undefined ? uidsOf(range) : messages.filter((m) => id !== undefined && m.raw.toLowerCase().includes(`message-id: ${id.toLowerCase()}`)).map((m) => m.uid);
						say(`* SEARCH${hits.map((h) => ` ${h}`).join('')}`);
						return say(`${tag} OK searched`);
					}
					return say(`${tag} OK`);
				}
				case 'IDLE': {
					idling = { tag };
					return say('+ idling');
				}
				case 'LOGOUT': say('* BYE'); say(`${tag} OK bye`); socket.end(); return;
				default: return say(`${tag} OK`); // NOOP, ID, ENABLE, NAMESPACE, LIST …: nothing this fake needs to answer
			}
		};
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			let at: number;
			while ((at = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 2); command(line); }
		});
	});
	const port = await listen(server);
	return {
		port, logins, fetches,
		/** A message lands in the folder; IDLE clients hear EXISTS. */
		deliver(raw: string) {
			messages.push({ uid: next++, raw: raw.replace(/\r?\n/g, '\r\n') });
			for (const n of idlers) n(messages.length);
		},
		close: closer(server, sockets),
	};
}

/** Replies by recipient: `full@` 452 4.2.2 (retry), `nobody@` 550 5.1.1 (permanent); everyone else 250. */
export async function fakeSmtp(o: { accept?: (user: string, secret: string) => boolean } = {}) {
	const sent: { mailFrom: string; rcpts: string[]; data: string }[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => undefined);
		let buffer = '', data: string[] | null = null, cur = { mailFrom: '', rcpts: [] as string[] }, authing = false;
		const say = (s: string) => { if (!socket.destroyed) socket.write(`${s}\r\n`); };
		say('220 fake.smtp ESMTP');
		const line = (l: string) => {
			if (data !== null) {
				if (l === '.') { sent.push({ ...cur, data: data.join('\r\n') }); data = null; cur = { mailFrom: '', rcpts: [] }; return say('250 2.0.0 queued'); }
				data.push(l.startsWith('..') ? l.slice(1) : l);
				return;
			}
			if (authing) { authing = false; return say('235 2.7.0 ok'); }
			const upper = l.toUpperCase();
			if (upper.startsWith('EHLO')) return say('250-fake.smtp\r\n250-DSN\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN XOAUTH2');
			if (upper.startsWith('AUTH PLAIN')) {
				const [, user = '', pass = ''] = Buffer.from(l.split(' ')[2] ?? '', 'base64').toString().split('\u0000');
				return o.accept === undefined || o.accept(user, pass) ? say('235 2.7.0 ok') : say('535 5.7.8 bad credentials');
			}
			if (upper.startsWith('AUTH XOAUTH2')) {
				const decoded = Buffer.from(l.split(' ')[2] ?? '', 'base64').toString();
				const user = /user=([^\x01]*)/.exec(decoded)?.[1] ?? '', token = /auth=Bearer ([^\x01]*)/.exec(decoded)?.[1] ?? '';
				return o.accept === undefined || o.accept(user, token) ? say('235 2.7.0 ok') : say('535 5.7.8 bad token');
			}
			if (upper.startsWith('AUTH')) { authing = true; return say('334 '); }
			if (upper.startsWith('MAIL FROM')) { cur.mailFrom = l; return say('250 2.1.0 ok'); }
			if (upper.startsWith('RCPT TO')) {
				if (l.includes('full@')) return say('452 4.2.2 Mailbox full, try again later');
				if (l.includes('nobody@')) return say('550 5.1.1 <nobody@else.example>: Recipient address rejected');
				cur.rcpts.push(l);
				return say('250 2.1.5 ok');
			}
			if (upper === 'DATA') { data = []; return say('354 go ahead'); }
			if (upper === 'QUIT') { say('221 bye'); socket.end(); return; }
			return say('250 ok'); // RSET, NOOP
		};
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			let at: number;
			while ((at = buffer.indexOf('\r\n')) >= 0) { const l = buffer.slice(0, at); buffer = buffer.slice(at + 2); line(l); }
		});
	});
	const port = await listen(server);
	return { port, sent, close: closer(server, sockets) };
}
