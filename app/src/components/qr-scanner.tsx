'use client';

import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Button } from '@/components/ui/button';

interface QRScannerProps {
  onScan: (result: string) => void;
  onError?: (error: string) => void;
}

export function QRScanner({ onScan, onError }: QRScannerProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [camerasLoaded, setCamerasLoaded] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);

  // Track mounted state and clean up on unmount. A fast navigate-away during
  // async camera startup could otherwise leak the camera stream.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopScanning();
    };
  }, []);

  // Load cameras only when user initiates scanning (to avoid camera light on page load)
  const loadCameras = async (): Promise<string | null> => {
    if (camerasLoaded && selectedCamera) {
      return selectedCamera;
    }

    try {
      const devices = await Html5Qrcode.getCameras();
      if (devices && devices.length) {
        setCameras(devices);
        // Prefer back camera on mobile
        const backCamera = devices.find(
          (d) => d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear')
        );
        const cameraId = backCamera?.id || devices[0].id;
        setSelectedCamera(cameraId);
        setCamerasLoaded(true);
        return cameraId;
      }
      return null;
    } catch (err) {
      console.error('Error getting cameras:', err);
      onError?.('Unable to access camera. Please check permissions.');
      return null;
    }
  };

  const startScanning = async () => {
    if (!containerRef.current) return;

    // Load cameras on first scan attempt (this is when camera permission is requested)
    const cameraId = await loadCameras();
    if (!cameraId) {
      onError?.('No cameras found. Please ensure camera permissions are granted.');
      return;
    }

    try {
      scannerRef.current = new Html5Qrcode('qr-reader');

      await scannerRef.current.start(
        cameraId,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        (decodedText) => {
          // Successfully scanned
          onScan(decodedText);
          stopScanning();
        },
        () => {
          // Scan error (ignore - this fires continuously when no QR is detected)
        }
      );

      // If the component unmounted while start() was awaiting (fast
      // navigate-away), immediately tear down so the camera stream isn't leaked.
      if (!isMountedRef.current) {
        stopScanning();
        return;
      }

      setIsScanning(true);
    } catch (err) {
      console.error('Error starting scanner:', err);
      onError?.('Failed to start camera. Please check permissions.');
    }
  };

  const stopScanning = async () => {
    // Always attempt to stop the scanner regardless of the isScanning flag.
    // Html5Qrcode.stop() throws harmlessly when not running, so guarding on
    // isScanning could leak a stream that started after the flag was read.
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (err) {
        console.error('Error stopping scanner:', err);
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  };

  return (
    <div className="space-y-4">
      {camerasLoaded && cameras.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor="camera-select" className="text-sm font-medium">
            Camera:
          </label>
          <select
            id="camera-select"
            value={selectedCamera}
            onChange={(e) => setSelectedCamera(e.target.value)}
            disabled={isScanning}
            className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.label || `Camera ${camera.id}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div
        id="qr-reader"
        ref={containerRef}
        className="w-full max-w-md mx-auto overflow-hidden rounded-lg bg-black"
        style={{ minHeight: isScanning ? '300px' : '0' }}
      />

      <div className="flex justify-center gap-2">
        {!isScanning ? (
          <Button onClick={startScanning}>
            Start Scanning
          </Button>
        ) : (
          <Button variant="destructive" onClick={stopScanning}>
            Stop Scanning
          </Button>
        )}
      </div>

      {camerasLoaded && cameras.length === 0 && (
        <p className="text-center text-muted-foreground">
          No cameras found. Please ensure camera permissions are granted.
        </p>
      )}
    </div>
  );
}
