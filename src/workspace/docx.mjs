const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const XML_MIME = "application/xml";
const RELS_MIME =
  "application/vnd.openxmlformats-package.relationships+xml";

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function slugifyTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[\u2022*-]\s+/, "")
    .replace(/\s+/g, " ");
}

function inferTitle(title, content) {
  const explicitTitle = slugifyTitle(title);
  if (explicitTitle) {
    return explicitTitle;
  }

  const firstNonEmptyLine = normalizeText(content)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  return slugifyTitle(firstNonEmptyLine || "Generated Report");
}

function splitParagraphs(content) {
  return normalizeText(content)
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function parseContentBlocks(content, title = "") {
  const blocks = [];
  const normalizedTitle = inferTitle(title, content);
  if (normalizedTitle) {
    blocks.push({
      style: "Title",
      text: normalizedTitle
    });
  }

  for (const paragraph of splitParagraphs(content)) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        blocks.push({
          style: `Heading${headingMatch[1].length}`,
          text: slugifyTitle(headingMatch[2])
        });
        continue;
      }

      const bulletMatch = line.match(/^[\u2022*-]\s+(.+)$/);
      if (bulletMatch) {
        blocks.push({
          style: "Normal",
          text: `• ${bulletMatch[1].trim()}`
        });
        continue;
      }

      blocks.push({
        style: "Normal",
        text: line
      });
    }
  }

  if (blocks.length === 1) {
    blocks.push({
      style: "Normal",
      text: normalizedTitle
    });
  }

  return blocks;
}

function buildRunXml(text) {
  return [
    "<w:r>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/>',
    "</w:rPr>",
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`,
    "</w:r>"
  ].join("");
}

function buildParagraphXml(block) {
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${escapeXml(block.style || "Normal")}"/>`,
    "</w:pPr>",
    buildRunXml(block.text),
    "</w:p>"
  ].join("");
}

function buildDocumentXml(blocks) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    ' xmlns:o="urn:schemas-microsoft-com:office:office"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
    ' xmlns:v="urn:schemas-microsoft-com:vml"',
    ' xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    ' xmlns:w10="urn:schemas-microsoft-com:office:word"',
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
    ' xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
    ' xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"',
    ' xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"',
    ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
    ' mc:Ignorable="w14 wp14">',
    "<w:body>",
    ...blocks.map((block) => buildParagraphXml(block)),
    "<w:sectPr>",
    '<w:pgSz w:w="11906" w:h="16838"/>',
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>',
    '<w:cols w:space="720"/>',
    '<w:docGrid w:linePitch="360"/>',
    "</w:sectPr>",
    "</w:body>",
    "</w:document>"
  ].join("");
}

function buildStylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:docDefaults>",
    "<w:rPrDefault>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/>',
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>',
    '<w:sz w:val="22"/>',
    '<w:szCs w:val="22"/>',
    "</w:rPr>",
    "</w:rPrDefault>",
    "<w:pPrDefault>",
    '<w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr>',
    "</w:pPrDefault>",
    "</w:docDefaults>",
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
    "<w:name w:val=\"Normal\"/>",
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Title">',
    '<w:name w:val="Title"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="32"/><w:szCs w:val="32"/>',
    "</w:rPr>",
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="280"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading1">',
    '<w:name w:val="heading 1"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="28"/><w:szCs w:val="28"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading2">',
    '<w:name w:val="heading 2"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="24"/><w:szCs w:val="24"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading3">',
    '<w:name w:val="heading 3"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="22"/><w:szCs w:val="22"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="120" w:after="80"/></w:pPr>',
    "</w:style>",
    "</w:styles>"
  ].join("");
}

function buildRootRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>"
  ].join("");
}

function buildDocumentRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>"
  ].join("");
}

function buildContentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    `<Default Extension="rels" ContentType="${RELS_MIME}"/>`,
    `<Default Extension="xml" ContentType="${XML_MIME}"/>`,
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}"/>`,
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    "</Types>"
  ].join("");
}

function buildCoreXml(title, createdAtIso) {
  const escapedTitle = escapeXml(title);
  const escapedTimestamp = escapeXml(createdAtIso);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapedTitle}</dc:title>`,
    "<dc:creator>Agent Cluster Workbench</dc:creator>",
    "<cp:lastModifiedBy>Agent Cluster Workbench</cp:lastModifiedBy>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${escapedTimestamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapedTimestamp}</dcterms:modified>`,
    "</cp:coreProperties>"
  ].join("");
}

function buildAppXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>Agent Cluster Workbench</Application>",
    "</Properties>"
  ].join("");
}

function getDosDateTime(date = new Date()) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds
  };
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const dataBuffer = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ""), "utf8");
    const checksum = crc32(dataBuffer);
    const { date, time } = getDosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryBuffer = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectoryBuffer, endRecord]);
}

export function createDocxBuffer({ title = "", content = "" } = {}) {
  const blocks = parseContentBlocks(content, title);
  const createdAt = new Date();
  const resolvedTitle = inferTitle(title, content);

  return createZipBuffer([
    {
      name: "[Content_Types].xml",
      content: buildContentTypesXml(),
      modifiedAt: createdAt
    },
    {
      name: "_rels/.rels",
      content: buildRootRelationshipsXml(),
      modifiedAt: createdAt
    },
    {
      name: "docProps/core.xml",
      content: buildCoreXml(resolvedTitle, createdAt.toISOString()),
      modifiedAt: createdAt
    },
    {
      name: "docProps/app.xml",
      content: buildAppXml(),
      modifiedAt: createdAt
    },
    {
      name: "word/document.xml",
      content: buildDocumentXml(blocks),
      modifiedAt: createdAt
    },
    {
      name: "word/styles.xml",
      content: buildStylesXml(),
      modifiedAt: createdAt
    },
    {
      name: "word/_rels/document.xml.rels",
      content: buildDocumentRelationshipsXml(),
      modifiedAt: createdAt
    }
  ]);
}
