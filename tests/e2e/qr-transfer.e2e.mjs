/**
 * Two real, independent Chromium processes:
 *   1. Sender chooses an actual binary file and renders QR bitmap <img>s.
 *   2. Receiver scans those bitmaps from a canvas-backed virtual webcam.
 *
 * No protocol helpers, application state, or decoded QR strings are injected.
 * The production camera processing path (video -> canvas -> jsQR) is used.
 * This simulates the optical path, NOT real-world camera optics/autofocus.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dist = resolve(root, 'frontend/app/dist');
const artifacts = resolve(root, 'tests/e2e/artifacts');
const basePath = '/client-side-qr-file-transfer';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function serveProductionBuild(t) {
  await access(resolve(dist, 'index.html'));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
      response.writeHead(404).end('Not found');
      return;
    }
    let relative;
    try {
      relative = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, '') || 'index.html';
    } catch {
      response.writeHead(400).end('Invalid URL');
      return;
    }
    const filename = resolve(dist, relative);
    if (filename !== dist && !filename.startsWith(dist + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const contents = await readFile(filename);
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(contents);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  t.after(() => new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok())));
  return `http://127.0.0.1:${server.address().port}${basePath}/`;
}

// Installed in BOTH independent browsers to simulate the two optical directions.
function installVirtualCamera() {
  if (!navigator.mediaDevices) throw new Error('Expected a secure localhost origin');
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 960;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Cannot create webcam canvas');
      ctx.imageSmoothingEnabled = false;
      const stream = canvas.captureStream(15);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      window.__e2eCamera = {
        setFrame: async (qrPngDataUrl) => {
          const img = new Image();
          img.src = qrPngDataUrl;
          await img.decode();
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 96, 96, 768, 768);
        },
      };
      return stream;
    },
  });
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
    configurable: true,
    value: async () => [{ kind: 'videoinput', deviceId: 'virtual-qr', groupId: 'e2e', label: 'Virtual QR camera' }],
  });
}

async function waitForVisibleQr(sender, status, previousSource) {
  await sender.waitForFunction(({ status, previousSource }) => {
    const label = document.querySelector('.sender .qr-status')?.textContent ?? '';
    const img = document.querySelector('.sender-qr img');
    return label.includes(status) && img?.src.startsWith('data:image/png') && img.src !== previousSource;
  }, { status, previousSource }, { timeout: 15_000 });
  return sender.locator('.sender-qr img').getAttribute('src');
}

// Two independent progress counters exist: data chunks and metadata QR parts.
// Always select the data counter by its label rather than relying on DOM order.
function receivedChunksProgress(receiver) {
  return receiver.locator('.receiver .progress-label')
    .filter({ hasText: 'Received chunks' }).locator('strong');
}

async function receivedCount(receiver, expected) {
  await receiver.waitForFunction((expected) => {
    const label = Array.from(document.querySelectorAll('.receiver .progress-label'))
      .find((element) => element.querySelector('span')?.textContent?.trim() === 'Received chunks');
    return label?.querySelector('strong')?.textContent?.trim() === expected;
  }, expected, { timeout: 15_000 });
}

test('two browsers scan rendered QR frames and download byte-identical files', { timeout: 120_000 }, async (t) => {
  const url = await serveProductionBuild(t);
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling'],
  };
  let senderBrowser;
  let receiverBrowser;
  let sender;
  let receiver;
  const browserErrors = [];

  try {
    // Separate Chromium processes, not merely two tabs sharing a browser profile.
    [senderBrowser, receiverBrowser] = await Promise.all([
      chromium.launch(launchOptions),
      chromium.launch(launchOptions),
    ]);
    const [senderContext, receiverContext] = await Promise.all([
      senderBrowser.newContext({ viewport: { width: 1440, height: 1000 } }),
      receiverBrowser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } }),
    ]);
    sender = await senderContext.newPage();
    receiver = await receiverContext.newPage();
    for (const [name, page] of [['sender', sender], ['receiver', receiver]]) {
      page.on('pageerror', (error) => browserErrors.push(`${name}: ${error.message}`));
    }
    await sender.addInitScript(installVirtualCamera);
    await receiver.addInitScript(installVirtualCamera);
    await Promise.all([sender.goto(url), receiver.goto(url)]);
    await sender.locator('#source-file').waitFor();
    // Before selecting a file both devices default to Receiver, so no QR is visible.
    assert.equal(await sender.locator('.qr-box img:visible').count(), 0);
    assert.equal(await receiver.locator('.qr-box img:visible').count(), 0);
    assert.equal(await receiver.locator('.receiver .preview').count(), 0, 'Receiver must not render a camera screen');
    assert.equal(await receiver.locator('.receiver video.capture-only-video').count(), 1, 'Hidden capture video must remain mounted');
    await receiver.getByRole('button', { name: 'Start front camera' }).click();
    await receiver.getByRole('button', { name: 'Stop camera' }).waitFor();
    await receiver.waitForFunction(() => Boolean(window.__e2eCamera));


    // Only rendered QR bitmaps travel between the two independent browser processes.
    // No application state or raw protocol strings are ever injected into the other browser.
    let previousDataQR = null;
    let previousAckQR = null;
    async function sendAndAcknowledge(status, expectedNotice, final = false) {
      const source = await waitForVisibleQr(sender, status, previousDataQR);
      assert.ok(source?.startsWith('data:image/png;base64,'), 'Expected Sender QR PNG');
      await receiver.evaluate(async (png) => window.__e2eCamera.setFrame(png), source);
      await receiver.waitForFunction((notice) =>
        document.querySelector('.receiver .line-muted[aria-live="polite"]')?.textContent?.includes(notice),
      expectedNotice, { timeout: 20_000 });
      await receiver.waitForFunction((prior) => {
        const img = document.querySelector('.receiver .ack-qr img');
        return img?.src.startsWith('data:image/png') && img.src !== prior;
      }, previousAckQR, { timeout: 15_000 });
      assert.equal(await receiver.locator('.qr-box img:visible').count(), 1, 'Receiver must show only the ACK QR');
      assert.match(await receiver.locator('.receiver .stats').textContent(), /Sender ID: [0-9a-f]{12}/);
      const ackPNG = await receiver.locator('.ack-qr img').getAttribute('src');
      assert.ok(ackPNG?.startsWith('data:image/png;base64,'));
      previousAckQR = ackPNG;
      // Sender must not advance before receiving an ACK via its own camera.
      assert.equal(await sender.locator('.sender-qr img').getAttribute('src'), source);
      await sender.evaluate(async (png) => window.__e2eCamera.setFrame(png), ackPNG);
      if (final) {
        await sender.getByText('Final ACK received: complete.').waitFor();
      } else {
        await sender.waitForFunction((prior) =>
          document.querySelector('.sender-qr img')?.getAttribute('src') !== prior &&
          document.querySelector('.sender-qr img')?.getAttribute('src')?.startsWith('data:image/png'),
        source, { timeout: 20_000 });
      }
      previousDataQR = source;
    }
    async function sendFile(name, buffer, dataParts) {
      previousDataQR = null;
      previousAckQR = null;
      await sender.locator('#source-file').setInputFiles({
        name, mimeType: 'application/octet-stream', buffer,
      });
      await sender.waitForFunction((expected) =>
        document.querySelector('.sender .stats')?.textContent?.includes(`Chunks: ${expected}`), dataParts);
      await sender.getByRole('button', { name: 'Stop Sender camera' }).waitFor();
      await sender.waitForFunction(() => Boolean(window.__e2eCamera));
      assert.equal(await sender.locator('.qr-box img:visible').count(), 1, 'Sender must show only the file QR');
      assert.match(await sender.locator('.sender .stats').textContent(), /Sender ID: [0-9a-f]{12}/);
      assert.equal(await sender.getByRole('button', { name: 'Sender', exact: true }).getAttribute('aria-pressed'), 'true');
      const metaParts = Number(await sender.locator('#metadata-jump-index').getAttribute('max'));
      for (let part = 1; part <= metaParts; part++) {
        await sendAndAcknowledge(`Metadata QR · part ${part} / ${metaParts}`,
          part === metaParts ? 'File metadata received' : `Received metadata part ${part} / ${metaParts}`);
        // Keep the previous ACK in Sender camera and prove it cannot advance a different QR.
        if (part === 1) {
          const now = await sender.locator('.sender-qr img').getAttribute('src');
          await sender.waitForTimeout(700);
          assert.equal(await sender.locator('.sender-qr img').getAttribute('src'), now,
            'Stale ACK must not advance a different QR frame');
        }
      }
      for (let part = 1; part <= dataParts; part++) {
        await sendAndAcknowledge(`Data QR · chunk ${part} / ${dataParts}`,
          `Received chunk ${part} / ${dataParts}`, part === dataParts);
      }
    }
    async function verifyDownload(name, original) {
      await receiver.locator('.receiver .stats').getByText('Verified', { exact: true }).waitFor();
      const downloadPromise = receiver.waitForEvent('download');
      await receiver.getByRole('link', { name: /Download verified file/ }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), name);
      assert.deepEqual(await readFile(await download.path()), original, 'Recovered file differs');
    }

    const filename = '転送📁.bin';
    const payload = Buffer.from(Array.from({ length: 135 }, (_, i) => (i * 73 + (i >> 3)) & 255));
    await sendFile(filename, payload, 3);
    await receivedCount(receiver, '3 / 3');
    await verifyDownload(filename, payload);

    // A second transfer uses a new transfer ID. Clear both virtual camera frames
    // so an old QR is not mistakenly received after a reset.
    await receiver.getByRole('button', { name: 'Stop camera' }).click();
    await receiver.getByRole('button', { name: 'Reset received file' }).click();
    await receiver.getByRole('button', { name: 'Start front camera' }).click();
    await receiver.getByRole('button', { name: 'Stop camera' }).waitFor();
    await receiver.waitForFunction(() => Boolean(window.__e2eCamera));
    await sendFile('empty.txt', Buffer.alloc(0), 1);
    await receivedCount(receiver, '1 / 1');
    await verifyDownload('empty.txt', Buffer.alloc(0));
    assert.deepEqual(browserErrors, [], `Unexpected browser errors: ${browserErrors.join('; ')}`);
  } catch (error) {
    await mkdir(artifacts, { recursive: true });
    if (sender) await sender.screenshot({ path: resolve(artifacts, 'sender-failure.png'), fullPage: true }).catch(() => {});
    if (receiver) await receiver.screenshot({ path: resolve(artifacts, 'receiver-failure.png'), fullPage: true }).catch(() => {});
    if (browserErrors.length) console.error('Browser page errors:', browserErrors.join('\n'));
    throw error;
  } finally {
    await Promise.allSettled([senderBrowser?.close(), receiverBrowser?.close()]);
  }
});
