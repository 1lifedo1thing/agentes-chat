import type { Artifact, LiveKind, LiveRoomError, LiveSelection } from "@agenteschat/client";
import {
  ApiError,
  isLiveFileKind,
  useArtifact,
  useArtifactVersions,
  useDuplicateLiveFile,
  useLivePeers,
  useRenameLiveFile,
  useRestoreLiveVersion,
  useSaveLiveVersion,
} from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockHour, dayLabel, formatTime } from "@agenteschat/client/lib/format";
import type { Peer } from "@agenteschat/live/awareness";
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  Icon,
  Kbd,
  Menu,
  MenuItem,
  MenuSeparator,
  modKey,
  Skeleton,
  SkeletonGroup,
  typingInField,
  useDelayed,
  useMatchMedia,
} from "@agenteschat/ui";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useArtifactDownload, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useFileShare } from "@/components/artifacts/ShareDialog";
import { useOrg } from "@/components/org-context";
import { contextMenuHandler, type MenuEntry } from "@/lib/context-menu";
import { useDocumentTitle } from "@/lib/desktop";
import { useToast } from "@/lib/toast";
import { AskAgentButton, AskAgentForm } from "./AskAgent";
import { Canvas } from "./canvas";
import type { LiveEditorProps, LiveEditorSearch } from "./editor";
import { forgetJustCreated, wasJustCreated } from "./just-created";
import { FollowingIsland, PresenceStack, usePeerLooks } from "./peers";
import { Slides } from "./slides";
import { Spreadsheet } from "./spreadsheet";
import { useLiveRoomWeb, useLiveVersionRoom } from "./useLiveRoomWeb";
import { SaveVersionDialog, VersionsPanel } from "./VersionsPanel";
import "./live.css";

/** The page's address: a version to look at (`v`), and the editor's own place (a sheet, a slide, presenting). */
export interface LiveFileSearch extends LiveEditorSearch {
  v?: number;
}

/** Under this width the header keeps its faces and its one primary action; the rest goes into ⋯ (ADR 0191 §9). */
export const LIVE_COMPACT_QUERY = "(max-width: 760px)";
/** "Salvando…" only once a change has waited this long: a burst of keys never blinks it. */
const SAVING_AFTER_MS = 400;

const EDITORS: Record<LiveKind, ComponentType<LiveEditorProps>> = {
  spreadsheet: Spreadsheet,
  slides: Slides,
  canvas: Canvas,
};

/**
 * A spreadsheet, a presentation or a canvas on a page of its own (ADR 0191 §9), full bleed with no sidebar: a header
 * (back, the kind, the title to rename, whether it's saved, who is here, Ask an agent, Share, Present for slides,
 * Download, ⋯) over the kind's editor, which draws everything below it. The page opens the file's room, says when it
 * is offline or read-only, shows a saved version read-only in place (`?v=`), and keeps whom the person follows.
 */
