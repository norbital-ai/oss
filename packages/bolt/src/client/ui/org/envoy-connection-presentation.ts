export type EnvoyTransportConnectionView = Readonly<{
	state: 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'error';
	stored: boolean;
	retrying?: boolean;
}>;

/** A retry is still an active connection attempt, never a terminal transport failure. */
export const connectionIsRecovering = (
	connection: EnvoyTransportConnectionView | undefined
): boolean => connection?.state === 'connecting' && connection.retrying === true;

/** Destructive presentation is reserved for the provider's unrecoverable state. */
export const connectionIsTerminalError = (
	connection: EnvoyTransportConnectionView | undefined
): boolean => connection?.state === 'error';

export const connectionLabel = (
	connection: EnvoyTransportConnectionView | undefined,
	provider: string
): string => {
	if (connection === undefined) return 'Reading…';
	switch (connection.state) {
		case 'connected':
			return 'Connected';
		case 'pairing':
			return provider === 'whatsapp' ? 'Scan to pair' : 'Pairing';
		case 'connecting':
			return connection.retrying === true ? 'Reconnecting' : 'Connecting';
		case 'error':
			return 'Needs attention';
		default:
			return connection.stored ? 'Paired, not connected' : 'Not paired';
	}
};
