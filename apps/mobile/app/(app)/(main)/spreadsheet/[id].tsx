import { useLocalSearchParams } from "expo-router";
import { SpreadsheetScreen } from "@/features/live-files/spreadsheet/SpreadsheetScreen";
import { isSafeId } from "@/features/shared/logic";
import { LandOn } from "@/ui/navigation";

/** A live spreadsheet (`/spreadsheet/<id>`, ADR 0191): from the Drive, a message's card, a link or New; none: the Drive. */
export default function SpreadsheetRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isSafeId(id)) return <LandOn href="/drive" />;
  return <SpreadsheetScreen key={id} id={id} />;
}
