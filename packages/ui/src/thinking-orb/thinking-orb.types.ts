export const THINKING_ORB_STATES = [
	'idle',
	'thinking',
	'searching',
	'listening',
	'working'
] as const;

export type ThinkingOrbState = (typeof THINKING_ORB_STATES)[number];
