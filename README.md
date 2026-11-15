# [Client-Side QR File Transfer](https://github.com/europanite/client-side-qr-file-transfer)

[![CI](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/ci.yml)
[![docker](https://github.com/europanite/semantic-tree/actions/workflows/docker.yml/badge.svg)](https://github.com/europanite/semantic-tree/actions/workflows/docker.yml)
[![GitHub Pages](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/pages.yml/badge.svg)](https://github.com/europanite/client-side-qr-file-transfer/actions/workflows/pages.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Architecture](https://img.shields.io/badge/architecture-client--side--only-yellow)

**[Open the Web App](https://europanite.github.io/client-side-qr-file-transfer/)** (available *after* deploying this repository)

Transmit a small file **optically** between devices: one browser displays animated QR codes while another browser reads them through its camera. The Sender and Receiver share one static website. No file transfer server, account, cloud API, or database is required.

> This URL and the repository links are deployment targets, **not published links** until you create the `client-side-qr-file-transfer` GitHub repository and enable GitHub Pages. Change the repository name and `frontend/app/app.json` `experiments.baseUrl` if you choose a different name.

## What it does

- **Left panel / Sender**: choose a file, split it into 384-byte chunks, show a looping sequence of QR codes with configurable frame interval, pause, step, and jump to a numbered chunk.
- **Right panel / Receiver**: request the user-facing/front camera (or pick another camera), scan QR codes, count/deduplicate collected chunks, show the most recently received QR and a gallery of the last eight accepted QR codes, show missing chunk numbers, and download the reconstructed file once SHA-256 matches.
- **No upload**: all encoding, checksum validation, QR rendering, scanning, reconstruction, and downloads happen in browser memory. Only application assets are fetched from the static host.
- **Resilience**: out-of-order chunks, repeats, CRC32 checks per data QR, SHA-256 integrity of the completed file, and metadata re-emitted every 16 data chunks.
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
4. If some QR codes were missed, leave the Sender looping, reduce speed using the Frame interval slider, or **Jump & pause** on missing chunk numbers shown under the Receiver's **Missing QR chunks** section.
5. Use **Reset received file** before receiving a different file. The Receiver deliberately ignores a second file's frames until reset to prevent mixing two transfers.

### Realistic speed and limits

- Maximum file size is **2 MiB** (safety/memory/UI cap). For practical optical transfers, start with a file under **100 KiB**.
- One QR carries **384 raw bytes**. Base64url makes the encoded QR around 550 printable characters including protocol fields.
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

## QR protocol v1 (`QRF1`)

All fields are ASCII separated by `|`, with base64url without padding for binary and UTF-8 text fields.

```text
QRF1|H|<12-hex-transfer-id>|<number-of-chunks>|<file-size>|<sha256-hex>|<base64url-utf8-filename>|<base64url-utf8-mime>
QRF1|D|<12-hex-transfer-id>|<0-based-index>|<number-of-chunks>|<crc32-hex>|<base64url-raw-bytes>
```

A header is sent first and after every group of 16 data frames. The receiver can accept data before receiving metadata. CRC32 catches damaged individual data frames. The final file is rejected if its length or SHA-256 digest differs from the header. This provides **integrity checks, not authentication**.

## Build and GitHub Pages

```bash
cd frontend/app
npm install
npm run build
```

## License

- Apache License 2.0.

