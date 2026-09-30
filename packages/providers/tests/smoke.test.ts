import { expect, it } from 'vitest';
import * as providers from '../src/index.ts';

it('loads', () => expect(providers).toBeTypeOf('object'));
