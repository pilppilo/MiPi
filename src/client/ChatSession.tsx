import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_BOT_NAME_CHARACTERS,
  MAX_BOT_PURPOSE_CHARACTERS,
  MAX_PROMPT_CHARACTERS,
  type ConversationSummary,
  mainConversationId,
  type Options,
  ROOT_CONVERSATION_ID,
  type UsageReadout,
} from "../protocol.ts";
import type { ConversationSnapshot } from "./session/session-state.ts";
import {
  activityByBot,
  advanceLastRead,
  archivePrompt,
  type BotActivity,
  type LastRead,
  listedBots,
  loadLastRead,
  restoreHintFor,
  saveLastRead,
  unreadByBot,
  unreadIds,
} from "./session/bots-list.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { askMiPi } from "./diagnostics.ts";
import { DRAWER_CLOSED, drawerReducer } from "./drawer.ts";
import {
  modelName,
  profileName,
  profileSummary,
  thinkingName,
  toolName,
  toolSummary,
} from "./names.ts";
import {
  BotMark,
  botStatusLabel,
  CloseIcon,
  MenuIcon,
  SendIcon,
  SettingsIcon,
  WIDE_LAYOUT,
} from "./marks.tsx";
import { webPlatform } from "./platform/web.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageText, TranscriptList } from "./Transcript.tsx";
import { usePiSession } from "./usePiSession.ts";

interface ChatSessionProps {
  readonly sessionId: string;
}

const conversationLabel = ({ id, parent, owner, title, name }: ConversationSummary): string => {
  // A bot by its name, which the owner can change (MiPi's too): never a fixed string.
  if (name !== undefined) return name;
  if (owner !== undefined) return `Subagent (id: ${id}, owner: ${owner.conversationId})`;
  if (title !== undefined) return parent === undefined ? title : `${title} (fork)`;
  if (id === ROOT_CONVERSATION_ID) return "Main conversation";
  if (parent !== undefined) return `Fork (id: ${id}, from: ${parent.at})`;
  return "New conversation";
};

/** Which bots have something unread, remembered on this device (`Platform.storage`), the open one never. */
function useUnread(
  sessionId: string,
  conversations: readonly ConversationSummary[],
  activeConversationId: number | undefined,
): ReadonlySet<number> {
  const [lastRead, setLastRead] = useState<LastRead>(() =>
    loadLastRead(webPlatform.storage, sessionId),
  );
  const next = advanceLastRead(lastRead, conversations, activeConversationId);
  useEffect(() => {
    if (next === lastRead) return;
    setLastRead(next);
    saveLastRead(webPlatform.storage, sessionId, next);
  }, [next, lastRead, sessionId]);
  return unreadIds(next, conversations);
}

const statusLabel = {
  connecting: "Connecting",
  connected: "Connected",
  failed: "Connection failed",
} as const;

const TYPING_IDLE_MS = 1_500;

const dollars = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * Today's spend by MiPi's own estimate, against its cap, then each provider's busiest window (all of them on hover).
 * Marked when background work is held: paused, or over the spend cap.
 */
function UsageLine({ usage }: { readonly usage: UsageReadout }) {
  const spend =
    usage.cap === undefined
      ? `Today ~${dollars(usage.spent)}`
      : `Today ~${dollars(usage.spent)} of ${dollars(usage.cap)}`;
  const providers = usage.providers.map((provider) => {
    switch (provider.status) {
      case "unavailable":
        return `${provider.label}: unavailable`;
      case "ok": {
        const busiest = [...provider.windows].sort(
          (left, right) => right.percent - left.percent,
        )[0];
        return busiest === undefined
          ? provider.label
          : `${provider.label} ${Math.round(busiest.percent)}% ${busiest.name}`;
      }
      default: {
        const _: never = provider;
        throw new Error("Unknown provider usage");
      }
    }
  });
  const held =
    usage.held === "paused"
      ? "paused"
      : usage.held === "spend-cap"
        ? "over the cap"
        : usage.held === "provider-limit"
          ? "provider limit"
          : undefined;
  const details = usage.providers.flatMap((provider) => {
    switch (provider.status) {
      case "unavailable":
        return [`${provider.label}: ${provider.reason}`];
      case "ok":
        return provider.windows.map(
          (window) =>
            `${provider.label} ${window.name}: ${Math.round(window.percent)}%${window.limited ? " (limit reached)" : ""}, resets ${new Date(window.resetsAt).toLocaleString()}`,
        );
      default: {
        const _: never = provider;
        throw new Error("Unknown provider usage");
      }
    }
  });
  return (
    <p
      className={`usage-line${held === undefined ? "" : " usage-line--held"}`}
      title={[
        "MiPi's own estimate at list prices",
        `Scheduled runs: ${usage.runs.used} of ${usage.runs.cap} rounds`,
        ...details,
      ].join("\n")}
    >
      {[spend, ...providers, ...(held === undefined ? [] : [held])].join(" · ")}
    </p>
  );
}

const typingLabel = (usernames: readonly string[]): string => {
  if (usernames.length === 1) return `${usernames[0]} is typing…`;
  if (usernames.length === 2) return `${usernames[0]}, ${usernames[1]} are typing…`;
  return usernames.length > 2 ? "Many are typing…" : "";
};

