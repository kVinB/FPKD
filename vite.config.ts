import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { computeBuildVersion } from './scripts/build-version.mjs';

export default defineConfig(({ command }) => {
  const buildVersion =
    process.env.BUILD_VERSION?.trim() ||
    (command === 'serve' ? 'dev' : computeBuildVersion());

  return {
    root: 'web',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
        '@web': fileURLToPath(new URL('./web/src', import.meta.url)),
      },
    },
    define: {
      __BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
    },
  };
});
