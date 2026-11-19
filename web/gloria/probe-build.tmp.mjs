import { build } from 'vite';
process.env.GLORIA_BRIDGE_REPORT = '1';
await build({ configFile: '/Users/mutolisp/Documents/applications/checklister-ng/web/gloria/vite.config.ts', logLevel: 'silent',
  build: { outDir: '/private/tmp/claude-501/-Users-mutolisp-Documents-applications-checklister-ng/9729716e-3c6e-4224-8bc4-65002f482a4d/scratchpad/probe/out', emptyOutDir: true, write: false, rolldownOptions: { input: 'src/probe.tsx' } },
}).catch((e) => console.error('BUILD ERROR', String(e).replace(/\x1b\[[0-9;]*m/g,'').slice(0, 200000)));
