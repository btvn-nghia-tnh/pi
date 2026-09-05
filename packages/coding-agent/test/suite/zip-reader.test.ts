import { crc32, deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { readZipEntries, ZipFormatError } from "../../src/modes/web/zip-reader.ts";

/** Build an in-memory ZIP with deflated entries — no fixture files needed. */
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
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(8, 8); // method: deflate
		local.writeUInt16LE(0, 10); // time
		local.writeUInt16LE(0x21, 12); // date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuffer.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuffer, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8); // flags
		central.writeUInt16LE(8, 10); // method
		central.writeUInt16LE(0, 12); // time
		central.writeUInt16LE(0x21, 14); // date
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuffer.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
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

it("readZipEntries extracts deflated members", () => {
	const zip = buildZip({
		"xl/workbook.xml": "<workbook/>",
		"xl/worksheets/sheet1.xml": "<worksheet><a/></worksheet>",
	});
	const entries = readZipEntries(zip);
	expect(entries.size).toBe(2);
	expect(entries.get("xl/workbook.xml")?.data.toString("utf-8")).toBe("<workbook/>");
	expect(entries.get("xl/worksheets/sheet1.xml")?.data.toString("utf-8")).toBe("<worksheet><a/></worksheet>");
});

it("readZipEntries handles unicode names", () => {
	const zip = buildZip({ "tên file/данные 📊.xml": "<ok/>" });
	const entries = readZipEntries(zip);
	expect(entries.get("tên file/данные 📊.xml")?.data.toString("utf-8")).toBe("<ok/>");
});

it("readZipEntries rejects non-ZIP buffers", () => {
	expect(() => readZipEntries(Buffer.from("this is not a zip at all"))).toThrowError(ZipFormatError);
});

it("readZipEntries rejects corrupt member data", () => {
	const zip = buildZip({ "a.xml": "content" });
	// Corrupt the first entry's local header signature (entry "a.xml" starts
	// at offset 0) — deflate streams survive single-bit garbage, headers do not.
	zip[0] ^= 0xff;
	expect(() => readZipEntries(zip)).toThrowError(ZipFormatError);
});
