import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  acceptFrame, assemble, buildSequence, decodeFrame, emptyReceiver,
  encodeStep, isComplete, CHUNK_BYTES, metadataPartCount, missingIndices, missingMetadataIndices, prepareFile,
  type Prepared, type Receiver,
} from './src/protocol';
import './styles.css';

const REPOSITORY = 'https://github.com/europanite/client-side-qr-file-transfer';
const QR_RENDER_SIZE = 640;
const CAMERA_TEST_QR = 'QRF-CAMERA-TEST';

type Reconstructed = { blob: Blob; name: string };
function readableBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}
function abbreviateMissing(numbers: number[]): string {
  if (!numbers.length) return 'None';
  return numbers.slice(0, 80).map((index) => index + 1).join(', ') + (numbers.length > 80 ? ` … and ${numbers.length - 80} more` : '');
}
function useQrImage(value: string | null, size = QR_RENDER_SIZE): { image: string; error: string } {
  // Do not show the previous frame while the next QR image is rendering.
  const [state, setState] = useState({ value: null as string | null, image: '', error: '' });
  useEffect(() => {
    let active = true;
    if (!value) { setState({ value: null, image: '', error: '' }); return; }
    QRCode.toDataURL(value, {
      errorCorrectionLevel: 'L', margin: 4, width: size,
      color: { dark: '#090909', light: '#ffffff' },
    }).then((image) => {
      if (active) setState({ value, image, error: '' });
    }).catch((error) => {
      if (active) setState({ value, image: '', error: `QR generation failed: ${String(error)}` });
    });
    return () => { active = false; };
  }, [value, size]);
  return state.value === value ? { image: state.image, error: state.error } : { image: '', error: '' };
}

function ReceivedQRCard({ qr, label }: { qr: string; label: string }) {
  const { image } = useQrImage(qr, 190);
  return <div className="received-tile">{image ? <img src={image} alt={`Received ${label}`} /> : <div className="thumbnail-loading">Processing…</div>}<span>{label}</span></div>;
}

