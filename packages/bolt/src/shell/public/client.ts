import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, type Schema } from 'effect';
import { hydrate, mount, tick, unmount, type Component } from 'svelte';
import { mountEdge } from '@norbital-ai/ui/effect';
import type { Json } from '../../decl/values.ts';
import { createBolt, type Bolt, type BoltConfig } from '../../page/bolt.ts';
import { storedFileUrl } from '../../page/file-ref.ts';
import { awaitDevice, resolveDevice, type DeviceApi } from '../../page/device.ts';
import {
	decodePublicHydration,
	PublicHydrationFailure,
	PUBLIC_HYDRATION_ID,
	type PublicBoot
} from '../../protocol/public-page.ts';
import Turnstile from '../auth/Turnstile.svelte';
import type { ChallengeQueue } from '../runtime.ts';
import { HEADERS, PATHS } from '../../protocol/wire.ts';

export { attach, fork, run } from '@norbital-ai/ui/effect';
export { resolveDevice, type DeviceApi } from '../../page/device.ts';
export { fileRef } from '../../page/file-ref.ts';
export { frameworkText } from '../i18n.ts';

type PublicClient = Bolt & {
	readonly org: { readonly name: string; readonly logo: string | null };
	readonly device: DeviceApi;
	href(app: string, page?: string, record?: { model: string; id: string }): string;
};
let current: PublicClient | null = null;
const client = (): PublicClient => {
	if (current === null) throw new Error('$bolt was read before public page hydration.');
	return current;
};
/** This browser facade has no dependency on the internal shell, Norbius, Studio or app sessions. */
export const bolt: Omit<PublicClient, 'describe'> & {
	readonly describe: PublicClient['describe'];
} = {
	get aggregate() {
		return client().aggregate;
	},
	get history() {
		return client().history;
	},
	get query() {
		return client().query;
	},
	act: (...args) => client().act(...args),
	recordCapabilities: (...args) => client().recordCapabilities(...args),
	decode: (...args) => client().decode(...args),
	get describe() {
		return client().describe;
	},
	options: (...args) => client().options(...args),
	start: (...args) => client().start(...args),
	clock: (...args) => client().clock(...args),
	convert: (...args) => client().convert(...args),
	observe: (...args) => client().observe(...args),
	upload: (...args) => client().upload(...args),
	fileUrl: (...args) => client().fileUrl(...args),
	get approvals() {
		return client().approvals;
	},
	get restore() {
		return client().restore;
	},
	get session() {
		return client().session;
	},
	get actor() {
		return client().actor;
	},
	get locale() {
		return client().locale;
	},
	t: (...args) => client().t(...args),
	get closed() {
		return client().closed;
	},
	get sync() {
		return client().sync;
	},
	get org() {
		return client().org;
	},
	get device() {
		return client().device;
	},
	href: (...args) => client().href(...args)
};

const scopedFetch =
	(
		boot: PublicBoot,
		challenge: ChallengeQueue | null,
		fetch: typeof globalThis.fetch
	): typeof globalThis.fetch =>
	(input, init) => {
		const request = new Request(
			typeof input === 'string' ? new URL(input, location.href) : input,
			init
		);
		const url = new URL(request.url);
		const path = url.pathname.slice(boot.base.length);
		if (url.origin !== location.origin || !path.startsWith('/__bolt/')) return fetch(request);
		const headers = new Headers(request.headers);
		if (boot.visitor !== null && boot.kiosk === null) headers.set('Bolt-App', boot.visitor.app);
		if (boot.kiosk !== null) headers.set(HEADERS.kiosk, boot.kiosk);
		const challenged =
			challenge !== null &&
			((request.method === 'POST' && path === PATHS.act) ||
				(request.method === 'PUT' && path.startsWith(PATHS.files)));
		return (
			challenged
				? Effect.runPromise(challenge.take, { signal: request.signal })
				: Promise.resolve(null)
		).then((token) => {
			if (token !== null) headers.set(HEADERS.challenge, token);
			return fetch(new Request(request, { headers }));
		});
	};

