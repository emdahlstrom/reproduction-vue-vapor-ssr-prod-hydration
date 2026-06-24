// Reproduce the bug: build Counter four ways and drive each in headless Chromium.
// non-inline + prod is dead — inert when hydrated, crashes when mounted fresh;
// inline + prod and the dev runtime are interactive. Run after `pnpm install`.
import { buildServeProbe, interactive } from './harness.mjs'

const variants = [
  { outDir: 'dist-noninline', label: 'non-inline + prod, hydration  [the bug]', opts: {}, ok: (r) => r.reactive === false && r.evtclick === 'undefined' && !r.error },
  { outDir: 'dist-inline', label: 'inline + prod, hydration', opts: { inline: true }, ok: interactive },
  { outDir: 'dist-noninline-dev', label: 'non-inline + dev, hydration (control)', opts: { dev: true }, ok: interactive },
  { outDir: 'dist-noninline-mount', label: 'non-inline + prod, fresh mount [crashes, no SSR]', opts: { input: 'mount.html', page: '/mount.html' }, ok: (r) => r.before === null && /reading 'anchor'/.test(r.error || '') },
]

let ok = true
for (const v of variants) {
  const r = await buildServeProbe({ outDir: v.outDir, ...v.opts })
  const pass = v.ok(r)
  ok &&= pass
  const tail = r.error ? `  error=${r.error.split('\n')[0]}` : ''
  console.log(`${pass ? '✓' : '✗'} ${v.label}: "${r.before}" -> "${r.after}"  $evtclick=${r.evtclick}  reactive=${r.reactive}${tail}`)
}

console.log(ok
  ? '\nReproduced: non-inline + prod is broken — inert when hydrated, crashes when mounted fresh; inline + prod and the dev runtime are interactive.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
