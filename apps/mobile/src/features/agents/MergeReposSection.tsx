import { useAgentMergeRepos, useAgentRepos, useGitHubRepos, useSetAgentMergeRepos } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { mergeChoices } from "@agenteschat/client/lib/repos";
import { matchesWords } from "@agenteschat/ui/search";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, Sheet, useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";

/**
 * "Pode fazer merge sem perguntar", as under GitHub on the web's Ferramentas e acesso: where the agent merges with no
 * approval card. Its owner or an admin chooses in a sheet, each switch saved at once. Shown only when there is
 * something chosen, or something to choose. A grouped list with its header and footer, as the profile's Access view.
 */
export function MergeReposSection({ agentId, name, mayEdit }: { agentId: string; name: string; mayEdit: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const merge = useAgentMergeRepos(orgId, agentId);
  const save = useSetAgentMergeRepos(orgId, agentId);
  const reach = useAgentRepos(orgId, agentId, mayEdit);
  const listing = useGitHubRepos(orgId, mayEdit);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  // The repositories whose switch was flipped and whose save is on its way: each waits for its own.
  const [flipping, setFlipping] = useState<ReadonlySet<string>>(() => new Set());
  // The list as the last save sends it, while it is on its way (each save sends the whole list): a switch flips on
  // the tap, and a refused save goes back to what is saved.
  const list = (save.isPending ? save.variables : undefined) ?? merge.data ?? [];
  const choices = mergeChoices(listing.data, reach.data ?? []);
  if (!merge.data || (list.length === 0 && !(mayEdit && choices.length > 0))) return null;
  const toggle = (repo: string) => {
    if (flipping.has(repo)) return;
    setFlipping((now) => new Set(now).add(repo));
    void save
      .mutateAsync(list.includes(repo) ? list.filter((r) => r !== repo) : [...list, repo])
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))
      .finally(() =>
        setFlipping((now) => {
          const left = new Set(now);
          left.delete(repo);
          return left;
        }),
      );
  };
  return (
    <>
      <GroupedHeader>{t("repos.merge.label")}</GroupedHeader>
      <GroupedList>
        {list.map((repo) => (
          <GroupedRow key={repo} label={repo} icon="code" />
        ))}
        {mayEdit ? (
          <GroupedRow
            label={list.length === 0 ? t("repos.choose") : t("repos.change")}
            chevron
            onPress={() => setPicking(true)}
          />
        ) : null}
      </GroupedList>
      {list.length === 0 ? (
        <GroupedFooter>{t("repos.merge.none")}</GroupedFooter>
      ) : (
        <GroupedFooter
          hint={{ name: t("common.about", { label: t("repos.merge.label") }), text: t("repos.merge.help") }}
        >
          {t("repos.merge.short")}
        </GroupedFooter>
      )}
      <Sheet open={picking} onClose={() => setPicking(false)}>
        <SheetTitle title={t("repos.merge.dialogTitle", agentGrammar(name))} />
        <SearchField value={q} onChangeText={setQ} placeholder={t("repos.search")} autoCorrect={false} />
        <GroupedList>
          {choices
            .filter((repo) => !q.trim() || matchesWords(repo, q))
            .map((repo) => (
              <GroupedRow key={repo} label={repo} toggle={list.includes(repo)} onPress={() => toggle(repo)} />
            ))}
        </GroupedList>
      </Sheet>
    </>
  );
}
