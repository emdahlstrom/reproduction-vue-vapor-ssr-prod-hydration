// Prove both bugs are the __DEV__ gate, and that the patch fixes both. The bundler
// build @vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js still carries the
// __DEV__ branches (isBlock/proxyRefs, setRef's setupState writes) that production
// dead-code-elimination strips; patch them back in there, rebuild the non-inline
// prod app, and drive a real browser at each patch level. node_modules is backed up
// and restored (self-heals from .orig if a run was killed mid-patch).
// Run after `pnpm install`:  node confirm.mjs
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { buildServeProbe, interactive } from './harness.mjs'

// The bundler build the installed vue actually uses — robust against stale or
// duplicate @vue+runtime-vapor@* copies in the pnpm store.
function runtimeBuild() {
  const fromVue = createRequire(createRequire(import.meta.url).resolve('vue/package.json'))
  const f = join(dirname(fromVue.resolve('@vue/runtime-vapor/package.json')), 'dist/runtime-vapor.esm-bundler.js')
  if (!existsSync(f)) throw new Error(`runtime-vapor bundler build not found: ${f} — run pnpm install`)
  return f
}

// #1 — handleSetupResult (packages/runtime-vapor/src/component.ts): restore the
// discriminator branch that prod DCE removes, so a non-inline setup()'s render() runs.
const FIX1 = [[
  /(\telse if \(setupResult === EMPTY_OBJ && component\.render\) instance\.block = callRender\(component\.render, instance, setupResult\);\n)(\telse instance\.block = setupResult;)/,
  (_, a, b) => `${a}\telse if (!isBlock(setupResult) && component.render) {\n\t\tinstance.setupState = proxyRefs(setupResult);\n\t\tinstance.block = callRender(component.render, instance, instance.setupState);\n\t}\n${b}`,
]]
// #1b — setRef (packages/runtime-vapor/src/apiTemplateRef.ts): make setupState and
// canSetSetupRef live in prod and ungate the setupState[ref] writes, so a string
// template ref reaches its setup variable.
const FIX1B = [
  [/const setupState = !!\(process\.env\.NODE_ENV !== "production"\) \? instance\.setupState \|\| \{\} : null;/, 'const setupState = instance.setupState || {};'],
  [/const canSetSetupRef = !!\(process\.env\.NODE_ENV !== "production"\) \? createCanSetSetupRefChecker\(setupState, refs\) : NO;/, 'const canSetSetupRef = createCanSetSetupRefChecker(setupState, refs);'],
  [/!!\(process\.env\.NODE_ENV !== "production"\) && canSetSetupRef\(/g, 'canSetSetupRef('],
]

function patch(file, fixes) {
  let src = readFileSync(file, 'utf8')
  for (const [re, rep] of fixes) {
    if (!re.test(src)) throw new Error(`patch target not found: ${re}`)
    src = src.replace(re, rep)
  }
  writeFileSync(file, src)
}

const errText = (r) => (r.error ? `  error=${r.error.split('\n')[0]}` : '')
const build = (opts) => buildServeProbe({ outDir: 'dist-confirm', minify: false, ...opts })

const rt = runtimeBuild()
const bak = `${rt}.orig`
if (existsSync(bak)) copyFileSync(bak, rt) // self-heal an interrupted run
copyFileSync(rt, bak)

let ok = true
try {
  // #1: assert the specific dead state unpatched, then interactivity once #1 is in.
  console.log('#1 handleSetupResult — non-inline prod is dead; the fix revives it:')
  const surfaces = [
    { label: 'hydration   (createVaporSSRApp)', opts: { input: 'index.html' }, dead: (r) => r.evtclick === 'undefined' && !r.reactive && !r.error },
    { label: 'fresh mount (createVaporApp)   ', opts: { input: 'mount.html', page: '/mount.html' }, dead: (r) => r.before === null && /reading 'anchor'/.test(r.error || '') },
  ]
  copyFileSync(bak, rt)
  const before = []
  for (const s of surfaces) before.push(await build(s.opts))
  patch(rt, FIX1)
  for (const [i, s] of surfaces.entries()) {
    const after = await build(s.opts)
    const pass = s.dead(before[i]) && interactive(after)
    ok &&= pass
    console.log(`  ${pass ? '✓' : '✗'} ${s.label}  unpatched dead=${s.dead(before[i])}${errText(before[i])}  →  patched interactive=${interactive(after)}`)
  }

  // #1b: with #1 the ref is still null; #1b makes it resolve. (#1 masks it until then.)
  console.log('\n#1b setRef — a setup-variable template ref, at three patch levels:')
  const levels = [
    { label: 'no fix  ', fixes: [], ok: (r) => r.before === null && /reading 'anchor'/.test(r.error || '') },
    { label: '#1 only ', fixes: FIX1, ok: (r) => r.before === 'ref-null' && !r.error },
    { label: '#1 + #1b', fixes: [...FIX1, ...FIX1B], ok: (r) => r.before === 'ref-ok' && !r.error },
  ]
  for (const lvl of levels) {
    copyFileSync(bak, rt)
    patch(rt, lvl.fixes)
    const r = await build({ input: 'ref.html', page: '/ref.html' })
    const pass = lvl.ok(r)
    ok &&= pass
    console.log(`  ${pass ? '✓' : '✗'} ${lvl.label}  onMounted=${r.before ?? '—'}${errText(r)}`)
  }
} finally {
  copyFileSync(bak, rt)
  rmSync(bak)
}

console.log(ok
  ? '\nConfirmed: both bugs are the __DEV__ gate. #1 revives the component; #1b then resolves the template ref.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
