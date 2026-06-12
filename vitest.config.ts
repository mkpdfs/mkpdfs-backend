import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@libs': path.resolve(__dirname, 'src/libs'),
      '@functions': path.resolve(__dirname, 'src/functions'),
      '@resources': path.resolve(__dirname, 'src/resources'),
    },
  },
});
