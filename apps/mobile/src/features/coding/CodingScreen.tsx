import { type CodeSession, useCodeSessions } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { GroupedHeader, GroupedList, GroupedRow, MEDIA_ROW, SkeletonList, useReducedMotion } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { CODING_NEW_HREF, sessionChatHref, sessionStateKey, sessionsByRepo, statWords } from "./logic";

/** Sessions whose agent's face moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Código, pushed from Você (ADR 0208, the web's Code page on the phone): the large title, "Nova sessão" as the bar's
 * "+" (with none yet, the empty state's own button), then the sessions I take part in by project, the newest first,
 * as the web's list reads them: the project and "no computador" for one only on the agent's computer as the group's
 * head; each session its agent's face (working while it works), its name, its state in words (waiting on you in the
 * waiting color) and the change's size. A row opens the session's conversation.
 */
export function CodingScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sessions = useCodeSessions(orgId);
  const pull = usePullRefresh(sessions.refetch);
  const reduced = useReducedMotion();
  const groups = useMemo(() => sessionsByRepo(sessions.data ?? []), [sessions.data]);
  const openNew = () => router.push(CODING_NEW_HREF as never);
  let row = 0;
  return (
    <PushedLargeTitle
      title={t("codeSessions.title")}
      grouped
      actions={[{ icon: "plus", sf: "plus", label: t("codeSessions.list.new"), onPress: openNew }]}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {sessions.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : sessions.isError && !sessions.data ? (
        <LoadFailed onRetry={() => void sessions.refetch()} />
      ) : groups.length === 0 ? (
        <FirstUse place="coding" acts label={t("codeSessions.list.new")} onPress={openNew} />
      ) : (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
          <LayoutAnimationConfig skipEntering>
            <View style={styles.in}>
              {groups.map((g) => (
                <View key={g.repo}>
                  <GroupedHeader>{g.local ? `${g.repo} · ${t("codeSessions.list.local")}` : g.repo}</GroupedHeader>
                  <GroupedList>
                    {g.sessions.map((s) => (
                      <SessionRow key={s.id} session={s} live={row++ < LIVE_ROWS} />
                    ))}
                  </GroupedList>
                </View>
              ))}
            </View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/** One session: its agent's face, its name, its state in words and the change's size. */
function SessionRow({ session, live }: { session: CodeSession; live: boolean }) {
  const { t } = useTranslation();
  const state = sessionStateKey(session);
  const stat = statWords(session);
  const working = session.work === "working" || session.work === "preparing";
  return (
    <GroupedRow
      leading={
        <AgentFace agentId={session.agentId} size={MEDIA_ROW.row.face} live={live} mode={working ? "run" : "idle"} />
      }
      label={session.title}
      labelLines={2}
      sub={state.pr !== null ? t(state.key, { number: state.pr }) : t(state.key)}
      {...(state.waiting ? { subTone: "amber" as const } : {})}
      {...(stat ? { value: stat } : {})}
      chevron
      onPress={() => router.push(sessionChatHref(session) as never)}
    />
  );
}

const styles = StyleSheet.create({
  in: { paddingBottom: 24 },
});
