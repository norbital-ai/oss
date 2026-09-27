import { app } from '../../../../../../../src/index.ts';

export default app('hr/kiosk', { title: 'Kiosk', description: 'Clock in', icon: 'clock', pages: { clock: { title: 'Clock', kiosk: true } } });
