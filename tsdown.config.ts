/**
 * Build the browser half of `dsh-cron`.
 *
 * The artifact is a closure-factory bundle: it calls
 * `window.__ModuleLoader__.load({ id, factory })` and resolves every platform
 * module through the injected `require` (the shell's frozen module table), so
 * the plugin shares React, the slot registry and the design primitives with
 * the host page instead of inlining a second copy.
 *
 * Everything that is NOT a platform module is inlined, because the module
 * table cannot answer a `require()` for it. One bundle, no CSS pipeline: styles
 * ship as a scoped string from `src/client/styles.ts`.
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the shell shares into the frozen module table. */
const PLATFORM_MODULES: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Plugin id: the graph row id, the style-tag marker, and the bundle id. */
const ID = 'dsh-cron'

export default {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // Platform modules stay external (the shell's module table answers them);
  // every other dependency is inlined, and `zod` has to be named explicitly
  // because it is a production dependency — the table has no `zod` entry, so
  // a `require("zod")` in this bundle would fail to materialize in the browser.
  deps: { neverBundle: [...PLATFORM_MODULES], alwaysBundle: ['zod'] },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig
