// The wire vocabulary of an integration instance (§4.5), shared by the host verbs (`protocol/integrations.ts`), the
// links manager and the browser (`client/integrations.ts`, the shell's setup views): where a link is, what its
// provider asks of the operator (a setup is data, P18), and the one `InstanceStatus` the shell draws, decoded at the
// trust boundary by its Schema (`schema.ts`).
import { Option, Schema } from 'effect';
import type { Json } from '../decl/values.ts';
import { InstanceStatus, type LocalText } from './schema.ts';

export type {
	InstanceState,
	InstanceStatus,
	IntegrationOffer,
	LinkStatus,
	LocalText,
	Pairing,
	ProviderChoice,
	SetupDescription,
	SetupField,
	SetupStep,
	TestSend
} from './schema.ts';

/** `x` in `locale`, English when it has none. */
export const localText = (x: LocalText, locale: string): string =>
	typeof x === 'string' ? x : locale.startsWith('zh') ? (x.zh ?? x.en) : x.en;

const decode = Schema.decodeUnknownOption(InstanceStatus);
/** Decodes a host's answer at the trust boundary. `null` for anything malformed: the host's bug, never a page's. */
export const decodeStatus = (v: Json): InstanceStatus | null => Option.getOrNull(decode(v));
