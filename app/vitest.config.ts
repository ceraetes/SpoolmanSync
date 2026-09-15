import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // ha-config-generator transitively imports the Prisma client at module load;
    // point it at the existing dev SQLite db so imports succeed (no queries run).
    env: {
      DATABASE_URL: 'file:./dev.db',
    },
  },
});
