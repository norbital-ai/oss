# Integrations, syncs and channels

An integration connects a workspace to an outside system. Everything else on this page sits on top of that connection. A **sync** moves rows through it on a schedule. A **channel** carries messages through it as they arrive, and an **envoy** answers them.

Details live in [integration definitions, instances and providers](./integration-providers.md) and [syncs](./syncs.md). This page says how the pieces differ.

## The words

| Word | Means | Lives in | Who writes it |
| --- | --- | --- | --- |
| Definition | What an outside system is: its driver, configuration, credential fields and webhooks. | `src/integration/<name>/+integration.ts` | Workspace source |
| Connection | One account of a definition. The code calls it an instance. | A `sys_integration` row, or a `+workspace.ts` `connections` slot | A person or the agent |
| Driver | A kind of system with a fixed contract: `http`, `sqlserver`, `whatsapp`, `email`, `telegram`, `slack`, `discord`, `wechat`, `chat`, `calendar`. | `DRIVERS` in `src/decl/runtime/integration.ts` | Bolt |
| Provider | The code that speaks one platform for a driver. `whatsapp` has `baileys`, `twilio` and more. | `@norbital-ai/providers`, registered by the host | Bolt or the host, never a workspace |
| Link | One provider opened for one connection, holding its socket or webhook registration. | The host's links manager | Opened by the host |
| Sync | Rows exchanged between a model and a connection. | `syncs` on `+model.ts` | Workspace source |
| Channel | A connection whose driver carries conversations. The code calls this a `conversation` driver. | `conversation` in `DRIVERS` | Bolt |
| Envoy | The agent answering outside senders on a channel. | A `sys_envoy` row, bound by `sys_integration.envoy` | A person or the agent |

## How they deviate

