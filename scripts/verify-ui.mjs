import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import fc from 'fast-check';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { largeLog, openOfflineWorkbench, slowPrompt } from './cli/e2e-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8', '.svg': 'image/svg+xml' };
const actionNames = [
  'create_session', 'switch_session', 'filter_sessions', 'rename_session', 'send_prompt',
  'stop_active_run', 'retry_stopped_run', 'toggle_inspector', 'choose_file', 'search_logs',
  'jump_error_line', 'toggle_inspector_fullscreen', 'toggle_theme', 'reload_page',
];

function settings() {
  const flags = parseArgs({ options: {
    seed: { type: 'string', default: '20261125' }, runs: { type: 'string', default: '5' },
    steps: { type: 'string', default: '12' }, help: { type: 'boolean' },
  } }).values;
  const { seed, runs, steps } = Object.fromEntries(['seed', 'runs', 'steps'].map((key) => [key, Number(flags[key])]));
  if (!flags.help) {
    assert.match(flags.seed, /^-?\d+$/u, '--seed must be an integer');
    assert.ok(Number.isSafeInteger(seed), '--seed must be a safe integer');
    for (const [label, value] of [['runs', runs], ['steps', steps]]) {
      assert.ok(/^\d+$/u.test(flags[label]) && Number.isSafeInteger(value) && value > 0, '--' + label + ' must be a positive safe integer');
    }
  }
  return { seed, runs, steps, help: flags.help };
}

