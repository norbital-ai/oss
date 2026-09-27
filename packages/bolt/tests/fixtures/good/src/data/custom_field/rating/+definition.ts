import { customField } from '../../../../../../../src/index.ts';

const f = customField({ description: 'A score', shape: { kind: 'int', min: 1, max: 5 } });
f.validate((v) => (v > 0 ? undefined : 'positive'));
export default f;
