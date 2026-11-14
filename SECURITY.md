# Security Policy

## Privacy model

The application contains no backend and does not make a file-upload request. Files are read using the browser File API, encoded locally, displayed optically as QR images, decoded from the receiver camera locally, and saved through a local `Blob` download. Application assets are still loaded from the static hosting origin.

## Limitations

- **No encryption or authentication**: A bystander who can capture enough QR frames may recover the complete file; a malicious source can impersonate a transfer.
- **No reverse signaling channel**: The sender cannot know which frames are received. Receiver-side missing indexes and manual replay are provided instead.
- **No persistence**: Browser refresh loses in-progress chunks.
- **No guarantee of optical reliability**: Camera performance depends on environment and hardware. Use the end-to-end SHA-256 verification; never trust incomplete transfers.
- **Untrusted input**: Incoming QR strings are length- and structure-limited and checked with CRC32 before acceptance. SHA-256 verifies output integrity against metadata from the QR stream, not against a trusted sender identity.
- **2 MiB cap**: Protects browser memory and UI responsiveness; actual practicality depends on number of frames.

## Camera permissions

Camera access requires HTTPS or localhost and explicit permission. Camera tracks are stopped on user request and component unmount. No camera frames are uploaded.

## Reporting vulnerabilities

Open a GitHub Security Advisory (preferred) or an issue if disclosure is safe. Please avoid including actual private files or leaked payloads in reports.
