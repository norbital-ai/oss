# Device, device notices and app sessions

## The device

The workspace bundle is the same on every platform; it only calls one Device. A shell (the native
app shell, a desktop shell) installs it as `window.bolt_device`, with `window.bolt_device_ready` when its
installation is asynchronous, before the workspace bundle runs. `mount_shell`'s typed `device` overrides it.
Bolt reads the installed device from an own data property, validates its metadata and required callable members,
and ignores a malformed installation. Each adapter keeps the native receiver and validates actual method results,
callback values and unsubscribe handles when invoked. Every member is optional. Availability supplies no server authority.

| Member          | Shape                                                                                        | Without it                        |
| --------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `platform`      | `'ios' \| 'android' \| 'web' \| 'desktop'`                                                   | —                                 |
| `pinned`        | `true`                                                                                       | the workspace switcher shows      |
| `geolocation`   | `{ source, api: Geolocation, background? }`                                                  | `navigator.geolocation`           |
| `notifications` | `{ status(), request(), open_settings(), show({ id, title, body, path }), on_open(listener) }` | the browser's Notification API    |
| `camera`        | `{ status(), request(), open_settings() }`                                                    | `getUserMedia`                    |
| `push`          | `{ register(): Promise<{ kind: 'web' \| 'apns', endpoint, keys }> }`                         | web push (service worker + VAPID) |
| `notices`       | `{ start({ url }), stop() }`                                                                 | —                                 |
| `navigation`    | `{ open_external(url) }`                                                                      | the browser opens the URL         |

Native geolocation takes precedence; native permission denial never changes providers. Native
`geolocation.background` optionally supplies `status(): Promise<{ enabled: boolean; always: boolean }>` and
`open_settings(): Promise<void>`. A foreground fix does not prove background authorization. These methods cannot grant
permission or guarantee execution after OS termination.

`pinned: true` says the shell is bound to one workspace: the Bolt shell hides its workspace switcher and the platform
link. The native app shell sets it only when its `norbital.app.ts` names a `workspace`; an unpinned app (only `host`)
leaves it absent and switches workspaces in place. Any other value is a malformed device.

`notifications.show` is called with the inbox notice's `id`: raising the same id again replaces it. `on_open` answers
its unsubscribe; its listener receives the tapped notice's workspace path. `push.register` asks the platform for the
device's endpoint (and for permission where the platform needs to); its answer is decoded as a `POST /__bolt/push`
body. `notices.start` receives the absolute `GET /__bolt/notices` URL; the shell holds it open with the
WebView's session cookie while the app is in the background.

## What the shell does with it

For a signed-in staff member, the shell (platform-free, scoped to the page's client):

- holds the live inbox open and, while the page is hidden, raises each new unread notice with `notifications.show`
  (a visible page shows a toast instead; a stored web endpoint's service worker raises it);
- follows a tapped notice's path (`on_open`);
- stores this device's push endpoint: `push.register()`, or, without one, web push. Every device receives; there is no
  setting. A browser that has not answered is asked on the member's first click, because browsers show the prompt only
  on a gesture; a browser that blocks notifications stores no endpoint;
- starts the shell's notice service (`notices.start`);
- at sign-out, before the session ends, stops the service and forgets the endpoint.

A link or navigation outside the workspace origin opens through `navigation.open_external` when present.

## The notice stream

`GET /__bolt/notices` (session cookie; `401` signed out, `403` for anyone without an inbox) is an event stream of the
member's notices created after it opened, each `data: { id, title, body, path }` with `id:` the notice's instant.
`Last-Event-ID` (or `?since=<instant>`) also replays, once, the unread notices of the inbox page after that instant. It
rides the live lane: no polling, a `: ping` every 25 s, and it ends on a release change; reconnect with
`Last-Event-ID`.

## Native push

`POST /__bolt/push` stores one device per endpoint, as its member's:

- web: a browser `PushSubscription.toJSON()` (`https://` endpoint);
- APNs: `{ kind: 'apns', endpoint: <hex device token>, keys: { topic: <bundle id>, environment: 'development' |
'production', team_id } }`;
- `{ endpoint, remove: true }` forgets it.

Each inbox notice's `bolt.push` run hands the host one push message per device, carrying the subscription's `kind`
and the notice's `id` and `path`; the host routes it (web push, APNs) and deletes a device its service reports gone. The
browser waits for its workspace service worker to activate before subscribing. The worker suppresses system alerts
only while a visible, focused window in that workspace can show its own toast. An unrelated tab or workspace does not
suppress background delivery. Web push requires host VAPID keys and the browser's notification permission.

Transient push failures retry through the durable `bolt.push` run (three attempts). A partly accepted batch may send
again: the stable notice id becomes the browser notification tag and a hashed APNs collapse id. This coalesces repeats
where supported; delivery is not exactly once. Existing queued run inputs still contain only notice ids. An APNs
alert carries `{ id, aps: { alert: { title, body }, sound: 'default' }, path }`.

## Reading device in a page

A page reads the same device through its `ctx` prop. `ctx.device.geolocation?.api` watches or reads a position
(native first, then the browser); `ctx.device?.notifications` is present only under a shell. Declare
`requires` on the app (`location`, `location:background`, `notifications`, `camera`) to hold its pages behind the
device wall until the member grants them.

## App sessions

`src/app/<app>/+session.svelte` runs for signed-in callers whose boot navigation grants that app, including workspace
home and other shell screens. It receives the page context through `ctx`, remains mounted across SPA navigation, and is
disposed with the signed-in client/shell. Visitors and callers without that app do not mount it. Run its device work
(a position watch, a visibility-driven refresh) on the edge with `{@attach attach((node) => effect)}`, so disposing
the session interrupts it; presentation-only listeners keep Svelte cleanup. This client lifecycle grants no server
policy and cannot survive native process termination.
