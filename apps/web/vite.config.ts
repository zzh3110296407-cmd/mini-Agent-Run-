import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const clarifyZodAnnotationComments: Plugin = {
  name: 'clarify-zod-annotation-comments',
  apply: 'build',
  enforce: 'pre',
  transform(source, id) {
    if (!/\/node_modules\/zod\/v4\/core\/(?:regexes|util)\.js$/.test(id)) return;
    // Zod 4.6.7 mentions the purity marker in prose. Leave actual call annotations intact.
    const code = source.replace(/^((?:\/\/ Wrapped in a| \* esbuild will not drop a) )`@__PURE__`/gm, '$1pure-marked');
    if (code !== source) return { code, map: null };
  },
};

export default defineConfig(({ mode }) => {
  const port = Number(loadEnv(mode, '../..', 'PORT').PORT ?? 3001);

  return {
    plugins: [clarifyZodAnnotationComments, vue()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true },
      },
    },
  };
});
