import { useCodeGit, useCodeSession } from "@agenteschat/client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { CHROME_MAX_SCALE, Icon, Text, useReducedMotion } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { useStepAsk } from "./menu";
import { freeForStep, STEP, stepWords } from "./steps";

/** After a step is asked, the line keeps away this long at most while the agent hasn't started on it. */
const ASKED_HOLD_MS = 20_000;
/** The line is 28 tall: 8 above and below reach the 44-point target. */
const LINE_SLOP = { top: 8, bottom: 8 };

/**
 * A code session's next git step over its conversation's composer (ADR 0208), the web header's button on the phone:
 * where the branch stands, then the step's word ("3 arquivos mudados · Commit"), which asks the agent in the
 * conversation. Only while the agent is free (`busy`: a run of it is live here) and there is a step to take; once
 * asked, it keeps away until the agent has started (or a while has passed). The shape of the bars above the
 * composer (`WaitingHereBar`), so one replaces another without moving.
 */
export function CodeStepLine({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const orgId = useOrgId();
  const sessionQuery = useCodeSession(orgId, sessionId);
  const session = sessionQuery.data ?? null;
  const free = freeForStep(session, busy);
  const git = useCodeGit(orgId, sessionId, free);
  const { ask, sending } = useStepAsk(session, { inChat: true });
  const [asked, setAsked] = useState(false);
  // A run that ends may have taken the step: its branch is read again, and nothing read before it ended is shown (a
  // commit just made must not offer Commit again for a moment).
  const [endedAt, setEndedAt] = useState(0);
  const refetch = git.refetch;
  useEffect(() => {
    if (busy) return;
    setEndedAt(Date.now());
    void refetch();
  }, [busy, refetch]);
  useEffect(() => {
    if (busy) setAsked(false);
  }, [busy]);
  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => setAsked(false), ASKED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [asked]);
  const fresh = git.dataUpdatedAt >= endedAt && sessionQuery.dataUpdatedAt >= endedAt;
  const next = free && fresh && !asked ? (git.data?.next ?? null) : null;
  if (!session || !git.data || !next) return null;
  const words = stepWords(t, session, git.data, next);
  const label = t(`codeSessions.git.step.${next}`);
  const press = () => {
    void ask(next).then((ok) => {
      if (ok) setAsked(true);
    });
  };
  return (
    <View style={styles.dock}>
      <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={styles.line}>
        <Icon name={STEP[next].icon} size={14} color={c.ink2} />
        <Pressable
          onPress={press}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={`${words}. ${label}`}
          accessibilityState={{ disabled: sending, busy: sending }}
          hitSlop={LINE_SLOP}
          style={({ pressed }) => [styles.words, pressed && styles.pressed]}
        >
          <Text variant="caption" tone="ink2" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {words}
          </Text>
        </Pressable>
        <Pressable
          onPress={press}
          disabled={sending}
          accessibilityElementsHidden
          importantForAccessibility="no"
          hitSlop={8}
          style={({ pressed }) => (pressed || sending ? styles.pressed : null)}
        >
          <Text
            variant="caption"
            tone="ink"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.act, { textDecorationColor: c.line2 }]}
          >
            {label}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The bars' shape above the composer (`WaitingHereBar`): bare, the composer's width.
  dock: { paddingBottom: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 8 },
  words: { flex: 1, minWidth: 0 },
  act: { fontWeight: "600", paddingHorizontal: 4, textDecorationLine: "underline" },
  pressed: { opacity: 0.7 },
});
