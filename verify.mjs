// Self-contained reproduction check (one process — builds, serves, drives a real
// browser, asserts). Run: `pnpm verify` (after `pnpm prerender`).
//
// Builds the same app three ways and hydrates each in headless Chromium:
//   1. NON-INLINE compile + PROD runtime   (what an Astro prod build emits)  -> BROKEN
//   2. INLINE compile + PROD runtime        (default `vite build`)            -> works
//   3. NON-INLINE compile + DEV runtime     (control)                        -> works
//
// It checks two things on the page:
//   A. a self-contained counter button (clicking increments its own text), and
//   B. a CROSS-COMPONENT case: a child checkbox whose @change emits to a parent
//      that derives a SUM ("N of 3 checked"). This is the realistic symptom —
//      the checkbox may toggle *natively* in the browser even when dead, so the
//      reliable signal is whether the parent's SUM updates.
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { build } from 'vite'

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
    configFile: false, // supply the plugin here so each variant controls inline vs non-inline
    logLevel: 'error',
    plugins: [vue(pluginOpts)],
    resolve: devRuntime
      ? { alias: { vue: 'vue/dist/vue.runtime-with-vapor.esm-browser.js' } }
      : undefined,
    build: { outDir, emptyOutDir: true },
  })
}

async function probe(url) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)

    const counter = page.getByRole('button', { name: /count is/ })
    const sum = page.getByTestId('sum')
    const box = page.locator('input[type=checkbox]').first()
    const self = page.locator('button.self').first() // child-owned reactive state

    const counterBefore = (await counter.textContent())?.trim()
    const sumBefore = (await sum.textContent())?.trim()
    const selfBefore = (await self.textContent())?.trim()

    await counter.click() // self-state of a standalone component
    await self.click() // the INTERACTED child's OWN reactive state
    await box.click() // cross-component: child @change -> parent toggle -> computed sum
    await page.waitForTimeout(150)

    return {
      counter: `${counterBefore} -> ${(await counter.textContent())?.trim()}`,
      counterReactive: counterBefore !== (await counter.textContent())?.trim(),
      childSelf: `${selfBefore} -> ${(await self.textContent())?.trim()}`,
      childSelfReactive: selfBefore !== (await self.textContent())?.trim(),
      checkboxNativeChecked: await box.isChecked(), // the browser toggles this even when dead
      sum: `${sumBefore} -> ${(await sum.textContent())?.trim()}`,
      sumReactive: sumBefore !== (await sum.textContent())?.trim(),
    }
  } finally {
    await browser.close()
  }
}

const variants = [
  { label: 'NON-INLINE + PROD runtime  [the bug]', outDir: 'dist-noninline', opts: { features: { prodDevtools: true } }, dev: false, expectReactive: false },
  { label: 'INLINE + PROD runtime', outDir: 'dist-inline', opts: {}, dev: false, expectReactive: true },
  { label: 'NON-INLINE + DEV runtime (control)', outDir: 'dist-noninline-dev', opts: { features: { prodDevtools: true } }, dev: true, expectReactive: true },
]

let allPass = true
for (const v of variants) {
  await buildVariant(v.outDir, v.opts, v.dev)
  const srv = await serve(join(process.cwd(), v.outDir))
  const r = await probe(`http://127.0.0.1:${srv.port}/`)
  srv.close()
  // The reliable signal is reactivity (counter text + parent SUM), not the
  // checkbox's native checked state (which flips in the browser regardless).
  const pass =
    r.counterReactive === v.expectReactive &&
    r.childSelfReactive === v.expectReactive &&
    r.sumReactive === v.expectReactive
  allPass &&= pass
  console.log(
    `${pass ? '✓' : '✗'} ${v.label}\n` +
      `    standalone counter:        ${r.counter}   (reactive=${r.counterReactive})\n` +
      `    interacted child OWN state: ${r.childSelf}   (reactive=${r.childSelfReactive})\n` +
      `    parent SUM (cross-comp):    ${r.sum}   (reactive=${r.sumReactive})\n` +
      `    checkbox native checked=${r.checkboxNativeChecked}  <- flips even when dead`,
  )
}

console.log(
  allPass
    ? '\nReproduced. Note the deceptive case: in the broken build the checkbox\nappears checked (native) but the parent SUM never updates.'
    : '\nUnexpected result — the contrast did not hold.',
)
process.exit(allPass ? 0 : 1)
