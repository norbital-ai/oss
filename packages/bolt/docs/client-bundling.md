# Client bundles and public rendering

The compiler owns Vite and Svelte configuration. A workspace supplies declarations, components
and ordinary helpers; it has no Vite config or SvelteKit route layer.

## Members-only workspace

Members-only apps and kiosks use the internal SPA. The shared platform build groups the shell's
static imports and the document preloads them to reduce network round trips. In a browser, the
shell waits for its styles; pages, record views, Settings and Norbius load when opened and stay
in the browser's module cache for subsequent visits. On iOS and Android, the native app also waits for its device
bridge and initializes the emitted main-thread module graph before opening the workspace, so
subsequent navigation does not wait for those modules. A failed shell initialization leaves an
error under the cover. This gate does not start workers or grant access to any server operation.

Standalone Bolt Server negotiates Brotli or gzip for static JavaScript and stylesheets.
Workspace responses and live streams are outside this compression path. Colony instead
serves precompressed variants of immutable client assets from its content store.

The runtime still mounts app sessions only for signed-in callers admitted to that app. Importing
a session module at startup does not mount it or grant its capabilities. Keep browser module
initialization free of device work; mounted effects belong to the page or session's scoped edge.

## Public and external pages

An app with a public, external or shared audience uses server rendering. The response contains the requested page's rendered body and head, followed by
hydration with the same component wrapper and query answers. Navigation to another such page is a
document request that admits and renders the new route. A signed-out document request for a page
that needs sign-in (an app with audience `external` or `all`) is answered with
`303` to `/sign-in?next=<path>`, which signs in or signs up and returns.

Each route has an independent browser entry and CSS built from its own transitive dependencies.
It does not warm the internal workspace or import unrelated pages, app sessions or Norbius.
Shared components and ordinary helpers that the page actually imports remain part of
its graph. The public wrapper supplies UI, translation, file and caller context without the
internal navigation shell.

A public component receives `ctx` as a prop. Read the caller's initial data with `ctx.query`
and render the query's `current` value. For query filters, `ctx.location` supplies the
workspace-relative pathname and search string. Use `$derived` for reactive arguments.

Svelte renders synchronously. The engine resolves the reads used by the render and renders again
with their answers. Every read uses the same caller and authorization as browser queries. The
guest meters the entire render with its CPU, heap, crossing and read-byte limits. Start
interactive work on mount, including writes, device work and resource effects.

Hydration validates the route, release and locale, then starts from the answers used on the
server. The same queries connect to the live stream. Public boot contains caller-visible
metadata and rows. Documents use `private, no-store` and vary by caller credentials.

## Artifact and import boundaries

`artifact.json.pages` maps `app/<app>/<page>` or `kiosk/<kiosk>/<page>` to its browser `entry`,
`css` and private `server: { file, sha256 }`. Server programs, source maps and byte assets live
under `server/`; `hashes.server` covers that tree alongside the existing artifact hashes. They
remain outside the statically served `client/` and workspace asset roots.

The browser import guard checks the actual transitive graph, including canonical paths and
raw/URL imports. Server declaration roles, `.env` files, server-named files and `server/`
directories cannot enter it. Type-only imports remain valid. Put genuinely shared browser
values in ordinary helpers and keep secrets and server operations in their owning server roles.

Custom hosts implementing Host API version 3 route public documents through the active
workspace's `render` operation before falling back to static client serving. Pass the original
request and preserve the returned cookies, status, cache and content-security headers; serving
the internal `index.html` for a public route bypasses its SSR contract.

## Files, frames and native device

`ctx.file_url(file)` requests the original stored file. `ctx.file_url(file, { preview: 512 })`
requests an image preview; `preview` is typed as `64 | 512 | 1024`, naming its maximum edge.
Previews remain subject to the file's current record or conversation authorization. Public file
URLs retain their app or kiosk scope; an image URL grants no additional read authority.

A conversation holds its files; a message row carries none. `sys_conversation.inputs` holds every
upload (posted in the agent panel, which uploads to `/__bolt/files/sys_conversation.inputs`, or
received from an integration), each entry naming its `message`; a message's `files` are read back
from those inputs (`filesOf`, `src/engine/conversations/store.ts`). `sys_conversation.outputs` holds
files tools made: `browser { download }` (a file fetched in the browser session, at most 20 MiB, through
the `Browser` port's `download`), `download` (a public media URL the host fetches and stores through
the `Files` port's `download`, kept only if its first bytes are media, at most 100 MiB; no bytes
enter the engine), screenshots, and the files a `run_js` script returns (classified by their bytes:
media, text, PDF and office documents, archives; an executable or an unrecognized binary is refused).
The panel's session rail shows them as
the Inputs and Outputs cards. Reading one follows the conversation (`readableFile`,
`src/engine/decisions/index.ts`): its uploader, the conversation's owner, a member who posted in it,
administrators for an in-app conversation, staff for a `public` envoy's thread, and whoever reads a
record it was filed into.

Apps and kiosks declare `embed: ['https://partner.example']` to allow specific framing origins.
By default only the workspace itself may frame the pages. Audience and
policies still control data access. Embedded session cookies use `SameSite=None; Secure; Partitioned`,
so each embedding site has its own session. The embedding site's iframe `allow` attribute delegates
browser permissions such as camera and geolocation; it confers no data authority.

The native device belongs to the current document: the host may inject `window.bolt_device`,
or pass an explicit `device` to `mount_shell`. Public hydration detects that same document's
descriptor; it does not read an embedding parent's globals. Browser geolocation is the fallback
when no native implementation exists, and a native denial does not trigger another provider.
See [Device](./device.md) for permission and session lifetimes.


## Browsers without streams

A fleet browser can refresh data without keeping a stream open. The document bridge is typed by
`PageSnapshotHost` from `@norbital-ai/bolt/page`. Set `window.bolt_live_mode = 'snapshot'` before the
page boots. Once a snapshot client is mounted, check that the optional bridge exists, then await
`window.bolt_refresh()` before inspecting the page. The runtime installs this read-only function
while snapshot clients are mounted and removes it when the last client's scope closes; its absence
means there is no mounted snapshot client to refresh. The Promise covers current mounted queries
and the next Svelte render; a read failure rejects and remains visible in the query state. There is
no tenant polling interval. Closing the page's scope unregisters its client.

Page code can yield `ctx.refresh()` to re-read its mounted queries. Queries retain a failure until a later successful answer and keep listening, so refreshing can recover them. Normal browser tabs use native streaming; an explicit refresh re-registers their views through that same versioned stream. The native read route admits snapshot transcripts, inbox and conversation lists through the same authority checks and reader as live views.