async function hostUi(dist, backend) {
  const assets = new Map([['/', join(dist, 'index.html')], ['/index.html', join(dist, 'index.html')]]);
  for (const file of readdirSync(join(dist, 'assets'), { withFileTypes: true })) {
    if (file.isFile()) assets.set('/assets/' + file.name, join(dist, 'assets', file.name));
  }
  const inFlight = new Set();
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(backend);
      target.pathname = url.pathname;
      target.search = url.search;
      const upstream = proxyRequest(target, { method: incoming.method, headers: incoming.headers }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        outgoing.flushHeaders();
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      inFlight.add(upstream);
      upstream.once('close', () => inFlight.delete(upstream));
      upstream.on('error', () => {
        if (outgoing.destroyed) return;
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.once('close', () => upstream.destroy());
      incoming.on('error', () => upstream.destroy());
      incoming.pipe(upstream);
      return;
    }
    const file = assets.get(url.pathname);
    if (incoming.method !== 'GET' || !file) {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, inFlight, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}

async function launchBrowser() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = [
    ...(explicit ? [['configured executable', { executablePath: explicit }]] : []),
    ['Playwright Chromium', {}], ['msedge', { channel: 'msedge' }], ['chrome', { channel: 'chrome' }],
  ];
  const failures = [];
  for (const [name, options] of candidates) {
    try {
      const browser = await chromium.launch({ ...options, headless: true, timeout: 10_000 });
      return { browser, name };
    } catch (error) {
      failures.push(name + ': ' + String(error.message).split(/\r?\n/u)[0]);
    }
  }
  throw new Error('No local Chromium browser could launch.\n' + failures.join('\n'));
}

function controls(page) {
  const id = (name) => page.getByTestId(name);
  const active = () => id('session-item').and(page.locator('[data-active="true"]'));
  const card = (value) => id('session-item').and(page.locator('[data-session-id="' + value + '"]'));
  const block = (value) => id('run-turn-block').and(page.locator('[data-run-id="' + value + '"]'));
  const rawRows = () => id('log-line');
  const chooser = () => id('log-file-choose');
  let sequence = 0;
  let directoryId;

  async function createSession(directory = false) {
    const title = 'UI session ' + String(++sequence).padStart(6, '0');
    await id('new-session-btn').click();
    const modal = id('path-picker-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('allowed-root-chip')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /^(?:前往|浏览此路径)$/u })).toHaveCount(0);
    const address = modal.getByTestId('path-address-input');
    await address.fill('data/fixtures');
    await modal.getByTestId('fs-entry-row').filter({ hasText: 'diagnostic-demo' }).click();
    const entry = modal.getByTestId('fs-entry-row').filter({ hasText: 'agent-run-passed.jsonl' });
    await expect(entry).toBeVisible();
    if (!directory) {
      const filePath = await entry.getAttribute('data-entry-path');
      assert.ok(filePath);
      await address.fill(filePath);
      await address.press('Enter');
      await expect(entry).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(modal.getByTestId('path-selection-summary')).toContainText(directory ? '目录' : '单文件');
    await modal.getByTestId('session-title-trigger').click();
    const titleInput = modal.getByTestId('session-title-input');
    await titleInput.fill(title);
    await titleInput.press('Enter');
    await expect(modal.getByTestId('session-title-trigger')).toHaveText(title);
    await id('confirm-create-session-btn').click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('main h1')).toHaveText(title);
    await expect(id('empty-session-guide')).toBeVisible();
    const identifier = await active().getAttribute('data-session-id');
    assert.ok(identifier);
    if (directory) directoryId = identifier;
    return identifier;
  }

  async function select(identifier) {
    const row = card(identifier);
    if (await row.getAttribute('data-active') !== 'true') await row.click();
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(id('prompt-input')).toBeVisible();
  }

  async function stopIfRunning() {
    const stop = id('stop-run-btn');
    if (!await stop.isVisible()) return;
    const run = id('run-turn-block').and(page.locator('[data-run-status="running"],[data-run-status="pending"]'));
    await expect(run).toHaveCount(1);
    const runId = await run.getAttribute('data-run-id');
    assert.ok(runId);
    await stop.click();
    await expect(block(runId)).toHaveAttribute('data-run-status', 'stopped');
    await expect(id('prompt-input')).toBeEnabled();
  }

  async function sendPrompt() {
    await stopIfRunning();
    await id('prompt-input').fill(slowPrompt);
    await id('prompt-input').press('Enter');
    await expect(id('stop-run-btn')).toBeVisible();
    await expect(id('active-tool-status')).toContainText('check_runtime_diagnostics');
  }

  async function ensureLog() {
    await select(directoryId);
    if (!await id('log-inspector-drawer').isVisible()) await id('toggle-inspector-btn').click();
    await expect(id('log-inspector-drawer')).toBeVisible();
    await chooser().click();
    const file = id('log-file-option').filter({ hasText: largeLog });
    const path = await file.getAttribute('data-file-path');
    assert.ok(path);
    await file.click();
    await expect(id('log-source-type')).toHaveText('原文件');
    await expect(page.locator('#inspector-panel .source-name')).toHaveAttribute('title', path);

    const topbar = page.locator('.topbar');
    const header = page.locator('.session-header');
    const title = await header.getByRole('heading', { level: 1 }).innerText();
    const directory = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    assert.ok(title && directory);
    await expect(topbar).not.toContainText(title);
    await expect(topbar).not.toContainText(directory);
    await expect(topbar.locator('.topbar-context')).toHaveCount(0);
    await expect(header).toHaveText(title);
    await expect(header.locator('code')).toHaveCount(0);
    await expect(id('high-signal-jump-bar')).toHaveCount(0);
    await expect(id('log-view-mode-toggle')).toHaveCount(0);
    const error = id('log-error-jump').and(page.locator('[data-error-line="1100"]'));
    await expect(error.getByTestId('log-error-preview')).toHaveText(/^(?!\s*\{)\s*\S.+/u);
  }

  async function rawLog() {
    await ensureLog();
    await expect(rawRows().first()).toBeVisible();
    await expect(rawRows().first().getByTestId('log-line-text')).toHaveJSProperty('tagName', 'CODE');
  }

  const actions = {
    create_session: () => createSession(false),
    async switch_session() {
      const other = id('session-item').and(page.locator('[data-active="false"]')).first();
      const identifier = await other.getAttribute('data-session-id');
      assert.ok(identifier);
      await select(identifier);
    },
    async filter_sessions() {
      const title = await page.locator('main h1').innerText();
      const filter = id('session-filter-input');
      await filter.fill(title);
      await expect(id('session-item')).toHaveCount(1);
      await expect(active()).toContainText(title);
      await filter.clear();
    },
    async rename_session() {
      const title = 'Renamed session ' + String(++sequence).padStart(6, '0');
      await active().hover();
      await active().getByTestId('session-rename-btn').click();
      await id('session-rename-input').fill(title);
      await id('session-rename-input').press('Enter');
      await expect(page.locator('main h1')).toHaveText(title);
    },
    send_prompt: sendPrompt,
    async stop_active_run() {
      if (!await id('stop-run-btn').isVisible()) await sendPrompt();
      await stopIfRunning();
    },
    async retry_stopped_run() {
      await sendPrompt();
      await stopIfRunning();
      const run = id('run-turn-block').and(page.locator('[data-run-status="stopped"]')).last();
      const original = await run.getAttribute('data-run-id');
      assert.ok(original);
      await run.getByTestId('retry-run-btn').click();
      await expect(id('stop-run-btn')).toBeVisible();
      await expect(id('retry-origin-link').last()).toContainText(original);
    },
    async toggle_inspector() {
      const visible = await id('log-inspector-drawer').isVisible();
      await id('toggle-inspector-btn').click();
      if (visible) await expect(id('log-inspector-drawer')).toHaveCount(0);
      else await expect(id('log-inspector-drawer')).toBeVisible();
    },
    choose_file: rawLog,
    async search_logs() {
      await rawLog();
      const field = id('log-search-input');
      const query = await field.inputValue() === '<script' ? '<img' : '<script';
      await field.fill(query);
      await field.press('Enter');
      await expect(id('log-match-count')).toContainText('命中');
      await expect(rawRows().first().locator('mark').first()).toHaveText(query);
    },
    async jump_error_line() {
      await ensureLog();
      const error = id('log-error-jump').and(page.locator('[data-error-line="1100"]'));
      await error.click();
      await expect(rawRows().and(page.locator('[data-line-number="1100"]'))).toHaveAttribute('data-selected', 'true');
      await expect(error).toHaveAttribute('aria-current', 'location');
    },
    async toggle_inspector_fullscreen() {
      await ensureLog();
      const panel = page.locator('#inspector-panel');
      const fullscreen = id('inspector-fullscreen-btn');
      const width = (await panel.boundingBox())?.width;
      const viewport = page.viewportSize();
      assert.ok(width && viewport);
      await fullscreen.click();
      await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
      await expect(id('inspector-divider')).toHaveCount(0);
      await expect(panel).toHaveCSS('position', 'fixed');
      assert.deepEqual(await panel.boundingBox(), { ...viewport, x: 0, y: 0 });

      await chooser().click();
      await id('log-file-option').filter({ hasText: 'agent-run-failed.jsonl' }).click();
      const row = rawRows().and(page.locator('[data-line-number="6"]'));
      await expect(row).toHaveAttribute('data-level', 'error');
      await expect(row.locator('.line-number')).toHaveText('6');
      await expect(row.locator('pre')).toHaveText(/\n {2}"type": "tool_call",/u);
      const error = id('log-error-jump').and(page.locator('[data-error-line="6"]'));
      await expect(error.locator('[data-summary-source="extracted"]')).toHaveText('错误提取');
      await expect(error.getByTestId('log-error-preview')).toHaveText('read_file_slice · The sequence field is absent.');

      await page.keyboard.press('Escape');
      await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
      await expect(id('log-inspector-drawer')).toBeVisible();
      await expect(id('inspector-divider')).toBeVisible();
      assert.equal((await panel.boundingBox())?.width, width);
      await expect(row.locator('pre')).toBeVisible();
      await ensureLog();
    },
    async toggle_theme() {
      const element = page.locator('html');
      const previous = await element.getAttribute('data-theme');
      await id('toggle-theme-btn').click();
      await expect(element).toHaveAttribute('data-theme', previous === 'light' ? 'dark' : 'light');
    },
    async reload_page() {
      const identifier = await active().getAttribute('data-session-id');
      const theme = await page.locator('html').getAttribute('data-theme');
      const runs = id('run-turn-block');
      const runId = await runs.count() ? await runs.last().getAttribute('data-run-id') : undefined;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(card(identifier)).toHaveAttribute('data-active', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (runId) await expect(block(runId)).toBeVisible();
    },
  };
  return { actions, createSession, id };
}

async function idle(inFlight) {
  const expires = performance.now() + 4000;
  while (inFlight.size > 0 && performance.now() < expires) await delay(10);
  assert.equal(inFlight.size, 0, 'Requests still pending after shutdown');
}

async function clearSessions(workbench) {
  const { sessions } = await workbench.request('/api/sessions');
  for (const session of sessions) {
    if (session.hasActiveRun) {
      const { runs } = await workbench.request('/api/sessions/' + session.id);
      for (const run of runs.filter(({ status }) => status === 'running' || status === 'pending')) {
        const response = await fetch(new URL('/api/runs/' + run.id + '/stop', workbench.address), {
          method: 'POST', signal: AbortSignal.timeout(4000),
        });
        assert.ok(response.ok);
        await response.json();
        await workbench.end(run.id);
      }
    }
    await workbench.request('/api/sessions/' + session.id, 'DELETE');
  }
}

async function explore(browser, site, workbench, options) {
  const coverage = new Set();
  let scenario = 0;
  let stepCount = 0;

  async function run(actions) {
    const context = await browser.newContext({ viewport: { width: 1536, height: 900 }, serviceWorkers: 'block' });
    const errors = [];
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && message.location().url !== 'data:,') errors.push(message.text());
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === site.origin) return route.fallback();
        errors.push('Unexpected external request to ' + url.origin);
        return route.abort();
      });
      const ui = controls(page);
      async function invariants() {
        assert.deepEqual(errors, [], 'Browser reported an error');
        await expect(ui.id('health-status-badge')).toContainText('在线');
        assert.deepEqual(errors, [], 'Browser reported an error');
        assert.equal(await page.locator('main :is(script,img,iframe), [data-testid="log-inspector-drawer"] :is(script,img,iframe)').count(), 0);
        if (await ui.id('stop-run-btn').isVisible()) {
          await expect(ui.id('prompt-input')).toBeDisabled();
          await expect(ui.id('send-run-btn')).toHaveCount(0);
        }
      }

      await page.goto(site.origin, { waitUntil: 'domcontentloaded' });
      await invariants();
      await ui.createSession(true);
      await ui.createSession(false);
      for (const action of actions) {
        await ui.actions[action]();
        await invariants();
        coverage.add(action);
        stepCount++;
      }
    } finally {
      try { await context.close(); } finally { await clearSessions(workbench); }
    }
    await idle(site.inFlight);
    assert.deepEqual(errors, [], 'Browser reported an error during exploration');
  }

  const shuffled = fc.shuffledSubarray(actionNames, { minLength: actionNames.length, maxLength: actionNames.length });
  const random = fc.array(fc.constantFrom(...actionNames), { minLength: options.steps, maxLength: options.steps });
  await fc.assert(fc.asyncProperty(shuffled, random, async (order, draws) => {
    // Cover each operation in the default run while varying both its order and the remaining choices.
    const scheduled = actionNames.slice(scenario * options.steps, (scenario + 1) * options.steps);
    scenario++;
    await run([...order.filter((name) => scheduled.includes(name)), ...draws].slice(0, options.steps));
  }), { seed: options.seed, numRuns: options.runs, endOnFailure: true });
  if (options.runs * options.steps >= actionNames.length) assert.equal(coverage.size, actionNames.length);
  return { actions: [...coverage].sort(), stepCount };
}

