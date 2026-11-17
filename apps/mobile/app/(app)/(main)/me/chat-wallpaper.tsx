import { useLocalSearchParams } from "expo-router";
import { wallpaperTargetOf } from "@/features/chat/wallpaper-logic";
import { WallpaperPage } from "@/features/me/WallpaperPage";

/**
 * Fundo: `?kind=channels|dms` from Você › Conversa (the channels' or the DMs' background), or `?channelId=` from a
 * conversation's options (that conversation's own).
 */
export default function ChatWallpaperRoute() {
  const params = useLocalSearchParams<{ kind?: string; channelId?: string }>();
  return <WallpaperPage target={wallpaperTargetOf(params)} />;
}
