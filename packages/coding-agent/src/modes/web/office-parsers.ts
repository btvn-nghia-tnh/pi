/**
 * Office Open XML preview parsers: xlsx workbooks and docx documents into
 * compact JSON for the web file preview. Both formats are ZIP containers of
 * XML parts; the ZIP layer lives in zip-reader.ts.
 *
 * Scope is preview-grade: values as display strings (shared strings,
 * inline text, booleans, formula cached values, date-formatted serials),
 * docx paragraphs/headings/lists/tables. Layout (merged cells, styles),
 * charts, images and embedded objects are out.
 */

import { readZipEntries, ZipFormatError } from "./zip-reader.ts";

// ------------------------------------------------------------------ xlsx

export interface SpreadsheetSheet {
	name: string;
	rows: string[][];
}

export interface SpreadsheetData {
	sheets: SpreadsheetSheet[];
}

export class OfficeParseError extends Error {}

/** Parse XML attributes of a start tag into a plain record. */
function parseAttributes(raw: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const pattern = /([A-Za-z0-9_:.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
	for (const match of regexMatches(pattern, raw)) {
		attributes[match[1]] = decodeXmlEntities(match[2]);
	}
	return attributes;
}

/** Scan a start tag's attribute block without matching the closing quote. */
/** Iterate regex matches without assignment-in-expression loops. */
function* regexMatches(pattern: RegExp, input: string): Generator<RegExpExecArray> {
	pattern.lastIndex = 0;
	let match = pattern.exec(input);
	while (match !== null) {
		yield match;
		match = pattern.exec(input);
	}
}

function attributeOf(tag: string, name: string): string | undefined {
	return parseAttributes(tag)[name];
}

function decodeXmlEntities(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&#10;", "\n")
		.replaceAll("&#13;", "\r")
		.replaceAll("&#9;", "\t")
		.replaceAll("&amp;", "&");
}

/** Concatenate every <t>…</t> run inside a shared-string item. */
function sharedStringText(siXml: string): string {
	let text = "";
	const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
	for (const match of regexMatches(pattern, siXml)) {
		text += decodeXmlEntities(match[1]);
	}
	return text;
}

/** "BC23" → column index 54 (A = 0). */
function columnIndex(cellRef: string): number {
	let index = 0;
	for (const char of cellRef) {
		if (char < "A" || char > "Z") break;
		index = index * 26 + (char.charCodeAt(0) - 64);
	}
	return index - 1;
}

/**
 * Builtin Excel serial number formats that mean "date/time". Custom ones are
 * matched separately by scanning their format code for date placeholders.
 */
const BUILTIN_DATE_NUMFMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function formatSerialAsDate(serial: number): string {
	// Excel epoch: 1899-12-30 (accounts for the 1900 leap-year bug).
	const ms = Math.round(serial * 86400000);
	const date = new Date(Date.UTC(1899, 11, 30) + ms);
	if (Number.isNaN(date.getTime())) return String(serial);
	const iso = date.toISOString();
	return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** Column-index keyed map of numFmtIds from xl/styles.xml cellXfs. */
function parseStyleDateFormats(stylesXml: string | undefined): Map<number, boolean> {
	const dateFormats = new Map<number, boolean>();
	if (stylesXml === undefined) return dateFormats;
	const customIds = new Set<number>();
	const numFmtPattern = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
	for (const match of regexMatches(numFmtPattern, stylesXml)) {
		const id = Number(match[1]);
		// A format code is date-like when it has date placeholders outside
		// of quoted literals and no digit-only placeholder before them.
		const code = match[2].replace(/"[^"]*"/g, "");
		if (/[ymdhs]/i.test(code)) customIds.add(id);
	}
	const cellXfsBlock = /<cellXfs>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
	const xfPattern = /<xf\b[^>]*>/g;
	let xfIndex = 0;
	for (const match of regexMatches(xfPattern, cellXfsBlock)) {
		const id = Number(attributeOf(match[0], "numFmtId") ?? "0");
		dateFormats.set(xfIndex, BUILTIN_DATE_NUMFMT_IDS.has(id) || customIds.has(id));
		xfIndex++;
	}
	return dateFormats;
}

/** Parse an xlsx workbook into display-string sheets. */
export function parseXlsx(buffer: Buffer, limits: SpreadsheetLimits): SpreadsheetData {
	const entries = readZipEntries(buffer);
	const part = (name: string): string | undefined => entries.get(name)?.data.toString("utf-8");

	const workbookXml = part("xl/workbook.xml");
	if (workbookXml === undefined) {
		throw new OfficeParseError("Not a valid xlsx workbook: missing xl/workbook.xml");
	}
	const relsXml = part("xl/_rels/workbook.xml.rels") ?? "";
	const relTargets = new Map<string, string>();
	const relPattern = /<Relationship\b[^>]*>/g;
	for (const rel of regexMatches(relPattern, relsXml)) {
		const id = attributeOf(rel[0], "Id");
		let target = attributeOf(rel[0], "Target");
		if (id !== undefined && target !== undefined) {
			if (target.startsWith("/")) target = target.slice(1);
			else if (!target.startsWith("xl/")) target = `xl/${target}`;
			relTargets.set(id, target);
		}
	}

	const sharedStrings: string[] = [];
	const sharedStringsXml = part("xl/sharedStrings.xml");
	if (sharedStringsXml !== undefined) {
		const siPattern = /<si>([\s\S]*?)<\/si>/g;
		for (const si of regexMatches(siPattern, sharedStringsXml)) {
			sharedStrings.push(sharedStringText(si[1]));
		}
	}

	const styleDateFormats = parseStyleDateFormats(part("xl/styles.xml"));

	const sheets: SpreadsheetSheet[] = [];
	const sheetPattern = /<sheet\b[^>]*>/g;
	for (const sheetTag of regexMatches(sheetPattern, workbookXml)) {
		const name = attributeOf(sheetTag[0], "name") ?? `Sheet${sheets.length + 1}`;
		const relationshipId = attributeOf(sheetTag[0], "r:id") ?? attributeOf(sheetTag[0], "id");
		const target = relationshipId !== undefined ? relTargets.get(relationshipId) : undefined;
		if (target === undefined) continue;
		const sheetXml = part(target);
		if (sheetXml === undefined) continue;
		sheets.push({ name, rows: parseSheetRows(sheetXml, sharedStrings, styleDateFormats, limits) });
	}
	if (sheets.length === 0) {
		throw new OfficeParseError("Not a valid xlsx workbook: no worksheets found");
	}
	return { sheets };
}

export interface SpreadsheetLimits {
	/** Maximum rows kept per sheet (further rows are dropped, flagged). */
	maxRows: number;
	/** Maximum columns kept per row. */
	maxColumns: number;
}

function parseSheetRows(
	sheetXml: string,
	sharedStrings: string[],
	styleDateFormats: Map<number, boolean>,
	limits: SpreadsheetLimits,
): string[][] {
	const rows: string[][] = [];
	let truncated = false;
	const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
	for (const rowMatch of regexMatches(rowPattern, sheetXml)) {
		if (rows.length >= limits.maxRows) {
			truncated = true;
			break;
		}
		const cells: string[] = [];
		const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
		for (const cellMatch of regexMatches(cellPattern, rowMatch[1] ?? "")) {
			const attrs = cellMatch[1];
			const body = cellMatch[2] ?? "";
			const cellType = attributeOf(attrs, "t");
			const cellStyle = Number(attributeOf(attrs, "s") ?? "-1");

			let value: string;
			if (cellType === "inlineStr") {
				value = sharedStringText(body);
			} else {
				const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
				if (raw === undefined) {
					continue; // formula with no cached value, or an empty styled cell
				}
				const text = decodeXmlEntities(raw);
				if (cellType === "s") {
					const index = Number(text);
					value = sharedStrings[index] ?? "";
				} else if (cellType === "b") {
					value = text === "1" ? "TRUE" : "FALSE";
				} else if (cellType === "e") {
					value = text; // in-cell error value (#DIV/0! etc.)
				} else if (styleDateFormats.get(cellStyle) === true && text !== "") {
					const serial = Number(text);
					value = Number.isFinite(serial) ? formatSerialAsDate(serial) : text;
				} else {
					value = text;
				}
			}
			const column = columnIndex(attributeOf(attrs, "r") ?? "");
			if (column >= 0 && column < limits.maxColumns) {
				cells.length = Math.max(cells.length, column + 1);
				cells[column] = value;
			}
		}
		// Sparse rows (missing cells) become empty strings; Array.from fills
		// the holes that map() would skip.
		rows.push(Array.from({ length: cells.length }, (_, index) => cells[index] ?? ""));
	}
	if (truncated) {
		rows.push([`… [sheet truncated at ${limits.maxRows} rows for preview]`]);
	}
	return rows;
}

// ------------------------------------------------------------------ docx

export type DocumentBlock =
	| { type: "paragraph"; text: string }
	| { type: "heading"; level: number; text: string }
	| { type: "listItem"; text: string; ordered: boolean }
	| { type: "table"; rows: string[][] };

export interface DocumentData {
	blocks: DocumentBlock[];
}

/** Heading level from a paragraph style id ("Heading1" → 1, "Title" → 1). */
function headingLevel(styleId: string): number | undefined {
	if (styleId === "Title") return 1;
	const match = /^Heading([1-9])$/.exec(styleId);
	return match ? Number(match[1]) : undefined;
}

/** Paragraph text = concatenated run texts (w:t, w:tab, w:br). */
function paragraphText(pXml: string): string {
	let text = "";
	const pattern = /<w:(t|tab|br)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:\1>)/g;
	for (const match of regexMatches(pattern, pXml)) {
		if (match[1] === "tab") text += "\t";
		else if (match[1] === "br") text += "\n";
		else text += decodeXmlEntities(match[3] ?? "");
	}
	return text;
}

/** Split a <w:p>…</w:p> body into the styles/numbering info + inner runs. */
function paragraphInfo(pXml: string): { level: number | undefined; ordered: boolean; list: boolean } {
	const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml)?.[1] ?? "";
	const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(pPr)?.[1];
	const list = /<w:numPr>/.test(pPr) || style === "ListParagraph";
	const ordered = /<w:numId\b[^>]*w:val="(\d+)"/.test(pPr) && !/w:numId\b[^>]*w:val="0"/.test(pPr);
	return { level: style !== undefined ? headingLevel(style) : undefined, ordered, list };
}

/** Parse a docx document body into preview blocks. */
export function parseDocx(buffer: Buffer, maxBlocks: number): DocumentData {
	const entries = readZipEntries(buffer);
	const documentXml = entries.get("word/document.xml")?.data.toString("utf-8");
	if (documentXml === undefined) {
		throw new OfficeParseError("Not a valid docx document: missing word/document.xml");
	}
	const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;

	const blocks: DocumentBlock[] = [];
	const blockPattern = /<(w:p|w:tbl)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
	for (const match of regexMatches(blockPattern, body)) {
		if (blocks.length >= maxBlocks) {
			blocks.push({ type: "paragraph", text: `… [document truncated at ${maxBlocks} blocks for preview]` });
			break;
		}
		if (match[1] === "w:tbl") {
			const rows: string[][] = [];
			const rowPattern = /<w:tr\b[^>]*?>([\s\S]*?)<\/w:tr>/g;
			for (const rowMatch of regexMatches(rowPattern, match[3] ?? "")) {
				const cells: string[] = [];
				const cellPattern = /<w:tc\b[^>]*?>([\s\S]*?)<\/w:tc>/g;
				for (const cellMatch of regexMatches(cellPattern, rowMatch[1])) {
					cells.push(paragraphText(cellMatch[1]).trim());
				}
				rows.push(cells);
			}
			blocks.push({ type: "table", rows });
		} else {
			const info = paragraphInfo(match[3] ?? "");
			const text = paragraphText(match[3] ?? "");
			if (info.level !== undefined) {
				blocks.push({ type: "heading", level: info.level, text });
			} else if (info.list && text.length > 0) {
				blocks.push({ type: "listItem", text, ordered: info.ordered });
			} else if (text.trim().length > 0) {
				blocks.push({ type: "paragraph", text });
			}
		}
	}
	if (blocks.length === 0) {
		throw new OfficeParseError("Not a valid docx document: no content found");
	}
	return { blocks };
}

export { ZipFormatError };
