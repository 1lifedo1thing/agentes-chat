import { type CodeChangeStatus, type CodeSession, useCodeFile, useCodeFiles } from "@agenteschat/client";
import { codeLangOfPath, highlightCode } from "@agenteschat/client/lib/code";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, cx, Icon, SearchField } from "@agenteschat/ui";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeLines } from "@/components/CodeBlock";
import { formatBytes } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";
import { ChangeLetter } from "./CodeGit";

/** Most search results listed at once: a narrower search finds the rest. */
const RESULTS_MAX = 200;

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The worktree's paths as folders and files, folders first, each by name. */
function buildTree(paths: string[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  const folders = new Map<string, Folder>([["", root]]);
  const folderOf = (path: string): Folder => {
    const known = folders.get(path);
    if (known) return known;
    const cut = path.lastIndexOf("/");
    const parent = folderOf(cut < 0 ? "" : path.slice(0, cut));
    const made: Folder = { name: cut < 0 ? path : path.slice(cut + 1), path, folders: [], files: [] };
    parent.folders.push(made);
    folders.set(path, made);
    return made;
  };
  for (const path of paths) {
    const cut = path.lastIndexOf("/");
    folderOf(cut < 0 ? "" : path.slice(0, cut)).files.push(path);
  }
  for (const f of folders.values()) {
    f.folders.sort((a, b) => byName(a.name, b.name));
    f.files.sort((a, b) => byName(a.slice(a.lastIndexOf("/") + 1), b.slice(b.lastIndexOf("/") + 1)));
  }
  return root;
}

/** Every folder above these paths ("src/app/x.ts" → "src", "src/app"). */
function foldersAbove(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const steps = path.split("/");
    for (let i = 1; i < steps.length; i += 1) out.add(steps.slice(0, i).join("/"));
  }
  return out;
}

/**
 * The session panel's Files tab (ADR 0208): the worktree's files as a tree (tracked ones and new ones git doesn't
 * ignore), the changed ones marked as the Git tab marks them and their folders open at first, a search by path; a file
 * opens in place, read-only, with line numbers and colors.
 */
