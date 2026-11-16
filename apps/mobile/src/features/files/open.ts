import { router } from "@/ui/navigation";
import { type FileRef, fileRoute } from "./logic";

/**
 * Opens a file from wherever it shows (a message, the Drive, a search, a file's pill, a task): a picture or a video
 * straight in the picture viewer, one transition, among the pictures and videos beside it (`siblings`, in the order
 * they show); anything else in the file screen (`fileRoute`). `from`: the deck it opened from, told where the person
 * stops; `replace`: in the current screen's place (a file's link that turned out to be a picture).
 */
export function openFile(ref: FileRef, siblings?: readonly FileRef[], how: { from?: string; replace?: boolean } = {}) {
  const route = fileRoute(ref, siblings, how.from);
  if (how.replace) router.replace(route);
  else router.push(route);
}
