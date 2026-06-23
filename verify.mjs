// Self-contained reproduction check (one process — builds, serves, drives a real
// browser, asserts). Run: `pnpm verify` (after `pnpm prerender`).
//
// Builds the same app twice — once with NON-INLINE template compilation
// (features.prodDevtools, what Astro's prod build emits) and once with the
// default INLINE compilation — both with the production Vue runtime. Then it
// hydrates each in headless Chromium and clicks the button.
//
// Expected: non-inline is DEAD (count stays 0, button has no $evtclick),
// inline is interactive. Exits non-zero if that contrast does not hold.
import { join, normalize, extname } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

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
    server.listen(0, '127.0.0.1', () =>
      r({ port: server.address().port, close: () => server.close() }),
    ),
  )
}

async function buildVariant(outDir, pluginOpts, devRuntime = false) {
  await build({
    root: process.cwd(),
    // Don't load vite.config.ts — we supply the plugin here so each variant
    // controls inline vs non-inline compilation explicitly (loading the config
    // too would run the vue plugin twice).
    configFile: false,
    logLevel: 'error',
    plugins: [vue(pluginOpts)],
    // devRuntime: force the *development* with-vapor runtime (__DEV__=true).
    resolve: devRuntime
      ? { alias: { vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' } }
      : undefined,
    build: { outDir, emptyOutDir: true },
  })
}

async function check(url) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle' })
    const btn = page.locator('#app button')
    const before = (await btn.textContent())?.trim()
    const evtclick = await btn.evaluate((el) => typeof el.$evtclick)
    await btn.click()
    await page.waitForTimeout(100)
    const after = (await btn.locator(':scope').textContent())?.trim()
    return { before, after, evtclick, interactive: before !== after }
  } finally {
    await browser.close()
  }
}

const variants = [
  { label: 'NON-INLINE compile (Astro-style) + PROD runtime  [the bug]', outDir: 'dist-noninline', opts: { features: { prodDevtools: true } }, dev: false, expectInteractive: false },
  { label: 'INLINE compile (default vite build) + PROD runtime', outDir: 'dist-inline', opts: {}, dev: false, expectInteractive: true },
  { label: 'NON-INLINE compile + DEV runtime (control)', outDir: 'dist-noninline-dev', opts: { features: { prodDevtools: true } }, dev: true, expectInteractive: true },
]

let allPass = true
for (const v of variants) {
  await buildVariant(v.outDir, v.opts, v.dev)
  const srv = await serve(join(process.cwd(), v.outDir))
  const r = await check(`http://127.0.0.1:${srv.port}/`)
  srv.close()
  const pass = r.interactive === v.expectInteractive
  allPass &&= pass
  console.log(
    `${pass ? '✓' : '✗'} ${v.label}\n    "${r.before}" -> "${r.after}"  | $evtclick=${r.evtclick} | interactive=${r.interactive} (expected ${v.expectInteractive})`,
  )
}

console.log(
  allPass
    ? '\nReproduced: the NON-INLINE production build is not interactive; the INLINE one is.'
    : '\nUnexpected result — the contrast did not hold.',
)
process.exit(allPass ? 0 : 1)
