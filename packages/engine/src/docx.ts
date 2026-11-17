import { type MarkdownBlock, parseMarkdown } from "./pdf";
import { zip } from "./zip";

/**
 * Markdown → Word (.docx), in pure TypeScript: a minimal OOXML package
 * (document, styles, numbering, links) zipped with deflate. Headings, text
 * with bold, italic, `code` and links, bullet and numbered lists, quotes,
 * code blocks, tables and rules. Text uses our brand fonts by name (Onest,
 * Martian Mono for code); Word falls back to its own when they aren't
 * installed.
 */
export function markdownToDocx(markdown: string, options: { title?: string } = {}): Uint8Array {
  const links: string[] = [];
  const body: string[] = [];
  if (options.title) body.push(paragraph(runsOf(options.title, links), { style: "Title" }));
  let list = 0;
  for (const block of parseMarkdown(markdown)) body.push(...blockXml(block, links, () => ++list));
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${links
    .map(
      (url, i) =>
        `<Relationship Id="rLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${attr(url)}" TargetMode="External"/>`,
    )
    .join("")}</Relationships>`;
  return zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["docProps/core.xml", core(options.title ?? "Documento")],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", rels],
    ["word/styles.xml", STYLES],
    ["word/numbering.xml", numbering(list)],
  ]);
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: number;
}

/** Inline Markdown: **bold**, *italic* / _italic_, `code`, [text](url). */
function inline(text: string, links: string[]): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    if (token.startsWith("**")) out.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) out.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const url = link?.[2] ?? "";
      if (link && /^(https?:|mailto:)/i.test(url)) {
        links.push(url);
        out.push({ text: link[1] ?? "", link: links.length });
      } else out.push({ text: token });
    } else out.push({ text: token.slice(1, -1), italic: true });
    last = at + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function run(r: Inline, extra = "") {
  const props = [
    r.bold ? "<w:b/>" : "",
    r.italic ? "<w:i/>" : "",
    r.code ? '<w:rFonts w:ascii="Martian Mono" w:hAnsi="Martian Mono" w:cs="Martian Mono"/><w:sz w:val="19"/>' : "",
    r.link ? '<w:rStyle w:val="Hyperlink"/>' : "",
    extra,
  ].join("");
  const xml = `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
  return r.link ? `<w:hyperlink r:id="rLink${r.link}">${xml}</w:hyperlink>` : xml;
}

const runsOf = (text: string, links: string[], extra = "") =>
  inline(text, links)
    .map((r) => run(r, extra))
    .join("");

function paragraph(runs: string, options: { style?: string; props?: string } = {}) {
  const pPr = `${options.style ? `<w:pStyle w:val="${options.style}"/>` : ""}${options.props ?? ""}`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
}

function blockXml(block: MarkdownBlock, links: string[], nextList: () => number): string[] {
  switch (block.type) {
    case "heading":
      return [paragraph(runsOf(block.text, links), { style: `Heading${Math.min(block.level, 3)}` })];
    case "paragraph":
      return [paragraph(runsOf(block.text, links))];
    case "quote":
      return [paragraph(runsOf(block.text, links, "<w:i/>"), { style: "Quote" })];
    case "list": {
      // Each list gets its own numbering instance so numbered lists restart at 1.
      const id = nextList();
      const num = block.ordered ? id * 2 : id * 2 - 1;
      return block.items.map((item) =>
        paragraph(runsOf(item, links), {
          style: "ListParagraph",
          props: `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>`,
        }),
      );
    }
    case "code":
      return (block.lines.length > 0 ? block.lines : [""]).map((line) =>
        paragraph(run({ text: line.replace(/\t/g, "  "), code: true }), { style: "Code" }),
      );
    case "rule":
      return [
        paragraph("", {
          props: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>',
        }),
      ];
    case "table": {
      const columns = Math.max(1, ...block.rows.map((r) => r.length));
      const width = Math.floor(9638 / columns);
      const rows = block.rows.map((row, r) => {
        const cellsXml = Array.from({ length: columns }, (_, k) => {
          const shade = r === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : "";
          const text = runsOf(row[k] ?? "", links, r === 0 ? "<w:b/>" : "");
          return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraph(text)}</w:tc>`;
        }).join("");
        return `<w:tr>${r === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cellsXml}</w:tr>`;
      });
      const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
      const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
      return [
        `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join("")}</w:tbl>`,
        paragraph(""),
      ];
    }
  }
}

function numbering(lists: number) {
  const abstract = (id: number, ordered: boolean) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${ordered ? "decimal" : "bullet"}"/><w:lvlText w:val="${ordered ? "%1." : "•"}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  const nums: string[] = [];
  for (let i = 1; i <= lists; i++) {
    nums.push(`<w:num w:numId="${i * 2 - 1}"><w:abstractNumId w:val="0"/></w:num>`);
    nums.push(
      `<w:num w:numId="${i * 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">${abstract(0, false)}${abstract(1, true)}${nums.join("")}</w:numbering>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const core = (title: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>agentes.chat</dc:creator></cp:coreProperties>`;

const style = (id: string, name: string, pPr: string, rPr: string, basedOn = "Normal") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Onest" w:hAnsi="Onest" w:eastAsia="Onest" w:cs="Onest"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style("Title", "Title", '<w:spacing w:after="240"/>', '<w:b/><w:sz w:val="44"/>')}${style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="36"/>')}${style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="30"/>')}${style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="25"/>')}${style("Quote", "Quote", '<w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr>', '<w:color w:val="555555"/>')}${style("ListParagraph", "List Paragraph", '<w:spacing w:after="60"/><w:ind w:left="720"/>', "")}${style("Code", "Code", '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>', '<w:rFonts w:ascii="Martian Mono" w:hAnsi="Martian Mono" w:cs="Martian Mono"/><w:sz w:val="19"/>')}<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5FBF"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
