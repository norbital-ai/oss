// The channel simulator as its own process: `node --experimental-strip-types main.ts [port]`.
import { startSimulator } from './server.ts';

const running = await startSimulator(Number(process.argv[2] ?? 5196));
console.log(`channel simulator on ${running.url}`);