const options = settings();
if (options.help) {
  console.log('Usage: npm run verify:ui -- [--seed <integer>] [--runs <count>] [--steps <count>]');
} else {
  const dist = join(root, 'apps/web/dist');
  assert.ok(existsSync(join(dist, 'index.html')), 'Run npm run build to prepare the frontend before verify:ui.');
  const directory = mkdtempSync(join(tmpdir(), 'mini-run-ui-'));
  // Keep browser profiles and Chromium's temporary files in the same disposable directory.
  Object.assign(process.env, { TEMP: directory, TMP: directory, TMPDIR: directory });
  let workbench;
  let site;
  let browser;
  let summary;
  try {
    workbench = await openOfflineWorkbench(root, { extraRoots: [join(root, 'data/fixtures')] });
    site = await hostUi(dist, workbench.address);
    const local = await launchBrowser();
    browser = local.browser;
    const result = await explore(browser, site, workbench, options);
    summary = { ok: true, browser: local.name, version: browser.version(),
      seed: options.seed, runs: options.runs, steps: options.steps, ...result, consoleErrors: 0, pageErrors: 0, pendingRequests: 0 };
  } finally {
    try { await browser?.close(); } finally {
      try { await site?.close(); } finally {
        try { await workbench?.close(); } finally {
          rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  }
  console.log(JSON.stringify(summary));
}
