// Squashes server.js plus all its libraries into ONE file so the packaged app
// can't miss a dependency.
import { build } from 'esbuild';

await build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'server.bundle.mjs',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
