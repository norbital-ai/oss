// The suite's guest runner where a test composes a host itself (`HostPorts.guests`, `GuestIsolates`): bolt-cli's
// `nodeGuests`, which bolt-server and the test kit run on (Bolt carries none).
import { nodeGuests } from '../../../bolt-cli/src/guests.ts';

export const guests = nodeGuests();
