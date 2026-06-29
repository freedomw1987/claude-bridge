import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useSession } from "@/hooks/useSessions";
import { adoptConversation, heartbeatSession, streamSession } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { StatusPill } from "@/components/StatusPill";
import { TaskList } from "@/components/TaskList";
import { CostBadge } from "@/components/CostBadge";
import { TimerLine } from "@/components/TimerLine";
import { AISummaryCard } from "@/components/AISummaryCard";
import { CostTimeline } from "@/components/CostTimeline";
import { RequirementInput, type Attachment } from "@/components/RequirementInput";
import { Loader2, ArrowLeft, GitBranch, Clock, MessagesSquare, BarChart3, Zap } from "lucide-react";
import { formatDuration, formatRelative, truncate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { buildProjectTimeline, type ProjectTimeline } from "@/mocks/activity";
import type {
  ConversationDetail,
  HermesProjectDetail,
  Message,
  SessionDetail as SessionDetailType,
} from "@/types";

/**
 * SessionDetail — single route that handles BOTH modes:
 *   - conversation → 1-on-1 CC feed + input box + "Adopt to Hermes" CTA
 *   - hermes       → tabs (Conversation / Stats & Todo) — same as the
 *                    old ProjectDetail, but driven by the new model
 *
 * Mirrors `src/discord/handlers/hermes/dispatch.ts`: Hermes is opt-in,
 * default state is plain conversation.
 */

type HermesTab = "conversation" | "overview";

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hermesTab, setHermesTab] = useState<HermesTab>("conversation");

  // ── Hooks first (Rules of Hooks) ───────────────────────────────────
  const timeline = useMemo(
    () =>
      session.data?.mode === "hermes"
        ? buildProjectTimeline(session.data.id)
        : null,
    [session.data?.id, session.data?.mode],
  );

  // P2.5: heartbeat on mount + every 30s to mark the session as
  // actively in use. Tells the server-side dashboard "this user is
  // still looking at this session". Cheap — one POST every 30s.
  useEffect(() => {
    if (!id) return;
    void heartbeatSession(id).catch(() => undefined);
    const h = setInterval(() => {
      void heartbeatSession(id).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(h);
  }, [id]);

  // P2.5: subscribe to live journal + message events for this session.
  // New entries are appended to the in-page feed in real time without
  // waiting for the next TanStack Query refresh.
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  useEffect(() => {
    if (!id) return;
    setLiveMessages([]);
    const iter = streamSession(id);
    const sub = (async () => {
      try {
        for await (const ev of iter) {
          if (ev.kind === "message") {
            setLiveMessages((prev) => [...prev, ev.message]);
          }
        }
      } catch {
        // EventSource will auto-reconnect on disconnect; we just bail
        // out of this consumer iteration.
      }
    })();
    return () => {
      void sub.then(() => undefined).catch(() => undefined);
    };
  }, [id]);

  // Wire kill into the mock handler so the toast actually reflects
  // the real backend response. The "P1 mock" path is preserved
  // when USE_MOCKS is true.
  async function realKill(): Promise<{ status?: string }> {
    if (!id) return {};
    try {
      const { killSession } = await import("@/lib/api");
      return await killSession(id);
    } catch (err) {
      toast.error("Kill failed", { description: String(err) });
      return {};
    }
  }
  void realKill; // (wired into the kill handler below)

  // ── Early returns ───────────────────────────────────────────────────
  if (session.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-fg-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="ml-2 text-sm">Loading…</span>
      </div>
    );
  }

  if (session.isError || !session.data) {
    return (
      <div className="space-y-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-fg">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to sessions
        </Link>
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Session not found: {id}
        </div>
      </div>
    );
  }

  const s = session.data;
  const elapsed = s.endedAt
    ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
    : Date.now() - new Date(s.startedAt).getTime();
  const isHermes = s.mode === "hermes";
  const isTerminalHermes =
    isHermes &&
    s.status !== "executing" &&
    s.status !== "judging" &&
    s.status !== "planning" &&
    s.status !== "awaiting_approval";

  // ── Submit handlers ─────────────────────────────────────────────────

  /**
   * P1 mock for both modes. Phase 3 wires:
   *   - conversation: POST /api/sessions/:id/messages
   *   - hermes:       POST /api/sessions/:id/todos (add todo) or
   *                   POST /api/sessions/:id/messages (send to CC)
   */
  async function handleSubmit(text: string, attachments: Attachment[]) {
    setIsSubmitting(true);
    try {
      await new Promise((r) => setTimeout(r, 500));
      const kind = s.mode === "conversation" ? "to conversation" : "to project";
      toast.success(`Sent ${kind} (mock)`, {
        description:
          `Message: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"\n` +
          `Attachments: ${attachments.length}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * P3: real adoption — POST /api/sessions/:id/adopt creates a new
   * Hermes project from this conversation. On success, navigate to
   * the new project so the user sees the Hermes tabs view.
   */
  async function handleAdopt() {
    if (!s) return;
    try {
      const goal = s.goal.startsWith("Thread session in ")
        ? s.goal.replace(/^Thread session in /, "Work in ")
        : s.goal;
      const result = await adoptConversation(s.id, { goal, mode: "auto" });
      if (result.ok && result.projectId) {
        toast.success("Adopted as Hermes project", {
          description: `New project: ${result.projectId.slice(0, 8)}`,
        });
        navigate(`/sessions/${result.projectId}`);
      } else {
        toast.error("Adopt failed", { description: "no projectId returned" });
      }
    } catch (err) {
      toast.error("Adopt failed", { description: String(err) });
    }
  }

  return (
    <div className="space-y-6">
      <HeaderRow
        session={s}
        isHermes={isHermes}
        onAdopt={!isHermes ? handleAdopt : undefined}
      />
      <MetaStrip session={s} elapsed={elapsed} isHermes={isHermes} />

      {/* Hermes-mode: sticky tabs */}
      {isHermes && (
        <div className="sticky top-[57px] z-10 -mx-4 border-b border-border bg-bg/80 px-4 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex gap-1">
            <TabButton
              active={hermesTab === "conversation"}
              onClick={() => setHermesTab("conversation")}
              icon={<MessagesSquare className="h-3.5 w-3.5" />}
              label="Conversation"
              badge={s.journal.length}
            />
            <TabButton
              active={hermesTab === "overview"}
              onClick={() => setHermesTab("overview")}
              icon={<BarChart3 className="h-3.5 w-3.5" />}
              label="Statistics & Todo"
            />
          </div>
        </div>
      )}

      {/* Tab content */}
      {isHermes ? (
        hermesTab === "conversation" ? (
          <HermesConversationTab
            project={s as HermesProjectDetail}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            disabled={isTerminalHermes}
          />
        ) : (
          <HermesOverviewTab project={s as HermesProjectDetail} timeline={timeline} />
        )
      ) : (
        <ConversationTab
          conversation={{
            ...(s as ConversationDetail),
            // Merge in any live messages streamed via SSE so the
            // conversation feed updates without waiting for a refetch.
            messages: [
              ...(s as ConversationDetail).messages,
              ...liveMessages,
            ],
          }}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function HeaderRow({
  session,
  isHermes,
  onAdopt,
}: {
  session: SessionDetailType;
  isHermes: boolean;
  onAdopt?: () => void;
}) {
  return (
    <div>
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1 text-sm text-fg-dim hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to sessions
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isHermes ? (
              <GitBranch className="h-4 w-4 text-warn" />
            ) : (
              <MessagesSquare className="h-4 w-4 text-accent" />
            )}
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {session.goal}
            </h1>
          </div>
          <p className="mt-1 flex items-center gap-2 font-mono text-xs text-fg-muted">
            <span>{session.shortId}</span>
            <span>·</span>
            <span>{isHermes ? "Hermes project" : "Conversation"}</span>
            {isHermes && (
              <>
                <span>·</span>
                <span className="truncate">{truncate(session.repoPath, 60)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onAdopt && (
            <button
              type="button"
              onClick={onAdopt}
              className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-sm font-medium text-warn hover:bg-warn/20"
              title="Promote this conversation to a Hermes-managed project"
            >
              <Zap className="h-3.5 w-3.5" />
              Adopt as Hermes project
            </button>
          )}
          <StatusPill status={session.status} />
        </div>
      </div>
    </div>
  );
}

function MetaStrip({
  session,
  elapsed,
  isHermes,
}: {
  session: SessionDetailType;
  elapsed: number;
  isHermes: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-bg-soft px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 text-fg-muted" />
        <span className="text-fg-dim">Started</span>
        <span>{formatRelative(session.startedAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-fg-dim">Elapsed</span>
        <span className="font-mono tabular-nums">{formatDuration(elapsed)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-fg-dim">Messages</span>
        <span className="font-mono tabular-nums">{session.totalMessages}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-fg-dim">Cost</span>
        <span className="font-mono tabular-nums">
          ${(session.costUsd / 100).toFixed(2)}
        </span>
      </div>
      {isHermes && (
        <CostBadge
          used={session.costUsd}
          budget={(session as HermesProjectDetail).config.maxCostUsd}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-accent text-fg"
          : "border-transparent text-fg-dim hover:text-fg",
      )}
    >
      {icon}
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-mono",
            active ? "bg-accent/15 text-accent" : "bg-bg-elev text-fg-muted",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Conversation tab (mode === "conversation") ────────────────────────

function ConversationTab({
  conversation,
  onSubmit,
  isSubmitting,
}: {
  conversation: ConversationDetail;
  onSubmit: (text: string, attachments: Attachment[]) => Promise<void> | void;
  isSubmitting: boolean;
}) {
  return (
    <div className="space-y-4">
      <MessageFeed messages={conversation.messages} />
      <RequirementInput
        placeholder={`Send to ${conversation.shortId}… (text, files, or voice)`}
        submitLabel="Send"
        onSubmit={onSubmit}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}

function MessageFeed({ messages }: { messages: Message[] }) {
  // Oldest first — read top to bottom like a chat log.
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Conversation
        </h2>
        <span className="font-mono text-xs text-fg-muted">
          {messages.length} {messages.length === 1 ? "message" : "messages"}
        </span>
      </div>
      {messages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-bg-soft p-6 text-center text-sm text-fg-muted">
          No messages yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
        </ol>
      )}
      <p className="mt-2 text-xs text-fg-muted">
        Live stream ships in P2 (SSE).
      </p>
    </section>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <li
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          isUser
            ? "bg-accent/15 text-accent"
            : "bg-bg-elev text-fg-muted",
        )}
      >
        {isUser ? "You" : "CC"}
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
          isUser
            ? "rounded-tr-sm bg-accent text-white"
            : "rounded-tl-sm border border-border bg-bg-soft text-fg",
        )}
      >
        {message.content}
      </div>
      <span className="self-end pb-0.5 text-[10px] tabular-nums text-fg-muted">
        {new Date(message.ts).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </li>
  );
}

// ── Hermes project tabs (mode === "hermes") ──────────────────────────

function HermesConversationTab({
  project,
  onSubmit,
  isSubmitting,
  disabled,
}: {
  project: HermesProjectDetail;
  onSubmit: (text: string, attachments: Attachment[]) => Promise<void> | void;
  isSubmitting: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Awaiting approval banner — most important CTA in this tab */}
      {project.status === "awaiting_approval" && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-4">
          <h3 className="font-medium text-warn">Plan awaiting review</h3>
          <p className="mt-1 text-sm text-fg-dim">
            The planner LLM proposed {project.plan.length} tasks. Approve,
            edit, or request changes below. (Full review UI ships in P2.5.)
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-white hover:bg-success/90"
              disabled
            >
              ✓ Approve & run
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm hover:bg-bg-elev"
              disabled
            >
              ✏️ Edit tasks
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm hover:bg-bg-elev"
              disabled
            >
              ✗ Reject
            </button>
          </div>
        </div>
      )}

      {/* Active timer (auto mode) */}
      {project.timer &&
        (project.status === "executing" || project.status === "judging" ||
          project.status === "planning") && <TimerLine timer={project.timer} />}

      <JournalFeed journal={project.journal} />

      {disabled ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-soft p-4 text-center text-sm text-fg-muted">
          Project is {project.status} — no more input.
        </div>
      ) : (
        <RequirementInput
          placeholder={`Send to ${project.shortId}… (text, files, or voice)`}
          submitLabel="Send"
          onSubmit={onSubmit}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}

function HermesOverviewTab({
  project,
  timeline,
}: {
  project: HermesProjectDetail;
  timeline: ProjectTimeline | null;
}) {
  return (
    <div className="space-y-6">
      <AISummaryCard
        summary={`Plan has ${project.plan.length} tasks, ${
          project.plan.filter((t) => t.status === "done" || t.status === "skipped").length
        } completed${
          project.plan.some((t) => t.status === "in_progress")
            ? `, ${project.plan.filter((t) => t.status === "in_progress").length} in progress`
            : ""
        }${
          project.plan.some((t) => t.status === "failed")
            ? `, ${project.plan.filter((t) => t.status === "failed").length} failed`
            : ""
        }. Total cost $${(project.costUsd / 100).toFixed(2)} over ${project.iterations} iterations.`}
      />

      {timeline && <CostTimeline timeline={timeline} />}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Tasks ({project.plan.filter((t) => t.status === "done").length}/{project.plan.length})
        </h2>
        <TaskList tasks={project.plan} />
      </section>
    </div>
  );
}

function JournalFeed({
  journal,
}: {
  journal: HermesProjectDetail["journal"];
}) {
  const ordered = [...journal].reverse();
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Journal
        </h2>
        <span className="font-mono text-xs text-fg-muted">
          {journal.length} {journal.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-bg-soft p-6 text-center text-sm text-fg-muted">
          No journal entries yet.
        </p>
      ) : (
        <ol className="space-y-0.5 rounded-lg border border-border bg-bg-soft p-2 font-mono text-xs">
          {ordered.map((j, i) => (
            <li
              key={`${j.ts}-${i}`}
              className="flex gap-2 border-l-2 border-border px-2 py-1 hover:border-accent"
            >
              <span className="shrink-0 text-fg-muted">
                {new Date(j.ts).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-fg-dim">
                {j.type}
              </span>
              <span className="min-w-0 flex-1 text-fg-dim">{j.message}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-xs text-fg-muted">Live stream ships in P2 (SSE).</p>
    </section>
  );
}