export function LiveFilePage({
  fileId,
  search,
  onSearch,
}: {
  fileId: string;
  search: LiveFileSearch;
  onSearch: (patch: Partial<LiveFileSearch>) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const compact = useMatchMedia(LIVE_COMPACT_QUERY);
  const query = useArtifact(org.id, fileId);
  const artifact = query.data;
  const kind: LiveKind | null = artifact && isLiveFileKind(artifact.kind) ? artifact.kind : null;
  const live = useLiveRoomWeb(org.id, fileId, { kind });
  const version = useLiveVersionRoom(org.id, fileId, search.v, kind);
  const peers = useLivePeers(live.room);
  const looks = usePeerLooks();
  const pageRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<LiveSelection | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(() => Boolean(search.v));
  const [saveOpen, setSaveOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [followId, setFollowId] = useState<number | null>(null);
  const save = useSaveLiveVersion(org.id, fileId);
  const restore = useRestoreLiveVersion(org.id, fileId);
  const share = useFileShare();
  const remover = useDeleteArtifact(() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } }));
  // The window's title in the desktop app (its Window menu, Mission Control) and the browser's tab: the file's name.
  useDocumentTitle(artifact?.title);

  // Not a live file (an old link, a file that changed kind): the Drive's viewer shows it.
  useEffect(() => {
    if (!artifact || isLiveFileKind(artifact.kind)) return;
    void navigate({
      to: "/org/$orgId/drive",
      params: { orgId: org.id },
      search: { artifact: artifact.id },
      replace: true,
    });
  }, [artifact, navigate, org.id]);

  // What the server refused while the person edits, said once each time.
  useEffect(() => {
    const room = live.room;
    if (!room) return;
    const words: Partial<Record<LiveRoomError, string>> = {
      too_large: t("live.shell.errors.tooLarge"),
      rate: t("live.shell.errors.rate"),
      read_only: t("live.shell.errors.readOnly"),
      invalid: t("live.shell.errors.invalid"),
    };
    return room.onError((code) => {
      const text = words[code];
      if (text) toast.show(text, code === "rate" ? "info" : "error");
    });
  }, [live.room, t, toast]);

  // Whom the person follows: their presence says so, and the island shows while they are here.
  const following = followId === null ? null : (peers.find((p) => p.clientId === followId) ?? null);
  const followedName = useRef<string | null>(null);
  if (following) followedName.current = looks(following.user).name;
  useEffect(() => {
    live.room?.setLocal({ following: followId ?? undefined });
  }, [live.room, followId]);
  useEffect(() => {
    if (followId === null || following || live.status !== "live") return;
    // They left the file.
    if (followedName.current) toast.show(t("live.shell.presence.left", { name: followedName.current }), "info");
    followedName.current = null;
    setFollowId(null);
  }, [followId, following, live.status, toast, t]);
  const follow = useCallback((peer: Peer | null) => setFollowId(peer ? peer.clientId : null), []);
  const stopFollowing = useCallback(() => setFollowId(null), []);

  const readOnlyNow = live.loaded && live.mode === "view";
  const previewing = search.v !== undefined;
  const canChange = Boolean(artifact) && !readOnlyNow && !previewing;
  const openSave = useCallback(() => {
    if (canChange) setSaveOpen(true);
  }, [canChange]);

  // ⌘S saves a version (free in the desktop app); ? shows the shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        openSave();
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !typingInField(e.target)) {
        if (document.querySelector('[role="dialog"], [role="menu"]')) return;
        e.preventDefault();
        setKeysOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSave]);

  // Presenting: the page takes the screen inside the click (a browser allows it only there); leaving the screen leaves
  // presenting, and leaving presenting gives the screen back.
  const present = () => {
    const el = pageRef.current;
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    onSearch({ present: true });
  };
  const presenting = Boolean(search.present);
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && presenting) onSearch({ present: undefined });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [presenting, onSearch]);
  useEffect(() => {
    if (!presenting && document.fullscreenElement && document.fullscreenElement === pageRef.current) {
      void document.exitFullscreen?.().catch(() => {});
    }
  }, [presenting]);

  // On its way to the Drive's viewer (not a live file): its socket was refused, which says nothing about the file.
  const leaving = Boolean(artifact) && !kind;
  const notFound =
    (query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403)) ||
    (!leaving && live.status === "closed" && (live.error === "not_found" || live.error === "forbidden"));
  if (notFound) {
    return (
      <div className="lf-page lf-page--empty">
        <EmptyState
          size="page"
          icon="file"
          title={t("live.shell.notFound.title")}
          actions={
            <Button
              variant="primary"
              onClick={() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } })}
            >
              {t("live.shell.notFound.back")}
            </Button>
          }
        />
      </div>
    );
  }
  if (query.isError || (!leaving && live.status === "closed" && live.error !== null && !live.loaded)) {
    return (
      <div className="lf-page lf-page--empty">
        <EmptyState
          size="page"
          icon="alert"
          title={t("live.shell.failed.title")}
          actions={
            <Button
              onClick={() => {
                void query.refetch();
                live.room?.checkAlive();
              }}
            >
              {t("live.shell.failed.retry")}
            </Button>
          }
        >
          {query.isError ? errorText(t, query.error, i18n.language) : t("live.shell.failed.body")}
        </EmptyState>
      </div>
    );
  }

  const room = previewing ? version.room : live.room;
  const ready = Boolean(artifact && kind && room && (previewing ? version.room : live.loaded));
  const Editor = kind ? EDITORS[kind] : null;
  return (
    <div
      ref={pageRef}
      className={cx("lf-page", presenting && "lf-page--presenting")}
      data-kind={kind ?? undefined}
      data-compact={compact || undefined}
    >
      {!presenting && (
        <LiveHeader
          artifact={artifact ?? null}
          kind={kind}
          live={live}
          previewing={previewing}
          compact={compact}
          peers={peers}
          followId={followId}
          onFollow={follow}
          selection={selection}
          onAsk={() => setAskOpen(true)}
          onShare={() => artifact && share.open(artifact)}
          onPresent={present}
          onVersions={() => setVersionsOpen((o) => !o)}
          onSave={openSave}
          onShortcuts={() => setKeysOpen(true)}
          onDelete={() => artifact && remover.ask(artifact)}
        />
      )}
      <div className="lf-body">
        <div className="lf-stage">
          {previewing && artifact && (
            <VersionBanner
              fileId={fileId}
              version={search.v ?? 0}
              canRestore={!readOnlyNow}
              busy={restore.isPending}
              onRestore={() => {
                const v = search.v;
                if (!v) return;
                restore.mutate(v, {
                  onSuccess: () => {
                    toast.show(t("live.shell.versions.restored", { version: v }));
                    onSearch({ v: undefined });
                  },
                  onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
                });
              }}
              onBack={() => onSearch({ v: undefined })}
            />
          )}
          {following && !previewing && !presenting && <FollowingIsland peer={following} onStop={stopFollowing} />}
          {previewing && version.failed ? (
            <EmptyState
              size="panel"
              icon="alert"
              title={t("live.shell.versions.openFailed")}
              actions={<Button onClick={version.retry}>{t("live.shell.versions.retry")}</Button>}
            />
          ) : ready && Editor && room && artifact ? (
            <div className="lf-editor" data-kind={kind}>
              <Editor
                key={previewing ? `v${search.v}` : "live"}
                room={room}
                orgId={org.id}
                artifact={artifact}
                readOnly={previewing || readOnlyNow}
                locale={i18n.language}
                search={search}
                onSearch={onSearch}
                following={previewing ? null : following}
                onStopFollowing={stopFollowing}
                onSelection={setSelection}
                onAsk={previewing ? undefined : () => setAskOpen(true)}
              />
            </div>
          ) : (
            <EditorSkeleton
              kind={kind}
              label={previewing ? t("live.shell.versions.opening") : t("live.shell.loading")}
            />
          )}
        </div>
        {versionsOpen && artifact && !presenting && (
          <VersionsPanel
            artifact={artifact}
            room={live.room}
            shown={search.v}
            onShow={(v) => onSearch({ v })}
            onSave={openSave}
            canSave={!readOnlyNow}
            onClose={() => {
              setVersionsOpen(false);
              if (previewing) onSearch({ v: undefined });
            }}
          />
        )}
      </div>
      <SaveVersionDialog
        open={saveOpen}
        busy={save.isPending}
        onClose={() => setSaveOpen(false)}
        onSave={(name) =>
          save.mutate(name || null, {
            onSuccess: (done) => {
              setSaveOpen(false);
              toast.show(done.version === null ? t("live.shell.versions.nothingNew") : t("live.shell.versions.saved"));
            },
            onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
          })
        }
      />
      {artifact && (
        <Dialog
          open={askOpen}
          onOpenChange={setAskOpen}
          title={t("live.shell.askAgent.title")}
          closeLabel={t("common.close")}
          width={440}
        >
          {askOpen && <AskAgentForm artifact={artifact} selection={selection} onDone={() => setAskOpen(false)} />}
        </Dialog>
      )}
      <ShortcutsDialog open={keysOpen} kind={kind} onClose={() => setKeysOpen(false)} />
      {remover.dialog}
      {share.dialog}
    </div>
  );
}

