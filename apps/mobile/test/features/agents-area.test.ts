import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { translator } from "./fixtures";

/** The agents, AI, members and team screens: components the tests can't render, read as text. */
const src = (path: string) => readFileSync(new URL(`../../src/features/${path}`, import.meta.url), "utf8");

describe("Agents", () => {
  test("the team's rows while it loads, a failed load with Try again, never the first agent's invitation", () => {
    const screen = src("agents/AgentsScreen.tsx");
    const skeleton = screen.indexOf("<SkeletonList rows={4} />");
    const failed = screen.indexOf("<LoadFailed onRetry={() => void directory.refetch()} />");
    const first = screen.indexOf('place="agents"');
    expect(skeleton).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(skeleton);
    expect(first).toBeGreaterThan(failed);
    expect(screen).toContain("directory.isError && !directory.data");
    // Its pull as the other tabs' (the tab screen draws the wheel or the orbit), and the team itself read again.
    expect(screen).toContain("pull={pull}");
    expect(screen).not.toContain("<RefreshControl");
    expect(screen).toContain("directory.refetch(),");
  });

  test("rows are memoized on plain values and share the screen's one clock", () => {
    const screen = src("agents/AgentsScreen.tsx");
    expect(screen).toContain("const AgentRow = memo(function AgentRow(");
    expect(screen.match(/useNow\(\)/g)).toHaveLength(1);
    expect(screen.match(/\{\.\.\.lineProps\(l\)\}\s+now=\{now\}/g)).toHaveLength(3);
    expect(screen).toContain("() => teamLines(agents, work, dms.data ?? [], asking, offline, atWork),");
    expect(screen).not.toContain("line={l}");
  });
});

