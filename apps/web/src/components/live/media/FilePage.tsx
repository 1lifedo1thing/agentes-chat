import { useArtifact } from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { useOrg } from "@/components/org-context";
import { LiveFilePage, type LiveFileSearch } from "../LiveFilePage";
import { MediaFilePage } from "./MediaFilePage";

/**
 * A file's page: a picture, a video or a PDF with its comments (ADR 0208), else a live file's editor (ADR 0196 §9),
 * which also sends anything else back to the Drive's viewer. Decided by the file as loaded (the same query both read).
 */
export function FilePage(props: {
  fileId: string;
  search: LiveFileSearch;
  onSearch: (patch: Partial<LiveFileSearch>) => void;
}) {
  const { org } = useOrg();
  const query = useArtifact(org.id, props.fileId);
  const artifact = query.data;
  const media = mediaKindOfArtifact(artifact);
  if (media && artifact) return <MediaFilePage {...props} media={media} />;
  // Until the file is known, neither page: a picture would open a live file's connection for nothing.
  if (!artifact && query.isPending) return <div className="lf-page lf-page--empty" aria-busy="true" />;
  return <LiveFilePage {...props} />;
}