export function FilesPane({ session }: { session: CodeSession }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const ready = session.worktree.state === "ready";
  const list = useCodeFiles(org.id, session.id, ready, session.work === "working");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const paths = list.data?.paths;
  const tree = useMemo(() => buildTree(paths ?? []), [paths]);
  const changed = useMemo(
    () => new Map<string, CodeChangeStatus>((list.data?.changes ?? []).map((c) => [c.path, c.status])),
    [list.data],
  );
  const changedFolders = useMemo(() => foldersAbove(changed.keys()), [changed]);
  // At first the folders with changes are open: what the agent touched is in sight.
  useEffect(() => {
    if (list.data && open === null) setOpen(new Set(changedFolders));
  }, [list.data, open, changedFolders]);
  const q = query.trim().toLowerCase();
  const results = useMemo(() => (q ? (paths ?? []).filter((p) => p.toLowerCase().includes(q)) : []), [q, paths]);
  if (!ready) return <p className="code-empty">{t("codeSessions.panel.notReady")}</p>;
  if (shown)
    return <FileView session={session} path={shown} status={changed.get(shown)} onBack={() => setShown(null)} />;
  const toggle = (path: string) =>
    setOpen((was) => {
      const next = new Set(was ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="code-tree">
      <div className="code-fhead">
        <SearchField
          size="sm"
          className="code-tree__search"
          aria-label={t("codeSessions.files.search")}
          placeholder={t("codeSessions.files.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("filters.clearSearch")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) setShown(results[0]);
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label={t("codeSessions.files.refresh")}
          title={t("codeSessions.files.refresh")}
          loading={list.isFetching}
          onClick={() => void list.refetch()}
        />
      </div>
      <div className="code-fscroll">
        {list.isPending ? (
          <p className="code-empty">{t("codeSessions.files.reading")}</p>
        ) : list.error ? (
          <p className="code-empty">{errorText(t, list.error)}</p>
        ) : (paths?.length ?? 0) === 0 ? (
          <p className="code-empty">{t("codeSessions.files.empty")}</p>
        ) : q ? (
          results.length === 0 ? (
            <p className="code-empty">{t("codeSessions.files.noMatch", { query: query.trim() })}</p>
          ) : (
            <ul className="code-tree__list">
              {results.slice(0, RESULTS_MAX).map((path) => (
                <li key={path}>
                  <FileRow path={path} status={changed.get(path)} withFolder onOpen={setShown} />
                </li>
              ))}
              {results.length > RESULTS_MAX && (
                <li className="code-tree__note">
                  {t("codeSessions.files.moreResults", {
                    count: results.length - RESULTS_MAX,
                    formatted: (results.length - RESULTS_MAX).toLocaleString(i18n.language),
                  })}
                </li>
              )}
            </ul>
          )
        ) : (
          <ul className="code-tree__list">
            <FolderItems
              folder={tree}
              depth={0}
              open={open ?? new Set()}
              changed={changed}
              changedFolders={changedFolders}
              onToggle={toggle}
              onOpen={setShown}
            />
          </ul>
        )}
        {list.data?.truncated && (
          <p className="code-tree__note">
            {t("codeSessions.files.truncated", {
              count: paths?.length ?? 0,
              formatted: (paths?.length ?? 0).toLocaleString(i18n.language),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

/** A folder's own rows: its folders (each opening into its own), then its files. */
function FolderItems({
  folder,
  depth,
  open,
  changed,
  changedFolders,
  onToggle,
  onOpen,
}: {
  folder: Folder;
  depth: number;
  open: Set<string>;
  changed: Map<string, CodeChangeStatus>;
  changedFolders: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation();
  const style = { "--depth": depth } as CSSProperties;
  return (
    <>
      {folder.folders.map((f) => {
        const isOpen = open.has(f.path);
        return (
          <li key={`d:${f.path}`}>
            <button
              type="button"
              className="code-tree__row code-tree__row--dir"
              style={style}
              aria-expanded={isOpen}
              data-changed={changedFolders.has(f.path) || undefined}
              title={changedFolders.has(f.path) ? t("codeSessions.files.hasChanges") : undefined}
              onClick={() => onToggle(f.path)}
            >
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} className="code-tree__chev" />
              <Icon name="drive" size={16} />
              <span className="code-tree__name">{f.name}</span>
              {changedFolders.has(f.path) && (
                <span className="ac-visually-hidden">{t("codeSessions.files.hasChanges")}</span>
              )}
            </button>
            {isOpen && (
              <ul className="code-tree__list">
                <FolderItems
                  folder={f}
                  depth={depth + 1}
                  open={open}
                  changed={changed}
                  changedFolders={changedFolders}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </ul>
            )}
          </li>
        );
      })}
      {folder.files.map((path) => (
        <li key={`f:${path}`}>
          <FileRow path={path} status={changed.get(path)} depth={depth} onOpen={onOpen} />
        </li>
      ))}
    </>
  );
}

/** A file's row: its name (its folder after it in search results) and, changed, the letter the Git tab gives it. */
function FileRow({
  path,
  status,
  depth = 0,
  withFolder = false,
  onOpen,
}: {
  path: string;
  status: CodeChangeStatus | undefined;
  depth?: number;
  withFolder?: boolean;
  onOpen: (path: string) => void;
}) {
  const cut = path.lastIndexOf("/");
  const name = cut < 0 ? path : path.slice(cut + 1);
  return (
    <button
      type="button"
      className={cx("code-tree__row", withFolder && "code-tree__row--found")}
      style={{ "--depth": depth } as CSSProperties}
      title={path}
      onClick={() => onOpen(path)}
    >
      <span className="code-tree__chev" aria-hidden="true" />
      <Icon name="file" size={16} />
      <span className="code-tree__name" data-status={status}>
        {name}
      </span>
      {withFolder && cut > 0 && <span className="code-tree__dir">{path.slice(0, cut)}</span>}
      {status && <ChangeLetter status={status} />}
    </button>
  );
}

/** One file, read-only, with its path, its letter when changed, line numbers and the shared highlighter's colors. */
function FileView({
  session,
  path,
  status,
  onBack,
}: {
  session: CodeSession;
  path: string;
  status: CodeChangeStatus | undefined;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const file = useCodeFile(org.id, session.id, path);
  const data = file.data;
  const lines = useMemo(
    () => (data?.state === "ok" ? highlightCode(data.content, codeLangOfPath(path)) : []),
    [data, path],
  );
  return (
    <div className="code-tree">
      <div className="code-fhead">
        <Button
          size="sm"
          variant="ghost"
          icon="chevronLeft"
          iconOnly
          aria-label={t("codeSessions.files.back")}
          title={t("codeSessions.files.back")}
          onClick={onBack}
        />
        <span className="code-vcs__title" title={path}>
          {status && <ChangeLetter status={status} />}
          <code>{path}</code>
        </span>
        {data?.state === "ok" && <span className="code-fhead__n tabular">{formatBytes(i18n.language, data.size)}</span>}
      </div>
      <div className="code-fscroll code-fview">
        {file.isPending ? (
          <p className="code-empty">{t("codeSessions.files.opening")}</p>
        ) : file.error ? (
          <p className="code-empty">{errorText(t, file.error)}</p>
        ) : data && data.state !== "ok" ? (
          <p className="code-empty">{t(`codeSessions.files.state.${data.state}`)}</p>
        ) : data ? (
          <>
            <pre className="code-viewer__code code-fview__code">
              <code>
                <CodeLines lines={lines} numbered />
              </code>
            </pre>
            {data.truncated && (
              <p className="code-tree__note">
                {t("codeSessions.files.cut", { size: formatBytes(i18n.language, data.content.length) })}
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
