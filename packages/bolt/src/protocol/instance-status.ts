// An integration instance's status as the shell reads it: its operator text in a locale, and the one `InstanceStatus`
// the shell draws, decoded at the trust boundary by its Schema (`@norbital-ai/host-api`).
import { Option, Schema } from 'effect';
import type { Json } from '../decl/values.ts';
import { InstanceStatus, type LocalText } from '@norbital-ai/host-api';

/** `x` in `locale`, English when it has none. */
export const local_text = (x: LocalText, locale: string): string =>
	typeof x === 'string' ? x : locale.startsWith('zh') ? (x.zh ?? x.en) : x.en;

const decode = Schema.decodeUnknownOption(InstanceStatus);
/** Decodes a host's answer at the trust boundary. `null` for anything malformed: the host's bug, never a page's. */
export const decode_status = (v: Json): InstanceStatus | null => Option.getOrNull(decode(v));
