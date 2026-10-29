# Client bundles and public rendering

The compiler owns Vite and Svelte configuration. A workspace supplies declarations, components
and ordinary helpers; it has no Vite config or SvelteKit route layer.

## Members-only workspace

Members-only apps and kiosks use the internal SPA. Before the shell mounts, the opening cover
waits for the emitted main-thread module graph, including dynamically imported pages,
representations and integration setup modules, to initialize and for its CSS to load. Browser
module caching then supplies subsequent SPA navigation. A failed initialization leaves an error
under the cover rather than admitting an incomplete workspace. This gate does not start workers
or grant access to any server operation.

The runtime still mounts app sessions only for signed-in callers admitted to that app. Importing
a session module at startup does not mount it or grant its capabilities. Keep browser module
initialization free of device work; mounted effects belong to the page or session's scoped edge.

## Public and external pages

An app whose audience is not `members`, or a kiosk whose auth is not `members`, uses server
rendering. The response contains the requested page's rendered body and head, followed by
hydration with the same component wrapper and typed data. Navigation to another such page is a
document request that admits and renders the new route. A signed-out document request for a page
that needs sign-in (an `external` or `all` app, a kiosk whose auth is not `none`) is answered with
`303` to `/sign-in?next=<path>`, which signs in or signs up and returns.

Each route has an independent browser entry and CSS built from its own transitive dependencies.
It does not warm the internal workspace or import unrelated pages, app sessions, Norbius or
Studio. Shared components and ordinary helpers that the page actually imports remain part of
its graph. The public wrapper supplies UI, translation, file and caller context without the
internal navigation shell.

For `+book.page.svelte`, author these companions in the same app or kiosk folder:

- `+book.page.server.ts`: default `pageServer({ data, load: function* (request, ctx) { … } })`.
- `book.page.data.ts`: the ordinary module exporting the default `Schema.Codec<D, Json>` used by
  both the loader and generated render/hydration wrapper.

The component takes `{ data: typeof Data.Type }`, with a type-only import of that codec. A browser
helper may also import the shared codec or public read descriptions. It must never import the
server declaration as a runtime value. The compiler verifies that `pageServer.data` is the exact
shared codec, not a separately recreated schema. `PageData` can derive the decoded type from a
page-server declaration through a type-only import.

The loader receives only the workspace-relative `pathname`, `search`, and a read-only native
context containing caller-scoped reads, actor and clock. It has no writes, device, credentials
or Node capabilities. Existing session, public-app and kiosk admission chooses the authority;
the loader never substitutes workspace authority. Visitor restrictions still apply, including
the restriction to admitted model reads. After hydration, interactive actions use
the normal browser protocol and its existing authorization and challenge checks.

Load the initial content in `pageServer.load`. Svelte rendering is synchronous: no asynchronous
component rendering, browser APIs or `$bolt` workflow execution during SSR. The server `$bolt`
facade supplies synchronous display metadata, translation, links and file URLs. Read initial data
in the loader and render that codec-typed data during SSR. The unified `bolt.query` owns browser
live reads after hydration; use `$derived` to capture its reactive inputs. Do not execute page
mutations, device work or mounted resource effects while rendering on the server. Preserve the
loader answer through hydration instead of issuing a second read before mount or copying it into
a separate loading/error state machine.

Loader execution, schema encoding and Svelte rendering run in one bounded source-only guest
invocation with the existing CPU, heap, crossing and read-byte limits. Hosts never import tenant
server modules into Node. Hydration validates its route, release and locale envelope and decodes
the data with the same codec before mounting. Its public boot contains caller-visible metadata,
messages and catalogue; it carries no server authority, credentials, agent prompt or Studio state.
Only return data intended for that caller: loader results are serialized into the response.
Rendered documents use `private, no-store` and vary by caller credentials.

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

`bolt.fileUrl(file)` requests the original stored file. `bolt.fileUrl(file, { preview: 512 })`
requests an image preview; `preview` is typed as `64 | 512 | 1024`, naming its maximum edge.
Previews remain subject to the file's current record or conversation authorization. Public file
URLs retain their app or kiosk scope; an image URL grants no additional read authority.

A conversation holds its files; a message row carries none. `sys_conversation.inputs` holds every
upload (posted in the agent panel, which uploads to `/__bolt/files/sys_conversation.inputs`, or
received from an integration), each entry naming its `message`; a message's `files` are read back
from those inputs (`filesOf`, `src/engine/conversations/store.ts`). `sys_conversation.outputs` holds
files tools made: `browser_download` (a file fetched in the browser session, at most 20 MiB, through
the `Browser` port's `download`), `download` (a public media URL the host fetches and stores through
the `Files` port's `download`, kept only if its first bytes are media, at most 100 MiB; no bytes
enter the engine), screenshots, and the files a `run_js` script returns (classified by their bytes:
media, text, PDF and office documents, archives; an executable or an unrecognized binary is refused).
The panel's session rail shows them as
the Inputs and Outputs cards. Reading one follows the conversation (`readableFile`,
`src/engine/decisions/index.ts`): its uploader, the conversation's owner, a member who posted in it,
administrators for an in-app conversation, staff for a `public` envoy's thread, and whoever reads a
record it was filed into.

Kiosks and portal pages declare `embed: ['https://partner.example']` to allow specific framing
origins; the default admits no embedding origins. Other pages remain same-origin. Audience and
policies still control data access. Embedded session cookies use `SameSite=None; Secure; Partitioned`,
so each embedding site has its own session. The embedding site's iframe `allow` attribute delegates
browser permissions such as camera and geolocation; it confers no data authority.

The native device belongs to the current document: the host may inject `window.boltDevice`,
or pass an explicit `device` to `mountShell`. Public hydration detects that same document's
descriptor; it does not read an embedding parent's globals. Browser geolocation is the fallback
when no native implementation exists, and a native denial does not trigger another provider.
See [Device](./device.md) for permission and session lifetimes.
