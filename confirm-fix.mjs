// Decisive confirmation. Applies the proposed fix (one discriminator branch) to the
// @vue/runtime-vapor SOURCE (where isBlock and proxyRefs still exist — both are
// dead-code-eliminated from the built production bundle), rebuilds the non-inline
// production app, and drives a real browser against both failure surfaces —
// hydration and fresh mount — unpatched vs patched. node_modules is backed up and
// restored (self-healed from .orig if a previous run was killed mid-patch). Run
// after `pnpm install`:  node confirm-fix.mjs
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServeProbe, interactive } from './harness.mjs'

// Locate @vue/runtime-vapor's bundler source (the version hash is in the path).
function runtimeSource() {
  const base = 'node_modules/.pnpm'
  const dir = readdirSync(base).find((d) => d.startsWith('@vue+runtime-vapor@'))
  if (!dir) throw new Error('@vue/runtime-vapor not found under node_modules/.pnpm — run pnpm install')
  const f = join(base, dir, 'node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js')
  if (!existsSync(f)) throw new Error(`runtime source missing: ${f}`)
  return f
}

// In production, handleSetupResult collapses to the EMPTY_OBJ check plus a bare
// else that assigns the setup() bindings object as instance.block. The fix inserts
// the discriminator branch — the exact diff from README "Root cause".
const TARGET =
  /(\telse if \(setupResult === EMPTY_OBJ && component\.render\) instance\.block = callRender\(component\.render, instance, setupResult\);\n)(\telse instance\.block = setupResult;)/
const FIX = `\telse if (!isBlock(setupResult) && component.render) {
\t\tinstance.setupState = proxyRefs(setupResult);
\t\tinstance.block = callRender(component.render, instance, instance.setupState);
\t}
`

function applyFix(file) {
  const src = readFileSync(file, 'utf8')
  if (!TARGET.test(src)) throw new Error('handleSetupResult source shape changed; cannot apply the fix.')
  writeFileSync(file, src.replace(TARGET, (_, head, tail) => head + FIX + tail))
}

const errText = (r) => (r.error ? ` error=${r.error.split('\n')[0]}` : '')

const surfaces = [
  { outDir: 'dist-fix-index', label: 'hydration  (createVaporSSRApp, pre-rendered button)', opts: { input: 'index.html', minify: false } },
  { outDir: 'dist-fix-mount', label: 'fresh mount (createVaporApp, empty #app)', opts: { input: 'mount.html', page: '/mount.html', minify: false } },
]
const probeSurface = (s) => buildServeProbe({ outDir: s.outDir, ...s.opts })

const rt = runtimeSource()
const bak = `${rt}.orig`
if (existsSync(bak)) copyFileSync(bak, rt) // self-heal a previous interrupted run
copyFileSync(rt, bak)

let ok = true
try {
  const before = []
  for (const s of surfaces) before.push(await probeSurface(s))
  applyFix(rt)
  const after = []
  for (const s of surfaces) after.push(await probeSurface(s))

  surfaces.forEach((s, i) => {
    const pass = !interactive(before[i]) && interactive(after[i])
    ok &&= pass
    console.log(`${pass ? '✓' : '✗'} ${s.label}`)
    console.log(`    unpatched: interactive=${interactive(before[i])} $evtclick=${before[i].evtclick}${errText(before[i])}`)
    console.log(`    patched:   interactive=${interactive(after[i])} $evtclick=${after[i].evtclick}${errText(after[i])}`)
  })
} finally {
  copyFileSync(bak, rt)
  rmSync(bak)
}

console.log(ok
  ? '\nConfirmed: the handleSetupResult fix makes both surfaces interactive. Root cause, not symptom.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
