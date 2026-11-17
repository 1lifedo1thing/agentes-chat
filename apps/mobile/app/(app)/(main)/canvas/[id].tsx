import { useLocalSearchParams } from "expo-router";
import { CanvasScreen } from "@/features/live-files/canvas/CanvasScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A live canvas (`/canvas/<id>`, ADR 0191): from the Drive, a message's card, a link or New; none: the Drive. */
export default function CanvasRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <CanvasScreen key={id} id={id} />;
}