| | Sync | Channel |
| --- | --- | --- |
| Carries | Rows of a model | Messages of a conversation |
| Starts on | A schedule, a person, or a webhook's hint | Each inbound event |
| Link calls | `request` or `read`; outbound `write` through the outbox | Inbound `messages` event; `send` and `typing` |
| Arrives in | The model's table | `sys_conversation` and `sys_message`, then an envoy's turn |
| Who acts | The sync's declared `read` and `write` bodies | The envoy under its policies, with a linked sender's authority in a direct message |
| On a preview | Reads nothing and answers `unlinked` | Binds no link, so nothing arrives or leaves |
| With no connection | Answers `unconnected` | Nothing to receive on |
| Workspace can add a new one | Yes, over `http` or `sqlserver` | No: [the host's providers](#which-platforms) decide |

A provider emits two kinds of event, and the split happens in one place, `links.ts`: `invalidate` wakes a sync, everything else goes to `Conversations.receive`. A calendar, for example, pushes `invalidate` and carries no conversation.

## The channel pipeline

1. The platform delivers: a webhook on `/hooks/integration/<instance>`, or a socket the link holds.
2. The provider verifies it and parses the platform's own shape into a `ChatMessage`.
3. `ctx.emit` passes it to `Conversations.receive`, which stores it. Only after that does the provider acknowledge, so a refused store is redelivered.
4. The engine routes it by `invocation`: `direct`, `mention`, `reply` or `ambient`.
5. The envoy admits the sender, holds a burst until they go quiet, and runs a turn as itself with the sender's authority joined in.
6. The reply queues as an outbound row and leaves through `Drivers.send`, which reaches the provider's `send`.

## The sync pipeline

1. A cron slot, a manual start or a webhook hint wakes the sync, which is debounced.
2. `read` takes a page from a cursor, per partition. The engine commits a page's rows and cursor together.
3. A snapshot's completion reconciles rows that disappeared.
4. `write` drains the outbox, with status on each row.

## How each is tested

Only the far end should be pretend. Each layer below replaces less than the one above it.

| Layer | Runs for real | Replaced | Tool | Needs a real account |
| --- | --- | --- | --- | --- |
| Provider | The provider: parsing, reconnects, refusals | The socket or `fetch` | `providers/tests/*`, `baileys-fake.ts`, `mail-servers.ts` | No |
| Links manager | Pairing, sealed credentials, fencing, resume | The provider | `integration-links.integration.test.ts` | No |
| Workspace logic | Sync bodies, admission, envoy, turn | Everything below `Drivers` | `bolt test`: `t.receive`, `t.syncs.read`, `t.syncs.deliver`, `t.fakes.links` | No |
| Whole pipeline | All of the above in a running host | The platform only | The channel simulator and `channel_check` | No |
| Real connection | Everything | Nothing | The connection's test action, or `channel_check { test }` | Yes |

`t.receive` enters at `Conversations.receive`, so it skips the provider. `t.fakes.links` stops at `Drivers`, so it never reaches the provider's `send`. `bolt test` has no webhook helper, so a webhook's signature and a webhook-triggered automation are not covered there.

### The channel simulator

The simulator is a separate process that stands where WhatsApp and Telegram stand. `env start` runs it on port 5196 and sets `COLONY_CHANNEL_SIMULATOR_URL`; a production host ignores that setting. `@norbital-ai/providers/simulator` offers `simulated-whatsapp`, `simulated-telegram` and `simulated-chat` beside the real providers, chosen per connection, so a real and a simulated connection can live in one workspace.

The real providers run unchanged. WhatsApp's simulated socket delivers raw Baileys messages through the patched receipt path, and Telegram's real webhook route and secret run because only the API address differs. The page at `http://127.0.0.1:5196` is a phone: pick a connection, write as the customer, read the replies.

`simulated-chat` runs on the chat contract and keeps a history a repair can read. Its page drops a delivery or deletes a message with no event, which is how the `history` level is proven whole: re-pair the connection, or wait for the daily pass, and the row is repaired. `/inbound` takes `at` to backdate a message, because a repair never calls a message younger than five minutes deleted.

It covers text in direct messages. Media, groups and edits are not simulated. It cannot show what the platform really does, so a protocol change, a dropped session or a ban only shows on a real account: keep one real connection on staging for a final check.

### A preview cannot run a channel or a sync

A preview binds no links, because its integrations would otherwise act on real accounts. Prove a sync's decoding in `bolt test` with `t.fakes.links.answer`. After the merge, create the connection on live, start the sync and read the rows.

## How each provider stays in sync

Every provider acknowledges only after the store commits, so a refused store comes back wherever the platform retries. The [levels](#levels-of-consistency) say what is repaired when a delivery never arrives. The older providers below sit outside the chat contract and reach these levels:

| Provider | Receives by | Level | Repairs from | Cannot recover |
| --- | --- | --- | --- | --- |
| WhatsApp (Baileys) | Socket | `webhook` | WhatsApp's offline queue | Anything past that queue. The signal store sits in memory per connection |
| WhatsApp (Twilio) | Webhook | `history` | The Messages list by thread and date, never `complete` | Deletes, and a thread with no stored message. It reads each message's date back, one call per delivery |
| Telegram | Webhook | `webhook` | Telegram's retries for about a day | Anything past them, and every delete: bots get no history and no delete events. Files over 20 MB stay named only |
| Slack | Events API webhook | `history` | `conversations.history` and `.replies` | Deletes once a read stops short, past 999 messages or the 10 newest reply threads. Existing apps must add `files:read` |
| Discord | Gateway socket | `history` | RESUME for a few minutes, then `GET /channels/{id}/messages` | Windows over 500 messages repair the oldest 500. A store refused past the session's life waits for the daily repair |
| WeChat | Encrypted push | `webhook` | Three attempts, each five seconds | Anything past them. A file not fetched within three seconds stays named only |
| Email (IMAP) | `IDLE` | `history` | A window's UIDs, with `QRESYNC` for live deletes where the server offers it | Mail older than 7 days or past 1,000 messages. Mail moved out of the folder counts as deleted |
| Google Calendar | Push hint | `changes` | `syncToken`, then a snapshot on 410 | Nothing of note |

No chat provider polls. Three hold a standing socket per connection, and Mattermost and Weixin hold one as well.

Treat an event as a hint and replay as the proof. A send is a separate question: after a timeout the outcome is unknown, and only a platform that dedupes on our key may repeat it.

## Which platforms

Every platform below is our own code, in `packages/providers/src/chat/<id>/`, built on one contract, `ChatPlatform` in `chat/adapter.ts`. An adapter verifies a delivery, parses it, sends, and reads history. The shared base owns everything a link owes the engine: the settings form, storing before acknowledging, file downloads, the change log's cursor and the daily repair. Where a platform publishes its own SDK the adapter uses it, loaded on first use, so a platform nobody connects costs nothing.

Slack, Discord, Telegram, WeChat, WhatsApp (Baileys and Twilio) and email (IMAP) are older providers with their own directories, outside this contract, and share its levels.

The connection form names each platform's route. `Official API` talks to the platform directly. `Via <gateway>` goes through a third party, which sees the messages and can change or stop. It also states the level below.

### Levels of consistency

A delivery is a hint. Webhooks drop, and people delete messages. What stays correct depends on what the platform lets us read back, so every platform declares one of three levels, and a connection that does not implement its level refuses to pair.

| Level | What the platform offers | What Norbital does | What is recovered |
| --- | --- | --- | --- |
| `changes` | A change log read from a cursor | Reads it at connect, on a push that carries no message, and daily. The cursor moves only once what it covers is stored | Every new message and delete in the log's retention. If the cursor expired, the connection page says messages from the gap may be missing |
| `history` | Threads that can be read back | At connect and daily, compares each active thread with the platform | Missed messages and edits. Deletes only where the platform shows the whole window, which `complete` declares |
| `webhook` | Neither | Stores before acknowledging, so the platform's own retries work | Only what the platform retries. A message lost beyond that is gone, and a delete with no event stays |

A repair reads active threads only: activity in the last 7 days, 200 threads at most per connection, one at a time, compared with at most 1,000 stored rows. No scan of the database happens, and a pass that finds nothing writes nothing. A connection with no recent thread asks the database once and then nothing until a message moves.

| Level | Platforms |
| --- | --- |
| `changes` | Gmail, iMessage (Photon), Google Calendar |
| `history` | Slack, Discord, email (IMAP), WhatsApp (Twilio), Google Chat, Lark / Feishu, Webex, Mattermost, X, XChat, WhatsApp (Kapso), SMS (Twilio), iMessage (Sendblue, Linq, Blooio), Dial, Zernio, GitHub, GitLab, Linear, Liveblocks, Velt, Resend |
| `webhook` | Telegram, WeChat, WhatsApp (Baileys), Microsoft Teams, WeCom, Messenger, Instagram, WhatsApp Business Cloud, LINE, Zalo, QQ, Weixin, Twitch, Notion, Novu, AgentPhone |

No level promises these:

- A repaired message's files keep their name and size, not their content. Reading bytes daily for a window would download every file again.
- A thread with no activity for 7 days is not compared, so a delete there stays.
- A repaired message is history. It starts no envoy turn unless it is new and recent enough that the sender may still be waiting.
- A delete means removed from the platform: an agent that already read a message keeps what it saw.
- Dial, X's post threads and WhatsApp (Twilio) never claim a complete read, so deletes are not found there.

A send is safe to retry only where a platform dedupes on our key: `idempotent` declares it, and a send with an unknown outcome is then repeated. Elsewhere the outcome stays unknown rather than risk a second message.

### Connecting one

1. Create a connection of the system `chat` definition. WhatsApp's providers stay under `whatsapp`.
2. Pair it, picking the platform as the provider. The form asks for that platform's settings, shows the webhook URL to register, and proves the settings with a call the platform answers.

Senders match no member on these platforms, so they admit only public envoys, except WhatsApp's providers. [Who counts as a member](#who-counts-as-a-member) covers the others. Sends carry text and, where listed, no attachments yet. Reactions and button presses are ignored.

Some platforms hand over a value only inside a delivery, such as Notion's verification token. The connection page shows it, and a person pastes it back.

What an adapter may keep in memory is bounded by `recent` in `chat/adapter.ts`, and a restart forgets it. QQ and Weixin use it for the message a reply must name: after a restart a QQ reply goes out as the bot's own message, and Weixin may refuse a send until the person writes again.

### Who counts as a member

An envoy treats a sender as a member only when the platform proves who they are. That decides a private envoy's admission and whether a direct message carries the member's authority.

| Channel | Linked by | Proof |
| --- | --- | --- |
| WhatsApp, Telegram | Phone, Telegram id | The platform's own account |
| Email (IMAP) | Address | The receiving server's top `Authentication-Results`, with DMARC passing for the `From` domain, or a DKIM signature aligned with it |
| Everything else | Nothing | Senders are never linked |

`From` is free text, and SPF proves only the envelope, so neither links anyone. A sender can add `Authentication-Results` headers but only below the receiving server's, so only the top one counts, and only when it names the server this mailbox trusts. Google's and Microsoft's are known. Any other server needs its name in the connection's Authentication server setting, and without it that mailbox links nobody.

Mail that fails is not dropped: it is an unknown sender. A public envoy answers it with its own policies alone, and a private one sends its fixed notice. Mail between two people on one Microsoft 365 tenant may carry no DMARC verdict, so it counts as unknown too.

### Adding a platform

1. Write `packages/providers/src/chat/<id>/index.ts` exporting a `ChatPlatform`, and add it to `chat/index.ts`.
2. Parse into `Incoming`. Answer `Unverified` for a bad signature, and a `PlatformError` with the status for a refusal.
3. Declare `consistency` by what the platform really offers. Claim `complete` only when one read covers the window, since a delete between pages could hide a live message.
4. Give the SDK a pinned entry in `peerDependencies`, optional, and import it dynamically.
5. Test it in `tests/chat/<id>.test.ts` against a faked API. `tests/chat/adapter.test.ts` refuses a platform without a test file.

A new driver is rarer: add it to `DRIVERS` with `conversation: { kind, handle }`, where `handle` names the member field senders match by.

### What a workspace can do alone

A workspace cannot supply a provider. A provider holds stored credentials, raw network access and direct `emit`, and it runs in the host outside the compute boundary, so tenant code there would escape the guest wall. An `http` connection cannot host an envoy either.

For a platform nobody supports, a webhook-triggered automation can still answer: `on: { webhook, verify }` receives the delivery, `ctx.ai` writes the reply, and `ctx.request` sends it. That is a one-way automation, not a channel: no conversation or transcript, no sender identity or limits, no typing or attachments, and it runs under fixed policies. `verify` covers the schemes in `WebhookScheme` only.