describe("an agent's profile", () => {
  test("what it did for you and what it knows say they didn't load, with Try again, never Nothing yet", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen).toContain("<LoadFailed onRetry={() => void forYou.refetch()} />");
    expect(screen).toContain("<LoadFailed onRetry={() => void knows.refetch()} />");
    // "Nothing yet" only under a list that loaded.
    expect(screen.indexOf("{forYou.data ? (")).toBeGreaterThan(-1);
    expect(screen.indexOf("{forYou.data ? (")).toBeLessThan(screen.indexOf("mobile.intentAgents.did.empty"));
  });

  test("Chat opens a conversation it knows at once, else spins and takes no second tap", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen).toContain("if (opening) return;");
    expect(screen).toContain("const known = dms.data?.find(");
    expect(screen).toMatch(/if \(known\) \{\s+router\.push\(chatHref\(known\.channelId\)\);/);
    expect(screen.match(/loading=\{opening\}/g)).toHaveLength(2);
    expect(screen).toContain(".finally(() => setOpening(false));");
  });

  test("its money and month formatters are built once per language, not per render", () => {
    const screen = src("agents/AgentProfileScreen.tsx");
    expect(screen.match(/new Intl\.\w+\(/g)).toHaveLength(2);
    expect(screen).toMatch(/useMemo\(\s*\(\) => new Intl\.NumberFormat/);
    expect(screen).toMatch(/useMemo\(\s*\(\) => new Intl\.DateTimeFormat/);
  });

  test("work nobody asked for: a number from its list in the picker, and forgetting the answers asks first", async () => {
    const brakes = src("agents/BrakesSection.tsx");
    expect(brakes).not.toContain("nextOf");
    expect(brakes.match(/menu=\{editable\}/g)).toHaveLength(2);
    expect(brakes).toContain("void pickOne({");
    expect(brakes).toMatch(/confirmAction\(\{\s+title: t\("mobile\.agent\.brakes\.forgetTitle"\)/);
    expect(brakes).toContain("onPress={forget}");
    const pt = await translator("pt-BR");
    expect(pt("mobile.agent.brakes.forgetText", { name: "Ada", context: "female" })).toBe(
      "A Ada volta a perguntar antes desse tipo de trabalho.",
    );
    expect((await translator("en"))("mobile.agent.brakes.forgetTitle")).toBe("Forget these answers?");
  });

  test("a repository's merge switch flips on the tap, and only its own row waits", () => {
    const merge = src("agents/MergeReposSection.tsx");
    expect(merge).toContain("const list = (save.isPending ? save.variables : undefined) ?? merge.data ?? [];");
    expect(merge).toContain("if (flipping.has(repo)) return;");
    expect(merge).not.toContain("disabled={save.isPending}");
  });

  test("Advanced is a settings page", () => {
    const more = src("agents/AgentMoreScreen.tsx");
    expect(more).toContain('<SettingsPage title={t("agentPage.tabs.advanced")}>');
    expect(more).not.toContain("<ScrollView");
  });
});

describe("saving forms", () => {
  test("a setup step's and Edit's Save spin in the bar while they save, the page locked under them", () => {
    const steps = src("agents/setup/SetupStepScreen.tsx");
    expect(steps.match(/busy=\{busy\}/g)).toHaveLength(4);
    expect(steps).toContain("busy={save.isPending}");
    expect(steps).not.toMatch(/disabled=\{busy\}|disabled: busy/);
    expect(src("agents/AgentEditScreen.tsx")).toContain("? { right: <ActivityIndicator color={c.muted} /> }");
    const sector = src("team/SectorScreen.tsx");
    expect(sector).toContain("busy={action.isPending}");
    expect(sector).toContain("<LoadFailed onRetry={() => void groups.refetch()} />");
    expect(sector).not.toContain("<EmptyState");
  });

  test("Use on other agents says how it went in one toast; its buttons spin while they save", () => {
    const setup = src("ai/AgentSetupScreen.tsx");
    // One toast for the result, one for a failure.
    expect(setup.match(/toast\(\{/g)).toHaveLength(2);
    expect(setup).toContain('...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}),');
    expect(setup).toMatch(/loading=\{busy\}\s+disabled=\{chosen\.length === 0\}/);
    expect(src("ai/KeyForAllScreen.tsx")).toMatch(/loading=\{busy\}\s+disabled=\{!chosen \|\| can\.length === 0\}/);
  });

  test("a device code's Copied says Copy again after a moment, with a tap of success; Start spins in place", () => {
    const flow = src("ai/AddAccount.tsx");
    expect(flow).toContain("const timer = setTimeout(() => setCopied(false), COPIED_MS);");
    expect(flow).toMatch(
      /if \(!login\?\.userCode \|\| !\(await copyText\(login\.userCode\)\)\) return;\s+successHaptic\(\);/,
    );
    expect(flow).toContain("loading={starting || loading}");
    expect(flow).not.toContain("styles.spinner");
  });

  test("Next goes on to the next field, the keyboard up between them", () => {
    const create = src("agents/NewAgentScreen.tsx");
    expect(create).toMatch(
      /returnKeyType="next"\s+submitBehavior="submit"\s+onSubmitEditing=\{\(\) => \{\s+toHandle\.current = true;\s+nameDone\(\);/,
    );
    expect(create).toContain("handleField.current?.focus();");
    expect(create).toContain("ref={handleField}");
    expect(src("agents/HandleInput.tsx")).toContain("ref={ref}");
    const suggest = src("members/SuggestPerson.tsx");
    expect(suggest).toMatch(/returnKeyType="next"\s+submitBehavior="submit"/);
    expect(suggest).toContain("onSubmitEditing={() => noteField.current?.focus()}");
    expect(suggest).toContain("ref={noteField}");
  });
});

describe("members", () => {
  test("a list that didn't load says so with Try again, and the page pulls to read it again", () => {
    const page = src("members/MembersPage.tsx");
    expect(page).toContain("<LoadFailed onRetry={() => void people.refetch()} />");
    expect(page).toContain(
      "refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}",
    );
    expect(page).toContain("usePullRefresh(() => Promise.allSettled([people.refetch(), rolesQ.refetch()]))");
    expect(src("members/JoinRequestsSheet.tsx")).toContain("<LoadFailed");
  });

  test("Remove and Leave confirm at once: what goes with the person is read as the row's menu opens", () => {
    const page = src("members/MembersPage.tsx");
    expect(page).toContain("if (removes) void qc.prefetchQuery(removalQuery(api, orgId, m.userId));");
    expect(page).toContain("preview = await qc.fetchQuery(removalQuery(api, orgId, m.userId));");
    expect(page).not.toContain("staleTime: 0");
  });
});

describe("Connect an AI and the right hand's cards", () => {
  test("a new page of Connect an AI starts at its top and fades in", () => {
    const sheet = src("ai/ConnectAi.tsx");
    expect(sheet).toContain(
      'scroll.current?.scrollTo({ y: Platform.OS === "ios" ? -barHeight : 0, animated: false });',
    );
    expect(sheet).toContain("onView={onView}");
    const steps = src("ai/ConnectAiSteps.tsx");
    expect(steps).toContain("<Animated.View key={pageKey} entering={reduced ? undefined : PAGE_IN}>");
    expect(steps).toContain("const PAGE_IN = FadeIn.duration(160);");
  });

  test("the team card's chips and the weekly card's link take a finger's 44 points", () => {
    const card = src("right-hand/TeamCard.tsx");
    expect(card).toContain('chipHit: { minHeight: 44, marginVertical: -4, justifyContent: "center" },');
    expect(card).toContain("style={styles.chipHit}");
    expect(src("right-hand/TeamWeekCard.tsx")).toContain(
      'when: { alignSelf: "flex-start", minHeight: 44, marginVertical: -8, justifyContent: "center" },',
    );
  });
});
