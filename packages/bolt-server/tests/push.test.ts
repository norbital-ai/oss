import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Sql } from '@norbital-ai/host-api';
import type { PushMessage } from '../src/push.ts';
import type webpush from 'web-push';
import { apns, push, type ApnsRequest } from '../src/push.ts';

const message: PushMessage = {
	_tag: 'Push', id: 'durable-notice', title: 'Your report is ready', body: null,
	subscription: { kind: 'web', endpoint: 'https://push.example/device', keys: { p256dh: 'public', auth: 'auth' } },
	link: null, path: '/inbox'
};
const database = () => {
	const statements: Sql[] = [];
	return { statements, db: { write: (statement: Sql) => Effect.sync(() => { statements.push(statement); return { rows: [], affected: 1 }; }) } };
};
const vapid = { public_key: 'public', private_key: 'private' };

describe('durable inbox push transports', () => {
	it.effect('sends the stable notice id and an offline delivery TTL without a page connection', () =>
		Effect.gen(function* () {
			const send = vi.fn<typeof webpush.sendNotification>(async () => ({ statusCode: 201, body: '', headers: { location: 'accepted' } }));
			const { db, statements } = database();
			expect(yield* push(db, vapid, 'https://workspace.example', send).send(message)).toEqual({ provider_id: 'accepted' });
			expect(send).toHaveBeenCalledWith({ endpoint: message.subscription.endpoint, keys: message.subscription.keys }, JSON.stringify({ id: message.id, title: message.title, body: null, path: '/inbox' }),
				{ vapidDetails: { subject: 'https://workspace.example', publicKey: 'public', privateKey: 'private' }, TTL: 86_400 });
			expect(statements).toEqual([]);
		})
	);
	for (const [status, kind] of [[400, 'invalid'], [401, 'invalid'], [404, 'invalid'], [408, 'timeout'], [410, 'invalid'], [429, 'rate_limited'], [503, 'upstream']] as const)
		it.effect(`keeps web push ${status} as ${kind} and forgets only gone endpoints`, () =>
			Effect.gen(function* () {
				const send = vi.fn<typeof webpush.sendNotification>(async () => { throw Object.assign(new Error('push refused'), { statusCode: status }); });
				const { db, statements } = database();
				expect(yield* Effect.flip(push(db, vapid, 'https://workspace.example', send).send(message))).toMatchObject({ kind, status, message: 'push refused' });
				expect(statements).toHaveLength(status === 404 || status === 410 ? 1 : 0);
				if (statements.length > 0) expect(statements[0]).toEqual({ text: 'DELETE FROM bolt_push_subscriptions WHERE endpoint = $1', params: [message.subscription.endpoint] });
			})
		);
	it.effect('keeps a network failure transient and an invalid subscription permanent without attempting it', () =>
		Effect.gen(function* () {
			const send = vi.fn<typeof webpush.sendNotification>(async () => { throw new Error('network down'); });
			const { db } = database(), transport = push(db, vapid, 'https://workspace.example', send);
			expect(yield* Effect.flip(transport.send(message))).toMatchObject({ kind: 'upstream', message: 'network down' });
			expect(yield* Effect.flip(transport.send({ ...message, subscription: { ...message.subscription, keys: {} } }))).toMatchObject({ kind: 'invalid' });
			expect(send).toHaveBeenCalledOnce();
		})
	);
	it.effect('uses a bounded stable APNs collapse id across retries and keeps provider status', () =>
		Effect.gen(function* () {
			const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
			const requests: { headers: Readonly<Record<string, string>>; body: string }[] = [];
			let status = 200;
			const request: ApnsRequest = (_origin, headers, body) => Effect.sync(() => { requests.push({ headers, body }); return { status, body: '{"reason":"ProviderRefusal"}' }; });
			const { db, statements } = database(), transport = apns(db, { TEAM: { key_id: 'KEY', key } }, request);
			const notice: PushMessage = { ...message, subscription: { kind: 'apns', endpoint: 'device-token', keys: { topic: 'ai.norbital.app', environment: 'production', team_id: 'TEAM' } } };
			yield* transport.send(notice);
			for (const [code, kind] of [[408, 'timeout'], [429, 'rate_limited'], [503, 'upstream'], [400, 'invalid'], [410, 'invalid']] as const) {
				status = code;
				expect(yield* Effect.flip(transport.send(notice))).toMatchObject({ kind, status: code });
			}
			const collapse = createHash('sha256').update(message.id).digest('hex');
			for (const sent of requests) {
				expect(sent.headers['apns-collapse-id']).toBe(collapse);
				expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(sent.body)).toMatchObject({ id: message.id, path: '/inbox' });
			}
			expect(collapse).toHaveLength(64);
			expect(statements).toEqual([{ text: 'DELETE FROM bolt_push_subscriptions WHERE endpoint = $1', params: ['device-token'] }]);
			expect(yield* Effect.flip(apns(db, {}, request).send(notice))).toMatchObject({ _tag: 'Unavailable', facility: 'push' });
			expect(requests).toHaveLength(6);
		})
	);
});