/** Hydrates the same wrapper and decoded props the isolated server rendered; navigation stays document based. */
export const hydratePublicPage = <D>(
	component: Component<{ data: D; boot: PublicBoot }>,
	codec: Schema.Codec<D, Json>,
	route: string,
	options: {
		readonly fetch?: typeof globalThis.fetch;
		readonly openStream?: BoltConfig['openStream'];
	} = {}
) =>
	Effect.gen(function* () {
		const target = document.getElementById('bolt');
		const text = document.getElementById(PUBLIC_HYDRATION_ID)?.textContent;
		const release = document.querySelector('meta[name="bolt-release"]')?.getAttribute('content');
		if (
			target === null ||
			text === undefined ||
			text === null ||
			release === undefined ||
			release === null
		)
			return yield* new PublicHydrationFailure({
				reason: 'Public page hydration metadata is missing.'
			});
		const props = yield* decodePublicHydration(text, codec, { route, release });
		yield* Effect.tryPromise(awaitDevice);
		const scope = yield* Scope.make();
		const tokens = yield* Queue.unbounded<string>();
		let reset = () => {};
		const challenge: ChallengeQueue | null =
			props.boot.visitor?.siteKey === undefined
				? null
				: {
						put: (token) => {
							Queue.offerUnsafe(tokens, token);
						},
						take: Queue.take(tokens).pipe(Effect.tap(() => Effect.sync(() => reset()))),
						setReset: (next) => {
							reset = next;
						}
					};
		const pageClient = yield* createBolt({
			actor: props.boot.actor,
			locale: props.boot.workspace.locale,
			tz: props.boot.workspace.tz,
			messages: props.boot.messages,
			base: props.boot.base,
			catalog: props.boot.catalog,
			describe: props.boot.describe,
			contract: props.boot.contract,
			fetch: scopedFetch(props.boot, challenge, options.fetch ?? globalThis.fetch),
			openStream: (url) => {
				const scoped = new URL(url, location.href);
				if (props.boot.visitor !== null && props.boot.kiosk === null)
					scoped.searchParams.set('app', props.boot.visitor.app);
				if (props.boot.kiosk !== null) scoped.searchParams.set('kiosk', props.boot.kiosk);
				return (
					options.openStream?.(scoped.href) ?? new EventSource(scoped, { withCredentials: true })
				);
			}
		}).pipe(
			Scope.provide(scope),
			Effect.onError(() => Scope.close(scope, Exit.void))
		);
		const installed = Object.assign(pageClient, {
			fileUrl: (ref: { readonly id: string }, options: Parameters<Bolt['fileUrl']>[1] = {}) =>
				storedFileUrl(
					props.boot.base,
					ref.id,
					options,
					props.boot.kiosk !== null
						? { kiosk: props.boot.kiosk }
						: props.boot.visitor === null
							? undefined
							: { app: props.boot.visitor.app }
				),
			org: { name: props.boot.workspace.name, logo: props.boot.workspace.logo ?? null },
			device: resolveDevice(),
			href: (app: string, page?: string, record?: { model: string; id: string }) => {
				const path = `${props.boot.base}/app/${app}${page === undefined ? '' : `/${page}`}`;
				return record === undefined
					? path
					: `${path}?record=${encodeURIComponent(record.model)}/${encodeURIComponent(record.id)}`;
			}
		});
		current = installed;
		const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
		const view = yield* Effect.try({
			try: () => hydrate(component, { target, props, recover: false }),
			catch: (cause) => new PublicHydrationFailure({ reason: String(cause) })
		}).pipe(
			Effect.onError(() =>
				Effect.sync(() => {
					if (current === installed) current = null;
				}).pipe(
					Effect.andThen(Scope.close(scope, Exit.void)),
					Effect.ensuring(Effect.promise(dispose))
				)
			)
		);
		const mountWidget = (target: HTMLElement, siteKey: string, queue: ChallengeQueue) =>
			mount(Turnstile, { target, props: { siteKey, queue } });
		let widget: ReturnType<typeof mountWidget> | null = null;
		let closed = false;
		const cleanup = Effect.suspend(() => {
			if (closed) return Effect.void;
			closed = true;
			if (current === installed) current = null;
			const mountedWidget = widget;
			return Effect.tryPromise(() => unmount(view)).pipe(
				Effect.ensuring(
					mountedWidget === null
						? Effect.void
						: Effect.tryPromise(() => unmount(mountedWidget)).pipe(Effect.orDie)
				),
				Effect.ensuring(
					Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.promise(dispose)))
				)
			);
		});
		yield* Effect.promise(tick).pipe(Effect.onError(() => cleanup.pipe(Effect.orDie)));
		const challengeTarget = document.getElementById('bolt-public-challenge');
		if (
			challenge !== null &&
			challengeTarget !== null &&
			props.boot.visitor?.siteKey !== undefined
		) {
			const siteKey = props.boot.visitor.siteKey;
			widget = yield* Effect.try({
				try: () => mountWidget(challengeTarget, siteKey, challenge),
				catch: (cause) => new PublicHydrationFailure({ reason: String(cause) })
			}).pipe(Effect.onError(() => cleanup.pipe(Effect.orDie)));
		}
		const close = (event: PageTransitionEvent) => {
			if (event.persisted) return;
			window.removeEventListener('pagehide', close);
			void Effect.runPromise(
				cleanup.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => console.error('Public page cleanup failed', cause))
					)
				)
			);
		};
		window.addEventListener('pagehide', close);
		return () => {
			window.removeEventListener('pagehide', close);
			return Effect.runPromise(cleanup);
		};
	});
