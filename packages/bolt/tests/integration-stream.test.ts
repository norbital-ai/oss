import { afterEach, expect, it, vi } from '@effect/vitest';
import { Effect, Fiber, Queue, Stream } from 'effect';
import { integrationClients } from '../src/page/integrations.ts';
import type { InstanceStatus } from '../src/protocol/instance-status.ts';

afterEach(() => vi.unstubAllGlobals());

it.live(
	'shares one scoped status socket across instances and closes only after the last watcher',
	() =>
		Effect.gen(function* () {
			const opened: Source[] = [];
			class Source {
				onmessage: ((event: MessageEvent<string>) => void) | null = null;
				onerror: (() => void) | null = null;
				closed = false;
				readonly url: string;
				constructor(url: string) {
					this.url = url;
					opened.push(this);
				}
				close() {
					this.closed = true;
				}
				send(instance: string) {
					const status: InstanceStatus = {
						instance,
						integration: 'email',
						driver: 'email',
						state: 'pairing',
						stored: true,
						pairing: { kind: 'oauth', value: `https://sign-in.example/${instance}` }
					};
					this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(status) }));
				}
			}
			vi.stubGlobal('EventSource', Source);
			const clients = integrationClients({ base: '/tenant/__bolt/integrations/' });
			const received = yield* Queue.unbounded<InstanceStatus>();
			const mail = yield* clients('mail')
				.watch()
				.pipe(
					Stream.runForEach((status) => Queue.offer(received, status)),
					Effect.forkScoped
				);
			const phone = yield* clients('phone')
				.watch()
				.pipe(
					Stream.runForEach((status) => Queue.offer(received, status)),
					Effect.forkScoped
				);
			const calendar = yield* clients('calendar')
				.watch()
				.pipe(
					Stream.runForEach((status) => Queue.offer(received, status)),
					Effect.forkScoped
				);
			yield* Effect.promise(() => vi.waitFor(() => expect(opened).toHaveLength(1)));
			const source = opened[0];
			if (source === undefined) throw new Error('Missing shared integration socket');
			expect(source.url).toBe('/tenant/__bolt/integrations?stream=1');
			for (const instance of ['mail', 'phone', 'calendar']) source.send(instance);
			expect((yield* Queue.take(received)).instance).toBe('mail');
			expect((yield* Queue.take(received)).instance).toBe('phone');
			expect((yield* Queue.take(received)).instance).toBe('calendar');
			yield* Fiber.interrupt(mail);
			expect(source.closed).toBe(false);
			yield* Fiber.interrupt(phone);
			expect(source.closed).toBe(false);
			source.send('calendar');
			expect((yield* Queue.take(received)).instance).toBe('calendar');
			yield* Fiber.interrupt(calendar);
			expect(source.closed).toBe(true);
		}).pipe(Effect.scoped)
);