/** The page's top bar: back, the kind, the title and how it's saved, then who is here and the file's actions. */
function LiveHeader({
  artifact,
  kind,
  live,
  previewing,
  compact,
  peers,
  followId,
  onFollow,
  selection,
  onAsk,
  onShare,
  onPresent,
  onVersions,
  onSave,
  onShortcuts,
  onDelete,
}: {
  artifact: Artifact | null;
  kind: LiveKind | null;
  live: ReturnType<typeof useLiveRoomWeb>;
  previewing: boolean;
  compact: boolean;
  peers: Peer[];
  followId: number | null;
  onFollow: (peer: Peer | null) => void;
  selection: LiveSelection | null;
  onAsk: () => void;
  onShare: () => void;
  onPresent: () => void;
  onVersions: () => void;
  onSave: () => void;
  onShortcuts: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const downloads = useArtifactDownload();
  const duplicate = useDuplicateLiveFile(org.id, artifact?.id ?? "");
  const rename = useRenameLiveFile(org.id, artifact?.id ?? "");
  const readOnly = live.loaded && live.mode === "view";
  const status = useStatusWords(live, previewing);
  const toDrive = () => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } });
  const back = () => {
    // Where the person came from in the app, else the Drive.
    if (router.history.canGoBack()) router.history.back();
    else toDrive();
  };
  const copy = () => {
    if (!artifact) return;
    duplicate.mutate(t("live.shell.copyTitle", { title: artifact.title }), {
      onSuccess: (made) =>
        toast.show(t("live.shell.duplicated", { title: made.title }), "success", {
          label: t("live.shell.open"),
          run: () =>
            void navigate({ to: "/org/$orgId/drive/$fileId", params: { orgId: org.id, fileId: made.id }, search: {} }),
        }),
      onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
    });
  };
  const formats = kind ? downloads.formats(kind) : [];
  // The header's right click (the desktop app's own menu when the person chose it): the file's actions, as ⋯ has them.
  const menu = (): MenuEntry[] =>
    artifact
      ? [
          { kind: "header", label: artifact.title },
          ...(artifact.inDrive !== false
            ? [{ kind: "item", id: "share", label: t("share.button"), icon: "personAdd", run: onShare } as const]
            : []),
          { kind: "item", id: "versions", label: t("live.shell.menu.versions"), icon: "clock", run: onVersions },
          {
            kind: "item",
            id: "save-version",
            label: t("live.shell.menu.saveVersion"),
            icon: "flag",
            disabled: readOnly || previewing,
            run: onSave,
          },
          { kind: "item", id: "duplicate", label: t("live.shell.menu.duplicate"), icon: "copy", run: copy },
          { kind: "item", id: "drive", label: t("live.shell.menu.showInDrive"), icon: "drive", run: toDrive },
          {
            kind: "item",
            id: "shortcuts",
            label: t("live.shell.menu.shortcuts"),
            icon: "keyboard",
            run: onShortcuts,
          },
          ...(artifact.canDelete
            ? ([
                { kind: "separator" },
                {
                  kind: "item",
                  id: "trash",
                  label: t("live.shell.menu.trash"),
                  icon: "trash",
                  danger: true,
                  run: onDelete,
                },
              ] as const)
            : []),
        ]
      : [];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click only; every action is also in ⋯ and the buttons
    <header className="lf-head" onContextMenu={contextMenuHandler(menu)}>
      <div className="lf-head__lead">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronLeft"
          className="lf-head__back"
          aria-label={t("live.shell.back")}
          title={t("live.shell.back")}
          onClick={back}
        />
        <Icon name={kind ? KIND_ICON[kind] : "file"} className="lf-head__kind" />
        <div className="lf-head__titles">
          {artifact ? (
            <TitleField
              key={artifact.id}
              value={artifact.title}
              canRename={!readOnly && !previewing}
              fileId={artifact.id}
              onRename={(title) =>
                rename.mutate(title, {
                  onError: (error) => toast.show(errorText(t, error, i18n.language), "error"),
                })
              }
            />
          ) : (
            <Skeleton width={180} height={16} />
          )}
          {status && (
            <span className={cx("lf-head__status", status.tone === "warn" && "is-offline")} role="status">
              {status.text}
            </span>
          )}
        </div>
      </div>
      {artifact && (
        <div className="lf-head__acts">
          <PresenceStack room={live.room} peers={peers} followingId={followId} onFollow={onFollow} />
          {!compact && <AskAgentButton artifact={artifact} selection={selection} />}
          {!compact && artifact.inDrive !== false && (
            <Button size="sm" icon="personAdd" onClick={onShare}>
              {t("share.button")}
            </Button>
          )}
          {kind === "slides" && (
            <Button size="sm" variant="primary" icon="present" onClick={onPresent}>
              {t("live.shell.present")}
            </Button>
          )}
          {formats.length > 0 && (
            <Menu
              align="end"
              label={t("live.shell.download")}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="download"
                  aria-label={t("live.shell.download")}
                  title={t("live.shell.download")}
                />
              }
            >
              {formats.map((f) => (
                <MenuItem key={f.key} icon={f.icon} onSelect={() => void downloads.save(artifact, f.format)}>
                  {f.label}
                </MenuItem>
              ))}
            </Menu>
          )}
          <Menu
            align="end"
            label={t("live.shell.more")}
            trigger={
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="more"
                aria-label={t("live.shell.more")}
                title={t("live.shell.more")}
              />
            }
          >
            {compact && (
              <MenuItem icon="agent" onSelect={onAsk}>
                {t("live.shell.ask")}
              </MenuItem>
            )}
            {compact && artifact.inDrive !== false && (
              <MenuItem icon="personAdd" onSelect={onShare}>
                {t("share.button")}
              </MenuItem>
            )}
            {compact && <MenuSeparator />}
            <MenuItem icon="clock" onSelect={onVersions}>
              {t("live.shell.menu.versions")}
            </MenuItem>
            <MenuItem icon="flag" disabled={readOnly || previewing} onSelect={onSave}>
              {t("live.shell.menu.saveVersion")}
            </MenuItem>
            <MenuItem icon="copy" disabled={duplicate.isPending} onSelect={copy}>
              {t("live.shell.menu.duplicate")}
            </MenuItem>
            <MenuItem icon="drive" onSelect={toDrive}>
              {t("live.shell.menu.showInDrive")}
            </MenuItem>
            <MenuItem icon="keyboard" onSelect={onShortcuts}>
              {t("live.shell.menu.shortcuts")}
            </MenuItem>
            {artifact.canDelete && (
              <>
                <MenuSeparator />
                <MenuItem icon="trash" danger onSelect={onDelete}>
                  {t("live.shell.menu.trash")}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      )}
    </header>
  );
}

