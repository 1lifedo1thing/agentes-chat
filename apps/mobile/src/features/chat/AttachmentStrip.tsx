import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Icon, Text, useTheme } from "@/ui";

/** A photo or a file picked for the next message, waiting in the field until it is sent with the words. */
export interface PendingFile {
  id: string;
  uri: string;
  name: string;
  type: string;
  /** Its size in bytes, when the picker told it (checked against the upload limit as it is picked). */
  size?: number;
  /** `sending` while its upload runs, `failed` when it didn't go (it stays, to try again). */
  state: "waiting" | "sending" | "failed";
}

/** How many go in one message. */
export const MAX_PENDING = 10;

const TILE = 64;
const RADIUS = 12;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const TILE_IN = FadeIn.duration(160).easing(EASE_OUT);
const TILE_OUT = FadeOut.duration(120).easing(EASE_OUT);
const TILE_MOVE = LinearTransition.duration(200).easing(EASE_OUT);

const isImage = (f: PendingFile) => f.type.startsWith("image/");
const isVideo = (f: PendingFile) => f.type.startsWith("video/");

/**
 * The pictures and files waiting to go with the next message, inside the field over the words (the composer's
 * `attachments`), as the system's messages hold them: square thumbnails (a file, its icon and name), each with one ×
 * in its own corner to take it out. Sending, a thumbnail dims under a spinner; one that didn't go is tinted red with
 * the try-again mark, and stays: send tries it again. A tile that leaves fades and the others close the gap. More are
 * added with the composer's "+", beside the field.
 */
export function AttachmentStrip({ files, onRemove }: { files: PendingFile[]; onRemove: (id: string) => void }) {
  const { t } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  if (files.length === 0) return null;
  const motion = reducedMotion ? {} : { entering: TILE_IN, exiting: TILE_OUT, layout: TILE_MOVE };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.strip}
      contentContainerStyle={styles.row}
    >
      {files.map((f) => (
        <Animated.View
          key={f.id}
          {...motion}
          style={[styles.tile, { backgroundColor: c.sunken }]}
          accessible
          accessibilityLabel={t(f.state === "sending" ? "mobile.chat.attach.sending" : "mobile.chat.attach.waiting", {
            name: f.name,
          })}
        >
          {isImage(f) || isVideo(f) ? (
            <Image source={{ uri: f.uri }} contentFit="cover" transition={0} style={StyleSheet.absoluteFill} />
          ) : (
            <View style={styles.fileIn}>
              <Icon name="file" size={20} color={c.muted} />
              <Text variant="caption" tone="muted" numberOfLines={2} style={styles.fileName}>
                {f.name}
              </Text>
            </View>
          )}
          {isVideo(f) ? (
            <View style={styles.play} pointerEvents="none">
              <Icon name="play" size={10} color="#fff" />
            </View>
          ) : null}
          {f.state === "sending" ? (
            <View style={[StyleSheet.absoluteFill, styles.veil]} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          ) : null}
          {f.state === "failed" ? (
            <View style={[StyleSheet.absoluteFill, styles.failed]} pointerEvents="none">
              <Icon name="replay" size={20} color="#fff" />
            </View>
          ) : null}
          {f.state === "sending" ? null : (
            // 20 drawn in the tile's own corner, 44 to the finger.
            <Pressable
              onPress={() => onRemove(f.id)}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.chat.attach.remove", { name: f.name })}
              hitSlop={12}
              style={({ pressed }) => [styles.x, pressed && styles.pressed]}
            >
              <Icon name="x" size={10} color="#fff" />
            </Pressable>
          )}
        </Animated.View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Inside the field: over the words, a little room under it.
  strip: { flexGrow: 0, marginBottom: 6 },
  // Clear of the field's rounded top corner.
  row: { flexDirection: "row", gap: 8, paddingTop: 6 },
  tile: { width: TILE, height: TILE, borderRadius: RADIUS, overflow: "hidden" },
  fileIn: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, padding: 6 },
  fileName: { textAlign: "center" },
  play: {
    position: "absolute",
    left: 4,
    bottom: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    paddingLeft: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  veil: { backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center" },
  failed: { backgroundColor: "rgba(200,40,40,0.55)", alignItems: "center", justifyContent: "center" },
  x: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
});
