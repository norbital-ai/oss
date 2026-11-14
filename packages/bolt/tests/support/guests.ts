// The suite's guest runner where a test composes a host itself (`HostPorts.guests`, `GuestIsolates`): bolt-cli's
// `node_guests`, which bolt-server and the test kit run on (Bolt carries none).
import { node_guests } from '@norbital-ai/host-api/node';

export const guests = node_guests();
