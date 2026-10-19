/**
 * The native Device runtime. The shell injects this bundle at document start into workspace pages (iOS
 * WKUserScript, Android WebViewCompat.addDocumentStartJavaScript) after Capacitor's bridge script, and it installs
 * `window.boltDevice` + `window.boltDeviceReady` before the workspace bundle runs. It never polls:
 * the Bolt shell drives `notifications.show` from its own live lane.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Cause, Effect, Exit, FiberSet, Schema } from 'effect';
import { backgroundLocation, installLocation, installLocationTransport } from './location.ts';
import { NorbitalShell } from './plugin.ts';

/** Written by `norbital-app generate` around this bundle. */
declare const NORBITAL_SHELL: unknown;
const ShellConfig = Schema.Struct({
	host: Schema.String,
	/** Set when the app is pinned to one workspace. */
	workspace: Schema.optionalKey(Schema.String),
	allowNavigation: Schema.Array(Schema.String),
	location: Schema.optionalKey(Schema.Struct({ background: Schema.Boolean })),
	notifications: Schema.Boolean
});
const Registration = Schema.Struct({
	kind: Schema.Literal('apns'),
	token: Schema.String,
	topic: Schema.String,
	environment: Schema.Literals(['development', 'production']),
	teamId: Schema.String
});
const Extra = Schema.Struct({ path: Schema.optionalKey(Schema.String) });

class ShellFailure extends Schema.TaggedError<ShellFailure>()('NorbitalShell.Failure', {
	message: Schema.String
}) {}
class DeviceFailure extends Schema.TaggedError<DeviceFailure>()('NorbitalShell.DeviceFailure', {
	cause: Schema.Defect()
}) {}
const native = <A>(work: () => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: () => new ShellFailure({ message: 'The native app could not complete this operation.' })
	});

type Access = 'granted' | 'prompt' | 'denied';
const accessOf = (display: string): Access =>
	display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
/** A stable 31-bit notification id for a notice id. */
const numericId = (id: string) =>
	[...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7) & 0x7fffffff;

/** A pinned app's workspace origin, or an unpinned app's host and its subdomains (same scheme and port). */
const home = (url: URL, host: URL, workspace: URL | undefined) =>
	workspace === undefined
		? url.protocol === host.protocol &&
			url.port === host.port &&
			(url.hostname === host.hostname || url.hostname.endsWith(`.${host.hostname}`))
		: url.origin === workspace.origin;

/** A home origin, or an allowed HTTPS host on its default port. */
const trusted = (
	value: string,
	host: URL,
	workspace: URL | undefined,
	hosts: ReadonlyArray<string>
) => {
	let url: URL;
	try {
		// Not `URL.parse` / `URL.canParse`: the oldest supported WebViews (iOS 15) lack them.
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username !== '' || url.password !== '') return false;
	if (home(url, host, workspace)) return true;
	if (url.protocol !== 'https:' || url.port !== '') return false;
	const name = url.hostname.toLowerCase();
	return hosts.some((rule) =>
		rule.startsWith('*.') ? name.endsWith(rule.slice(1)) : name === rule.toLowerCase()
	);
};

