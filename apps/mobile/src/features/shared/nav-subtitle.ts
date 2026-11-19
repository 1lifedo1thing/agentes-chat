import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import { Platform, type ViewProps } from "react-native";

interface NavSubtitleNative {
  /** iOS 26 and later: the system's bar shows a subtitle under its title. */
  supported(): boolean;
}

/**
 * The system bar's own subtitle (iOS 26, `modules/nav-subtitle`): a view of no size in the screen sets it on the
 * screen's navigation item, so the bar centres the title and its line itself, beside its buttons. Null where there is
 * none (Android, iOS before 26, a build without the module): `PushedHeader` draws the title and its line there.
 */
const native = Platform.OS === "ios" ? requireOptionalNativeModule<NavSubtitleNative>("NavSubtitle") : null;

export const NavSubtitle: ComponentType<ViewProps & { subtitle?: string | undefined }> | null = native?.supported()
  ? requireNativeView("NavSubtitle")
  : null;
