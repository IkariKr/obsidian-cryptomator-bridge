import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron'],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  outfile: 'main.js',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  define: {
    __PLUGIN_VERSION__: JSON.stringify(manifest.version),
  },
});
