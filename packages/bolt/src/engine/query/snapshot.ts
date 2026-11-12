import { Context } from 'effect';
import { BoltError } from '../../protocol/errors.ts';

/** Native MVCC visibility, retained only by the live reader that requested it. */
export type ReadSnapshot = {
	readonly minimum: bigint;
	readonly maximum: bigint;
	readonly active: string;
	readonly bytes: number;
};
export const ReadSnapshots = Context.Reference<Map<string, ReadSnapshot> | undefined>(
	'bolt/ReadSnapshots', { defaultValue: () => undefined }
);

/** PostgreSQL pg_snapshot text: xmin:xmax:comma-separated in-progress top-level xids. */
export function readSnapshot(value: string): ReadSnapshot {
	const match = /^(\d+):(\d+):((?:\d+(?:,\d+)*)?)$/.exec(value);
	const minimum = match?.[1], maximum = match?.[2], active = match?.[3];
	if (minimum === undefined || maximum === undefined || active === undefined || BigInt(minimum) > BigInt(maximum))
		throw BoltError.make('corrupt', 'decode', 'The database returned an invalid read snapshot.');
	return { minimum: BigInt(minimum), maximum: BigInt(maximum), active: `,${active},`, bytes: value.length };
}

/** Captures are committed transactions; visibility means this read already includes their effects. */
export function visibleIn(transaction: string, snapshot: ReadSnapshot): boolean {
	const xid = BigInt(transaction);
	return xid < snapshot.minimum || (xid < snapshot.maximum && !snapshot.active.includes(`,${xid},`));
}
