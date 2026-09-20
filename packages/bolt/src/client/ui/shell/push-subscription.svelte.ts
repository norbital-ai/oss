import { Effect, Option, Schema, type Cause } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import type { PushSubscription as PushSubscriptionJson } from '@norbital-ai/bolt-protocol';

/**
 * Whether this browser receives the workspace's pushes, and the one gesture that changes it.
 *
 * Four states, each a fact the browser can be asked for: `unavailable` (no worker, no push API,
 * or a host with no VAPID key), `denied` (the person said no and only the browser's own settings
 * undo that), `off`, `on`. The permission prompt has to follow a tap — iOS refuses it otherwise —
 * so `enable` is only ever called from a click, and `read` is what mounting calls.
 */
type PushStatus = 'unknown' | 'unavailable' | 'denied' | 'off' | 'on';

type PushCommands = Readonly<{
	readonly subscribe: (input: PushSubscriptionJson) => Effect.Effect<unknown, Error>;
	readonly unsubscribe: (input: { readonly endpoint: string }) => Effect.Effect<unknown, Error>;
}>;

/** `PushSubscription.toJSON()` as the runtime stores it; a browser that minted no keys yields none. */
const SubscriptionJson = Schema.Struct({
	endpoint: Schema.NonEmptyString,
	keys: Schema.Struct({ p256dh: Schema.NonEmptyString, auth: Schema.NonEmptyString })
});
const decodeSubscription = Schema.decodeUnknownOption(SubscriptionJson);

// Push implies the worker and the Notification API on every browser that has it.
const supported = (): boolean => typeof window !== 'undefined' && 'PushManager' in window;

const worker = Effect.tryPromise(() => navigator.serviceWorker.ready);
const held = worker.pipe(
	Effect.flatMap((registration) =>
		Effect.tryPromise(() => registration.pushManager.getSubscription())
	)
);

export class PushSubscriptionState {
	status = $state<PushStatus>('unknown');
	error = $state<string | undefined>(undefined);
	readonly #commands: PushCommands;
	readonly #publicKey: () => string | null | undefined;

	constructor(commands: PushCommands, publicKey: () => string | null | undefined) {
		this.#commands = commands;
		this.#publicKey = publicKey;
	}

	readonly #run = (work: Effect.Effect<PushStatus, Cause.UnknownError | Error>): Promise<void> =>
		Effect.runPromise(
			work.pipe(
				Effect.tap((status) => Effect.sync(() => (this.status = status))),
				Effect.catch((cause) => Effect.sync(() => (this.error = getErrorMessage(cause)))),
				Effect.asVoid
			)
		);

	/** What the browser already holds; called once the host's key is known. */
	readonly read = (): Promise<void> =>
		this.#run(
			!supported() || !this.#publicKey()
				? Effect.succeed('unavailable' as const)
				: Notification.permission === 'denied'
					? Effect.succeed('denied' as const)
					: held.pipe(Effect.map((existing) => (existing === null ? 'off' : 'on')))
		);

	/** From a tap only. */
	readonly enable = (): Promise<void> => {
		const key = this.#publicKey();
		if (!supported() || !key) return Promise.resolve();
		this.error = undefined;
		return this.#run(
			Effect.tryPromise(() => Notification.requestPermission()).pipe(
				Effect.flatMap((permission) =>
					permission !== 'granted'
						? Effect.succeed('denied' as const)
						: worker.pipe(
								Effect.flatMap((registration) =>
									Effect.tryPromise(() => registration.pushManager.getSubscription()).pipe(
										Effect.flatMap((existing) =>
											existing !== null
												? Effect.succeed(existing)
												: Effect.tryPromise(() =>
														registration.pushManager.subscribe({
															userVisibleOnly: true,
															applicationServerKey: key
														})
													)
										)
									)
								),
								Effect.flatMap((subscription) =>
									Option.match(decodeSubscription(subscription.toJSON()), {
										onNone: () =>
											Effect.fail(new Error('The browser minted a push subscription without keys')),
										onSome: (json) => this.#commands.subscribe(json)
									})
								),
								Effect.as('on' as const)
							)
				)
			)
		);
	};

	readonly disable = (): Promise<void> => {
		if (!supported()) return Promise.resolve();
		this.error = undefined;
		return this.#run(
			held.pipe(
				Effect.flatMap((subscription) =>
					subscription === null
						? Effect.void
						: this.#commands
								.unsubscribe({ endpoint: subscription.endpoint })
								.pipe(Effect.flatMap(() => Effect.tryPromise(() => subscription.unsubscribe())))
				),
				Effect.as('off' as const)
			)
		);
	};
}