/** "Salvo" / "Salvando…" / offline / read-only, in quiet words beside the title. */
function useStatusWords(
  live: ReturnType<typeof useLiveRoomWeb>,
  previewing: boolean,
): { text: string; tone: "quiet" | "warn" } | null {
  const { t } = useTranslation();
  const { org } = useOrg();
  const saving = useDelayed(live.unsent, SAVING_AFTER_MS);
  if (previewing) return null;
  if (live.status === "offline") return { text: t("live.shell.status.offline"), tone: "warn" };
  if (!live.loaded) return live.status === "closed" ? null : { text: t("live.shell.status.connecting"), tone: "quiet" };
  if (live.mode === "view") {
    return { text: org.deletion ? t("live.shell.status.closing") : t("live.shell.status.readOnly"), tone: "quiet" };
  }
  return { text: saving ? t("live.shell.status.saving") : t("live.shell.status.saved"), tone: "quiet" };
}

/**
 * The title, renamed where it is: it reads as the page's title and turns into its field on a click or Tab; Enter or
 * leaving it renames, Esc puts it back. A new file opens with it selected, ready to be named.
 */
function TitleField({
  fileId,
  value,
  canRename,
  onRename,
}: {
  fileId: string;
  value: string;
  canRename: boolean;
  onRename: (title: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Renamed elsewhere (another person, an agent) while not editing: the new name.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // A file just made from "New": its title selected, ready to be named (once; kept a moment for a remount).
  useEffect(() => {
    if (!canRename || !wasJustCreated(fileId)) return;
    field.current?.focus();
    field.current?.select();
    const id = setTimeout(() => forgetJustCreated(fileId), 1000);
    return () => clearTimeout(id);
  }, [canRename, fileId]);
  if (!canRename) {
    return <h1 className="lf-title lf-title--still">{value}</h1>;
  }
  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onRename(next);
    else setDraft(value);
  };
  return (
    <h1 className="lf-title">
      <span className="lf-title__mirror" aria-hidden="true">
        {draft || " "}
      </span>
      <input
        ref={field}
        className="lf-title__field"
        aria-label={t("live.shell.title")}
        value={draft}
        maxLength={200}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(value);
            setEditing(false);
            // Blurring now would rename with the old draft: put it back first, then leave.
            requestAnimationFrame(() => field.current?.blur());
          }
        }}
      />
    </h1>
  );
}

