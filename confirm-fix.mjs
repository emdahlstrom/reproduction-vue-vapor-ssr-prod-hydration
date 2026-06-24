// Decisive confirmation of the root cause. Applies the proposed one-line fix to
// the @vue/runtime-vapor SOURCE (where isBlock and proxyRefs still exist — both
// are dead-code-eliminated from the built production bundle), rebuilds the
// non-inline production app, and drives a real browser against both failure
// surfaces — hydration and fresh mount — unpatched vs patched. Run after
// `pnpm install`:
//
//   node confirm-fix.mjs
//
// node_modules is backed up to a .orig file and restored in a finally block (and
// self-healed from .orig at startup if a previous run was killed mid-patch). If
// the single fix makes both surfaces interactive, handleSetupResult is the cause,
// not a symptom. See README "Root cause".
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
      minify: false,
      rollupOptions: { input: resolve(process.cwd(), input) },
    },
  })
}

// Locate @vue/runtime-vapor's bundler source (version hash is part of the path).
function runtimeSource() {
  const base = 'node_modules/.pnpm'
  const dir = readdirSync(base).find((d) => d.startsWith('@vue+runtime-vapor@'))
  if (!dir) throw new Error('@vue/runtime-vapor not found under node_modules/.pnpm — run pnpm install')
  const f = join(base, dir, 'node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js')
  if (!existsSync(f)) throw new Error(`runtime source missing: ${f}`)
  return f
}

// In production, handleSetupResult collapses to the EMPTY_OBJ check + a bare else
// that assigns the setup() bindings object as instance.block. The proposed fix
// inserts the discriminator branch — the exact diff from README "Root cause".
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

async function run(outDir, input, page) {
  await buildProdUnminified(outDir, input)
  const srv = await serve(join(process.cwd(), outDir))
  const r = await probe(`http://127.0.0.1:${srv.port}${page}`)
  srv.close()
  return r
}

const surfaces = [
  { label: 'hydration  (createVaporSSRApp, pre-rendered button)', input: 'index.html', page: '/', outDir: 'dist-fix-index' },
  { label: 'fresh mount (createVaporApp, empty #app)', input: 'mount.html', page: '/mount.html', outDir: 'dist-fix-mount' },
]

const rt = runtimeSource()
const bak = `${rt}.orig`
if (existsSync(bak)) copyFileSync(bak, rt) // self-heal a previous interrupted run
copyFileSync(rt, bak)

let ok = true
try {
  const before = []
  for (const s of surfaces) before.push(await run(s.outDir, s.input, s.page))
  applyFix(rt)
  const after = []
  for (const s of surfaces) after.push(await run(s.outDir, s.input, s.page))

  surfaces.forEach((s, i) => {
    const pass = before[i].interactive === false && after[i].interactive === true && !after[i].error
    ok &&= pass
    console.log(`${pass ? '✓' : '✗'} ${s.label}`)
    console.log(`    unpatched: interactive=${before[i].interactive} $evtclick=${before[i].evtclick}${before[i].error ? ` error=${before[i].error.split('\n')[0]}` : ''}`)
    console.log(`    patched:   interactive=${after[i].interactive} $evtclick=${after[i].evtclick}${after[i].error ? ` error=${after[i].error.split('\n')[0]}` : ''}`)
  })
} finally {
  copyFileSync(bak, rt)
  rmSync(bak)
}

console.log(ok
  ? '\nConfirmed: the one-line handleSetupResult fix makes both surfaces interactive. Root cause, not symptom.'
  : '\nUnexpected result.')
process.exit(ok ? 0 : 1)
