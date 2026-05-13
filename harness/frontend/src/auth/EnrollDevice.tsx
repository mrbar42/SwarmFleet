import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { createEnrollmentQr } from "./api";

function formatExpiresIn(expiresAt: string, now: number): string {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return "Expiration unknown";
  const remainingMs = Math.max(0, expiresMs - now);
  if (remainingMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Expires in ${days}d ${hours}h`;
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`;
  return `Expires in ${minutes}m`;
}

export default function EnrollDevice() {
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(interval);
  }, []);

  const expiresIn = useMemo(
    () => (expiresAt ? formatExpiresIn(expiresAt, now) : null),
    [expiresAt, now],
  );

  const generateQr = async () => {
    setIsGenerating(true);
    setIsCopied(false);
    setError(null);
    try {
      const result = await createEnrollmentQr();
      const dataUrl = await QRCode.toDataURL(result.url, {
        margin: 1,
        width: 220,
        color: {
          dark: "#0d1117",
          light: "#ffffff",
        },
      });
      setUrl(result.url);
      setExpiresAt(result.expiresAt);
      setQrDataUrl(dataUrl);
      setNow(Date.now());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not generate QR code",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const copyUrl = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  };

  return (
    <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[#e6edf3]">
            Enroll a device
          </div>
          <p className="text-xs text-[#8b949e]">
            Generate a one-time QR link for a phone, tablet, or browser.
          </p>
        </div>
        <button
          onClick={() => void generateQr()}
          disabled={isGenerating}
          className="shrink-0 rounded-md bg-[#238636] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {url ? "Generate another" : "Enroll a new device"}
        </button>
      </div>

      {qrDataUrl && url && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div className="shrink-0 rounded-md bg-white p-2">
            <img
              src={qrDataUrl}
              alt="Enrollment QR code"
              className="h-40 w-40"
            />
          </div>
          <div className="min-w-0 flex-1">
            {expiresIn && (
              <p className="mb-2 text-xs font-medium text-[#d29922]">
                {expiresIn}
              </p>
            )}
            <div className="rounded-md border border-[#30363d] bg-[#0d1117] p-2">
              <p className="break-all font-mono text-xs text-[#8b949e]">
                {url}
              </p>
            </div>
            <button
              onClick={() => void copyUrl()}
              className="mt-2 rounded-md border border-[#30363d] px-2.5 py-1 text-xs text-[#8b949e] transition-colors hover:text-[#c9d1d9]"
            >
              {isCopied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-[#f85149]">{error}</p>}
    </div>
  );
}
