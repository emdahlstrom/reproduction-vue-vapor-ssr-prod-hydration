// Decisive confirmation of the root cause. Builds the non-inline PRODUCTION app
// UNMINIFIED, rewrites the one handleSetupResult branch in the built bundle to
// restore the isBlock discriminator that __DEV__ gating strips, then drives a
// real browser against both failure surfaces — hydration and fresh mount —
// patched vs unpatched. Run after `pnpm install`:
//
//   node confirm-fix.mjs
//
// If the single patch makes both surfaces interactive, handleSetupResult is the
// cause, not a symptom. See README "Root cause".
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { build } from 'vite'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

function serve(root) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0])
    let f = normalize(join(root, p))
    if (!f.startsWith(root)) return res.writeHead(403).end()
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
    if (!existsSync(f)) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
    res.end(readFileSync(f))
  })
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => server.close() })),
  )
}

async function probe(url) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)
    if ((await page.locator('button').count()) === 0) {
      return { interactive: false, evtclick: null, error: errors[0] || null }
    }
    const btn = page.getByRole('button', { name: /count is/ })
    const before = (await btn.textContent())?.trim()
    const evtclick = await btn.evaluate((el) => typeof el.$evtclick)
    await btn.click()
    await page.waitForTimeout(100)
    const after = (await btn.textContent())?.trim()
    return { interactive: before !== after && evtclick === 'function', evtclick, error: errors[0] || null }
  } finally {
    await browser.close()
  }
}

async function buildProdUnminified(outDir, input) {
  await build({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    plugins: [vue({ features: { prodDevtools: true } })],
    build: {
      outDir,
      emptyOutDir: true,
      minify: false, // keep the runtime readable so the patch target is stable
      rollupOptions: { input: resolve(process.cwd(), input) },
    },
  })
}

// Vite can emit several JS chunks; pick the one that actually holds
// handleSetupResult rather than assuming it is the first file.
function bundleFile(outDir) {
  const dir = join(outDir, 'assets')
  const name = readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .find((n) => STRIPPED.test(readFileSync(join(dir, n), 'utf8')))
  if (!name) throw new Error(`no bundle under ${dir} contains handleSetupResult`)
  return join(dir, name)
}

// handleSetupResult in the production bundle, discriminator stripped. setup()
// returns the bindings object, so setupResult !== EMPTY_OBJ, the first branch is
// dead, and the bindings object is wrongly assigned as instance.block.
const STRIPPED =
  /if \(setupResult === EMPTY_OBJ && component\.render\) instance\.block = callRender\(component\.render, instance, setupResult\);\s*else instance\.block = setupResult;/

// isBlock and proxyRefs are dead-code-eliminated from the prod bundle. Inline
// isBlock's body (Array.isArray stands in for the absent isArray helper) and use
// reactive for proxyRefs — same ref-unwrap-on-get/set behavior for this case.
// isVaporComponent, isFragment, callRender and reactive all survive in the bundle.
const PATCHED = `if (setupResult === EMPTY_OBJ && component.render) instance.block = callRender(component.render, instance, setupResult);
\telse if (!(setupResult instanceof Node || Array.isArray(setupResult) || isVaporComponent(setupResult) || isFragment(setupResult)) && component.render) {
\t\tinstance.setupState = reactive(setupResult);
\t\tinstance.block = callRender(component.render, instance, instance.setupState);
\t}
\telse instance.block = setupResult;`

function patch(file) {
  const src = readFileSync(file, 'utf8')
  const matches = src.match(new RegExp(STRIPPED, 'g'))
  if (!matches) throw new Error(`handleSetupResult shape not found in ${file}; the bundle changed — update STRIPPED.`)
  if (matches.length !== 1) throw new Error(`expected exactly one handleSetupResult, found ${matches.length}`)
  writeFileSync(file, src.replace(STRIPPED, PATCHED))
}

async function run(outDir, page) {
  const srv = await serve(join(process.cwd(), outDir))
  const r = await probe(`http://127.0.0.1:${srv.port}${page}`)
  srv.close()
  return r
}

const surfaces = [
  { label: 'hydration  (createVaporSSRApp, pre-rendered button)', input: 'index.html', page: '/' },
  { label: 'fresh mount (createVaporApp, empty #app)', input: 'mount.html', page: '/mount.html' },
]

let ok = true
for (const s of surfaces) {
  const outDir = `dist-fix-${s.input.replace('.html', '')}`
  await buildProdUnminified(outDir, s.input)
  const before = await run(outDir, s.page)
  patch(bundleFile(outDir))
  const after = await run(outDir, s.page)
  const pass = before.interactive === false && after.interactive === true && !after.error
  ok &&= pass
  console.log(`${pass ? '✓' : '✗'} ${s.label}`)
  console.log(`    unpatched: interactive=${before.interactive} $evtclick=${before.evtclick}${before.error ? ` error=${before.error.split('\n')[0]}` : ''}`)
  console.log(`    patched:   interactive=${after.interactive} $evtclick=${after.evtclick}${after.error ? ` error=${after.error.split('\n')[0]}` : ''}`)
}

console.log(ok
  ? '\nConfirmed: one handleSetupResult branch fixes both surfaces. Root cause, not symptom.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
