import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import Peer, { type DataConnection } from "peerjs";
import { QRCodeSVG } from "qrcode.react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Beam — Send files between any device" },
      {
        name: "description",
        content:
          "Peer-to-peer file transfer between phone, tablet, laptop and desktop. No sign-up, no size limits — files go straight from device to device.",
      },
      { property: "og:title", content: "Beam — Send files between any device" },
      {
        property: "og:description",
        content:
          "Share a code, transfer files directly between your devices with end-to-end encrypted WebRTC.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const CHUNK_SIZE = 64 * 1024;
const ID_PREFIX = "beam-";

function shortId() {
  return Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type Meta = { kind: "meta"; name: string; size: number; type: string; id: string };
type Done = { kind: "done"; id: string };
type Signal = Meta | Done;

type Transfer = {
  id: string;
  name: string;
  size: number;
  type: string;
  direction: "in" | "out";
  received: number;
  status: "transferring" | "done" | "error";
  url?: string;
};

function Index() {
  const [myId, setMyId] = useState<string>("");
  const [peerReady, setPeerReady] = useState(false);
  const [remoteId, setRemoteId] = useState("");
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [connStatus, setConnStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const incomingRef = useRef<
    Record<string, { meta: Meta; chunks: BlobPart[]; received: number }>
  >({});

  // Init Peer
  useEffect(() => {
    const id = ID_PREFIX + shortId();
    const peer = new Peer(id, { debug: 1 });
    peerRef.current = peer;

    peer.on("open", (openId) => {
      setMyId(openId.replace(ID_PREFIX, ""));
      setPeerReady(true);
    });
    peer.on("error", (err) => {
      console.error(err);
      setError(err.message || "Connection error");
      setConnStatus((s) => (s === "connecting" ? "error" : s));
    });
    peer.on("connection", (incoming) => {
      wireConnection(incoming);
    });

    return () => {
      peer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function wireConnection(c: DataConnection) {
    setConnStatus("connecting");
    c.on("open", () => {
      setConn(c);
      setConnStatus("connected");
      setError(null);
    });
    c.on("close", () => {
      setConn(null);
      setConnStatus("idle");
    });
    c.on("error", (err) => {
      console.error(err);
      setError(err.message || "Connection error");
      setConnStatus("error");
    });
    c.on("data", (data) => handleData(data));
  }

  function handleData(data: unknown) {
    if (data instanceof ArrayBuffer || (data && (data as ArrayBufferView).byteLength !== undefined && !(data as { kind?: string }).kind)) {
      // binary chunk — belongs to the current active incoming transfer (the oldest not done)
      const activeId = Object.keys(incomingRef.current).find(
        (k) => incomingRef.current[k].received < incomingRef.current[k].meta.size,
      );
      if (!activeId) return;
      const entry = incomingRef.current[activeId];
      const buf = data as ArrayBuffer;
      entry.chunks.push(buf);
      entry.received += (buf as ArrayBuffer).byteLength;
      setTransfers((prev) =>
        prev.map((t) => (t.id === activeId ? { ...t, received: entry.received } : t)),
      );
      return;
    }
    const sig = data as Signal;
    if (sig.kind === "meta") {
      incomingRef.current[sig.id] = { meta: sig, chunks: [], received: 0 };
      setTransfers((prev) => [
        {
          id: sig.id,
          name: sig.name,
          size: sig.size,
          type: sig.type,
          direction: "in",
          received: 0,
          status: "transferring",
        },
        ...prev,
      ]);
    } else if (sig.kind === "done") {
      const entry = incomingRef.current[sig.id];
      if (!entry) return;
      const blob = new Blob(entry.chunks, { type: entry.meta.type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === sig.id ? { ...t, status: "done", received: entry.meta.size, url } : t,
        ),
      );
      delete incomingRef.current[sig.id];
    }
  }

  function connectToPeer() {
    if (!peerRef.current || !remoteId.trim()) return;
    setError(null);
    setConnStatus("connecting");
    const c = peerRef.current.connect(ID_PREFIX + remoteId.trim().toLowerCase(), {
      reliable: true,
    });
    wireConnection(c);
  }

  function disconnect() {
    conn?.close();
    setConn(null);
    setConnStatus("idle");
  }

  async function sendFiles(files: FileList | File[]) {
    if (!conn) return;
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const meta: Meta = {
        kind: "meta",
        id,
        name: file.name,
        size: file.size,
        type: file.type,
      };
      conn.send(meta);
      setTransfers((prev) => [
        {
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          direction: "out",
          received: 0,
          status: "transferring",
        },
        ...prev,
      ]);
      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        // backpressure
        // @ts-expect-error peerjs internal
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > 16 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 50));
        }
        conn.send(buf);
        offset += buf.byteLength;
        const sent = offset;
        setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, received: sent } : t)));
      }
      const done: Done = { kind: "done", id };
      conn.send(done);
      setTransfers((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "done", received: file.size } : t)),
      );
    }
  }

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !myId) return "";
    return `${window.location.origin}/?peer=${myId}`;
  }, [myId]);

  // Auto-fill from ?peer=
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("peer");
    if (p) setRemoteId(p);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-10 md:py-16">
        <header className="mb-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30">
              <BeamIcon />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Beam</h1>
              <p className="text-xs text-muted-foreground">Direct device-to-device transfer</p>
            </div>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:block">
            End-to-end encrypted · WebRTC
          </span>
        </header>

        <section className="mb-10 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
            Send anything, between any device.
          </h2>
          <p className="mt-4 text-base text-muted-foreground md:text-lg">
            Open Beam on both devices. Share the code — files stream peer-to-peer over an encrypted
            WebRTC channel. Nothing touches a server.
          </p>
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Your code */}
          <div className="rounded-3xl border bg-card p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Your device
              </h3>
              <span
                className={`inline-flex h-2 w-2 rounded-full ${
                  peerReady ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
            </div>
            <div className="flex items-start gap-6">
              <div>
                <p className="text-xs text-muted-foreground">Your code</p>
                <p className="mt-1 font-mono text-3xl font-semibold tracking-widest md:text-4xl">
                  {myId || "····"}
                </p>
                <button
                  disabled={!myId}
                  onClick={() => navigator.clipboard.writeText(myId)}
                  className="mt-4 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  Copy code
                </button>
              </div>
              {shareUrl && (
                <div className="ml-auto rounded-xl border bg-background p-2">
                  <QRCodeSVG value={shareUrl} size={96} />
                </div>
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Scan the QR on another device to open Beam pre-filled with this code.
            </p>
          </div>

          {/* Connect */}
          <div className="rounded-3xl border bg-card p-6 shadow-sm">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Connect to a device
            </h3>
            {connStatus !== "connected" ? (
              <div className="space-y-3">
                <input
                  value={remoteId}
                  onChange={(e) => setRemoteId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && connectToPeer()}
                  placeholder="Enter their code"
                  className="w-full rounded-xl border bg-background px-4 py-3 font-mono text-lg tracking-widest outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={connectToPeer}
                  disabled={!peerReady || !remoteId || connStatus === "connecting"}
                  className="w-full rounded-xl bg-primary py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {connStatus === "connecting" ? "Connecting…" : "Connect"}
                </button>
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 text-emerald-600">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-sm font-medium">Connected to {remoteId}</span>
                </div>
                <button
                  onClick={disconnect}
                  className="mt-4 rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (conn && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
          }}
          className={`mt-6 rounded-3xl border-2 border-dashed p-10 text-center transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border bg-card/50"
          } ${!conn ? "opacity-60" : ""}`}
        >
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <UploadIcon />
          </div>
          <p className="mt-4 text-base font-medium">
            {conn ? "Drop files here to send" : "Connect a device to start sending"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">or</p>
          <label
            className={`mt-3 inline-flex cursor-pointer rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background ${
              !conn ? "pointer-events-none" : ""
            }`}
          >
            Choose files
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && sendFiles(e.target.files)}
            />
          </label>
        </div>

        {/* Transfers */}
        {transfers.length > 0 && (
          <div className="mt-8 space-y-2">
            <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Transfers
            </h3>
            {transfers.map((t) => {
              const pct = t.size ? Math.min(100, (t.received / t.size) * 100) : 0;
              return (
                <div key={t.id} className="rounded-2xl border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={`grid h-9 w-9 place-items-center rounded-xl ${
                        t.direction === "in"
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      {t.direction === "in" ? <DownIcon /> : <UpIcon />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(t.received)} / {formatBytes(t.size)}
                        {t.status === "done" && " · Complete"}
                      </p>
                    </div>
                    {t.status === "done" && t.direction === "in" && t.url && (
                      <a
                        href={t.url}
                        download={t.name}
                        className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                      >
                        Save
                      </a>
                    )}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all ${
                        t.status === "done" ? "bg-emerald-500" : "bg-primary"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <footer className="mt-16 border-t pt-6 text-center text-xs text-muted-foreground">
          Files never leave your devices — transfers are peer-to-peer via WebRTC.
        </footer>
      </div>
    </div>
  );
}

function BeamIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v14" /><path d="m6 9 6-6 6 6" /><path d="M5 21h14" />
    </svg>
  );
}
function UpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
  );
}
function DownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
  );
}
