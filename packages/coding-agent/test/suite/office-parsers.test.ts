import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { OfficeParseError, parseDocx, parseXlsx, type SpreadsheetLimits } from "../../src/modes/web/office-parsers.ts";

/** Build an in-memory ZIP with deflated entries (shared with zip-reader tests). */
function buildZip(files: Record<string, string>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBuffer = Buffer.from(name, "utf-8");
		const data = Buffer.from(content, "utf-8");
		const compressed = deflateRawSync(data);
		const crc = crc32(data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuffer.length, 26);
		locals.push(local, nameBuffer, compressed);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuffer.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuffer);
		offset += 30 + nameBuffer.length + compressed.length;
	}
	const centralDirectory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(Object.keys(files).length, 8);
	eocd.writeUInt16LE(Object.keys(files).length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralDirectory, eocd]);
}

const LIMITS: SpreadsheetLimits = { maxRows: 100, maxColumns: 64 };

/** Minimal xlsx with one sheet using shared strings, numbers and a date style. */
function buildXlsx(): Buffer {
	return buildZip({
		"xl/workbook.xml":
			'<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
		"xl/sharedStrings.xml":
			'<sst count="3"><si><t>Name</t></si><si><t>Bob &amp; Co</t></si><si><r><t>Bold</t></r><r><t> part</t></r></si></sst>',
		"xl/styles.xml":
			'<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
		"xl/worksheets/sheet1.xml":
			"<worksheet><sheetData>" +
			'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
			'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c><c r="C2" s="1"><v>45123</v></c></row>' +
			'<row r="3"><c r="A3"><v>TRUE</v></c><c r="D3" t="b"><v>1</v></c></row>' +
			"</sheetData></worksheet>",
		"xl/worksheets/sheet2.xml":
			'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline text</t></is></c></row></sheetData></worksheet>',
	});
}

describe("parseXlsx", () => {
	it("extracts sheets, shared strings, numbers, booleans and dates", () => {
		const data = parseXlsx(buildXlsx(), LIMITS);
		expect(data.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Notes"]);
		expect(data.sheets[0].rows).toEqual([
			["Name", "Bob & Co", "Bold part"],
			["Bob & Co", "42.5", "2023-07-16"],
			["TRUE", "", "", "TRUE"],
		]);
		expect(data.sheets[1].rows).toEqual([["inline text"]]);
	});

	it("truncates large sheets with a marker row", () => {
		const rows = Array.from(
			{ length: 50 },
			(_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
		).join("");
		const zip = buildZip({
			"xl/workbook.xml": '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
			"xl/_rels/workbook.xml.rels":
				'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
			"xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
		});
		const data = parseXlsx(zip, { maxRows: 10, maxColumns: 64 });
		expect(data.sheets[0].rows).toHaveLength(11); // 10 rows + truncation marker
		expect(data.sheets[0].rows[10]).toEqual(["… [sheet truncated at 10 rows for preview]"]);
	});

	it("rejects buffers that are not xlsx", () => {
		const zip = buildZip({ "other/file.xml": "<x/>" });
		expect(() => parseXlsx(zip, LIMITS)).toThrowError(OfficeParseError);
	});
});

/** Minimal docx: title, heading, list items, paragraphs and a table. */
function buildDocx(): Buffer {
	const paragraph = (text: string, style?: string, numId?: string) => {
		const pPr = [
			style !== undefined ? `<w:pStyle w:val="${style}"/>` : "",
			numId !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : "",
		].join("");
		return `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
	};
	const table =
		"<w:tbl><w:tr>" +
		"<w:tc><w:p><w:r><w:t>Feature</w:t></w:r></w:p></w:tc>" +
		"<w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>" +
		"</w:tr><w:tr>" +
		"<w:tc><w:p><w:r><w:t>xlsx</w:t></w:r></w:p></w:tc>" +
		'<w:tc><w:p><w:r><w:t xml:space="preserve">done &amp; tested</w:t></w:r></w:p></w:tc>' +
		"</w:tr></w:tbl>";
	return buildZip({
		"word/document.xml":
			"<w:document><w:body>" +
			paragraph("Quarterly Report", "Title") +
			paragraph("Overview", "Heading2") +
			paragraph("First paragraph &amp; more") +
			paragraph("Bullet one", "ListParagraph", "1") +
			paragraph("Bullet two", undefined, "1") +
			table +
			"</w:body></w:document>",
	});
}

describe("parseDocx", () => {
	it("extracts headings, paragraphs, list items and tables", () => {
		const data = parseDocx(buildDocx(), 100);
		expect(data.blocks).toEqual([
			{ type: "heading", level: 1, text: "Quarterly Report" },
			{ type: "heading", level: 2, text: "Overview" },
			{ type: "paragraph", text: "First paragraph & more" },
			{ type: "listItem", text: "Bullet one", ordered: true },
			{ type: "listItem", text: "Bullet two", ordered: true },
			{
				type: "table",
				rows: [
					["Feature", "Status"],
					["xlsx", "done & tested"],
				],
			},
		]);
	});

	it("truncates long documents with a marker", () => {
		const paragraphs = Array.from({ length: 30 }, (_, index) => `<w:p><w:r><w:t>p${index}</w:t></w:r></w:p>`).join(
			"",
		);
		const zip = buildZip({ "word/document.xml": `<w:document><w:body>${paragraphs}</w:body></w:document>` });
		const data = parseDocx(zip, 10);
		expect(data.blocks).toHaveLength(11);
		expect(data.blocks[10]).toEqual({ type: "paragraph", text: "… [document truncated at 10 blocks for preview]" });
	});

	it("rejects buffers without word/document.xml", () => {
		const zip = buildZip({ "other.xml": "<x/>" });
		expect(() => parseDocx(zip, 100)).toThrowError(OfficeParseError);
	});
});
