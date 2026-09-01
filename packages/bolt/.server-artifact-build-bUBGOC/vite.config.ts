import { defineConfig } from 'vite';
import { bolt } from '@norbital-ai/bolt/vite';

export default defineConfig({ plugins: [bolt()] });
