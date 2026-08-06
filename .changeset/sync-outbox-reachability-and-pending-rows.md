---
'@norbital-ai/pod': patch
'@norbital-ai/ui': patch
---

Decide "offline" from whether the server answers, drain the outbox on its own clock, and mark a row that has not committed yet.

`PodSyncClient.isOnline()` was `navigator.onLine && this.online`, and `setOnline` was defined and
never called from anywhere but a test — so the whole verdict was `navigator.onLine`. That property
answers a different question: whether the machine has a network interface it believes is up. A Wi-Fi
handover, a VPN reconnect or a NIC waking from sleep flips it false for a moment, and any mutation
landing in that window took the queue branch and came back `OFFLINE_QUEUED` while the server was
answering every other request perfectly well. Reachability is now observed from real traffic: the SSE
stream reports whether it could be opened, and every `sync/*` POST reports whether it got an answer.
A status the server (or its edge) produced counts as reachable however unwelcome it is — only a
`fetch` that never got an answer, or 408/502/503/504, mean nothing served the request. The device's
own connectivity events still have a part, and only one direction of it: a browser reporting its radio
is down marks the server unreachable without spending a request on proving it, and the moment it
reports back up the outbox drains at once — the attempt itself is the probe that may only then flip
the verdict back.

Once queued, the outbox drained in exactly one place: the top of a stream _iteration_, reached only
when a new SSE connection is established. A healthy feed stays connected for minutes, so a write that
queued behind one momentary failure sat there until a proxy timed the stream out — the reported
"it only committed after about a minute". A queued write now schedules its own retry, starting at one
second and backing off to a ten-second ceiling, and a connection observed to recover drains
immediately rather than waiting for the next reconnect.

`sync/*` POSTs carried no deadline, which was worse than it sounds: the stream loop awaited
`flushPending()`, `stopStream()` awaits the stream loop, and the subscription registry's serialized
catch-up queue awaits `stopStream()`. One accepted-but-never-answered mutate therefore stalled every
collection's catch-up behind it, so reads waiting on those collections never resolved, never errored
and never retried. The drain is now scheduled rather than awaited on the feed's critical path, and
every request has a 60s ceiling.

A mutation naming a record whose create is still queued no longer goes to the server for an id the
server has never seen — the `404 Record with ID … not found` that self-resolved once the outbox
drained. Create-then-delete on an unsynced row is a no-op and both entries are dropped; an update is
folded into the create still waiting to be sent; anything else naming a busy record is appended to
the outbox, which is already ordered and drained in order — and now stamps each entry strictly after
the one before it, so two writes inside the same millisecond cannot tie and reorder. A delete for an
id the outbox knows nothing about is still the server's to judge, and still 404s.

`CollectionTable` marks a row whose write is still in the outbox. It reuses the affordance approval
already established — a leading border with a `title` and `aria-label`, so the state survives colour
blindness and a screen reader — in warning amber rather than brand, and takes precedence over
awaiting-approval because an unsynced row is one the server does not hold at all. It is derived from
`_pod_pending` itself rather than inferred, so it clears the moment the write settles; a _rejected_
write is never in this state, because the mutation is rolled back and reported where it was made.
