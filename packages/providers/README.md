# `@norbital-ai/providers`

Bolt's built-in integration drivers. Workspaces name drivers; a host registers these providers at the
host boundary. Facility adapters (mail, sms, phone, speech) belong to the host that writes them; bolt-server's
are an example.

```ts
import { drivers } from '@norbital-ai/bolt-server';
```

Entries:

- `@norbital-ai/providers` — `default_providers()` (WhatsApp Web/Twilio, Telegram, Slack, Discord,
  WeChat, IMAP/SMTP mailbox, Google Calendar, and every platform under `src/chat/`), OAuth helpers and
  the shared HTTP answer decoding
- `@norbital-ai/providers/abi` — the provider ABI and `to_drivers()`
- `@norbital-ai/providers/openrouter` — OpenRouter chat and embeddings
- `@norbital-ai/providers/errors` — shared provider failures

Each integration instance pairs with its own account and seals its credentials on the host; the
package reads no host environment. `@whiskeysockets/baileys` is an optional dependency of the
WhatsApp Web provider, and each chat platform's own SDK is an optional peer, loaded on first use.

Embedding hosts bind `open_ai_embeddings`'s `files(key, max)` to their tenant-scoped file reader.
The engine sends stored-file metadata; the provider loads each batch in the host, so image bytes
do not cross the Cell. Inline file bytes remain available for host-supplied inputs. File reads
share the embedding call's cancellation and propagate their original failure.
