import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { GenerateScreen } from "@/features/live-files/canvas/GenerateScreen";
import { pointOf, refsOf } from "@/features/live-files/canvas/routes";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/**
 * "Gerar imagem" onto a live canvas (`/generate/<id>`, ADR 0195): from the chosen pictures (`refs`), placed around
 * where the person was looking (`x`, `y`); none: the Drive.
 */
export default function GenerateRoute() {
  const { id, refs, x, y } = useLocalSearchParams<{ id: string; refs?: string; x?: string; y?: string }>();
  const references = useMemo(() => refsOf(refs), [refs]);
  const at = useMemo(() => pointOf(x, y), [x, y]);
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <GenerateScreen key={id} id={id} refs={references} at={at} />;
}
