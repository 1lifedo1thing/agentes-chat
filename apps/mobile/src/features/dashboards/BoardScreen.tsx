import { busyWidgets } from "@agenteschat/client";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { IconButton } from "@/ui";
import { router } from "@/ui/navigation";
import { FirstUse } from "../shared/FirstUse";
import { usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useBoard } from "./hooks";
import { HOME, phoneRows, widgetsInOrder } from "./logic";
import { useBoardMenu } from "./menu";
import { AudienceLine, MissingScreen, ProposalBanner, useBoardByline } from "./parts";
import { WidgetPeek } from "./WidgetPeek";

/** While a widget is being built or updated, the board is asked again this often (events usually come first). */
const BUSY_POLL_MS = 15_000;

/** "New widget" for a board (`home` for My Home). */
export const newWidgetHref = (dashboardId: string) => `/widget-new?dashboardId=${dashboardId}` as const;

/**
 * A dashboard, pushed (ADR 0135), with a large title as Routines: its name in the content, scrolling away under the
 * glass bar, whose own title fades in. Under the name, who made it, who sees it and how many widgets; an agent's
 * request to publish it; then its widgets on two columns (a 2-wide one takes the whole row, a 2-high one draws its
 * data big), or "Add widget" when empty. Share (the globe or the lock), "+" and "…" (Organize, Rename, Pin, Delete)
 * in the bar. `id` is `home` for My Home,
 * made the first time it is opened.
 */
export function BoardScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { board, loading, failed, refetch } = useBoard(id);
  const menu = useBoardMenu(board);
  const pull = usePullRefresh(refetch);
  const byline = useBoardByline();
  const busy = board ? busyWidgets(board.widgets).length > 0 : false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refetch(), BUSY_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  if (!board) {
    return (
      <MissingScreen
        title={id === HOME ? t("dashboards.home") : ""}
        state={loading ? "loading" : failed ? "failed" : "gone"}
        onRetry={() => void refetch()}
        gone={t("dashboards.errors.notFound")}
      />
    );
  }
  const home = board.kind === "home";
  const title = home ? t("dashboards.home") : board.title;
  const add = () => router.push(newWidgetHref(home ? HOME : board.id));
  const share = () => router.push(`/board-share/${board.id}`);
  const widgets = widgetsInOrder(board.widgets);
  const rows = phoneRows(widgets.map((w) => ({ w: w.layout.w, widget: w })));
  return (
    <PushedLargeTitle
      title={title}
      grouped
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      right={
        <View style={styles.barRight}>
          {board.canManage && !home ? (
            <IconButton
              icon={board.audience === "workspace" ? "globe" : "lock"}
              label={t("dashboards.share.action")}
              onPress={share}
            />
          ) : null}
          {board.canEdit ? <IconButton icon="plus" label={t("widgets.add.label")} onPress={add} /> : null}
          {/* The page's large title takes no native bar buttons yet: its "…" lists the board's choices in the app's
              sheet on both systems. */}
          {menu ? <IconButton icon="more" label={menu.label} onPress={menu.onPress} /> : null}
        </View>
      }
    >
      <View style={styles.in}>
        {home ? null : (
          <View style={styles.meta}>
            <AudienceLine board={board} after={byline(board) || undefined} />
          </View>
        )}
        <ProposalBanner board={board} />
        {widgets.length === 0 ? (
          <FirstUse place="board" size="panel" acts={board.canEdit} label={t("widgets.add.label")} onPress={add} />
        ) : (
          <View style={styles.grid}>
            {rows.map((items) => (
              <View key={items.map((x) => x.widget.id).join("+")} style={styles.row}>
                {items.map(({ widget: w }) => (
                  <View key={w.id} style={items.length === 1 && w.layout.w < 2 ? styles.half : styles.cell}>
                    <WidgetPeek widget={w} canEdit={board.canEdit} board={{ id: home ? HOME : board.id, home }} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}
      </View>
    </PushedLargeTitle>
  );
}

/** Between the widgets, across and down. */
const GAP = 10;

const styles = StyleSheet.create({
  in: { paddingHorizontal: 16, gap: 10 },
  barRight: { flexDirection: "row", alignItems: "center" },
  meta: { paddingHorizontal: 4 },
  grid: { gap: GAP },
  row: { flexDirection: "row", gap: GAP },
  cell: { flex: 1, minWidth: 0 },
  // A lone half widget as wide as one in a row of two: half the row, less half the gap between them.
  half: { width: "50%", paddingRight: GAP / 2 },
});
