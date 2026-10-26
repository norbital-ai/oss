import { randomBytes } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, FiberSet, Layer, Option, Redacted, Ref, Scope } from 'effect';
import {
	credentials,
	Drivers,
	integrationLinks,
	Port,
	Secrets,
	type LinkAdmission,
	type LinksHost
} from '@norbital-ai/bolt/engine';
import { TestWorkspace, type TestOptions, type WorkspaceServices } from '@norbital-ai/bolt/test';
import { toDrivers, type ProviderDef } from '../src/abi.ts';

/** A fixture's real Drivers.changed closure is wired after its scoped workspace is acquired. */
export const engineHost = <A, E>(
	options: TestOptions,
	work: (fixture: {
		t: TestWorkspace['Service'];
		store: Effect.Success<ReturnType<typeof credentials>>;
		links: (
			defs: readonly ProviderDef[],
			options?: Pick<LinksHost, 'fetch' | 'secrets' | 'publicUrl'>
		) => Effect.Effect<Effect.Success<ReturnType<typeof integrationLinks>>, never, Scope.Scope>;
	}) => Effect.Effect<A, E, WorkspaceServices | Scope.Scope>
) =>
	Effect.gen(function* () {
		const changed = yield* Ref.make(Option.none<Drivers['Service']['changed']>());
		const ports = Layer.succeed(Drivers, {
			available: false,
			send: () => Port.unavailable('link'),
			typing: () => Port.unavailable('link'),
			request: () => Port.unavailable('link'),
			read: () => Port.unavailable('link'),
			changed: (instance: string) =>
				Ref.get(changed).pipe(
					Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (fn) => fn(instance) }))
				)
		});
		return yield* Effect.gen(function* () {
			const t = yield* TestWorkspace,
				codec = yield* Secrets;
			const store = yield* credentials(t.db, codec).pipe(Effect.provide(NodeCrypto.layer)),
				context = yield* Effect.context<LinkAdmission>();
			const links = (
				defs: readonly ProviderDef[],
				options: Pick<LinksHost, 'fetch' | 'secrets' | 'publicUrl'> = {
					publicUrl: 'https://apex.example/acme'
				}
			) =>
				Effect.gen(function* () {
					const run = yield* FiberSet.makeRuntimePromise<never>();
					const providers = yield* toDrivers(defs, run);
					const manager = yield* integrationLinks({
						providers,
						enter: (effect) => effect.pipe(Effect.provideContext(context)),
						admit: (effect) => effect.pipe(Effect.provideContext(context)),
						credentials: store,
						...options,
						log: () => {}
					}).pipe(Effect.provide(NodeCrypto.layer));
					yield* Ref.set(changed, Option.some(manager.port.changed));
					return manager;
				});
			return yield* work({ t, store, links });
		}).pipe(
			Effect.provide(
				TestWorkspace.layer({
					...options,
					links: null,
					secretsKey: Redacted.make(randomBytes(32)),
					ports
				})
			)
		);
	});
