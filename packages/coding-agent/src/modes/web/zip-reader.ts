/**
 * Minimal read-only ZIP reader for Office preview parsing (xlsx/docx are
 * ZIP containers of XML parts). Only what those formats need: the central
 * directory + local headers, stored and deflated entries, no ZIP64 (files
 * are far below the preview size cap when it matters).
 */

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD fixed part: signature + 18 bytes of fields + comment-length field. */
const EOCD_MIN_SIZE = 22;
/** Maximum bytes to scan backwards for the EOCD (comment is rarely used). */
const EOCD_MAX_COMMENT = 1024;
const STORED = 0;
const DEFLATED = 8;

/** One extracted archive member, keyed by its full name (e.g. "xl/workbook.xml"). */
export interface ZipEntry {
	name: string;
	data: Buffer;
}

export class ZipFormatError extends Error {}

function readUint16(buffer: Buffer, offset: number): number {
	return buffer.readUInt16LE(offset);
}

function readUint32(buffer: Buffer, offset: number): number {
	return buffer.readUInt32LE(offset);
}

/** Locate the end-of-central-directory record; returns its byte offset. */
function findEocdOffset(buffer: Buffer): number {
	const maxStart = Math.max(0, buffer.length - EOCD_MIN_SIZE);
	const minStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
	for (let offset = maxStart; offset >= minStart; offset--) {
		if (readUint32(buffer, offset) === EOCD_SIGNATURE) return offset;
	}
	throw new ZipFormatError("Not a ZIP archive: end-of-central-directory record not found");
}

/**
 * Extract every member. Duplicate names keep the last entry (Office writers
 * do not emit them, but a hostile file must not crash the preview).
 */
export function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
	const eocd = findEocdOffset(buffer);
	const entryCount = readUint16(buffer, eocd + 10);
	const cdOffset = readUint32(buffer, eocd + 16);

	const entries = new Map<string, ZipEntry>();
	let cursor = cdOffset;
	for (let index = 0; index < entryCount; index++) {
		if (cursor + 46 > buffer.length || readUint32(buffer, cursor) !== CENTRAL_SIGNATURE) {
			throw new ZipFormatError("Corrupt ZIP archive: truncated central directory");
		}
		const method = readUint16(buffer, cursor + 10);
		const compressedSize = readUint32(buffer, cursor + 20);
		const nameLength = readUint16(buffer, cursor + 28);
		const extraLength = readUint16(buffer, cursor + 30);
		const commentLength = readUint16(buffer, cursor + 32);
		const localOffset = readUint32(buffer, cursor + 42);
		const name = buffer.toString("utf-8", cursor + 46, cursor + 46 + nameLength);

		if (localOffset + 30 > buffer.length || readUint32(buffer, localOffset) !== LOCAL_SIGNATURE) {
			throw new ZipFormatError(`Corrupt ZIP archive: bad local header for "${name}"`);
		}
		const localNameLength = readUint16(buffer, localOffset + 26);
		const localExtraLength = readUint16(buffer, localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
		if (dataStart + compressedSize > buffer.length) {
			throw new ZipFormatError(`Corrupt ZIP archive: truncated data for "${name}"`);
		}

		let data: Buffer;
		if (method === STORED) {
			data = Buffer.from(compressed);
		} else if (method === DEFLATED) {
			try {
				data = inflateRawSync(compressed);
			} catch (error: unknown) {
				throw new ZipFormatError(
					`Corrupt ZIP archive: cannot inflate "${name}" (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		} else {
			throw new ZipFormatError(`Unsupported ZIP compression method ${method} for "${name}"`);
		}
		entries.set(name, { name, data });
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}
