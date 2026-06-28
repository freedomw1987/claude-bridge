import { useRef, useState } from "react";
import { Paperclip, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { VoiceRecordButton } from "./VoiceRecordButton";
import { AttachmentChip, type Attachment } from "./AttachmentChip";
import { cn } from "@/lib/cn";

// Re-export for parent components that import RequirementInput + Attachment
// together (Dashboard, ProjectDetail). Avoids forcing them to know that
// the Attachment type actually lives in AttachmentChip.
export type { Attachment };

export interface RequirementInputProps {
  /** Placeholder for the textarea. */
  placeholder: string;
  /** Label on the submit button. */
  submitLabel: string;
  /** Variant: "primary" (accent color) or "ghost" (no background). */
  variant?: "primary" | "ghost";
  /**
   * Called when user submits. The function returns a Promise so the
   * parent can show a loading state on the button. Resolve on success.
   */
  onSubmit: (text: string, attachments: Attachment[]) => Promise<void> | void;
  /**
   * When true, the input is disabled and shows a loading spinner on
   * the submit button. Use during async submission.
   */
  isSubmitting?: boolean;
  className?: string;
}

/**
 * RequirementInput — universal input box for sending a new requirement
 * or follow-up command. Used on:
 *   - Dashboard (creates a new project)
 *   - ProjectDetail (sends a message to that project's Claude Code session)
 *
 * Supports text + image/file attachments + voice input (hold-to-record,
 * MediaRecorder → blob → Phase 5 will route to OpenAI Whisper).
 *
 * Submissions are currently mocked via a toast; real backend wiring
 * ships in Phase 3 (Add Todo).
 */
export function RequirementInput({
  placeholder,
  submitLabel,
  variant = "primary",
  onSubmit,
  isSubmitting = false,
  className,
}: RequirementInputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const next: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      if (f) next.push({ id: crypto.randomUUID(), file: f });
    }
    setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSubmit() {
    if (isSubmitting || isTranscribing) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    try {
      await onSubmit(trimmed, attachments);
      setText("");
      setAttachments([]);
    } catch (err) {
      toast.error("Submission failed", { description: String(err) });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  function onTranscribe(_blob: Blob) {
    setIsTranscribing(true);
    // TODO P5: POST /api/audio/transcribe with the blob.
    // For P1 we simulate transcription with a short delay + the
    // placeholder text below — gives the right UX shape.
    setTimeout(() => {
      const placeholder = "[transcribed voice] describe what to do";
      setText((t) => (t ? `${t} ${placeholder}` : placeholder));
      setIsTranscribing(false);
      toast.success("Voice captured", { description: "Transcribed (mock — Phase 5 wires Whisper)" });
    }, 800);
  }

  const canSubmit =
    (text.trim().length > 0 || attachments.length > 0) && !isSubmitting && !isTranscribing;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        "rounded-xl border bg-bg-soft p-3 transition-colors",
        dragOver ? "border-accent bg-accent/5" : "border-border",
        className,
      )}
    >
      {/* Attachments row */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={removeAttachment}
            />
          ))}
        </div>
      )}

      {/* Textarea + buttons row.
       *
       * Mobile (default): textarea on its own row, full width. Buttons
       * wrap to a second row, with voice + attach on the left and send
       * on the right. Larger touch targets (h-10) for thumb use.
       *
       * sm+ (≥ 640px): single horizontal row, textarea flex-1, all
       * three action buttons inline. Standard h-9 sizes.
       */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          disabled={isSubmitting || isTranscribing}
          className={cn(
            "min-h-[44px] min-w-0 flex-1 resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm",
            "placeholder:text-fg-muted focus:border-accent focus:outline-none",
            "disabled:opacity-50",
          )}
        />
        <div className="flex items-center justify-between gap-2 sm:contents">
          <div className="flex items-center gap-2">
            <VoiceRecordButton
              onTranscribe={onTranscribe}
              isTranscribing={isTranscribing}
              disabled={isSubmitting}
              className="h-10 w-10 sm:h-9 sm:w-9"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting}
              aria-label="Attach file"
              title="Attach file (drag & drop also works)"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-bg-soft hover:bg-bg-elev sm:h-9 sm:w-9",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = ""; // allow re-selecting the same file
              }}
              className="hidden"
            />
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              "flex h-10 shrink-0 items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors sm:h-9 sm:px-3",
              variant === "primary"
                ? "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/40"
                : "border border-border bg-bg text-fg hover:bg-bg-elev disabled:opacity-50",
              "disabled:cursor-not-allowed",
            )}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span>{submitLabel}</span>
          </button>
        </div>
      </div>

      {/* Hint */}
      <p className="mt-2 text-[10px] text-fg-muted">
        ⌘+Enter to send · drag & drop files · hold mic to record voice
      </p>
    </div>
  );
}