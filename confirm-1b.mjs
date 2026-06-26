// Confirmation for the second __DEV__-gated bug (#1b): a setup-variable template
// ref (`const el = ref(); ref="el"`) is null in non-inline prod even once #1
// (handleSetupResult) lets render() run, because setRef's `setupState[ref] = node`
// write is __DEV__-gated and dead-code-eliminated. Patches the @vue/runtime-vapor
// SOURCE at three levels (no fix, #1, #1 + #1b), fresh-mounts RefProbe, and reads
// what onMounted saw. node_modules is backed up and restored. Run after
// `pnpm install`:  node confirm-1b.mjs
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { buildApp, serve } from './harness.mjs'

function runtimeSource() {
  const base = 'node_modules/.pnpm'
  const dir = readdirSync(base).find((d) => d.startsWith('@vue+runtime-vapor@'))
  if (!dir) throw new Error('@vue/runtime-vapor not found — run pnpm install')
  const f = join(base, dir, 'node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js')
  if (!existsSync(f)) throw new Error(`runtime source missing: ${f}`)
  return f
}

// #1: restore the discriminator branch so render() runs at all (else the template
// ref is never even reached). Same fix as confirm-fix.mjs.
const FIX1 = [
  [/(\telse if \(setupResult === EMPTY_OBJ && component\.render\) instance\.block = callRender\(component\.render, instance, setupResult\);\n)(\telse instance\.block = setupResult;)/,
   (_, a, b) => `${a}\telse if (!isBlock(setupResult) && component.render) {\n\t\tinstance.setupState = proxyRefs(setupResult);\n\t\tinstance.block = callRender(component.render, instance, instance.setupState);\n\t}\n${b}`],
]
// #1b: make setupState + canSetSetupRef live in prod and ungate the setupState writes.
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

async function probe(outDir) {
  await buildApp({ outDir, input: 'ref.html', minify: false }) // non-inline prod
  const srv = await serve(join(process.cwd(), outDir))
  let browser
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`http://127.0.0.1:${srv.port}/ref.html`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(200)
    const button = (await page.locator('button').count()) > 0
    const text = button ? (await page.locator('button').textContent())?.trim() : null
    return { button, refValue: text, error: errors[0] || null }
  } finally {
    await browser?.close()
    srv.close()
  }
}

const levels = [
  { label: 'no fix          ', fixes: [], ok: (r) => !r.button && /reading 'anchor'/.test(r.error || '') },
  { label: '#1 only         ', fixes: FIX1, ok: (r) => r.button && r.refValue === 'ref-null' && !r.error },
  { label: '#1 + #1b        ', fixes: [...FIX1, ...FIX1B], ok: (r) => r.button && r.refValue === 'ref-ok' && !r.error },
]

const rt = runtimeSource()
const bak = `${rt}.orig`
if (existsSync(bak)) copyFileSync(bak, rt)
copyFileSync(rt, bak)

let ok = true
try {
  for (const lvl of levels) {
    copyFileSync(bak, rt)
    patch(rt, lvl.fixes)
    const r = await probe('dist-1b')
    const pass = lvl.ok(r)
    ok &&= pass
    console.log(`${pass ? '✓' : '✗'} ${lvl.label} button=${r.button} el.value=${r.refValue ?? '—'}${r.error ? ` error=${r.error.split('\n')[0]}` : ''}`)
  }
} finally {
  copyFileSync(bak, rt)
  rmSync(bak)
}

console.log(ok
  ? '\nConfirmed: #1 lets render() run; the setup-variable template ref then stays null until #1b ungates setRef. Two separate __DEV__-gated bugs.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
