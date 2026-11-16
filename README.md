# [Client-Side QR File Transfer](https://github.com/europanite/client-side-qr-file-transfer)

[![CI](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/ci.yml)
[![Docker](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/docker.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/docker.yml)
[![GitHub Pages](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/pages.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/pages.yml)
[![Browser E2E](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/e2e.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/e2e.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Architecture](https://img.shields.io/badge/architecture-client--side--only-yellow)

**[Open the Web App](https://europanite.github.io/client-side-qr-file-transfer/)** (available *after* deploying this repository)

Transmit a small file **optically** between devices: one browser displays animated QR codes while another browser reads them through its camera. The Sender and Receiver share one static website. No file transfer server, account, cloud API, or database is required.

> This URL and the repository links are deployment targets, **not published links** until you create the `client-side-qr-file-transfer` GitHub repository and enable GitHub Pages. Change the repository name and `frontend/app/app.json` `experiments.baseUrl` if you choose a different name.

## What it does

- **Left panel / Sender**: choose a file, split it into 48-byte chunks, show a looping sequence of QR codes with configurable frame interval, pause, step, and jump to a numbered chunk.
- **Right panel / Receiver**: request the user-facing/front camera (or pick another camera), scan QR codes, count/deduplicate collected chunks, show the most recently received QR and a gallery of the last eight accepted QR codes, show missing chunk numbers, and download the reconstructed file once SHA-256 matches.
- **No upload**: all encoding, checksum validation, QR rendering, scanning, reconstruction, and downloads happen in browser memory. Only application assets are fetched from the static host.
- **Resilience**: out-of-order chunks, repeats, CRC32 checks per data QR, SHA-256 integrity of the completed file, and small metadata QR frames re-emitted every 64 data chunks.
- **Alternative input**: a saved QR screenshot can be decoded using the Receiver's image selector when a physical camera is unavailable.

## Quick start (Docker Compose)

You only need **Docker Engine with Docker Compose** installed. From the repository root:

```bash
# Tests, TypeScript type checking, and production web export
# This service exits when verification is finished.
docker compose -f docker-compose.test.yml run --rm --build frontend_test

# Start the local web app in the background
docker compose up -d --build frontend

# Inspect runtime logs when needed
docker compose logs -f frontend
```

Open **http://localhost:8081** in your browser. To stop the server:

```bash
docker compose down
```

The test image runs `npm test`, `npm run typecheck`, and `npm run build` inside Docker. The web image runs Expo's web development server on port 8081. All npm commands run **inside the containers**; Node.js/npm do not need to be installed on the host.

For users who prefer running without Docker, the equivalent commands are `cd frontend/app && npm install && npm test && npm run typecheck && npm run web` on Node.js 22.13 or later.

Open the local URL printed by Expo (usually `http://localhost:8081`). `localhost` allows camera access in most modern browsers; for deployment, use **HTTPS**. Test the two devices with the [same page](https://europanite.github.io/client-side-qr-file-transfer/) open on both. The Sender display must be physically visible to the Receiver camera. A normal laptop camera cannot read codes on its *own* display without an optical reflection or external camera.

### How to transfer a file

1. On device A, open the page, use **Choose file** under **Sender**, and point its screen toward device B's camera.
2. On device B, open the **same website** and click **Start front camera**, permitting camera access.
3. Watch **Received chunks** increase. Once all chunks and metadata are collected and the SHA-256 check passes, **Download verified file** appears.
4. If some QR codes were missed, leave the Sender looping, reduce speed using the Frame interval slider, or **Jump & pause** on missing data chunks or **Jump metadata** on missing metadata parts shown on the Receiver.
5. Use **Reset received file** before receiving a different file. The Receiver deliberately ignores a second file's frames until reset to prevent mixing two transfers.

### Realistic speed and limits

- Maximum file size is **2 MiB** (safety/memory/UI cap). For practical optical transfers with 48-byte data frames, start with a file under **5 KiB**.
- Each QR carries at most **48 raw bytes**. Each data or metadata QR is typically under 110 printable characters including protocol fields. Smaller QR patterns are much easier for a typical front camera to scan, at the cost of approximately eight times as many data frames.
- Default frame interval: **1.4 seconds**. Actual throughput depends on camera autofocus, resolution, exposure, QR display size, screen brightness, and decoding rate.
- The sender has **no receiver acknowledgment**: it cannot automatically know whether a frame was received. It loops indefinitely; the Receiver deduplicates repeated frames.
- Files are stored **in memory only**. Closing or refreshing the Receiver page loses the current transfer. No recovery across page reloads is implemented.
- The prototype does **not** have encryption, sender authentication, error-correcting multi-frame codes, or bidirectional ACK. Anyone able to photograph the displayed QR codes can potentially recover the file. Do **not** send confidential data in public places.

## Two-browser QR transfer E2E test

Run the actual sender and receiver UIs in **two independent Chromium processes**. Playwright transfers each rendered QR **image** into a canvas-backed virtual camera on the receiver. The browser's normal video capture and `jsQR` decoding code reconstructs the file; the test downloads it and checks that the bytes and filename are identical to the source.

```bash
docker compose -f docker-compose.e2e.yml up --build --abort-on-container-exit --exit-code-from browser_e2e
# To remove the stopped container:
docker compose -f docker-compose.e2e.yml down
```

## QR protocol v2 (`QRF2`)

All fields are ASCII separated by `|`, with base64url without padding for binary and UTF-8 text fields.

```text
QRF2|M|<12-hex-transfer-id>|<0-based-metadata-index>|<metadata-part-count>|<crc32-hex>|<base64url-metadata-part>
QRF2|D|<12-hex-transfer-id>|<0-based-data-index>|<data-part-count>|<crc32-hex>|<base64url-data-part>
```

Metadata (file size, name, MIME type, SHA-256) is JSON-encoded and split into separate 48-byte fragments, rather than transmitted in one dense QR. Every metadata fragment is sent before data and repeated after each group of 64 data frames. Metadata and data can arrive out of order and are deduplicated. CRC32 catches damaged individual QR frames. The final file is rejected if its length or SHA-256 digest differs from the reconstructed metadata. This provides **integrity checks, not authentication**. `QRF2` requires both Sender and Receiver to run the updated application; older `QRF1` QR codes are intentionally not accepted.

## Build and GitHub Pages

```bash
cd frontend/app
npm install
npm run build
```

## License

- Apache License 2.0.

