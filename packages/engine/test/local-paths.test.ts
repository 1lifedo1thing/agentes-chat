import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { advance, decideTurnEnd, localPathsCited, type TurnEnd } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * Nobody can open the agent's computer: a reply that cites a file there as if people could ("Salvei em
 * `notas/precos.md`") is written again once, unposted, with the file shared or what it holds, unless the person
 * writes paths or code themselves, or the run works in a repository or a mission.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("a path on the agent's computer", () => {
  test("found in backticks or bare, folders too, in Portuguese and English", () => {
    expect(localPathsCited("Salvei o saldo em `notas/tabela-precos.md` e o resto em notas/.", "")).toEqual([
      "notas/tabela-precos.md",
      "notas/",
    ]);
    expect(localPathsCited("Está em ~/relatorios/ e em /home/agente/out.csv.", "")).toEqual([
      "~/relatorios/",
      "/home/agente/out.csv",
    ]);
    expect(localPathsCited("I saved it to ~/out/ and the table is in /home/agent/x.csv", "")).toEqual([
      "~/out/",
      "/home/agent/x.csv",
    ]);
    expect(localPathsCited("The draft is at drafts/q3-plan.docx, see ./export/summary.pdf.", "")).toEqual([
      "drafts/q3-plan.docx",
      "./export/summary.pdf",
    ]);
    expect(localPathsCited("Vendas: (ver `relatorios/vendas-outubro.xlsx`)", "")).toEqual([
      "relatorios/vendas-outubro.xlsx",
    ]);
    // A source file under a home folder is still on its computer.
    expect(localPathsCited("Rodei /home/agent/app/run.py.", "")).toEqual(["/home/agent/app/run.py"]);
  });

  test("never an address, a mail, a wiki link, a code block, a ratio, a unit, a pair, a date or a version", () => {
    const words = [
      "Veja https://example.com/docs/guia.md, www.example.com/precos e example.com/planos.",
      "See github.com/example/repo/blob/main/README.md and docs.example.com/v2/intro.html",
      "Está na página [[Processos/Deploy]] da wiki, escreva para ana@example.com.",
      "Written up in [[Sales/Q3 notes]]; mail bob.smith@example.com/ops if needed.",
      "Rode:\n```\ncat notas/precos.md\n```",
      "Run this:\n```bash\ncp ~/out/report.pdf ./share/\n```",
      "Use e/ou, 24/7, 80 km/h, R$ 49/mês, 09/11/2026, c/ desconto, A/B e Pessoal/Equipe/Empresa.",
      "Use and/or, 24/7, 60 mph, $9/mo, 11/09/2026, w/ the team, TCP/IP, I/O, km/h. and m/s².",
      "Planos s/ juros p/ você, 1/2 xícara, 3/4 do time, nov/2026, seg/sex.",
      "Upgrade from v1.2/v1.3 and HTTP/1.1 to HTTP/2; S.A./Ltda. both work.",
      "Times: Vendas/Marketing, Product/Design, Suporte/CS.",
      "Compare Remix/Next.js and Deno/Node.js before choosing.",
      "The API answers on /api/users and /v2/orders/, see /docs/intro.html.",
      "Ok, @dev/ops vai olhar isso.",
    ];
    for (const reply of words) expect({ reply, cited: localPathsCited(reply, "") }).toEqual({ reply, cited: [] });
  });

  test("a code file named in a plain chat is code talk, not a file to open", () => {
    expect(localPathsCited("Corrigi em `src/login.ts` e os testes em test/login.test.ts passam.", "")).toEqual([]);
    expect(localPathsCited("Fixed it in src/auth/session.py and lib/util.rb.", "corrige o login")).toEqual([]);
  });

  test("a person who writes paths or code reads them: their chat is about files", () => {
    const reply = "Atualizei `notas/planos.md` e salvei a cópia em ~/backup/.";
    expect(localPathsCited(reply, "atualiza o notas/planos.md")).toEqual([]);
    expect(localPathsCited(reply, "olha esse erro:\n```\nTypeError\n```")).toEqual([]);
    expect(localPathsCited(reply, "atualiza as notas dos planos")).toEqual(["notas/planos.md", "~/backup/"]);
    // A web address in the message is no path of theirs.
    expect(localPathsCited(reply, "olha https://example.com/planos/precos.html")).toEqual([
      "notas/planos.md",
      "~/backup/",
    ]);
  });

  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Salvei em `notas/precos.md`.",
    mission: false,
    localPaths: ["notas/precos.md"],
    wakesLater: async () => false,
    verdict: async () => "done",
    ...over,
  });

  test("written again once, judge or not, not counted against the nudges; never between agents nor past a bound", async () => {
    const d = await decideTurnEnd(turn());
    expect(d).toMatchObject({ outcome: "continue", rule: "local_paths" });
    expect(d.nudge).toStartWith(
      "Not posted: your reply cites files on your computer (`notas/precos.md`), which nobody else can open",
    );
    expect(d.nudge).toContain("upload_file");
    expect(d.nudge).toContain("export_file");
    expect(d.nudge).toContain("[[Title]]");
    const next = advance({ count: 0 }, d, 0);
    expect(next).toEqual({ count: 0, pathsNudged: true });
    expect(await decideTurnEnd(turn({ state: next }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ verdict: null }))).toMatchObject({ rule: "local_paths" });
    // Even with the nudges spent, once.
    expect(await decideTurnEnd(turn({ state: { count: 2 } }))).toMatchObject({ rule: "local_paths" });
    expect(await decideTurnEnd(turn({ kind: "agents_dm" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ bound: "stuck" }))).toMatchObject({ outcome: "done", rule: "stuck" });
  });
});

