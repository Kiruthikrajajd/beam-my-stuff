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
          "Peer-to-peer file transfer between phone, tablet, laptop and desktop. Auto-resumes if the connection drops.",
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
const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 20;

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
type ResumeState = {
  kind: "resume-state";
  // For every transfer this peer is receiving that isn't yet complete,
  // report how many bytes it already has. The sender resumes from there.
  incoming: { id: string; received: number }[];
};
type Signal = Meta | Done | ResumeState;

type Transfer = {
  id: string;
  name: string;
  size: number;
  type: string;
  direction: "in" | "out";
  received: number;
  status: "transferring" | "paused" | "done" | "error";
  url?: string;
};

function Index() {
  const [myId, setMyId] = useState<string>("");
  const [peerReady, setPeerReady] = useState(false);
  const [remoteId, setRemoteId] = useState("");
  const [connStatus, setConnStatus] = useState<
    "idle" | "connecting" | "connected" | "reconnecting" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  // Peer we are/were connected to (short form, no prefix). Used for auto-reconnect.
  const remotePeerRef = useRef<string | null>(null);
  // True if this side initiated the connection — only initiator auto-reconnects
  // to avoid duplicate connection races.
  const initiatedRef = useRef(false);
  const userDisconnectedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Incoming: chunks are appended as they arrive; survives reconnects.
  const incomingRef = useRef<
    Record<string, { meta: Meta; chunks: ArrayBuffer[]; received: number }>
  >({});
  // Which incoming id is currently receiving binary chunks (set by the last "meta"
  // received or by a resume announcement).
  const activeIncomingIdRef = useRef<string | null>(null);

  // Outgoing: the File plus how much has been ack'd/known-received by the peer.
  const outgoingRef = useRef<
    Record<string, { file: File; meta: Meta; offset: number; done: boolean }>
  >({});
  // Resume offsets reported by peer on (re)connect, keyed by transfer id.
  // Consumed by active send loops which check it after every await.
  const resumeOffsetsRef = useRef<Record<string, number>>({});
  // Resolvers waiting for the next successful (re)connection.
  const connectWaitersRef = useRef<Array<() => void>>([]);

  // ---------- Peer lifecycle ----------

  useEffect(() => {
    const id = ID_PREFIX + shortId();
    const peer = new Peer(id, { debug: 1 });
    peerRef.current = peer;

    peer.on("open", (openId) => {
      setMyId(openId.replace(ID_PREFIX, ""));
      setPeerReady(true);
    });
    peer.on("error", (err) => {
      console.error("[peer error]", err);
      // "peer-unavailable" during reconnect: keep trying, don't surface as fatal.
      const msg = err.message || String(err);
      if (connStatus === "reconnecting" && /unavailable/i.test(msg)) return;
      setError(msg);
      setConnStatus((s) => (s === "connecting" ? "error" : s));
    });
    peer.on("disconnected", () => {
      // Peer lost signaling — try to reconnect to the broker so we can
      // re-establish or accept data connections again.
      try {
        peer.reconnect();
      } catch {
        /* ignore */
      }
    });
    peer.on("connection", (incoming) => {
      // Remote initiated. Remember them so we can reconnect if they drop.
      remotePeerRef.current = incoming.peer.replace(ID_PREFIX, "");
      initiatedRef.current = false;
      wireConnection(incoming);
    });

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      peer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Connection wiring + resume handshake ----------

  function wireConnection(c: DataConnection) {
    setConnStatus((s) => (s === "reconnecting" ? "reconnecting" : "connecting"));

    c.on("open", () => {
      connRef.current = c;
      reconnectAttemptsRef.current = 0;
      setRemoteId(remotePeerRef.current ?? "");
      setConnStatus("connected");
      setError(null);

      // Announce which incoming transfers are still in flight so the peer
      // knows where to resume its outgoing sends.
      const incoming = Object.entries(incomingRef.current)
        .filter(([, v]) => v.received < v.meta.size)
        .map(([id, v]) => ({ id, received: v.received }));
      const msg: ResumeState = { kind: "resume-state", incoming };
      try {
        c.send(msg);
      } catch (err) {
        console.error("[send resume-state]", err);
      }

      // Wake any senders that were paused waiting for a live connection.
      const waiters = connectWaitersRef.current;
      connectWaitersRef.current = [];
      waiters.forEach((w) => w());
    });

    c.on("data", (data) => handleData(data));

    c.on("close", () => {
      connRef.current = null;
      // Anything in-flight is now paused.
      setTransfers((prev) =>
        prev.map((t) => (t.status === "transferring" ? { ...t, status: "paused" } : t)),
      );
      if (userDisconnectedRef.current) {
        userDisconnectedRef.current = false;
        setConnStatus("idle");
        remotePeerRef.current = null;
        return;
      }
      // Auto-reconnect only if we initiated originally and still know the peer.
      if (initiatedRef.current && remotePeerRef.current) {
        scheduleReconnect();
      } else {
        // The remote side (which initiated) will retry to us. Show "reconnecting"
        // as long as we still have live transfers to resume.
        const hasPending =
          Object.values(incomingRef.current).some((v) => v.received < v.meta.size) ||
          Object.values(outgoingRef.current).some((v) => !v.done);
        setConnStatus(hasPending ? "reconnecting" : "idle");
      }
    });

    c.on("error", (err) => {
      console.error("[conn error]", err);
      setError(err.message || "Connection error");
    });
  }

  function scheduleReconnect() {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setConnStatus("error");
      setError("Could not reconnect. Ask the other device to reconnect.");
      // Fail any still-pending transfers so the UI is honest.
      setTransfers((prev) =>
        prev.map((t) => (t.status === "paused" ? { ...t, status: "error" } : t)),
      );
      return;
    }
    setConnStatus("reconnecting");
    const attempt = ++reconnectAttemptsRef.current;
    const delay = Math.min(RECONNECT_DELAY_MS * attempt, 10_000);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      const peer = peerRef.current;
      const target = remotePeerRef.current;
      if (!peer || !target) return;
      if (peer.disconnected) {
        try {
          peer.reconnect();
        } catch {
          /* ignore */
        }
      }
      const c = peer.connect(ID_PREFIX + target, { reliable: true });
      wireConnection(c);
    }, delay);
  }

  function waitForConnection(): Promise<void> {
    if (connRef.current && connRef.current.open) return Promise.resolve();
    return new Promise((resolve) => {
      connectWaitersRef.current.push(resolve);
    });
  }

  // ---------- Incoming data handling ----------

  function handleData(data: unknown) {
    // Binary chunk: ArrayBuffer or a typed-array view.
    if (
      data instanceof ArrayBuffer ||
      (typeof data === "object" &&
        data !== null &&
        ArrayBuffer.isView(data as ArrayBufferView) &&
        !(data as { kind?: string }).kind)
    ) {
      const buf =
        data instanceof ArrayBuffer
          ? data
          : (data as ArrayBufferView).buffer.slice(
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
            );
      const activeId = activeIncomingIdRef.current;
      if (!activeId) return;
      const entry = incomingRef.current[activeId];
      if (!entry) return;
      entry.chunks.push(buf);
      entry.received += buf.byteLength;
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === activeId ? { ...t, received: entry.received, status: "transferring" } : t,
        ),
      );
      return;
    }
    const sig = data as Signal;
    if (sig.kind === "meta") {
      // A fresh transfer — or an announcement that this id is what follows next.
      if (!incomingRef.current[sig.id]) {
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
      }
      activeIncomingIdRef.current = sig.id;
    } else if (sig.kind === "done") {
      const entry = incomingRef.current[sig.id];
      if (!entry) return;
      const blob = new Blob(entry.chunks, {
        type: entry.meta.type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === sig.id
            ? { ...t, status: "done", received: entry.meta.size, url }
            : t,
        ),
      );
      delete incomingRef.current[sig.id];
      if (activeIncomingIdRef.current === sig.id) activeIncomingIdRef.current = null;
    } else if (sig.kind === "resume-state") {
      // Peer told us how many bytes it has for each in-flight transfer.
      // Any of our outgoing transfers matching these ids should resume from
      // that offset. Any outgoing NOT listed by the peer is assumed lost on
      // their side — we rewind to 0 to be safe.
      const map: Record<string, number> = {};
      for (const item of sig.incoming) map[item.id] = item.received;
      for (const [id, out] of Object.entries(outgoingRef.current)) {
        if (out.done) continue;
        resumeOffsetsRef.current[id] = map[id] ?? 0;
      }
    }
  }

  // ---------- Connect / disconnect actions ----------

  function connectToPeer() {
    if (!peerRef.current || !remoteId.trim()) return;
    setError(null);
    setConnStatus("connecting");
    initiatedRef.current = true;
    userDisconnectedRef.current = false;
    reconnectAttemptsRef.current = 0;
    remotePeerRef.current = remoteId.trim().toLowerCase();
    const c = peerRef.current.connect(ID_PREFIX + remotePeerRef.current, { reliable: true });
    wireConnection(c);
  }

  function disconnect() {
    userDisconnectedRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    connRef.current?.close();
    connRef.current = null;
    remotePeerRef.current = null;
    setRemoteId("");
    setConnStatus("idle");
  }

  // ---------- Sending ----------

  async function sendFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      const meta: Meta = {
        kind: "meta",
        id,
        name: file.name,
        size: file.size,
        type: file.type,
      };
      outgoingRef.current[id] = { file, meta, offset: 0, done: false };
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
      // Fire and forget; each send loop is resilient to disconnects.
      void sendFileLoop(id);
    }
  }

  async function sendFileLoop(id: string) {
    const entry = outgoingRef.current[id];
    if (!entry) return;
    const { file, meta } = entry;

    // Every time we (re)start streaming this file we must re-announce the meta
    // so the receiver routes subsequent binary chunks to the right transfer.
    let announced = false;

    while (entry.offset < file.size) {
      // Wait for a live connection.
      if (!connRef.current || !connRef.current.open) {
        setTransfers((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "paused" } : t)),
        );
        await waitForConnection();
        announced = false; // must re-announce after reconnect
      }

      // If the peer told us a resume offset, honor it (might be lower than
      // our optimistic local offset — the peer is the source of truth).
      if (resumeOffsetsRef.current[id] !== undefined) {
        entry.offset = resumeOffsetsRef.current[id];
        delete resumeOffsetsRef.current[id];
        setTransfers((prev) =>
          prev.map((t) => (t.id === id ? { ...t, received: entry.offset } : t)),
        );
      }

      const conn = connRef.current;
      if (!conn || !conn.open) continue;

      if (!announced) {
        try {
          conn.send(meta);
          announced = true;
        } catch (err) {
          console.error("[re-announce meta]", err);
          continue;
        }
      }

      // Backpressure on the underlying data channel.
      const dc = (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
      if (dc && dc.bufferedAmount > 16 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const end = Math.min(entry.offset + CHUNK_SIZE, file.size);
      const slice = file.slice(entry.offset, end);
      let buf: ArrayBuffer;
      try {
        buf = await slice.arrayBuffer();
      } catch (err) {
        console.error("[read file]", err);
        setTransfers((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "error" } : t)),
        );
        return;
      }

      // Re-check the connection after the async read.
      if (!connRef.current || !connRef.current.open) continue;

      try {
        connRef.current.send(buf);
      } catch (err) {
        console.error("[send chunk]", err);
        continue; // loop will wait for reconnect
      }
      entry.offset = end;
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, received: entry.offset, status: "transferring" } : t,
        ),
      );
    }

    // Signal completion (idempotent — receiver ignores unknown ids).
    const done: Done = { kind: "done", id };
    try {
      if (connRef.current?.open) connRef.current.send(done);
    } catch (err) {
      console.error("[send done]", err);
    }
    entry.done = true;
    setTransfers((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, status: "done", received: file.size } : t,
      ),
    );
  }

  // ---------- URL / QR ----------

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !myId) return "";
    return `${window.location.origin}/?peer=${myId}`;
  }, [myId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("peer");
    if (p) setRemoteId(p);
  }, []);

  // ---------- UI ----------

  const isConnected = connStatus === "connected";
  const isReconnecting = connStatus === "reconnecting";

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
            End-to-end encrypted · WebRTC · Auto-resume
          </span>
        </header>

        <section className="mb-10 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
            Send anything, between any device.
          </h2>
          <p className="mt-4 text-base text-muted-foreground md:text-lg">
            Open Beam on both devices. Share the code — files stream peer-to-peer over an encrypted
            WebRTC channel. If the connection drops, transfers resume automatically from where they
            stopped.
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
            {!isConnected && !isReconnecting ? (
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
                <div
                  className={`flex items-center gap-2 ${
                    isReconnecting ? "text-amber-600" : "text-emerald-600"
                  }`}
                >
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
                        isReconnecting ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                    />
                    <span
                      className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                        isReconnecting ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                    />
                  </span>
                  <span className="text-sm font-medium">
                    {isReconnecting
                      ? `Reconnecting to ${remotePeerRef.current ?? "peer"}…`
                      : `Connected to ${remoteId}`}
                  </span>
                </div>
                {isReconnecting && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Attempt {reconnectAttemptsRef.current} of {MAX_RECONNECT_ATTEMPTS}. Transfers
                    will resume automatically.
                  </p>
                )}
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
            if (isConnected && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
          }}
          className={`mt-6 rounded-3xl border-2 border-dashed p-10 text-center transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border bg-card/50"
          } ${!isConnected ? "opacity-60" : ""}`}
        >
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <UploadIcon />
          </div>
          <p className="mt-4 text-base font-medium">
            {isConnected ? "Drop files here to send" : "Connect a device to start sending"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">or</p>
          <label
            className={`mt-3 inline-flex cursor-pointer rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background ${
              !isConnected ? "pointer-events-none" : ""
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
              const barColor =
                t.status === "done"
                  ? "bg-emerald-500"
                  : t.status === "paused"
                    ? "bg-amber-500"
                    : t.status === "error"
                      ? "bg-destructive"
                      : "bg-primary";
              const statusText =
                t.status === "done"
                  ? " · Complete"
                  : t.status === "paused"
                    ? " · Paused, will resume"
                    : t.status === "error"
                      ? " · Failed"
                      : "";
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
                        {statusText}
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
                      className={`h-full transition-all ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <footer className="mt-16 border-t pt-6 text-center text-xs text-muted-foreground">
          Files never leave your devices — transfers are peer-to-peer via WebRTC, and resume
          automatically if the connection drops.
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
