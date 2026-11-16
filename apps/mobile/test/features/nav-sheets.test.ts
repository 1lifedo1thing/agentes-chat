import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

/**
 * Real navigation inside sheets: a step of a sheet is a sheet over the one before (the screen's sheet stack, or a
 * `Sheet` presented over a route's sheet), so a flick down goes back a step; never the sheet's content swapped in
 * place with a back drawn in it. The sheets are components the tests can't render: what they wire in, as text.
 */
const src = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("connecting a service: each step a sheet over the one before", () => {
  const sheet = src("connectors/ConnectSheet.tsx");

  test("no step is swapped in place, and no Back is drawn to step back", () => {
    expect(sheet).not.toContain("setStep(");
    expect(sheet).not.toContain("setPhase(");
    expect(sheet).not.toContain('t("common.back")');
  });

  test("Connect, Adjust and Continue push the next step; the address is a step of its own", () => {
    // What it does → connecting.
    expect(sheet).toContain("onPress={() => sheet.push(<ConnectingStep flow={flow} />)}");
    // The address → connecting to it, the address shown there (a flick down goes back to change it).
    expect(sheet).toContain("sheet.push(<ConnectingStep flow={flow} url={address} />);");
    expect(sheet).toContain('if (!item) return <AddressStep flow={flow} initialUrl={url ?? ""} />;');
    // The confirmation → its tools (a catalog service) or who uses it, and its tools → who uses it.
    expect(sheet).toContain(
      "sheet.push(<StepView flow={flow} step={nextOf(flow, from)} connectionId={connectionId} />)",
    );
    expect(sheet).toContain('step === "done" && flow.head.steps.includes("review") ? "review" : "who"');
    // Every step repeats the service's head and its place among the steps.
    expect(sheet.match(/<StepHead\b/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("the address field lives only on its step; connecting reads the address it was handed", () => {
    expect(sheet.match(/t\("mobile\.connectors\.addressLabel"\)/g)).toHaveLength(2);
    const address = sheet.slice(sheet.indexOf("function AddressStep("), sheet.indexOf("function ConnectingStep("));
    expect(address).toContain('accessibilityLabel={t("mobile.connectors.addressLabel")}');
    const connect = sheet.slice(sheet.indexOf("function ConnectStep("));
    expect(connect).not.toContain("useState(initialUrl");
    expect(connect).toContain('url = "",');
  });

  test("connecting ends on its own step's confirmation, and Done closes every step", () => {
    const connecting = sheet.slice(sheet.indexOf("function ConnectingStep("), sheet.indexOf("function DoneStep("));
    expect(connecting).toContain("onConnected={(id, name) => setConnected({ id, name })}");
    expect(connecting).toContain("onDone={sheet.close}");
    const who = sheet.slice(sheet.indexOf("function WhoStep("));
    expect(who).toContain(
      '<Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />',
    );
  });
});

describe("a request's Refuse: its reason on a sheet over the request", () => {
  const sheet = src("approvals/ApprovalSheet.tsx");

  test("no Back drawn beside Refuse; the reason is a step presented over the request", () => {
    expect(sheet).not.toContain('t("mobile.common.back")');
    expect(sheet).toContain("<Sheet open={refusing} onClose={() => setRefusing(false)}>");
    expect(sheet).toContain("onPress={() => setRefusing(true)}");
    // The link's refuse (a card's Refuse) opens on that step alone, while the request can still be refused.
    expect(sheet).toContain("refuse && pending && a.canDecide ? (");
    expect(sheet).not.toContain("useState(startRefusing)");
  });
});

describe("denying a join request: its reason on a sheet over the list", () => {
  const sheet = src("members/JoinRequestsSheet.tsx");

  test("the card never swaps its answer for a form with a Back", () => {
    expect(sheet).not.toContain('t("mobile.common.back")');
    expect(sheet).not.toContain('key="deny"');
    expect(sheet).toContain("<Sheet open={denying !== null} onClose={() => setDenying(null)}>");
    expect(sheet).toContain("onDeny={() => setDenying(r)}");
    // The step denies, says so and closes; the card leaves the list by itself.
    const deny = sheet.slice(sheet.indexOf("function DenyStep("), sheet.indexOf("function HandOff("));
    expect(deny).toContain(
      "await deny.mutateAsync({ id: r.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });",
    );
    expect(deny).toContain("onDone();");
    expect(deny).toMatch(/<TextArea[\s\S]*?limit=\{REASON_LIMIT\}/);
  });
});

describe("Remind me: a picked time is a step over the quick times", () => {
  const sheet = src("reminders/RemindSheet.tsx");

  test("Pick a time pushes its step; no button swaps the quick times back in", () => {
    expect(sheet).toMatch(/sheet\.push\(\s*<RemindAt/);
    expect(sheet).not.toContain("setCustom(null)");
    expect(sheet).not.toContain("mobile.remind.quick");
    // Both steps set the reminder the same way, and closing it closes every step.
    expect(sheet.match(/useRemind\(\{ channelId, threadId, message \}\)/g)).toHaveLength(2);
    expect(sheet).toContain("sheet.close();");
  });

  test("the quick times' way back is gone from both languages", () => {
    for (const tree of [featureKeysEn, featureKeysPtBR]) expect("quick" in tree.remind).toBe(false);
  });
});

describe("Team templates: a template is a sheet over the list", () => {
  const card = src("right-hand/TeamCard.tsx");
  const templates = card.slice(card.indexOf("export function TeamTemplatesSheet("), card.indexOf("const styles = "));

  test("no back drawn in the bar, no template swapped in for the list", () => {
    expect(templates).not.toContain('icon="back"');
    expect(templates).not.toContain("setPicked(");
    expect(templates).toContain("onPress={() => onTemplate(x.id)}");
    // Each step over the first presents as it mounts; a flick down takes it away, and the first's going clears them.
    expect(templates).toContain("onClose={() => setOver((list) => list.slice(0, i))}");
    expect(templates).toContain("onGone={() => setOver([])}");
    // Opened on a template, the list is a step over it.
    expect(templates).toContain(
      '{...(at === 0 && step.kind === "template" ? { onList: () => push({ kind: "list" }) } : {})}',
    );
  });

  test("the templates are read only while the sheet is open", () => {
    expect(templates).toContain("const list = useTeamTemplates(orgId, i18n.language, on);");
    expect(templates).not.toContain("useTeamTemplates(orgId, i18n.language, true)");
  });
});

describe("no back drawn in a sheet's bar or as a row", () => {
  test("Add workspace closes with ×, over the list it came from", () => {
    expect(src("me/WorkspacesPages.tsx")).toContain('<SheetHeader title={t("mobile.me.addWorkspace")} />');
    const parts = src("new/parts.tsx");
    expect(parts).not.toContain('icon?: "x" | "back"');
    expect(parts).toContain("<SheetBar inset title={title} onClose={onPress ?? (() => goBack())} />");
  });

  test("a gone cargo says so, and the bar's back is the way out", () => {
    const gone = src("roles/parts.tsx");
    expect(gone).not.toContain("backToList");
    expect(gone).not.toContain('icon="back"');
    for (const tree of [featureKeysEn, featureKeysPtBR]) expect("backToList" in tree.roles).toBe(false);
  });
});