const install = Effect.gen(function* () {
	if (!Capacitor.isNativePlatform() || window.top !== window.self) return;
	const shell = yield* Schema.decodeUnknownEffect(ShellConfig)(NORBITAL_SHELL);
	const host = new URL(shell.host);
	const workspace = shell.workspace === undefined ? undefined : new URL(shell.workspace);
	if (!home(new URL(location.href), host, workspace)) return;
	const platform = Capacitor.getPlatform();
	if (platform !== 'ios' && platform !== 'android') return;
	const run = yield* FiberSet.makeRuntimePromise();
	const previous = Object.getOwnPropertyDescriptor(window, 'boltDevice');

	if (shell.location !== undefined) {
		yield* installLocation(shell.location.background);
		yield* installLocationTransport;
	}

	// One native listener; a tap that arrives before the shell subscribes waits for the first subscriber.
	const opened = new Set<(path: string) => void>();
	let pending: string | undefined;
	if (shell.notifications)
		yield* Effect.acquireRelease(
			native(() =>
				LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
					const extra = Schema.decodeUnknownOption(Extra)(notification.extra);
					const path = extra._tag === 'Some' ? extra.value.path : undefined;
					if (path === undefined) return;
					if (opened.size === 0) pending = path;
					else for (const listener of opened) listener(path);
				})
			),
			(listener) =>
				native(() => listener.remove()).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		);
	const permission = native(() => LocalNotifications.checkPermissions()).pipe(
		Effect.map((value) => accessOf(value.display))
	);

	Object.defineProperty(window, 'boltDevice', {
		value: Object.freeze({
			platform,
			// a pinned app (`norbital.app.ts` `workspace`) offers no other workspace; an unpinned one keeps the switcher
			...(workspace === undefined ? {} : { pinned: true }),
			...(shell.location === undefined
				? {}
				: {
						geolocation: Object.freeze({
							source: 'native',
							api: navigator.geolocation,
							...(shell.location.background
								? {
										background: Object.freeze({
											status: () => run(backgroundLocation.status),
											openSettings: () => run(backgroundLocation.openSettings)
										})
									}
								: {})
						})
					}),
			...(shell.notifications
				? {
						notifications: Object.freeze({
							status: () => run(permission),
							request: () =>
								run(
									native(() => LocalNotifications.requestPermissions()).pipe(
										Effect.map((value) => accessOf(value.display))
									)
								),
							openSettings: () => run(backgroundLocation.openSettings),
							show: (notice: { id: string; title: string; body: string | null; path: string }) =>
								run(
									permission.pipe(
										Effect.flatMap((access) =>
											access !== 'granted'
												? Effect.void
												: native(() =>
														LocalNotifications.schedule({
															notifications: [
																{
																	id: numericId(notice.id),
																	title: notice.title,
																	body: notice.body ?? '',
																	extra: { path: notice.path }
																}
															]
														})
													).pipe(Effect.asVoid)
										)
									)
								),
							onOpen: (listener: (path: string) => void) => {
								opened.add(listener);
								if (pending !== undefined) {
									const path = pending;
									pending = undefined;
									listener(path);
								}
								return () => {
									opened.delete(listener);
								};
							}
						}),
						...(platform === 'ios'
							? {
									push: Object.freeze({
										register: () =>
											run(
												native(() => NorbitalShell.pushRegistration()).pipe(
													Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
													Effect.map((registration) => ({
														kind: registration.kind,
														endpoint: registration.token,
														keys: {
															topic: registration.topic,
															environment: registration.environment,
															teamId: registration.teamId
														}
													}))
												)
											)
									})
								}
							: {
									notices: Object.freeze({
										start: (options: { url: string }) =>
											run(native(() => NorbitalShell.startNotices({ url: options.url }))),
										stop: () => run(native(() => NorbitalShell.stopNotices()))
									})
								})
					}
				: {}),
			navigation: Object.freeze({
				openExternal: (url: string) => run(native(() => Browser.open({ url })))
			})
		}),
		configurable: true
	});

	yield* Effect.acquireRelease(
		native(() =>
			App.addListener('appUrlOpen', ({ url }) => {
				if (trusted(url, host, workspace, shell.allowNavigation)) location.assign(url);
			})
		),
		(listener) =>
			native(() => listener.remove()).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
	);
	if (platform === 'android')
		yield* Effect.acquireRelease(
			native(() =>
				App.addListener('backButton', ({ canGoBack }) => {
					if (canGoBack) history.back();
					else
						void run(
							native(() => App.exitApp()).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
						);
				})
			),
			(listener) =>
				native(() => listener.remove()).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		);
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			if (previous === undefined) Reflect.deleteProperty(window, 'boltDevice');
			else Object.defineProperty(window, 'boltDevice', previous);
		})
	);
});

// Not `Promise.withResolvers`: the oldest supported WebViews (iOS 15) lack it.
const ready: { resolve: () => void; reject: (cause: DeviceFailure) => void } = {
	resolve: () => undefined,
	reject: () => undefined
};
const readyPromise = new Promise<void>((resolve, reject) => {
	ready.resolve = resolve;
	ready.reject = reject;
});
Object.defineProperty(window, 'boltDeviceReady', {
	value: readyPromise,
	configurable: true
});
// Keep the published promise rejecting for consumers even when native startup fails before their modules arrive.
void readyPromise.catch(() => undefined);

/** The page owns one scope; interruption closes native listeners and location watchers. */
const dispose = Effect.runCallback(
	Effect.scoped(
		Effect.forkScoped(
			install.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isSuccess(exit)) ready.resolve();
						else ready.reject(new DeviceFailure({ cause: Cause.squash(exit.cause) }));
					})
				),
				Effect.tapCause(Effect.logError),
				Effect.ignore
			),
			{ startImmediately: true }
		).pipe(Effect.andThen(Effect.never))
	)
);
let closed = false;
const restored = (event: PageTransitionEvent) => {
	// Restored pages hold device captured from the closed scope; a fresh document must capture the new scope.
	if (event.persisted && closed) {
		window.removeEventListener('pageshow', restored);
		location.reload();
	}
};
window.addEventListener(
	'pagehide',
	(event) => {
		if (closed) return;
		closed = true;
		if (!event.persisted) window.removeEventListener('pageshow', restored);
		dispose();
	},
	{ once: true }
);
window.addEventListener('pageshow', restored);