const conversationIdFromLocation = (): number | undefined => {
  const value = new URLSearchParams(window.location.search).get("conversation");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export function ChatSession({ sessionId }: ChatSessionProps) {
  const [initialConversationId] = useState(conversationIdFromLocation);
  const session = usePiSession(sessionId, initialConversationId);
  const [showSystem, setShowSystem] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newCobotUnder, setNewCobotUnder] = useState<number>();
  const [renamingCobot, setRenamingCobot] = useState<number>();
  const [confirmingArchive, setConfirmingArchive] = useState<number>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The spaces drawer on narrow screens (COD-244); on wide ones it is the sidebar, always shown.
  const [drawer, dispatchDrawer] = useReducer(drawerReducer, DRAWER_CLOSED);
  const drawerToggleRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const newBotToggleRef = useRef<HTMLButtonElement | null>(null);
  const settingsToggleRef = useRef<HTMLButtonElement | null>(null);
  const settingsCloseRef = useRef<HTMLButtonElement | null>(null);
  const activityToggleRef = useRef<HTMLButtonElement | null>(null);
  const activityCloseRef = useRef<HTMLButtonElement | null>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const pinToLatestRef = useRef(true);
  const renderedConversationRef = useRef<number | undefined>(undefined);
  const transcriptHeightRef = useRef(0);
  const autoScrollingRef = useRef(false);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const autoScrollStartRef = useRef(0);
  const autoScrollTargetRef = useRef(0);
  const autoScrollStartedAtRef = useRef(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingConversationRef = useRef<number | undefined>(undefined);
  const activeConversationId = session.activeConversationId;
  const activeConversation = session.activeConversation;
  const activeSummary = session.conversations.find(({ id }) => id === activeConversationId);
  // Optional panels follow what the agent advertises (COD-246): one it doesn't is simply not there.
  const hasUsage = session.capabilities.has("usage");
  const hasActivity = session.capabilities.has("activity");
  const hasDiagnostics = session.capabilities.has("diagnostics");
  const activityGraph = hasActivity ? session.activity : undefined;
  const usage = hasUsage ? session.usage : undefined;
  const listed = listedBots(session.conversations);
  const activity = activityByBot(session.conversations, activityGraph);
  const ownUnread = useUnread(sessionId, session.conversations, activeConversationId);
  const unread = unreadByBot(session.conversations, ownUnread);
  const activityCount = Object.keys(activityGraph?.tasks ?? {}).length;
  const isConnected = session.status === "connected";
  // An archived conversation opens read-only (COD-201): the agent refuses its messages too.
  const readOnly = activeSummary?.archivedAt !== undefined;
  const restoreHint = restoreHintFor(activeSummary, session.conversations);
  const archiveQuestion = archivePrompt(activeSummary, session.conversations);
  const canSubmit =
    isConnected &&
    activeConversationId !== undefined &&
    !readOnly &&
    !submitting &&
    draft.trim().length > 0;

  const stopTyping = (): void => {
    if (typingTimeoutRef.current !== undefined) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = undefined;
    const conversationId = typingConversationRef.current;
    typingConversationRef.current = undefined;
    if (conversationId !== undefined) session.setTyping(conversationId, false);
  };

  const updateDraft = (content: string): void => {
    setDraft(content);
    if (!isConnected || activeConversationId === undefined || content.length === 0) {
      stopTyping();
      return;
    }
    if (typingConversationRef.current !== activeConversationId) {
      stopTyping();
      typingConversationRef.current = activeConversationId;
      session.setTyping(activeConversationId, true);
    }
    if (typingTimeoutRef.current !== undefined) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const stopAutoScroll = (): void => {
    if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = undefined;
    autoScrollingRef.current = false;
  };

  const followLatest = (transcript: HTMLElement): void => {
    const target = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    if (Math.abs(target - transcript.scrollTop) <= 1) {
      transcript.scrollTop = target;
      stopAutoScroll();
      return;
    }
    autoScrollStartRef.current = transcript.scrollTop;
    autoScrollTargetRef.current = target;
    autoScrollStartedAtRef.current = performance.now();
    if (autoScrollFrameRef.current !== undefined) return;
    autoScrollingRef.current = true;
    const step = (time: number): void => {
      const elapsed = time - autoScrollStartedAtRef.current;
      const progress = Math.min(elapsed / 180, 1);
      const eased = progress * progress * (3 - 2 * progress);
      const start = autoScrollStartRef.current;
      const target = autoScrollTargetRef.current;
      transcript.scrollTop = start + (target - start) * eased;
      if (progress >= 1 || Math.abs(target - transcript.scrollTop) <= 1) {
        transcript.scrollTop = target;
        autoScrollFrameRef.current = undefined;
        autoScrollingRef.current = false;
        return;
      }
      autoScrollFrameRef.current = requestAnimationFrame(step);
    };
    autoScrollFrameRef.current = requestAnimationFrame(step);
  };

  useEffect(() => () => stopTyping(), [activeConversationId, isConnected]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript === null) return;

    const conversationChanged = renderedConversationRef.current !== activeConversationId;
    const previousHeight = transcriptHeightRef.current;
    transcriptHeightRef.current = transcript.scrollHeight;
    if (conversationChanged) {
      renderedConversationRef.current = activeConversationId;
      pinToLatestRef.current = true;
      stopAutoScroll();
      transcript.scrollTop = transcript.scrollHeight;
      return;
    }
    if (!pinToLatestRef.current || transcript.scrollHeight === previousHeight) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopAutoScroll();
      transcript.scrollTop = transcript.scrollHeight;
      return;
    }

    followLatest(transcript);
  });

  useEffect(() => () => stopAutoScroll(), []);

  const openLinkedConversation = useEffectEvent(() => {
    const conversationId =
      conversationIdFromLocation() ?? mainConversationId(session.conversations);
    if (
      conversationId !== undefined &&
      conversationId !== activeConversationId &&
      session.conversations.some(({ id }) => id === conversationId)
    ) {
      session.openConversation(conversationId);
    }
    // Back or forward lands on a conversation: Settings would hide it.
    setSettingsOpen(false);
  });

  // Moved off a conversation archived under this tab (COD-233): its link goes too, so a reload doesn't reopen it.
  const shownConversationRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const shown = shownConversationRef.current;
    shownConversationRef.current = activeConversationId;
    const linked = conversationIdFromLocation();
    if (shown === undefined || linked !== shown || activeConversationId === undefined) return;
    if (activeConversationId === shown) return;
    const left = session.conversations.find(({ id }) => id === shown);
    if (
      left?.archivedAt !== undefined &&
      activeConversationId === mainConversationId(session.conversations)
    ) {
      window.history.replaceState(null, "", `?conversation=${activeConversationId}`);
    }
  }, [activeConversationId]);

  useEffect(() => {
    const handlePopState = (): void => openLinkedConversation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // The drawer's focus: into it as it opens, back to its toggle as it closes.
  useEffect(() => {
    if (drawer.focus === "drawer") {
      requestAnimationFrame(() => drawerRef.current?.focus());
    } else if (drawer.focus === "toggle") {
      requestAnimationFrame(() => drawerToggleRef.current?.focus());
    }
  }, [drawer]);

  // Grown wide while open: the drawer is the sidebar now, and nothing is left inert.
  useEffect(() => {
    const wide = window.matchMedia(WIDE_LAYOUT);
    const onChange = (): void => {
      if (wide.matches) dispatchDrawer({ type: "wide" });
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const content = draft.trim();
    if (
      content.length === 0 ||
      activeConversationId === undefined ||
      !isConnected ||
      readOnly ||
      submitting
    ) {
      return;
    }
    stopTyping();
    setSubmitting(true);
    try {
      const accepted = await session.submitPrompt(activeConversationId, content);
      if (accepted) setDraft((current) => (current === draft ? "" : current));
    } finally {
      setSubmitting(false);
    }
  };

  const trackTranscriptPosition = (): void => {
    const transcript = transcriptRef.current;
    if (transcript === null || autoScrollingRef.current) return;
    const distanceFromLatest =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    pinToLatestRef.current = distanceFromLatest <= 48;
  };

  const interruptAutoScroll = (): void => {
    if (autoScrollingRef.current) stopAutoScroll();
  };

  const submitWithKeyboardShortcut = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const followConversationLink = (
    event: MouseEvent<HTMLAnchorElement>,
    conversationId: number,
  ): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // Settings covers the conversation: picking one from the sidebar shows it.
    setSettingsOpen(false);
    pickedFromDrawer();
    if (conversationId !== session.activeConversationId) {
      window.history.pushState(null, "", event.currentTarget.href);
      session.openConversation(conversationId);
    }
  };

  const renderConversationLink = (summary: ConversationSummary) => (
    <a
      href={`?conversation=${summary.id}`}
      className={summary.kind === "main" ? "bot-link bot-link--main" : "bot-link"}
      aria-current={summary.id === activeConversationId ? "page" : undefined}
      onClick={(event) => followConversationLink(event, summary.id)}
    >
      {summary.kind === "cobot" || summary.owner !== undefined ? null : (
        <BotMark summary={summary} activity={activity.get(summary.id)} />
      )}
      <span className="bot-text">
        <span className="bot-name">
          {conversationLabel(summary)}
          <BotDots activity={activity.get(summary.id)} unread={unread.has(summary.id)} />
        </span>
        <span className="bot-status">{botStatusLabel(activity.get(summary.id))}</span>
      </span>
    </a>
  );

  const renderChildren = (id: number): ReactNode => {
    const children = listed.children.get(id);
    if (children === undefined) return null;
    return (
      <ul className="bot-children">
        {children.map((child) => (
          <li key={child.id}>
            {renderConversationLink(child)}
            {renderChildren(child.id)}
          </li>
        ))}
      </ul>
    );
  };

  const compactActivityLayout = (): boolean => window.matchMedia("(width < 75rem)").matches;

  const toggleActivity = (): void => {
    const opening = !activityOpen;
    setActivityOpen(opening);
    if (opening && compactActivityLayout()) {
      requestAnimationFrame(() => activityCloseRef.current?.focus());
    }
  };

  const closeActivity = (): void => {
    setActivityOpen(false);
    requestAnimationFrame(() => activityToggleRef.current?.focus());
  };

  const toggleSettings = (): void => {
    const opening = !settingsOpen;
    setSettingsOpen(opening);
    if (opening) dispatchDrawer({ type: "settings" });
    requestAnimationFrame(() => (opening ? settingsCloseRef : settingsToggleRef).current?.focus());
  };

  const closeSettings = (): void => {
    setSettingsOpen(false);
    // Settings was opened from the drawer: on a narrow screen its toggle is hidden with it, so the drawer's goes.
    requestAnimationFrame(() =>
      (window.matchMedia(WIDE_LAYOUT).matches
        ? settingsToggleRef
        : drawerToggleRef
      ).current?.focus(),
    );
  };

  /** New bot cancelled: the sheet goes, and focus returns to the button that opened it. */
  const closeNewBot = (): void => {
    setNewBotOpen(false);
    requestAnimationFrame(() => newBotToggleRef.current?.focus());
  };

  /** A bot picked in the drawer: it closes, and the conversation takes focus. */
  const pickedFromDrawer = (): void => {
    if (!drawer.open) return;
    dispatchDrawer({ type: "picked" });
    requestAnimationFrame(() => conversationHeadingRef.current?.focus());
  };

  const openFromSettings = (conversationId: number): void => {
    if (conversationId !== session.activeConversationId) {
      window.history.pushState(null, "", `?conversation=${conversationId}`);
      session.openConversation(conversationId);
    }
    setSettingsOpen(false);
    requestAnimationFrame(() => conversationHeadingRef.current?.focus());
  };

  /** Ask MiPi (COD-236): MiPi opens with the diagnostics in its composer. Nothing is sent until the owner sends it. */
  const askMiPiFromSettings = (prompt: string): void => {
    askMiPi(prompt, {
      conversations: session.conversations,
      open: (conversationId) => {
        if (conversationId !== session.activeConversationId) {
          window.history.pushState(null, "", `?conversation=${conversationId}`);
          session.openConversation(conversationId);
        }
      },
      // Not `updateDraft`: a prepared draft isn't the owner typing, so no typing presence goes out.
      setDraft,
      closeSettings: () => setSettingsOpen(false),
      // After the render that shows the conversation (and enables the composer).
      focusComposer: () => requestAnimationFrame(() => promptRef.current?.focus()),
    });
  };

  const workspaceClass = [
    "session-workspace",
    hasActivity && activityOpen ? "session-workspace--activity-open" : "",
    settingsOpen ? "session-workspace--settings-open" : "",
    drawer.open ? "session-workspace--drawer-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={workspaceClass}>
      {/* The spaces drawer on narrow screens, the sidebar on wide ones (COD-244, D · Spaces). */}
      <aside
        ref={drawerRef}
        id="spaces-drawer"
        className="session-sidebar"
        aria-label="Bots and settings"
        tabIndex={-1}
        inert={newBotOpen}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drawer.open) {
            event.stopPropagation();
            dispatchDrawer({ type: "close" });
          }
        }}
      >
        <header className="session-header">
          <h1>
            <a className="product-link" href="/">
              MiPi
            </a>
          </h1>
          <p className="connection-status" role="status">
            <span
              className={`connection-dot connection-dot--${session.status}`}
              aria-hidden="true"
            />
            {statusLabel[session.status]}
          </p>
          {usage === undefined ? null : <UsageLine usage={usage} />}
          {usage?.limits?.map((limit) => (
            <p key={limit.provider} className="usage-line usage-line--held" role="status">
              {limit.text}
            </p>
          ))}
        </header>

        {session.error === undefined ? null : (
          <p className="session-error" role="alert">
            {session.error}
          </p>
        )}

        <nav className="conversation-navigation" aria-labelledby="conversations-heading">
          <div className="conversation-navigation-header">
            <h2 id="conversations-heading" className="section-label">
              Bots
            </h2>
          </div>
          <div className="conversation-list" tabIndex={0}>
            {listed.main === undefined && listed.bots.length === 0 ? (
              <p className="conversation-list-empty">No bots yet.</p>
            ) : (
              <ul>
                {[listed.main, ...listed.bots].map((bot) =>
                  bot === undefined ? null : (
                    <li key={bot.id}>
                      {renderConversationLink(bot)}
                      {listed.children.has(bot.id) ? (
                        <details className="bot-tree" open>
                          <summary>Side chats and subagents</summary>
                          {renderChildren(bot.id)}
                        </details>
                      ) : null}
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        </nav>

        <div className="drawer-footer">
          <button
            ref={settingsToggleRef}
            className="round-button settings-toggle"
            type="button"
            aria-label="Settings"
            aria-controls="settings-panel"
            aria-expanded={settingsOpen}
            onClick={toggleSettings}
          >
            <SettingsIcon />
          </button>
          <button
            ref={newBotToggleRef}
            className="pill-button new-bot-toggle"
            type="button"
            aria-expanded={newBotOpen}
            aria-controls="new-bot-form"
            aria-haspopup="dialog"
            onClick={() => setNewBotOpen((open) => !open)}
            disabled={!isConnected}
          >
            New bot
          </button>
        </div>
      </aside>

      <div className="session-main">
        {/* Behind the open drawer, only the scrim takes a tap: the conversation is inert. */}
        <main className="conversation-view" inert={drawer.open || newBotOpen}>
          <header className="conversation-header">
            <div className="conversation-titlebar">
              <button
                ref={drawerToggleRef}
                className="round-button drawer-toggle"
                type="button"
                aria-label="Bots and settings"
                aria-controls="spaces-drawer"
                aria-expanded={drawer.open}
                onClick={() => dispatchDrawer({ type: "toggle" })}
              >
                <MenuIcon />
              </button>
              <details className="bot-profile">
                <summary aria-label="Bot details">
                  {activeSummary === undefined ? null : (
                    <BotMark
                      summary={activeSummary}
                      activity={activity.get(activeSummary.id)}
                      size="large"
                    />
                  )}
                  <h2 ref={conversationHeadingRef} id="transcript-heading" tabIndex={-1}>
                    {activeSummary === undefined
                      ? "Conversation"
                      : conversationLabel(activeSummary)}
                  </h2>
                </summary>
                <div className="bot-profile-panel">
                  {activeSummary?.kind !== "bot" || activeSummary.purpose === undefined ? null : (
                    <p className="bot-purpose">{activeSummary.purpose}</p>
                  )}
                  {activeConversation === undefined ? null : (
                    <ConversationDetails
                      conversation={activeConversation}
                      profile={activeSummary?.profile}
                      fixedProfile={activeSummary?.kind === "main"}
                      options={session.options}
                      disabled={!isConnected || readOnly}
                      onConfigure={(change) =>
                        session.configureConversation(activeConversation.id, change)
                      }
                    />
                  )}
                  <div className="bot-profile-links">
                    {/* A side chat under this bot (COD-200): here, beside its other actions, not under every bot in the list. */}
                    {activeSummary === undefined ||
                    activeSummary.archivedAt !== undefined ||
                    (activeSummary.kind !== "main" &&
                      activeSummary.kind !== "bot") ? null : newCobotUnder === activeSummary.id ? (
                      <CobotNameForm
                        key={`cobot-${activeSummary.id}`}
                        label="New cobot"
                        disabled={!isConnected}
                        onSave={async (name) => {
                          const bot = activeSummary.id;
                          if (await session.createCobot(bot, name)) {
                            setNewCobotUnder((current) => (current === bot ? undefined : current));
                            setSettingsOpen(false);
                          }
                        }}
                        onCancel={() => setNewCobotUnder(undefined)}
                      />
                    ) : (
                      <button
                        className="text-button"
                        type="button"
                        aria-expanded={false}
                        onClick={() => setNewCobotUnder(activeSummary.id)}
                        disabled={!isConnected}
                      >
                        New cobot
                      </button>
                    )}
                    {activeSummary?.kind !== "cobot" ||
                    activeSummary.archivedAt !== undefined ? null : renamingCobot ===
                      activeSummary.id ? (
                      <CobotNameForm
                        key={activeSummary.id}
                        label="Rename cobot"
                        name={activeSummary.name ?? ""}
                        disabled={!isConnected}
                        onSave={(name) => {
                          session.renameBot(activeSummary.id, name);
                          setRenamingCobot(undefined);
                        }}
                        onCancel={() => setRenamingCobot(undefined)}
                      />
                    ) : (
                      <button
                        className="text-button"
                        type="button"
                        disabled={!isConnected}
                        onClick={() => setRenamingCobot(activeSummary.id)}
                      >
                        Rename cobot
                      </button>
                    )}
                    {archiveQuestion === undefined ||
                    activeSummary === undefined ? null : confirmingArchive === activeSummary.id ? (
                      <div className="archive-confirm" role="group" aria-label="Archive">
                        <p>{archiveQuestion}</p>
                        <button
                          type="button"
                          disabled={!isConnected}
                          onClick={() => {
                            session.archiveBot(activeSummary.id);
                            setConfirmingArchive(undefined);
                          }}
                        >
                          Archive
                        </button>
                        <button type="button" onClick={() => setConfirmingArchive(undefined)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="text-button"
                        type="button"
                        disabled={!isConnected}
                        onClick={() => setConfirmingArchive(activeSummary.id)}
                      >
                        {activeSummary.kind === "cobot" ? "Archive cobot" : "Archive bot"}
                      </button>
                    )}
                  </div>
                  <div className="bot-profile-actions">
                    <label className="system-toggle">
                      <input
                        type="checkbox"
                        checked={showSystem}
                        onChange={(event) => setShowSystem(event.currentTarget.checked)}
                      />{" "}
                      Show system entries
                    </label>
                    {hasActivity ? (
                      <button
                        ref={activityToggleRef}
                        className="pill-button activity-toggle"
                        type="button"
                        aria-controls="activity-panel"
                        aria-expanded={activityOpen}
                        onClick={toggleActivity}
                      >
                        Activity <span aria-hidden="true">{activityCount}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              </details>
              {/* Reserved for voice (D · Spaces): empty until the agent advertises it. */}
              <span className="titlebar-slot" aria-hidden="true" />
            </div>
            {!readOnly ? null : (
              <div className="read-only-banner" role="status">
                <p>
                  {restoreHint === undefined
                    ? "Archived: read-only. Restore it to talk to it again."
                    : "Archived: read-only."}
                </p>
                <button
                  type="button"
                  disabled={!isConnected || restoreHint !== undefined}
                  title={restoreHint}
                  onClick={() => session.restoreBot(activeSummary.id)}
                >
                  Restore
                </button>
                {restoreHint === undefined ? null : (
                  <span className="archived-entry-hint">{restoreHint}</span>
                )}
              </div>
            )}
          </header>

          <section
            ref={transcriptRef}
            className="transcript"
            aria-labelledby="transcript-heading"
            role="log"
            tabIndex={0}
            onScroll={trackTranscriptPosition}
            onWheel={interruptAutoScroll}
            onTouchStart={interruptAutoScroll}
            onPointerDown={interruptAutoScroll}
          >
            {activeConversation === undefined ? (
              <p className="transcript-empty">Loading conversation…</p>
            ) : activeConversation.entries.length === 0 && activeConversation.live === null ? (
              <p className="transcript-empty">Send a message to begin.</p>
            ) : (
              <>
                {activeConversation.earlier ? (
                  <button
                    className="text-button transcript-load"
                    type="button"
                    onClick={() => session.loadEarlier(activeConversation.id)}
                  >
                    Load earlier messages
                  </button>
                ) : null}
                <TranscriptList
                  hideSystem={!showSystem}
                  entries={activeConversation.entries}
                  gaps={activeConversation.gaps}
                  tools={activeConversation.tools}
                  runActive={activeConversation.live !== null}
                  // No forking from the web until forks are cobots (COD-200): a fork is a plain chat, which the bots
                  // list doesn't show, so it would strand the owner in a chat they can't find again.
                  onFork={undefined}
                  onFillGap={(gap) => session.fillGap(activeConversation.id, gap)}
                />
              </>
            )}

            {activeConversation?.live === null || activeConversation?.live === undefined ? null : (
              <article
                className="transcript-message transcript-message--assistant transcript-message--live"
                aria-busy={activeConversation.live.active}
              >
                <header>
                  <div className="transcript-message-title">
                    <strong>Assistant</strong>
                  </div>
                  <button
                    className="text-button transcript-fork transcript-fork--placeholder"
                    type="button"
                    aria-hidden="true"
                    tabIndex={-1}
                    disabled
                  >
                    Fork
                  </button>
                </header>
                {activeConversation.live.text.length === 0 ? (
                  <p className="responding">Responding…</p>
                ) : (
                  <Markdown text={activeConversation.live.text} />
                )}
                {activeConversation.live.retry === undefined ? null : (
                  <p role="status">Retrying: {activeConversation.live.retry.error}</p>
                )}
              </article>
            )}

            {activeConversation === undefined ||
            activeConversation.compactions.length === 0 ? null : (
              <p className="compaction-status" role="status">
                {compactionStatusText(activeConversation.compactions)}
              </p>
            )}

            {activeConversation?.failure === undefined ? null : (
              <p className="transcript-error" role="alert">
                {activeConversation.failure.kind} failed: {activeConversation.failure.message}
              </p>
            )}

            {activeConversation === undefined || activeConversation.queued.length === 0 ? null : (
              <ol className="transcript-list queued-inputs" aria-label="Queued messages">
                {activeConversation.queued.map((input) => (
                  <li key={input.submissionId}>
                    <article className="transcript-message transcript-message--user transcript-message--queued">
                      <header>
                        <div className="transcript-message-title">
                          <strong>User</strong>
                          <span>Queued</span>
                        </div>
                      </header>
                      <MessageText text={input.text} />
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <form className="prompt-bar" onSubmit={submit}>
            <label className="visually-hidden" htmlFor="prompt">
              Message
            </label>
            <textarea
              ref={promptRef}
              id="prompt"
              name="prompt"
              rows={1}
              maxLength={MAX_PROMPT_CHARACTERS}
              value={draft}
              placeholder={readOnly ? "Archived: restore it to send a message." : "Message"}
              onChange={(event) => updateDraft(event.currentTarget.value)}
              onKeyDown={submitWithKeyboardShortcut}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              disabled={!isConnected || activeConversationId === undefined || readOnly}
            />
            <button
              className="send-button"
              type="submit"
              disabled={!canSubmit}
              aria-label={submitting ? "Sending" : "Send"}
            >
              <SendIcon />
            </button>
            <p className="typing-indicator" aria-live="polite">
              {typingLabel(activeConversation?.typing ?? [])}
            </p>
          </form>
        </main>

        {/* Over the main screen while the drawer is open: a tap anywhere on it closes the drawer. */}
        <button
          className="drawer-scrim"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => dispatchDrawer({ type: "close" })}
        />
      </div>

      {/* New bot (COD-244): a sheet over everything; nothing behind it takes input meanwhile. */}
      {newBotOpen ? (
        <div className="sheet-layer">
          <button
            className="sheet-backdrop"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={closeNewBot}
          />
          <NewBotForm
            profiles={(session.options?.profiles ?? [{ id: "default", name: "" }]).map(
              ({ id }) => id,
            )}
            options={session.options}
            disabled={!isConnected}
            onCreate={async (bot) => {
              const created = await session.createBot(bot);
              if (created) {
                setNewBotOpen(false);
                setSettingsOpen(false);
                pickedFromDrawer();
              }
              return created;
            }}
            onCancel={closeNewBot}
          />
        </div>
      ) : null}

      {hasActivity ? (
        <ActivityPanel
          graph={activityGraph}
          activeConversationId={activeConversationId}
          onClose={closeActivity}
          closeButtonRef={activityCloseRef}
          onOpenConversation={(conversationId) => {
            if (conversationId !== session.activeConversationId) {
              window.history.pushState(null, "", `?conversation=${conversationId}`);
              session.openConversation(conversationId);
            }
            if (compactActivityLayout()) {
              setActivityOpen(false);
              requestAnimationFrame(() => conversationHeadingRef.current?.focus());
            }
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          conversations={session.conversations}
          disabled={!isConnected}
          onOpen={openFromSettings}
          onRestore={(conversationId) => session.restoreBot(conversationId)}
          onClose={closeSettings}
          closeButtonRef={settingsCloseRef}
          diagnostics={
            hasDiagnostics
              ? {
                  diag: session.diag,
                  onSubscribe: session.subscribeDiag,
                  onUnsubscribe: session.unsubscribeDiag,
                  onAskMiPi: askMiPiFromSettings,
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

/** "New bot": a name and a purpose (its fixed instructions), on a profile the pickers offer (COD-197). */
/** A bot's dots: working or waiting (from the activity graph), and something unread. */
function BotDots({
  activity,
  unread,
}: {
  readonly activity: BotActivity | undefined;
  readonly unread: boolean;
}) {
  return (
    <>
      {activity === undefined ? null : (
        <span
          className={`bot-dot bot-dot--${activity}`}
          role="img"
          aria-label={activity === "running" ? "Working" : "Waiting"}
          title={activity === "running" ? "Working" : "Waiting"}
        />
      )}
      {unread ? (
        <span className="bot-dot bot-dot--unread" role="img" aria-label="Unread" title="Unread" />
      ) : null}
    </>
  );
}

function CobotNameForm({
  label,
  name,
  disabled,
  onSave,
  onCancel,
}: {
  readonly label: string;
  readonly name?: string;
  readonly disabled: boolean;
  readonly onSave: (name: string) => void | Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name ?? "");
  const [saving, setSaving] = useState(false);
  const ready = !disabled && !saving && draft.trim().length > 0;
  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await onSave(draft.trim());
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="new-bot-form" aria-label={label} onSubmit={submit}>
      <label>
        Name
        <input
          value={draft}
          maxLength={MAX_BOT_NAME_CHARACTERS}
          onChange={(event) => setDraft(event.currentTarget.value)}
          required
          autoFocus
        />
      </label>
      <div className="new-bot-actions">
        <button type="submit" disabled={!ready}>
          {name === undefined ? "Create" : "Save"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewBotForm({
  profiles,
  options,
  disabled,
  onCreate,
  onCancel,
}: {
  readonly profiles: readonly string[];
  readonly options: Options | undefined;
  readonly disabled: boolean;
  readonly onCreate: (bot: {
    readonly name: string;
    readonly purpose: string;
    readonly profile: string;
  }) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [profile, setProfile] = useState(profiles[0] ?? "default");
  const [creating, setCreating] = useState(false);
  const ready = name.trim().length > 0 && purpose.trim().length > 0 && !creating && !disabled;
  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setCreating(true);
    try {
      await onCreate({ name: name.trim(), purpose: purpose.trim(), profile });
    } finally {
      setCreating(false);
    }
  };
  return (
    <form
      id="new-bot-form"
      className="new-bot-form sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-heading"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <header className="sheet-header">
        <h2 id="new-bot-heading">New bot</h2>
        <button className="round-button" type="button" aria-label="Cancel" onClick={onCancel}>
          <CloseIcon />
        </button>
      </header>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={name}
          maxLength={MAX_BOT_NAME_CHARACTERS}
          placeholder="Planner"
          onChange={(event) => setName(event.currentTarget.value)}
          required
          autoFocus
        />
      </label>
      <label className="field">
        <span className="field-label">What it's for</span>
        <textarea
          value={purpose}
          maxLength={MAX_BOT_PURPOSE_CHARACTERS}
          rows={3}
          placeholder="Plan my week and keep my Linear issues tidy."
          onChange={(event) => setPurpose(event.currentTarget.value)}
          required
        />
        <span className="field-hint">
          This becomes its standing instructions. It can't be changed later.
        </span>
      </label>
      <fieldset className="toolkit-choices">
        <legend className="field-label">What it can use</legend>
        {profiles.map((id) => {
          const summary = profileSummary(id, options);
          return (
            <label key={id} className="toolkit-choice">
              <input
                type="radio"
                name="toolkit"
                value={id}
                checked={profile === id}
                onChange={() => setProfile(id)}
              />
              <span className="toolkit-choice-text">
                <strong>{profileName(id)}</strong>
                {summary === undefined ? null : <span>{summary}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="new-bot-actions">
        <button className="primary-button" type="submit" disabled={!ready}>
          {creating ? "Creating…" : "Create bot"}
        </button>
      </div>
    </form>
  );
}

function ConversationDetails({
  conversation,
  profile,
  options,
  disabled,
  onConfigure,
  fixedProfile,
}: {
  readonly conversation: ConversationSnapshot;
  readonly profile: string | undefined;
  /** MiPi always runs on `main`, which no picker offers: shown as text, not a select that falls back to another. */
  readonly fixedProfile: boolean;
  readonly options: Options | undefined;
  readonly disabled: boolean;
  readonly onConfigure: (change: { readonly model?: string; readonly profile?: string }) => void;
}) {
  const agent = conversation.agent;
  const totals = usageTotals(conversation.usage);
  const modelId = agent?.model?.modelId ?? options?.defaultModel;
  const shownProfile = profile ?? (fixedProfile ? "main" : "default");
  const summary = profileSummary(shownProfile, options);
  // What the bot can use right now, by plain name (`names.ts`); the ids stay in each chip's title.
  const tools =
    agent?.tools === undefined ? undefined : Array.isArray(agent.tools) ? agent.tools : undefined;
  const removed =
    agent?.tools !== undefined && !Array.isArray(agent.tools) ? agent.tools.remove : undefined;

  return (
    <section className="runtime-information" aria-label="Bot settings">
      <div className="detail-rows">
        <div className="detail-row">
          {options === undefined || options.models.length === 0 ? (
            <>
              <span className="detail-label">Model</span>
              <span className="detail-value" title={modelId}>
                {modelId === undefined ? "Provider default" : modelName(modelId, options)}
                {options?.modelsError === undefined ? null : (
                  <span className="detail-hint"> · the model list can't be read right now</span>
                )}
              </span>
            </>
          ) : (
            <>
              <label className="detail-label" htmlFor="model-picker">
                Model
              </label>
              <select
                id="model-picker"
                value={modelId}
                disabled={disabled}
                onChange={(event) => onConfigure({ model: event.currentTarget.value })}
              >
                {modelId === undefined || options.models.some(({ id }) => id === modelId) ? null : (
                  <option value={modelId}>{modelName(modelId, options)}</option>
                )}
                {options.models.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="detail-row">
          <label className="detail-label" htmlFor="profile-picker">
            Toolkit
          </label>
          {fixedProfile ? (
            <output
              id="profile-picker"
              className="detail-value"
              title="MiPi always has its own toolkit"
            >
              {profileName(shownProfile)}
            </output>
          ) : (
            <select
              id="profile-picker"
              value={shownProfile}
              disabled={disabled || options === undefined}
              onChange={(event) => onConfigure({ profile: event.currentTarget.value })}
            >
              {/* A profile no picker offers (the relay's old `pidu`) is shown as it is, never as another. */}
              {options === undefined ||
              options.profiles.some(({ id }) => id === shownProfile) ? null : (
                <option value={shownProfile}>{profileName(shownProfile)}</option>
              )}
              {(options?.profiles ?? [{ id: shownProfile, name: "" }]).map((choice) => (
                <option key={choice.id} value={choice.id} title={choice.name}>
                  {profileName(choice.id)}
                </option>
              ))}
            </select>
          )}
        </div>
        {summary === undefined ? null : <p className="detail-note">{summary}</p>}
      </div>

      <div className="detail-tools">
        <h3 className="section-label">It can use</h3>
        {tools === undefined ? (
          <p className="detail-note">
            {removed === undefined
              ? "The usual tools"
              : `The usual tools, except ${removed.map(toolName).join(", ")}`}
          </p>
        ) : tools.length === 0 ? (
          <p className="detail-note">Nothing but chat</p>
        ) : (
          <ul className="tool-chips">
            {tools.map((id) => (
              <li key={id} title={toolSummary(id) ?? id}>
                {toolName(id)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="detail-stats">
        {totals.tokens.toLocaleString()} tokens · {formatCached(totals)} cached ·{" "}
        {formatCost(totals.cost)} · Thinking: {thinkingName(agent?.thinkingLevel ?? "off")}
      </p>
    </section>
  );
}

interface UsageTotals {
  readonly tokens: number;
  readonly cost: number;
  /** Prompt tokens served from the provider's cache, and all prompt tokens (cached, written, and uncached). */
  readonly cacheRead: number;
  readonly prompt: number;
}

function usageTotals(usage: ConversationSnapshot["usage"]): UsageTotals {
  let tokens = 0;
  let cost = 0;
  let cacheRead = 0;
  let prompt = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const value of Object.values(bucket)) {
      tokens += value.totalTokens;
      cost += value.cost.total;
      cacheRead += value.cacheRead;
      prompt += value.input + value.cacheRead + value.cacheWrite;
    }
  }
  return { tokens, cost, cacheRead, prompt };
}

/** `1,536 (62%)`: how much of the prompt came from the provider's cache, the measure COD-166 keeps high. */
export function formatCached({
  cacheRead,
  prompt,
}: Pick<UsageTotals, "cacheRead" | "prompt">): string {
  if (prompt === 0) return "0";
  return `${cacheRead.toLocaleString()} (${Math.round((cacheRead / prompt) * 100)}%)`;
}

const costFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const formatCost = (cost: number): string => costFormatter.format(cost);

function compactionStatusText(compactions: ConversationSnapshot["compactions"]): string {
  return compactions.some(({ blocking }) => blocking)
    ? "Compacting context before responding…"
    : "Compacting context in the background…";
}