/** "Versão de 14:32 · Restaurar esta versão · Voltar à atual", over a saved version shown read-only. */
function VersionBanner({
  fileId,
  version,
  canRestore,
  busy,
  onRestore,
  onBack,
}: {
  fileId: string;
  version: number;
  canRestore: boolean;
  busy: boolean;
  onRestore: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const versions = useArtifactVersions(org.id, fileId);
  const at = versions.data?.find((v) => v.version === version)?.createdAt;
  const today = at ? dayLabel(t, i18n.language, at) === t("common.today") : false;
  const when = at
    ? today
      ? formatTime(i18n.language, at)
      : new Intl.DateTimeFormat(i18n.language, {
          day: "numeric",
          month: "short",
          hour: clockHour(i18n.language),
          minute: "2-digit",
        }).format(new Date(at))
    : null;
  return (
    <div className="lf-banner" role="status">
      <span className="lf-banner__words">
        {when ? t("live.shell.versions.viewing", { when }) : t("live.shell.versions.number", { version })}
      </span>
      <span className="lf-banner__acts">
        {canRestore && (
          <Button size="sm" variant="primary" loading={busy} disabled={busy} onClick={onRestore}>
            {t("live.shell.versions.restore")}
          </Button>
        )}
        <Button size="sm" onClick={onBack}>
          {t("live.shell.versions.back")}
        </Button>
      </span>
    </div>
  );
}

/** Loading: the editor's own shape (a grid, a slide and its rail, a dotted plane), never a spinner alone. */
function EditorSkeleton({ kind, label }: { kind: LiveKind | null; label: string }) {
  return (
    <SkeletonGroup label={label} className={cx("lf-skel", kind && `lf-skel--${kind}`)}>
      {kind === "slides" ? (
        <>
          <span className="lf-skel__rail">
            <Skeleton shape="block" className="lf-skel__thumb" />
            <Skeleton shape="block" className="lf-skel__thumb" />
            <Skeleton shape="block" className="lf-skel__thumb" />
          </span>
          <span className="lf-skel__stage">
            <Skeleton shape="block" className="lf-skel__slide" />
          </span>
        </>
      ) : kind === "canvas" ? (
        <span className="lf-skel__plane">
          <Skeleton shape="block" className="lf-skel__dock" />
        </span>
      ) : (
        <>
          <span className="lf-skel__bar">
            <Skeleton shape="block" width="40%" height={24} />
          </span>
          <span className="lf-skel__grid" />
        </>
      )}
    </SkeletonGroup>
  );
}

/** The keys of the page and of its editor ("?" opens it, or ⋯ › Keyboard shortcuts). */
function ShortcutsDialog({ open, kind, onClose }: { open: boolean; kind: LiveKind | null; onClose: () => void }) {
  const { t } = useTranslation();
  const mod = modKey();
  const general: [string, string[]][] = [
    [t("live.shell.shortcuts.undo"), [mod, "Z"]],
    [t("live.shell.shortcuts.redo"), [mod, "⇧", "Z"]],
    [t("live.shell.shortcuts.saveVersion"), [mod, "S"]],
    [t("live.shell.shortcuts.show"), ["?"]],
    [t("live.shell.shortcuts.stopFollowing"), ["Esc"]],
  ];
  const own: Record<LiveKind, { title: string; keys: [string, string[]][] }> = {
    spreadsheet: {
      title: t("live.shell.shortcuts.spreadsheet"),
      keys: [
        [t("live.shell.shortcuts.edit"), ["F2"]],
        [t("live.shell.shortcuts.confirm"), ["↵"]],
        [t("live.shell.shortcuts.cancel"), ["Esc"]],
        [t("live.shell.shortcuts.nextCell"), ["Tab"]],
        [t("live.shell.shortcuts.bold"), [mod, "B"]],
        [t("live.shell.shortcuts.italic"), [mod, "I"]],
        [t("live.shell.shortcuts.fillDown"), [mod, "D"]],
        [t("live.shell.shortcuts.clear"), ["⌫"]],
        [t("live.shell.shortcuts.selectAll"), [mod, "A"]],
      ],
    },
    slides: {
      title: t("live.shell.shortcuts.slides"),
      keys: [
        [t("live.shell.shortcuts.duplicate"), [mod, "D"]],
        [t("live.shell.shortcuts.remove"), ["⌫"]],
        [t("live.shell.shortcuts.nudge"), ["←", "→"]],
        [t("live.shell.shortcuts.bold"), [mod, "B"]],
        [t("live.shell.shortcuts.italic"), [mod, "I"]],
      ],
    },
    canvas: {
      title: t("live.shell.shortcuts.canvas"),
      keys: [
        [t("live.shell.shortcuts.select"), ["V"]],
        [t("live.shell.shortcuts.hand"), ["H"]],
        [t("live.shell.shortcuts.note"), ["N"]],
        [t("live.shell.shortcuts.text"), ["T"]],
        [t("live.shell.shortcuts.generate"), ["G"]],
        [t("live.shell.shortcuts.zoom"), ["=", "-"]],
        [t("live.shell.shortcuts.fit"), ["⇧", "1"]],
        [t("live.shell.shortcuts.duplicate"), [mod, "D"]],
      ],
    },
  };
  const groups = [{ title: t("live.shell.shortcuts.general"), keys: general }, ...(kind ? [own[kind]] : [])];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("live.shell.shortcuts.title")}
      closeLabel={t("common.close")}
      width={440}
    >
      <div className="lf-keys">
        {groups.map((g) => (
          <section key={g.title} className="lf-keys__group">
            <h3 className="lf-keys__title">{g.title}</h3>
            <dl className="lf-keys__list">
              {g.keys.map(([what, keys]) => (
                <div key={what} className="lf-keys__row">
                  <dt>{what}</dt>
                  <dd>
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
