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

// Installed BEFORE the receiver loads the app; the sender gets no shim at all.
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
    await receiver.addInitScript(installVirtualCamera);
    await Promise.all([sender.goto(url), receiver.goto(url)]);
    await sender.locator('#source-file').waitFor();
    await receiver.getByRole('button', { name: 'Start front camera' }).click();
    await receiver.getByRole('button', { name: 'Stop camera' }).waitFor();
    await receiver.waitForFunction(() => Boolean(window.__e2eCamera));

    let previousSource = null;
    async function scan(status, expectedNotice) {
      // Only copy the rendered bitmap: no access to application protocol objects.
      const source = await waitForVisibleQr(sender, status, previousSource);
      assert.ok(source?.startsWith('data:image/png;base64,'), 'Expected a rendered QR PNG');
      await receiver.evaluate(async (image) => window.__e2eCamera.setFrame(image), source);
      previousSource = source;
      // The diagnostic box is also aria-live; only the transfer notice carries accepted-frame acknowledgments.
      if (expectedNotice) {
        try {
          await receiver.waitForFunction((notice) =>
            document.querySelector('.receiver .line-muted[aria-live="polite"]')?.textContent?.includes(notice),
          expectedNotice, { timeout: 15_000 });
        } catch (error) {
          const state = await receiver.evaluate(() => ({
            notice: document.querySelector('.receiver .line-muted[aria-live="polite"]')?.textContent,
            progress: Array.from(document.querySelectorAll('.receiver .progress-label'))
              .find((element) => element.querySelector('span')?.textContent?.trim() === 'Received chunks')
              ?.querySelector('strong')?.textContent,
            cameraButton: document.querySelector('.receiver .toolbar button')?.textContent,
          }));
          throw new Error(`QR not received (${status}): ${JSON.stringify(state)}`, { cause: error });
        }
      }
    }
    async function scanMetadata() {
      // Metadata is deliberately fragmented into low-density QR frames.
      const total = Number(await sender.locator('#metadata-jump-index').getAttribute('max'));
      assert.ok(total >= 2, 'Expected multiple metadata frames');
      for (let part = 1; part <= total; part += 1) {
        await sender.locator('#metadata-jump-index').fill(String(part));
        await sender.getByRole('button', { name: 'Jump metadata' }).click();
        await scan(`Metadata QR · part ${part} / ${total}`,
          part === total ? 'File metadata received' : `Received metadata part ${part} / ${total}`);
      }
    }
    async function jumpToChunk(n, expectedNotice) {
      await sender.locator('#jump-index').fill(String(n));
      await sender.getByRole('button', { name: 'Jump & pause' }).click();
      await scan(`Data QR · chunk ${n} /`, expectedNotice);
    }
    async function upload(name, buffer, chunkCount) {
      await sender.locator('#source-file').setInputFiles({
        name, mimeType: 'application/octet-stream', buffer,
      });
      await sender.waitForFunction((total) =>
        document.querySelector('.sender .stats')?.textContent?.includes(`Chunks: ${total}`), chunkCount);
      const initialFrame = await waitForVisibleQr(sender, 'Metadata QR · part 1 /', previousSource);
      await sender.waitForTimeout(1700);
      assert.equal(await sender.locator('.sender-qr img').getAttribute('src'), initialFrame,
        'Sender must hold its QR steady until a person clicks Next QR');
      await scanMetadata();
    }
    async function verifyDownload(name, original) {
      await receiver.locator('.receiver .stats').getByText('Verified', { exact: true }).waitFor();
      const downloadPromise = receiver.waitForEvent('download');
      await receiver.getByRole('link', { name: /Download verified file/ }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), name);
      const restored = await readFile(await download.path());
      assert.deepEqual(restored, original, 'Reconstructed bytes differ from source bytes');
    }

    // Confirm the physical QR decoding path separately from the file protocol.
    await sender.getByRole('button', { name: 'Show camera test QR' }).click();
    await scan('Camera test QR', null);
    await receiver.getByText('Camera test QR detected successfully').waitFor();
    await sender.getByRole('button', { name: 'Return to transfer' }).click();

    const filename = '転送📁.bin';
    const payload = Buffer.from(Array.from({ length: 135 }, (_, n) => (n * 73 + (n >> 3)) & 255));
    await upload(filename, payload, 3);
    await sender.getByRole('button', { name: 'Start over' }).click();
    await sender.getByRole('button', { name: 'Next QR' }).click();
    await sender.getByRole('button', { name: 'Previous QR' }).click();
    await jumpToChunk(2, 'Received chunk 2 / 3');
    await receivedCount(receiver, '1 / 3');
    await receiver.getByText('Missing QR chunks (2)').waitFor();
    await jumpToChunk(1, 'Received chunk 1 / 3');
    await receivedCount(receiver, '2 / 3');
    await jumpToChunk(2, null); // Duplicate QR frame must not count twice.
    await receiver.waitForTimeout(600);
    assert.equal((await receivedChunksProgress(receiver).textContent())?.trim(), '2 / 3');
    await jumpToChunk(3, 'Received chunk 3 / 3');
    await receivedCount(receiver, '3 / 3');
    await verifyDownload(filename, payload);

    // The receiver camera still displays the final QR. Resetting while it runs
    // would immediately re-accept that old transfer ID and reject the next file.
    // Stop capture first, then reset, and restart with a fresh blank camera feed.
    await receiver.getByRole('button', { name: 'Stop camera' }).click();
    await receiver.getByRole('button', { name: 'Start front camera' }).waitFor();
    await receiver.getByRole('button', { name: 'Reset received file' }).click();
    await receivedCount(receiver, '0 / ?');
    await receiver.getByRole('button', { name: 'Start front camera' }).click();
    await receiver.getByRole('button', { name: 'Stop camera' }).waitFor();
    await receiver.waitForTimeout(350);
    assert.equal((await receivedChunksProgress(receiver).textContent())?.trim(), '0 / ?',
      'The previous transfer was unexpectedly reacquired after reset');

    // A second transfer on the same two browser processes tests empty files.
    const emptyFilename = 'empty.txt';
    await upload(emptyFilename, Buffer.alloc(0), 1);
    await jumpToChunk(1, 'Received chunk 1 / 1');
    await receivedCount(receiver, '1 / 1');
    await verifyDownload(emptyFilename, Buffer.alloc(0));
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
