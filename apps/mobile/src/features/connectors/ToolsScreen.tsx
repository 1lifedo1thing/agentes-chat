import { useCatalog, useConnections, useCustomServers } from "@agenteschat/client";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, GroupedList } from "@/ui";
import { router } from "@/ui/navigation";
import { RowBones } from "../roles/parts";
import { useColors, useOrgId } from "../shared/hooks";
import { BottomBar, goBack, Loaded, PushedHeader } from "../shared/parts";
import { ReviewStep, type SaveBar } from "./ToolReview";

/** Opens a connection's Ferramentas (from its sheet, or the gallery when its tools wait for a review). */
export const openTools = (id: string) => router.push({ pathname: "/connectors/tools", params: { id } });

/**
 * Ferramentas, a screen pushed over Conectores (the web's "Ferramentas", "Revisar" while some wait): what each
 * tool may do on its own, grouped by level, under the native bar with its back button. A server's are changed here
 * and saved with Salvar, pinned at the bottom, which goes back; our catalog services' are shown as they are.
 */
export function ToolsScreen({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const item = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
    (i) => i.id === connectionId,
  );
  const name = item ? itemName(t, item) : "";
  // Until the connection is known, a catalog one can't tell its tools yet (it would read as none).
  const loading = !item && (catalog.isPending || connections.isPending || servers.isPending);
  // A server's Salvar, pinned at the bottom: the review hands it up (a state setter, the same every render).
  const [save, setSave] = useState<SaveBar | null>(null);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      {/* On the grouped gray: Android's opaque bar takes it too, no band above the groups. */}
      <PushedHeader title={t("connectors.tools")} {...(name ? { subtitle: name } : {})} solid={false} grouped />
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.page, { paddingBottom: save ? 24 : insets.bottom + 24 }]}
      >
        {/* The tools fade in over their rows' shape; tools already here when the screen opens just show. */}
        <LayoutAnimationConfig skipEntering>
          {loading ? (
            // The rows' shape while the connection is read, never a bare spinner.
            <GroupedList>
              <RowBones />
              <RowBones name={56} />
            </GroupedList>
          ) : (
            <Loaded>
              <View style={styles.stack}>
                <ReviewStep
                  connectionId={connectionId}
                  def={item?.def ?? null}
                  name={name}
                  onNext={goBack}
                  onScreen
                  onSaveBar={setSave}
                />
              </View>
            </Loaded>
          )}
        </LayoutAnimationConfig>
      </ScrollView>
      {save ? (
        <BottomBar bottom={insets.bottom}>
          <Button
            variant="primary"
            wide
            label={save.label}
            disabled={save.busy}
            loading={save.saving}
            onPress={save.onPress}
          />
        </BottomBar>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The pushed screens' 16-point margin, as the connection screen it opens from.
  page: { paddingHorizontal: 16, paddingTop: 8, gap: 14 },
  // The page's own gap, for what fades in together.
  stack: { gap: 14 },
});
