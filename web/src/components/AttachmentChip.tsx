import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface Attachment {
  id: string;
  file: File;
  previewUrl?: string;
}

/**
 * Thumbnail chip for one uploaded file. Images show an inline preview,
 * other files show an icon + name + size.
 *
 * `previewUrl` is a blob: URL created via `URL.createObjectURL` and
 * must be revoked when the chip is removed (cleanup in the useEffect).
 */
export function AttachmentChip({
  attachment,
  onRemove,
  className,
}: {
  attachment: Attachment;
  onRemove: (id: string) => void;
  className?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    attachment.previewUrl ?? null,
  );

  useEffect(() => {
    if (attachment.previewUrl) {
      setPreviewUrl(attachment.previewUrl);
      return;
    }
    if (attachment.file.type.startsWith("image/")) {
      const url = URL.createObjectURL(attachment.file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [attachment]);

  const isImage = attachment.file.type.startsWith("image/");
  const sizeLabel = formatSize(attachment.file.size);

  return (
    <div
      className={cn(
        "group inline-flex items-center gap-2 rounded-lg border border-border bg-bg-soft p-1.5",
        className,
      )}
    >
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-bg-elev">
        {isImage && previewUrl ? (
          <img
            src={previewUrl}
            alt={attachment.file.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-fg-muted">
            {isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 px-1">
        <div className="truncate text-xs font-medium">{attachment.file.name}</div>
        <div className="font-mono text-[10px] text-fg-muted">{sizeLabel}</div>
      </div>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.file.name}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-danger/10 hover:text-danger"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}