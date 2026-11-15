import { type ErrorBoundaryProps, Stack } from "expo-router";
import { ScreenError } from "@/features/shared/ScreenError";
import { coverBarOptions, usePushedOptions, useScrollUnderPushedOptions, useTheme } from "@/ui";

/** A link straight to a pushed screen still has the tabs under it (the back button works). */
export const unstable_settings = { anchor: "(tabs)" };

/** A screen that breaks while drawing shows what happened and a way back, instead of closing the app. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * The app's screens under its sheets: the native tabs, and the screens pushed over them with the platform's push (the
 * tab bar hides there; the native back button and the edge swipe go back), Você and its screens among them. The
 * sheets present over all of it (`../_layout.tsx`). Header options are set here so the first frame of a push already
 * has its bar; `PushedHeader` fills in the title and actions.
 */
export default function MainStack() {
  const { colors } = useTheme();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, gestureEnabled: true }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[channelId]" options={pushed} />
      <Stack.Screen name="block/[id]" options={pushed} />
      <Stack.Screen name="conversations/[kind]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="channel-category" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="channel-category-new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="sector-new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="sector/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="channel-categories" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="channel-category-edit" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="mission/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent/[id]" options={{ ...pushed, ...coverBarOptions }} />
      <Stack.Screen name="account-delete" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="ai-accounts" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="usage" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-usage/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-ai/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-model/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-advanced/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-more/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-setup/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-step/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-edit" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-delete" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="new-agent" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="drive/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="memory/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="memory/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki/[slug]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-history" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-map" options={pushed} />
      <Stack.Screen name="wiki-move" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-audience" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="who-sees" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-trash" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="archived-channels" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-agents" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="wiki-write" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="routines/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="routines/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="routines/new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="routines/zone" options={{ ...pushed, ...scrollUnder }} />
      {/* Dashboards (ADR 0135): every screen pushed with back, never a sheet; the list opens from the home. */}
      <Stack.Screen name="dashboards" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board-new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board-share/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board-organize/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board-edit/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="board-edit-roles" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="widget/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="widget-new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-pick" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="widget-pin" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="team" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="proposals" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="task-manager/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="task-manager/[runId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent-tasks/[agentId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="connectors/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="connectors/tools" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="connectors/[id]" options={{ ...pushed, ...coverBarOptions }} />
      <Stack.Screen
        name="connectors/oauth"
        options={{ animation: "none", contentStyle: { backgroundColor: colors.bg } }}
      />
      {/* Connect an AI: pushed screens, one question each, on the grouped gray (its bar counts the steps). */}
      <Stack.Screen
        name="connect-ai"
        options={{ ...pushed, ...scrollUnder, contentStyle: { backgroundColor: colors.grouped } }}
      />
      {/* Você: a pushed page with a clear bar over its sky; its screens pushed over it on the grouped gray. */}
      <Stack.Screen name="me/index" options={{ ...pushed, ...coverBarOptions }} />
      <Stack.Screen name="me/account" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/status" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/zone" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/email" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/workspaces" options={{ ...pushed, ...scrollUnder }} />
      {/* On the sign-in's ruler: its own sky and back circle, no bar. */}
      <Stack.Screen name="me/team-server" options={{ headerShown: false }} />
      <Stack.Screen name="me/scan" options={{ headerShown: false }} />
      <Stack.Screen name="me/members" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="invite-people" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="invite-pick" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="invite-link" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="invite-edit" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="suggest-person" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/notifications" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/approvals" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/start" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/activity" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/agent-style" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/chat-look" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/sounds" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/appearance" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/app-icon" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/language" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="me/about" options={{ ...pushed, ...scrollUnder }} />
      {/* The workspace's settings: its page under the sky (from Você), then each section on the grouped gray. */}
      <Stack.Screen name="settings/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/general" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/advanced" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/mode" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/delete" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/right-hand" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/zone" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/telemetry" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/access" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/invites" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/[roleId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/permissions" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/who" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/channels" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/channel" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/agents" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/agent" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/people" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/add" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/look" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/rename" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/roles/person" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/skills/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/skills/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/skills/new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/skills/edit" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/[machineId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/phone/[phoneId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/audience" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/android-setup" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/iphone-setup" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/devices/connect" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/computers/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/computers/[machineId]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/computers/rename" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/computers/folder" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/computers/agent" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/audit/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/audit/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/apps" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/media" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/storage" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/import" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-item" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-new" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-env" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-access" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-connect" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="settings/vault-connection" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen
        name="images"
        options={{
          presentation: "transparentModal",
          animation: "fade",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      {/* A bare link to a browser request: finds its conversation and replaces itself with it. */}
      <Stack.Screen name="handoff/[id]" options={{ animation: "none", contentStyle: { backgroundColor: colors.bg } }} />
      <Stack.Screen name="link" options={{ animation: "none", contentStyle: { backgroundColor: colors.bg } }} />
      <Stack.Screen
        name="file/[id]"
        options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.bg } }}
      />
      <Stack.Screen
        name="computer/[agentId]"
        options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.bg } }}
      />
      <Stack.Screen
        name="browser-profile/[profileId]"
        options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.bg } }}
      />
    </Stack>
  );
}
