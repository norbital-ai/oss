# @norbital-ai/app-shell

A native iOS and Android shell for Bolt workspaces, branded from one `norbital.app.ts`, built and uploaded by the
`norbital-app` CLI. Host-agnostic: it points at any host (a Norbital platform origin or a self-hosted `bolt-server`)
and nothing server-side injects code into it.

```ts
// norbital.app.ts (or norbital.app.json)
import { defineApp } from '@norbital-ai/app-shell';

export default defineApp({
	id: 'com.example.cleaner', // iOS bundle id and Android application id
	name: 'Cleaner',
	description: 'Jobs for cleaners.',
	version: '1.0.0',
	build: 1, // CFBundleVersion / versionCode, increase per upload
	icon: './icon.png', // 1024×1024 PNG
	splash: { color: '#FFFFFF' }, // optional `image`, defaults to the icon
	themeColor: '#FFFFFF', // optional fallback for splash, background and offline colours
	host: 'https://norbital.example', // an origin; https, http only for localhost, 127.0.0.1, 10.0.2.2, *.localhost
	workspace: 'https://t-abc.workspaces.norbital.example/apps/cleaner', // optional: pins the app (below)
	allowNavigation: ['*.stripe.com'], // extra hosts that stay in the WebView
	capabilities: {
		location: { background: true, purpose: '…' }, // usage strings, background mode, Android permissions
		notifications: true, // APNs entitlement (iOS), notices service (Android)
		camera: { purpose: '…' }
	},
	ios: { teamId: 'ABCDE12345', apsEnvironment: 'production' },
	android: {} // optional `debugCa: './ca.pem'`: a local HTTPS host's CA, trusted by debug builds only
});
```

| Key               | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `host`            | Required. The server the app belongs to, as an origin (scheme, host, optional port; no path or slash).      |
| `workspace`       | Optional. One workspace page, path included, on `host`'s origin or a subdomain of its hostname.             |
| `allowNavigation` | Optional. Extra HTTPS hosts (`*.` for subdomains) that stay in the WebView; they never receive the runtime. |

**Pinned** (`workspace` set): the app opens `workspace` and is home on that workspace's origin only. The runtime sets
`boltDevice.pinned: true`, so the Bolt shell hides its workspace switcher and the platform link.

**Unpinned** (`workspace` unset): the app opens `host` and is home on the host origin and every subdomain of the
host's hostname, on the same scheme and port. On a Norbital platform the host's root answers with workspace selection
and every workspace (`t-<hash>.<tenant base>`) is a subdomain, so the Bolt shell's own switcher moves between them
inside the app; `boltDevice.pinned` is absent. A self-hosted `bolt-server` serves its one workspace at its root.

Only home documents receive the device runtime and the native bridge; a store build (`build`, `upload`) needs an
`https` host and, when set, an `https` workspace.

## CLI

| Command                                                        | Does                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `norbital-app init <dir>`                                      | starter `norbital.app.ts`, `package.json` pinning the shell and its Capacitor set, `.gitignore`                                                     |
| `norbital-app generate [dir]`                                  | renders `<dir>/.native/{ios,android,www}` from the package templates, embeds the runtime, draws icons and splash with macOS `sips`, runs `cap sync` |
| `norbital-app doctor [dir]`                                    | checks the config, installed Capacitor versions, Xcode, simulator, JDK 21, Android SDK and release credentials                                      |
| `norbital-app run --platform ios\|android [--target id] [dir]` | generate, then `cap run` on a simulator / emulator                                                                                                  |
| `norbital-app build [--platform ios,android] [dir]`            | generate, then a signed IPA (`xcodebuild archive` + `-exportArchive`) and AAB (`gradlew bundleRelease`)                                             |
| `norbital-app deploy [--platform ios,android] [dir]`           | generate, build, upload to App Store Connect and the Google Play internal track                                                                     |

`.native/` is build output: regenerated from scratch on every `generate`, never edited, never committed. Every
external command is time-bounded and streams its output.

Credentials come from the environment:

- iOS upload: `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_FILE` (`.p8`).
  `build` uses them when present, else Xcode's signed-in account.
- Android signing: `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- Google Play: `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` (service-account JSON; edits insert → bundle upload → internal track
  → commit, signed with `node:crypto`).

## Device runtime

The shell injects `build/runtime/norbital-shell.js` at document start into home-origin pages (iOS
`WKUserScript`, Android `WebViewCompat.addDocumentStartJavaScript`). It installs `window.boltDeviceReady`
synchronously and then `window.boltDevice`:

- `platform: 'ios' | 'android'`
- `pinned: true` when the app is pinned to a `workspace`; absent when unpinned
- `geolocation?` (with `capabilities.location`): `{ source: 'native', api: navigator.geolocation, background? }`;
  `background` (with `location.background`) is `{ status(): Promise<{ enabled, always }>, openSettings() }`
- `notifications?` (with `capabilities.notifications`): `status()`, `request()`, `openSettings()`,
  `show({ id, title, body, path })`, `onOpen(listener): () => void`
- `push?` (iOS, notifications): `register(): Promise<{ kind: 'apns', endpoint, keys: { topic, environment, teamId } }>`
- `notices?` (Android, notifications): `start({ url })`, `stop()` — the background notice stream
- `navigation: { openExternal(url) }`

It never polls; the Bolt shell drives `notifications.show` from its live lane.

## Native plugin `NorbitalShell`

| Method / event           | Platform | Result                                                                  |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `locationStatus()`       | both     | `{ enabled, always }`                                                   |
| `openSettings()`         | both     | opens the app's system settings                                         |
| `pushRegistration()`     | iOS      | `{ kind: 'apns', token (hex), topic (bundle id), environment, teamId }` |
| `pushRegistration` event | iOS      | the same object, on every registration                                  |
| `startNotices({ url })`  | Android  | starts the notices foreground service on a home-origin URL              |
| `stopNotices()`          | Android  | stops it                                                                |

Navigation: home origins and `allowNavigation` hosts stay in the WebView; other `http(s)`, `tel`, `mailto` and `sms`
links open in the system. A tapped notices-service notification opens its `path` on the origin of the notices stream
it came from; a tapped APNs push opens its `path` on the open workspace's origin (else `host`, or the pinned
workspace). The native bridge only answers home-origin documents.
