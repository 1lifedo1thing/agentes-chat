import { describe, expect, test } from "bun:test";
import type { SheetData } from "@agenteschat/live";
import * as XLSX from "xlsx";
import { officeFormatOf, readCsv, readWorkbook, readXls, writeCsv, writeXlsx } from "../src/office";
import { zip } from "../src/zip";

const cellAt = (sheet: SheetData | undefined, r: number, c: number) => sheet?.cells.find((x) => x.r === r && x.c === c);
const bytes = (text: string) => new TextEncoder().encode(text);

describe("CSV and TSV", () => {
  test("semicolons with decimal commas, quoted fields with separators and line breaks, codes kept as text", () => {
    const book = readCsv(
      bytes(
        'Item;Preço\r\nCafé;12,50\r\n"Moído; fino";1.234,5\r\nCódigo;007\r\n"Nota ""longa""\nem duas linhas";-3\r\n',
      ),
      "precos.csv",
    );
    const sheet = book.sheets[0];
    expect(sheet?.name).toBe("precos");
    expect(sheet?.rows).toBe(5);
    expect(sheet?.cols).toBe(2);
    expect(cellAt(sheet, 0, 1)?.v).toBe("Preço");
    expect(cellAt(sheet, 1, 1)?.v).toBe(12.5);
    expect(cellAt(sheet, 2, 0)?.v).toBe("Moído; fino");
    expect(cellAt(sheet, 2, 1)?.v).toBe(1234.5);
    expect(cellAt(sheet, 3, 1)?.v).toBe("007");
    expect(cellAt(sheet, 4, 0)?.v).toBe('Nota "longa"\nem duas linhas');
    expect(cellAt(sheet, 4, 1)?.v).toBe(-3);
  });

  test("commas with decimal points, grouped thousands in quotes, a formula-looking field stays text", () => {
    const sheet = readCsv('name,total,note\nAda,"1,234.5",=SUM(A1)\nAtlas,2.5e3,\n').sheets[0];
    expect(cellAt(sheet, 1, 1)?.v).toBe(1234.5);
    expect(cellAt(sheet, 1, 2)).toEqual({ r: 1, c: 2, v: "=SUM(A1)" });
    expect(cellAt(sheet, 2, 1)?.v).toBe(2500);
    expect(cellAt(sheet, 2, 2)).toBeUndefined();
  });

  test("tabs by the name, Windows-1252 text and a byte order mark", async () => {
    const tsv = await readWorkbook(bytes("a\tb\n1\t2\n"), "data.tsv", "text/tab-separated-values");
    expect(tsv.sheets[0]?.cells).toHaveLength(4);
    const latin = new Uint8Array([0x50, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x31, 0x0a]);
    expect(cellAt(readCsv(latin, "old.csv").sheets[0], 0, 0)?.v).toBe("Preço");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("x,y\n")]);
    expect(cellAt(readCsv(bom).sheets[0], 0, 0)?.v).toBe("x");
  });

  test("a sheet written as CSV: quoted where it must be, dates as they show, every row as wide as the widest", () => {
    const csv = writeCsv({
      name: "A",
      rows: 4,
      cols: 3,
      cells: [
        { r: 0, c: 0, v: "Item, with comma" },
        { r: 0, c: 2, v: 'say "hi"' },
        { r: 1, c: 0, v: 46343, s: { nf: "dd/mm/yyyy" }, t: "17/11/2026" },
        { r: 1, c: 1, v: 0.1 + 0.2 },
        { r: 2, c: 0, v: true },
        { r: 2, c: 1, f: "1/0", e: "#DIV/0!" },
        { r: 3, c: 2, v: "two\nlines" },
      ],
    });
    expect(csv).toBe(
      '"Item, with comma",,"say ""hi"""\r\n17/11/2026,0.30000000000000004,\r\nTRUE,#DIV/0!,\r\n,,"two\nlines"\r\n',
    );
    // And back.
    const back = readCsv(csv).sheets[0];
    expect(cellAt(back, 0, 0)?.v).toBe("Item, with comma");
    expect(cellAt(back, 3, 2)?.v).toBe("two\nlines");
  });

  test("past 200,000 cells it is too large", () => {
    const row = `${Array.from({ length: 50 }, (_, i) => i).join(",")}\n`;
    expect(() => readCsv(row.repeat(4001))).toThrow(expect.objectContaining({ code: "office.too_large" }));
  });
});