export default function App() {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [senderError, setSenderError] = useState('');
  const [position, setPosition] = useState(0);
  const [cameraTestMode, setCameraTestMode] = useState(false);
  const [jumpIndex, setJumpIndex] = useState('1');
  const [metaJumpIndex, setMetaJumpIndex] = useState('1');
  const [receiver, setReceiver] = useState<Receiver>(emptyReceiver);
  const [cameraError, setCameraError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraNames, setCameraNames] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [fileResult, setFileResult] = useState<Reconstructed | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanStatus, setScanStatus] = useState('No camera QR detected yet');
  const [scanStats, setScanStats] = useState({ frames: 0, decoded: 0, size: '—' });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<number | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastTickRef = useRef(0);
  const lastStatsUpdateRef = useRef(0);
  const scanStatsRef = useRef({ frames: 0, decoded: 0, size: '—' });
  const isMountedRef = useRef(true);
  const metaCount = prepared ? metadataPartCount(prepared) : 0;
  const sequence = useMemo(() => prepared ? buildSequence(prepared.header.total, metadataPartCount(prepared)) : [], [prepared]);
  const currentStep = sequence[position];
  const currentQR = useMemo(() => cameraTestMode ? CAMERA_TEST_QR :
    (prepared && currentStep ? encodeStep(prepared, currentStep) : null),
    [cameraTestMode, prepared, currentStep]);
  const senderQR = useQrImage(currentQR);
  const receivedQR = useQrImage(receiver.lastQR);
  const missing = useMemo(() => missingIndices(receiver), [receiver]);
  const missingMeta = useMemo(() => missingMetadataIndices(receiver), [receiver]);
  const complete = isComplete(receiver);
  const expected = receiver.total;

  const stopCamera = useCallback(() => {
    if (tickRef.current !== null) cancelAnimationFrame(tickRef.current);
    tickRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  }, []);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (tickRef.current !== null) cancelAnimationFrame(tickRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const consumeQR = useCallback((text: string) => {
    if (text === CAMERA_TEST_QR) {
      setScanStatus('Camera test QR detected successfully');
      setScanError('');
      return;
    }
    try {
      const frame = decodeFrame(text);
      setReceiver((previous) => acceptFrame(previous, frame, text));
      setScanStatus(frame.kind === 'metadata'
        ? `Valid metadata QR detected: ${frame.index + 1} / ${frame.total}`
        : `Valid data QR detected: ${frame.index + 1} / ${frame.total}`);
      setScanError('');
    } catch (error) {
      if (text.startsWith('QRF2|')) {
        setScanStatus('QR detected but transfer frame invalid');
        setScanError(String(error));
      } else {
        setScanStatus('QR detected, but it is not a QRF2 transfer QR');
      }
    }
  }, []);

  const scanTick = useCallback((now: number) => {
    if (!streamRef.current) return;
    if (now - lastTickRef.current >= 180) {
      lastTickRef.current = now;
      const video = videoRef.current;
      const canvas = videoCanvasRef.current;
      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        // Use enough pixels for small QR modules while avoiding full-resolution 4K scans.
        const width = Math.min(1280, video.videoWidth);
        const height = Math.max(1, Math.round(video.videoHeight * width / video.videoWidth));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          try {
            ctx.drawImage(video, 0, 0, width, height);
            const image = ctx.getImageData(0, 0, width, height);
            scanStatsRef.current.frames += 1;
            scanStatsRef.current.size = `${video.videoWidth} × ${video.videoHeight}`;
            // Try the full camera image, then the central portion at native pixel size.
            // A displayed QR is often small within a laptop webcam's field of view.
            let detected = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
            if (!detected && scanStatsRef.current.frames % 2 === 0) {
              const cropW = Math.round(width * 0.65);
              const cropH = Math.round(height * 0.78);
              const left = Math.round((width - cropW) / 2);
              const top = Math.round((height - cropH) / 2);
              const crop = ctx.getImageData(left, top, cropW, cropH);
              detected = jsQR(crop.data, cropW, cropH, { inversionAttempts: 'attemptBoth' });
            }
            if (detected) {
              scanStatsRef.current.decoded += 1;
              consumeQR(detected.data);
            }
            if (now - lastStatsUpdateRef.current > 600) {
              lastStatsUpdateRef.current = now;
              setScanStats({ ...scanStatsRef.current });
            }
          } catch (error) {
            setCameraError(`Camera frame processing failed: ${String(error)}`);
          }
        }
      }
    }
    tickRef.current = requestAnimationFrame(scanTick);
  }, [consumeQR]);

  const startCamera = useCallback(async (deviceId?: string) => {
    stopCamera();
    setCameraError('');
    setScanStatus('Waiting for camera frames');
    scanStatsRef.current = { frames: 0, decoded: 0, size: '—' };
    setScanStats({ ...scanStatsRef.current });
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser does not support camera capture. Use HTTPS or localhost.');
      return;
    }
    try {
      const video: MediaStreamConstraints['video'] = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      if (!isMountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      // Device enumeration can fail even after getUserMedia succeeds. Do not stop capture.
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      if (isMountedRef.current) {
        setCameraNames(devices.filter((device) => device.kind === 'videoinput'));
        setCameraActive(true);
        lastTickRef.current = 0;
        tickRef.current = requestAnimationFrame(scanTick);
      }
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraActive(false);
      setCameraError(`Could not start camera: ${String(error)}`);
    }
  }, [scanTick, stopCamera]);

  const selectFile = useCallback(async (file: File | undefined) => {
    setCameraTestMode(false);
    setSenderError('');
    setPrepared(null);
    setPosition(0);
    if (!file) return;
    try {
      const next = await prepareFile(file);
      setPrepared(next);
      setJumpIndex('1');
      setMetaJumpIndex('1');
    } catch (error) {
      setSenderError(String(error));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    if (!complete) { setFileResult(null); setVerifyError(''); return; }
    assemble(receiver).then((result) => {
      if (alive) { setFileResult(result); setVerifyError(''); }
    }).catch((error) => {
      if (alive) { setFileResult(null); setVerifyError(String(error)); }
    });
    return () => { alive = false; };
  }, [complete, receiver]);
  useEffect(() => {
    if (!fileResult) { setDownloadUrl(''); return; }
    const url = URL.createObjectURL(fileResult.blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [fileResult]);

  const resetReceiver = () => {
    setReceiver(emptyReceiver());
    setScanError('');
    setVerifyError('');
    setFileResult(null);
  };
  const showMetadata = () => {
    if (!prepared) return;
    const num = Number(metaJumpIndex);
    if (!Number.isInteger(num) || num < 1 || num > metaCount) {
      setSenderError('Enter a valid metadata part number.');
      return;
    }
    const target = sequence.findIndex((step) => step.kind === 'metadata' && step.index === num - 1);
    if (target >= 0) { setCameraTestMode(false); setPosition(target); setSenderError(''); }
  };
  const showChunk = () => {
    if (!prepared) return;
    const num = Number(jumpIndex);
    if (!Number.isInteger(num) || num < 1 || num > prepared.header.total) {
      setSenderError('Enter a valid chunk number.');
      return;
    }
    const target = sequence.findIndex((step) => step.kind === 'data' && step.index === num - 1);
    if (target >= 0) { setCameraTestMode(false); setPosition(target); setSenderError(''); }
  };
  const nextFrame = () => {
    setCameraTestMode(false);
    setPosition((current) => Math.min(current + 1, sequence.length - 1));
  };
  const previousFrame = () => {
    setCameraTestMode(false);
    setPosition((current) => Math.max(current - 1, 0));
  };
  const scanImage = async (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 1500 / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas is unavailable');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (!result) throw new Error('No readable QR code in this image');
      consumeQR(result.data);
    } catch (error) { setScanError(String(error)); }
    finally { URL.revokeObjectURL(url); }
  };

  return (
    <main className="shell">
      <header className="site-header">
        <div>
          <a className="project-link" href={REPOSITORY} target="_blank" rel="noreferrer">Client-Side QR File Transfer</a>
          <p>File transfer through light, not through a server. One website for both devices.</p>
        </div>
        <span className="local-badge">100% client-side · QR optical transfer</span>
      </header>
      <div className="intro">
        Open this website on two devices. Keep each Sender QR on screen until the Receiver confirms it, then click Next QR manually. No automatic switching or server transfer.
      </div>
      <div className="panels">
        <section className="panel sender" aria-label="Sender panel">
          <div className="panel-title"><span className="step-dot">1</span><div><h1>Sender</h1><p>One QR at a time. Advance only after the Receiver confirms it.</p></div></div>
          <label className="file-label" htmlFor="source-file">Choose file (maximum 2 MiB)</label>
          <input id="source-file" type="file" onChange={(event) => { void selectFile(event.currentTarget.files?.[0]); }} />
          {senderError && <p role="alert" className="error">{senderError}</p>}
          <div className="stats">
            <span>File: <strong>{prepared?.header.name || 'None'}</strong></span>
            <span>Size: <strong>{prepared ? readableBytes(prepared.header.size) : '—'}</strong></span>
            <span>Chunks: <strong>{prepared?.header.total ?? '—'}</strong></span>
            <span>Bytes per QR: <strong>{CHUNK_BYTES}</strong></span>
          </div>
          <div className="qr-box sender-qr" aria-label="Transmitted QR code">
            {senderQR.image ? <img src={senderQR.image} alt={cameraTestMode ? 'Camera test QR' : `QR code: ${currentStep?.kind === 'metadata' ? `metadata part ${(currentStep?.index ?? 0) + 1}` : `chunk ${(currentStep?.index ?? 0) + 1}`}`} />
              : <div className="placeholder">{senderQR.error || 'Select a file to display QR codes'}</div>}
          </div>
          <div className="qr-status">{cameraTestMode ? 'Camera test QR — point the Receiver camera here' : prepared && currentStep ? (currentStep.kind === 'metadata'
            ? `Metadata QR · part ${currentStep.index + 1} / ${metaCount}`
            : `Data QR · chunk ${currentStep.index + 1} / ${prepared.header.total}`) : 'No active transfer'}</div>
          <div className="toolbar">
            <button disabled={!prepared || (!cameraTestMode && position === sequence.length - 1)} onClick={nextFrame}>Next QR</button>
            <button className="secondary-button" disabled={!prepared || (!cameraTestMode && position === 0)} onClick={previousFrame}>Previous QR</button>
            <button className="secondary-button" disabled={!prepared} onClick={() => { setCameraTestMode(false); setPosition(0); }}>Start over</button>
            <button className="secondary-button" onClick={() => setCameraTestMode((value) => !value)}>{cameraTestMode ? 'Return to transfer' : 'Show camera test QR'}</button>
          </div>
          <div className="line-muted">Frame {prepared ? position + 1 : 0} / {sequence.length}. The QR remains fixed until you click Next QR; no auto-loop.</div>
          <div className="jump-row">
            <label htmlFor="jump-index">Show chunk #</label>
            <input id="jump-index" type="number" min="1" max={prepared?.header.total ?? 1} value={jumpIndex} onChange={(e) => setJumpIndex(e.target.value)} />
            <button className="secondary-button" disabled={!prepared} onClick={showChunk}>Jump & pause</button>
          </div>
          <div className="jump-row">
            <label htmlFor="metadata-jump-index">Show metadata #</label>
            <input id="metadata-jump-index" type="number" min="1" max={metaCount || 1} value={metaJumpIndex} onChange={(e) => setMetaJumpIndex(e.target.value)} />
            <button className="secondary-button" disabled={!prepared} onClick={showMetadata}>Jump metadata</button>
          </div>
          <p className="small-note">Watch the Receiver's accepted-frame message before clicking Next QR. A one-way optical link cannot automatically acknowledge a frame; you control advancement manually. You can go back to resend a missing QR.</p>
        </section>
        <section className="panel receiver" aria-label="Receiver panel">
          <div className="panel-title"><span className="step-dot purple">2</span><div><h1>Receiver</h1><p>Read QR codes using the front-facing camera.</p></div></div>
          <div className="toolbar">
            <button onClick={() => { if (cameraActive) stopCamera(); else void startCamera(cameraId); }}>{cameraActive ? 'Stop camera' : 'Start front camera'}</button>
            <button className="secondary-button" onClick={resetReceiver}>Reset received file</button>
          </div>
          {!!cameraNames.length && <label className="camera-picker" htmlFor="camera-select">Camera
            <select id="camera-select" value={cameraId} onChange={(event) => {
              setCameraId(event.target.value);
              if (cameraActive) void startCamera(event.target.value);
            }}>
              <option value="">Front camera (automatic)</option>
              {cameraNames.map((device, i) => <option key={device.deviceId || i} value={device.deviceId}>{device.label || `Camera ${i + 1}`}</option>)}
            </select>
          </label>}
          {cameraError && <p className="error" role="alert">{cameraError}</p>}
          <div className="preview" aria-label="Live receiver camera preview">
            <video ref={videoRef} muted autoPlay playsInline className="camera-video" />
            {!cameraActive && <div className="preview-overlay">Camera is off · HTTPS or localhost required</div>}
          </div>
          <canvas ref={videoCanvasRef} className="hidden-canvas" aria-hidden="true" />
          <div className="image-fallback"><label htmlFor="qr-image">Or scan a QR screenshot:</label> <input id="qr-image" type="file" accept="image/*" onChange={(event) => { void scanImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/></div>
          {scanError && <p className="error" role="alert">{scanError}</p>}
          <div className="scan-debug" role="status" aria-live="polite">
            <strong>Camera diagnostics</strong>
            <span>Frames analyzed: {scanStats.frames} · QR detections: {scanStats.decoded} · Resolution: {scanStats.size}</span>
            <span>{scanStatus}</span>
            <span>If frames increase but detections remain zero, hold the Sender test QR steady, improve focus and lighting, or select another camera.</span>
          </div>
          <div className="progress-label"><span>Received chunks</span><strong>{receiver.received} / {expected ?? '?'}</strong></div>
          <progress max={expected || 1} value={receiver.received} />
          <div className="progress-label"><span>Metadata QR parts</span><strong>{Object.keys(receiver.metadata).length} / {receiver.metadataTotal ?? '?'}</strong></div>
          {missingMeta.length > 0 && <div className="line-muted">Missing metadata parts: {abbreviateMissing(missingMeta)}</div>}
          <div className="line-muted" aria-live="polite">{receiver.notice}</div>
          <div className="stats">
            <span>File: <strong>{receiver.header?.name || 'Waiting for metadata'}</strong></span>
            <span>Size: <strong>{receiver.header ? readableBytes(receiver.header.size) : '—'}</strong></span>
            <span>SHA-256: <strong>{fileResult ? 'Verified' : (complete ? 'Verifying…' : 'Pending')}</strong></span>
          </div>
          {verifyError && <p className="error" role="alert">{verifyError}</p>}
          {fileResult && downloadUrl && <a className="download" href={downloadUrl} download={fileResult.name}>Download verified file ({readableBytes(fileResult.blob.size)})</a>}
          <details className="missing"><summary>Missing QR chunks ({missing.length})</summary><p>{expected === null ? 'Not yet known.' : abbreviateMissing(missing)}</p></details>
          <h2 className="received-title">Last successfully received QR</h2>
          <div className="qr-box received-qr">
            {receivedQR.image ? <img src={receivedQR.image} alt="Regenerated QR code of the last successfully received frame" />
              : <div className="placeholder">Accepted QR appears here after scanning</div>}
          </div>
          <p className="qr-status">{receiver.lastLabel || 'Waiting for a valid QR'}</p>
          {!!receiver.history.length && <details className="received-history">
            <summary>Received QR history (latest {receiver.history.length})</summary>
            <div className="received-gallery">{receiver.history.map((item, index) => <ReceivedQRCard key={`${item.label}-${index}`} qr={item.qr} label={item.label}/>)}</div>
          </details>}
        </section>
      </div>
      <footer>Open-source · No user accounts · No signaling server · SHA-256 file integrity · Camera frames remain in the browser</footer>
    </main>
  );
}
