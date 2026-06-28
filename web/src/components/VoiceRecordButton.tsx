import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * VoiceRecordButton — press-and-hold to record audio.
 *
 * Uses the browser's MediaRecorder API (universal) to capture audio.
 * On release, the recorded blob is returned via `onTranscribe` for the
 * parent to send to OpenAI Whisper (Phase 5) or any other STT backend.
 *
 * In Phase 1 the parent component simulates transcription with a
 * placeholder delay — this component just captures audio + emits the
 * blob. Whisper integration ships in P5.
 *
 * UX:
 *   - Hold the button → starts recording (red dot + elapsed counter)
 *   - Release → stops, fires onTranscribe(blob)
 *   - During transcription (parent says isTranscribing=true) → spinner
 *
 * Browser support: MediaRecorder works in Chrome/Edge/Firefox/Safari
 * (recent versions). On Tauri WebView it's always Chromium, so this is
 * safe in production.
 */
type Status = "idle" | "recording" | "transcribing";

export interface VoiceRecordButtonProps {
  onTranscribe: (blob: Blob) => void;
  isTranscribing?: boolean;
  disabled?: boolean;
  className?: string;
}

export function VoiceRecordButton({
  onTranscribe,
  isTranscribing = false,
  disabled = false,
  className,
}: VoiceRecordButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const status_: Status = isTranscribing ? "transcribing" : status;

  function startRecording() {
    if (disabled || status_ !== "idle") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      // Browser doesn't support mic — could show toast here.
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          chunksRef.current = [];
          // Stop the mic stream
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          setStatus("idle");
          onTranscribe(blob);
        };
        recorderRef.current = recorder;
        recorder.start();
        startedAtRef.current = Date.now();
        setStatus("recording");
        setElapsed(0);
        tickRef.current = setInterval(() => {
          setElapsed(Date.now() - startedAtRef.current);
        }, 100);
      })
      .catch(() => {
        // Mic permission denied or hardware error — silent fallback
        setStatus("idle");
      });
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    };
  }, []);

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={startRecording}
      onMouseUp={stopRecording}
      onMouseLeave={stopRecording}
      onTouchStart={startRecording}
      onTouchEnd={stopRecording}
      aria-label={status_ === "recording" ? "Recording — release to stop" : "Hold to record"}
      title="Hold to record"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
        "border border-border bg-bg-soft hover:bg-bg-elev",
        "disabled:cursor-not-allowed disabled:opacity-50",
        status_ === "recording" && "border-danger bg-danger/15 text-danger",
        status_ === "transcribing" && "border-accent bg-accent/15 text-accent",
        className,
      )}
    >
      {status_ === "recording" ? (
        <span className="relative flex h-full w-full items-center justify-center">
          <span className="absolute inset-0 animate-pulse rounded-md bg-danger/20" />
          <span className="relative flex flex-col items-center">
            <Square className="h-3.5 w-3.5" />
            <span className="font-mono text-[9px] tabular-nums leading-none">
              {Math.floor(elapsed / 1000)}s
            </span>
          </span>
        </span>
      ) : status_ === "transcribing" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );
}