describe("legacy Excel and OpenDocument workbooks", () => {
  function sample() {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Item", "Price"],
      ["Coffee", 12.5],
      ["Tea", 3],
      [true, { t: "n", v: 25, f: "B2*2" }],
      ["Merged", null],
    ]);
    (ws.B2 as XLSX.CellObject).z = "0.00";
    ws["!merges"] = [{ s: { r: 4, c: 0 }, e: { r: 4, c: 1 } }];
    ws["!cols"] = [{ wpx: 150 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Costs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["hidden"]]), "Secret");
    wb.Workbook = {
      Sheets: [
        { name: "Costs", Hidden: 0 },
        { name: "Secret", Hidden: 1 },
      ],
    };
    return wb;
  }

  for (const bookType of ["biff8", "ods"] as const) {
    test(`${bookType === "biff8" ? ".xls" : ".ods"}: values, merges and formulas; hidden sheets left out`, async () => {
      const file = new Uint8Array(XLSX.write(sample(), { bookType, type: "array" }) as ArrayBuffer);
      const name = bookType === "biff8" ? "costs.xls" : "costs.ods";
      const book = await readWorkbook(file, name);
      // The library writes no hidden flag into an .ods: only the .xls says it.
      expect(book.sheets.map((s) => s.name)).toEqual(bookType === "biff8" ? ["Costs"] : ["Costs", "Secret"]);
      const sheet = book.sheets[0];
      expect(cellAt(sheet, 0, 0)?.v).toBe("Item");
      expect(cellAt(sheet, 1, 1)?.v).toBe(12.5);
      expect(cellAt(sheet, 3, 0)?.v).toBe(true);
      expect(cellAt(sheet, 3, 1)?.v).toBe(25);
      expect(sheet?.merges).toEqual([{ r1: 4, c1: 0, r2: 4, c2: 1 }]);
      if (bookType === "ods") expect(cellAt(sheet, 3, 1)?.f).toBe("B2*2");
    });
  }

  test("an .ods is unpacked by the server's own reader first: a part past the budget never reaches the library", async () => {
    const bomb = zip(
      [
        ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
        ["content.xml", new Uint8Array(41 * 1024 * 1024)],
      ],
      { store: (path) => path === "mimetype" },
    );
    await expect(readXls(bomb)).rejects.toMatchObject({ code: "office.too_large" });
  });

  test("a file named for one format and holding another is read for what it is", async () => {
    const xlsx = writeXlsx({ sheets: [{ name: "A", rows: 1, cols: 1, cells: [{ r: 0, c: 0, v: "real xlsx" }] }] });
    expect(cellAt((await readWorkbook(xlsx, "old.xls")).sheets[0], 0, 0)?.v).toBe("real xlsx");
    expect(cellAt((await readWorkbook(bytes("a,b\n"), "export.xls")).sheets[0], 0, 1)?.v).toBe("b");
    await expect(readWorkbook(bytes("x"), "notes.docx")).rejects.toMatchObject({ code: "office.unsupported" });
    await expect(readXls(bytes("not a workbook"))).rejects.toMatchObject({ code: "office.unreadable" });
  });

  test("formats by name first, then by declared type", () => {
    expect(officeFormatOf("Costs.XLSX")).toBe("xlsx");
    expect(officeFormatOf("deck.pptm")).toBe("pptx");
    expect(officeFormatOf("file", "application/vnd.ms-excel")).toBe("xls");
    expect(officeFormatOf("file", "text/csv; charset=utf-8")).toBe("csv");
    expect(officeFormatOf("old.doc", "application/msword")).toBeNull();
  });
});