/** Only its name matters here: a computer's way to share a file in the conversation. */
const computer: ToolSource = {
  name: "computer",
  tools: async () => [
    {
      name: "upload_file",
      description: "Share a file from your computer in this conversation.",
      scope: "",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "shared" }),
    },
  ],
};

const lastUserText = (request: ModelRequest | undefined) => {
  const last = request?.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const agentBodies = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice)
    .map((m) => m.body);

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

describe("a run that cites one to people", () => {
  test("its reply is written again, and only that one is posted", async () => {
    f = await setup({
      toolSources: [computer],
      reply: (_request, call) => ({
        chunks: [
          call === 1
            ? "Pesquisei os planos e salvei o resumo em `notas/planos.md`."
            : "Pesquisei os planos: o Básico custa US$ 9 por mês e o Pro US$ 29.",
        ],
      }),
    });
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(lastUserText(f.provider.calls[1]?.request)).toContain(
      "Not posted: your reply cites files on your computer (`notas/planos.md`)",
    );
    expect(await agentBodies(f)).toEqual(["Pesquisei os planos: o Básico custa US$ 9 por mês e o Pro US$ 29."]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "local_paths").length).toBe(1);
  });

  test("a rewrite that still cites it is posted as written", async () => {
    const answer = "Salvei o resumo em `notas/planos.md`.";
    f = await setup({ toolSources: [computer], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("a person who wrote the path, or an agent with no computer, gets the reply as it is", async () => {
    const answer = "Atualizei `notas/planos.md` com os preços de hoje.";
    f = await setup({ toolSources: [computer], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev atualiza o notas/planos.md");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    await f.close();

    f = await setup({ reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev atualiza as notas dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(await agentBodies(f)).toEqual([answer]);
  });

  test("on a computer the person connected themselves, they can open the path: posted as it is", async () => {
    const answer = "Salvei a planilha em ~/Documents/planos.csv.";
    f = await setup({ toolSources: [computer], reply: () => ({ chunks: [answer] }) });
    const [mac] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "Mac da Ana", kind: "connected", pairedByUserId: f.owner.id })
      .returning();
    await f.db.update(schema.agents).set({ machineId: mac?.id }).where(eq(schema.agents.id, f.agent.id));
    await ask(f, "@dev monta a planilha dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(await agentBodies(f)).toEqual([answer]);

    // Someone else's computer: the person can't open it.
    await f.db
      .update(schema.machines)
      .set({ pairedByUserId: null })
      .where(eq(schema.machines.id, mac?.id ?? ""));
    await ask(f, "@dev monta de novo");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
  });
});
