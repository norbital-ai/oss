import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { EffectId, type ConnectorRequest } from '@norbital-ai/bolt-protocol';
import { connectionReader } from '../src/runtime/automations/connection.js';
import { Secrets } from '../src/runtime/secrets/secrets.js';

const connection = {
	baseUrl: 'https://api.example.test/v3',
	authentication: { type: 'header' as const, header: 'X-Api-Key', value: { env: 'API_KEY' } }
};
const vault = (value: string | null) =>
	Secrets.Service.of({
		read: () => Effect.succeed(value),
		status: () => Effect.succeed([]),
		write: () => Effect.void
	});

it('resolves managed authentication and keeps pagination inside the declared connection', async () => {
	const calls: { id: string; input: ConnectorRequest }[] = [];
	const get = connectionReader(EffectId.make('import-year'), connection, {
		execute: (id, input) => {
			calls.push({ id, input });
			return Effect.succeed({
				output: { status: 429, headers: { 'retry-after': '3' }, body: { error: 'rate limit' } }
			});
		}
	});
	const run = (path: string, query: Record<string, string>) =>
		Effect.runPromise(
			get({ path, query }).pipe(Effect.provideService(Secrets.Service, vault('private-key')))
		);
	expect(
		await run('calendars/jurisdiction%40holiday/events', { timeMin: '2027-01-01T00:00:00Z' })
	).toEqual({ status: 429, headers: { 'retry-after': '3' }, body: { error: 'rate limit' } });
	await run('calendars/jurisdiction%40holiday/events', { pageToken: 'a+b/c=' });
	expect(calls.map((call) => call.id)).toEqual([
		'import-year:connection:0',
		'import-year:connection:1'
	]);
	expect(calls[0]?.input).toMatchObject({
		connector: 'http',
		operation: 'http.request',
		input: { method: 'GET', headers: { 'X-Api-Key': 'private-key' } }
	});
	expect(calls[1]?.input.input).toHaveProperty(
		'url',
		'https://api.example.test/v3/calendars/jurisdiction%40holiday/events?pageToken=a%2Bb%2Fc%3D'
	);
});

it('refuses origin replacement and encoded traversal before reading credentials or making requests', async () => {
	let reads = 0;
	const get = connectionReader(EffectId.make('unsafe'), connection, {
		execute: () => {
			throw new Error('network must not run');
		}
	});
	for (const path of [
		'https://attacker.test',
		'//attacker.test',
		'/admin',
		'../admin',
		'%2e%2e/admin',
		'a/%2Fadmin',
		'a/%255cadmin',
		'a\\b',
		'a?key=secret',
		'a#fragment'
	]) {
		const result = await Effect.runPromise(
			Effect.result(get({ path })).pipe(
				Effect.provideService(Secrets.Service, {
					...vault('secret'),
					read: () => {
						reads++;
						return Effect.succeed('secret');
					}
				})
			)
		);
		expect(result._tag, path).toBe('Failure');
	}
	expect(reads).toBe(0);
});

it('refuses undeclared or unset connections and malformed provider responses', async () => {
	let requests = 0;
	const connector = {
		execute: () => {
			requests++;
			return Effect.succeed({ output: { unrelated: true } });
		}
	};
	for (const declared of [undefined, connection]) {
		const get = connectionReader(EffectId.make('missing'), declared, connector);
		await expect(
			Effect.runPromise(
				get({ path: 'events' }).pipe(Effect.provideService(Secrets.Service, vault(null)))
			)
		).rejects.toThrow(/declares no|Configure/);
	}
	expect(requests).toBe(0);
	await expect(
		Effect.runPromise(
			connectionReader(
				EffectId.make('bad'),
				connection,
				connector
			)({ path: 'events' }).pipe(Effect.provideService(Secrets.Service, vault('private-key')))
		)
	).rejects.toThrow('invalid response');
});
