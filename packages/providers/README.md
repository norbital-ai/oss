# `@norbital-ai/providers`

The provider implementations behind Bolt's driver kinds and host ports. Workspaces name drivers and
facilities; a host registers these providers and injects them at the host boundary.

```ts
import { drivers } from '@norbital-ai/bolt-server';
```

Entries:

- `@norbital-ai/providers` — `defaultProviders()` (WhatsApp Web/Cloud, Telegram, Slack, Discord,
  WeChat, IMAP/SMTP mailbox, Google Calendar), `transactional()` host messaging, Twilio/Sinch/Resend
  adapters, OAuth helpers and speech
- `@norbital-ai/providers/abi` — the provider ABI and `toDrivers()`
- `@norbital-ai/providers/openrouter` — OpenRouter speech and embeddings
- `@norbital-ai/providers/errors` — shared provider failures

Each integration instance pairs with its own account and seals its credentials on the host; the
package reads no host environment. `@whiskeysockets/baileys` is an optional dependency of the
WhatsApp Web provider.
