// `off`: the one way a host leaves a facility member out (plan 01). It is a value, so it crosses HOST_API's module graphs
// by its tag, never by identity.
export const off = { _tag: 'Off' } as const;
export type Off = typeof off;
export const isOff = (value: object): value is Off => '_tag' in value && value._tag === 'Off';
