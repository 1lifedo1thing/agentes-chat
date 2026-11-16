import { SheetBar } from "@/ui";
import { router } from "@/ui/navigation";
import type { AppHref } from "../links/logic";
import { goBack } from "../shared/parts";

/**
 * Pieces of the forms "New" opens (the "+" of the tabs), each a native form sheet: the title row, and leaving every
 * sheet to open what was just made.
 */

/**
 * The sheet's bar in a sheet's padded body: the task sheets' `SheetBar` (the title centered, close or back to "Novo"
 * on the left), its sides and its room under the grabber the body's own.
 */
export function SheetHeader({
  title,
  icon = "x",
  onPress,
}: {
  title: string;
  icon?: "x" | "back";
  /** Instead of closing the sheet (a page inside it goes back to the one before). */
  onPress?: () => void;
}) {
  return <SheetBar inset title={title} icon={icon} onClose={onPress ?? (() => goBack())} />;
}

/** Closes the sheets and screens over the tabs ("New" and its forms), then opens `href` (a new conversation) there. */
export function closeSheetsAndOpen(href: AppHref) {
  if (router.canDismiss()) router.dismissAll();
  setTimeout(() => router.push(href), 60);
}
