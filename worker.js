// @huamidev 2026/04/13
importScripts('templates.js');

function readU16(dv, o) { return dv.getUint16(o, false); }
function readU32(dv, o) { return dv.getUint32(o, false); }
function writeU16(dv, o, v) { dv.setUint16(o, v, false); }
function writeU32(dv, o, v) { dv.setUint32(o, v, false); }
function readTag(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
}
function writeTag(dv, o, tag) {
  for (let i = 0; i < 4; i++) dv.setUint8(o + i, tag.charCodeAt(i));
}
function align4(n) { return (n + 3) & ~3; }

function calcChecksum(data) {
  const padLen = align4(data.length);
  const padded = new Uint8Array(padLen);
  padded.set(data);
  const dv = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padLen; i += 4) sum = (sum + dv.getUint32(i, false)) >>> 0;
  return sum;
}

function hashData(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${data.length}:${(h >>> 0).toString(16)}`;
}

function dataEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isTTC(buf) {
  const dv = new DataView(buf);
  return readTag(dv, 0) === 'ttcf';
}

function parseTTC(buf) {
  const dv = new DataView(buf);
  const numFonts = readU32(dv, 8);
  const offsets = [];
  for (let i = 0; i < numFonts; i++) offsets.push(readU32(dv, 12 + i * 4));
  return { numFonts, offsets };
}

function parseSFNT(buf, offset) {
  const dv = new DataView(buf);
  const sfVersion = readU32(dv, offset);
  const numTables = readU16(dv, offset + 4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const r = offset + 12 + i * 16;
    tables.push({
      tag: readTag(dv, r),
      checksum: readU32(dv, r + 4),
      offset: readU32(dv, r + 8),
      length: readU32(dv, r + 12),
    });
  }
  return { sfVersion, numTables, tables };
}

function sliceTable(buf, rec) {
  return new Uint8Array(buf.slice(rec.offset, rec.offset + rec.length));
}

function decodeUTF16BE(data, off, len) {
  let s = '';
  for (let i = 0; i < len; i += 2)
    s += String.fromCharCode((data[off + i] << 8) | data[off + i + 1]);
  return s;
}

function decodeMacRoman(data, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
  return s;
}

function getNameStr(nameData, nameID, platformID, langID) {
  const dv = new DataView(nameData.buffer, nameData.byteOffset, nameData.byteLength);
  const count = readU16(dv, 2);
  const strOff = readU16(dv, 4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (readU16(dv, r + 6) !== nameID) continue;
    if (readU16(dv, r) !== platformID) continue;
    if (readU16(dv, r + 4) !== langID) continue;
    const len = readU16(dv, r + 8);
    const off = readU16(dv, r + 10);
    if (platformID === 3) return decodeUTF16BE(nameData, strOff + off, len);
    if (platformID === 1) return decodeMacRoman(nameData, strOff + off, len);
  }
  return null;
}

function getSubfamily(nd) {
  return getNameStr(nd, 2, 3, 0x0409) || getNameStr(nd, 2, 1, 0) || 'Regular';
}
function getFamily(nd) {
  return getNameStr(nd, 1, 3, 0x0409) || getNameStr(nd, 1, 1, 0) || '?';
}

function getNameInfo(nd) {
  return {
    family: getNameStr(nd, 1, 3, 0x0409) || getNameStr(nd, 1, 1, 0) || '',
    subfamily: getNameStr(nd, 2, 3, 0x0409) || getNameStr(nd, 2, 1, 0) || '',
    copyright: getNameStr(nd, 0, 3, 0x0409) || getNameStr(nd, 0, 1, 0) || '',
    version: getNameStr(nd, 5, 3, 0x0409) || getNameStr(nd, 5, 1, 0) || '',
    designer: getNameStr(nd, 9, 3, 0x0409) || getNameStr(nd, 9, 1, 0) || '',
    license: getNameStr(nd, 13, 3, 0x0409) || getNameStr(nd, 13, 1, 0) || '',
  };
}

function readFontMetrics(tables) {
  const m = { usWeightClass: 400, unitsPerEm: 1000, sTypoAscender: 800, sTypoDescender: -200, sTypoLineGap: 0 };
  const os2 = tables.find(t => t.tag === 'OS/2');
  if (os2 && os2.data.length >= 78) {
    const dv = new DataView(os2.data.buffer, os2.data.byteOffset, os2.data.byteLength);
    m.usWeightClass = dv.getUint16(4, false);
    if (os2.data.length >= 74) {
      m.sTypoAscender = dv.getInt16(68, false);
      m.sTypoDescender = dv.getInt16(70, false);
      m.sTypoLineGap = dv.getInt16(72, false);
    }
  }
  const head = tables.find(t => t.tag === 'head');
  if (head && head.data.length >= 20) {
    const dv = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
    m.unitsPerEm = dv.getUint16(18, false);
  }
  return m;
}

function modifyOS2(d, weight, fsType, lineHeightOffset) {
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  writeU16(dv, 4, weight);
  writeU16(dv, 8, fsType);
  if (lineHeightOffset && d.length >= 78) {
    dv.setInt16(68, dv.getInt16(68, false) + lineHeightOffset, false);
    dv.setInt16(70, dv.getInt16(70, false) - lineHeightOffset, false);
    dv.setInt16(72, dv.getInt16(72, false) + lineHeightOffset, false);
    dv.setUint16(74, Math.max(0, dv.getUint16(74, false) + lineHeightOffset), false);
    dv.setUint16(76, Math.max(0, dv.getUint16(76, false) + lineHeightOffset), false);
  }
  return c;
}

function modifyHhea(d, lineHeightOffset) {
  if (!lineHeightOffset) return d;
  if (!d || d.length < 10) return d;
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  dv.setInt16(4, dv.getInt16(4, false) + lineHeightOffset, false);
  dv.setInt16(6, dv.getInt16(6, false) - lineHeightOffset, false);
  dv.setInt16(8, dv.getInt16(8, false) + lineHeightOffset, false);
  return c;
}

function modifyHead(d, sizeOffset) {
  if (!d || d.length < 20) return d;
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  dv.setUint32(8, 0, false);
  if (sizeOffset) {
    const cur = dv.getUint16(18, false);
    dv.setUint16(18, Math.max(16, cur - sizeOffset), false);
  }
  return c;
}

const WEIGHT_KW = {
  ultralight:'ultralight', extralight:'ultralight',
  thin:'thin', light:'light',
  regular:'regular', 'default':'regular',
  medium:'medium',
  semibold:'semibold', demibold:'semibold',
  bold:'bold',
  heavy:'heavy', extrabold:'heavy', ultrabold:'heavy', black:'heavy',
};
const FALLBACK = {
  ultralight:['thin','light','regular'],
  thin:['ultralight','light','regular'],
  light:['thin','regular','ultralight'],
  regular:['medium','light','thin'],
  medium:['regular','semibold','light'],
  semibold:['bold','medium','heavy','regular'],
  bold:['semibold','heavy','medium','regular'],
  heavy:['bold','semibold','medium','regular'],
};

function classifyWeight(sub) {
  const s = sub.toLowerCase();
  for (const [kw, cat] of Object.entries(WEIGHT_KW)) {
    if (s.includes(kw)) return cat;
  }
  return 'regular';
}

function pickSource(sources, targetWeight, mode) {
  let mappedWeight = 'regular';
  if (mode === 'single') {
    mappedWeight = 'regular';
  } else if (mode === 'dual') {
    if (['medium', 'semibold', 'bold', 'heavy'].includes(targetWeight)) {
      mappedWeight = 'medium';
    } else {
      mappedWeight = 'regular';
    }
  } else if (mode === 'triple') {
    if (['medium', 'semibold', 'bold', 'heavy'].includes(targetWeight)) {
      mappedWeight = 'bold';
    } else if (['ultralight', 'thin', 'light'].includes(targetWeight)) {
      mappedWeight = 'light';
    } else {
      mappedWeight = 'regular';
    }
  }
  if (sources.has(mappedWeight)) return sources.get(mappedWeight);
  if (sources.has('regular')) return sources.get('regular');
  return sources.values().next().value;
}

function loadSource(buf) {
  const sources = new Map();
  let metaLogged = false;
  if (isTTC(buf)) {
    const ttc = parseTTC(buf);
    log('info', `  TTC 包含 ${ttc.numFonts} 个子字体`);
    const hasPub = ttc.offsets.some(off => {
      const s = parseSFNT(buf, off);
      const nr = s.tables.find(t => t.tag === 'name');
      if (!nr) return false;
      return !getFamily(sliceTable(buf, nr)).startsWith('.');
    });
    for (const offset of ttc.offsets) {
      const sfnt = parseSFNT(buf, offset);
      const nameRec = sfnt.tables.find(t => t.tag === 'name');
      if (!nameRec) continue;
      const nd = sliceTable(buf, nameRec);
      const fam = getFamily(nd);
      if (hasPub && fam.startsWith('.')) continue;
      if (!metaLogged) {
        const info = getNameInfo(nd);
        if (info.family) log('info', `  字体名称: ${info.family}`);
        if (info.designer) log('info', `  设计师: ${info.designer}`);
        if (info.version) log('info', `  版本: ${info.version}`);
        if (info.copyright) log('info', `  版权: ${info.copyright.substring(0, 80)}`);
        metaLogged = true;
      }
      const cat = classifyWeight(getSubfamily(nd));
      if (!sources.has(cat)) {
        sources.set(cat, {
          sfVersion: sfnt.sfVersion,
          tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
        });
      }
    }
  } else {
    const sfnt = parseSFNT(buf, 0);
    const nameRec = sfnt.tables.find(t => t.tag === 'name');
    if (nameRec) {
      const nd = sliceTable(buf, nameRec);
      const info = getNameInfo(nd);
      if (info.family) log('info', `  字体名称: ${info.family}`);
      if (info.subfamily) log('info', `  子族: ${info.subfamily}`);
      if (info.designer) log('info', `  设计师: ${info.designer}`);
      if (info.version) log('info', `  版本: ${info.version}`);
      if (info.copyright) log('info', `  版权: ${info.copyright.substring(0, 80)}`);
    }
    const fontData = {
      sfVersion: sfnt.sfVersion,
      tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
    };
    for (const w of ['ultralight','thin','light','regular','medium','semibold','bold','heavy'])
      sources.set(w, fontData);
  }
  return sources;
}

function buildTTC(fonts) {
  const pool = [];
  const refMap = new Map();

  function getPoolIdx(data) {
    if (refMap.has(data)) return refMap.get(data);
    const idx = pool.length;
    pool.push(data);
    refMap.set(data, idx);
    return idx;
  }

  const fontRefs = fonts.map(f => ({
    sfVersion: f.sfVersion,
    tables: f.tables.map(t => ({
      tag: t.tag, poolIdx: getPoolIdx(t.data), length: t.data.length,
    })).sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  }));

  const numFonts = fonts.length;
  const ttcHdrSize = 12 + 4 * numFonts;
  let off = ttcHdrSize;
  const dirOffsets = [];
  for (const fr of fontRefs) {
    dirOffsets.push(off);
    off += 12 + 16 * fr.tables.length;
  }
  off = align4(off);
  const poolOffsets = [];
  for (const d of pool) {
    poolOffsets.push(off);
    off += align4(d.length);
  }
  const totalSize = off;

  const result = new ArrayBuffer(totalSize);
  const dv = new DataView(result);
  const bytes = new Uint8Array(result);

  writeTag(dv, 0, 'ttcf');
  writeU16(dv, 4, 2);
  writeU16(dv, 6, 0);
  writeU32(dv, 8, numFonts);
  for (let i = 0; i < numFonts; i++) writeU32(dv, 12 + i * 4, dirOffsets[i]);

  const poolChecksums = pool.map(d => calcChecksum(d));

  for (let fi = 0; fi < numFonts; fi++) {
    const fr = fontRefs[fi];
    const o = dirOffsets[fi];
    const nt = fr.tables.length;
    writeU32(dv, o, fr.sfVersion);
    writeU16(dv, o + 4, nt);
    let p2 = 1, lg = 0;
    while (p2 * 2 <= nt) { p2 *= 2; lg++; }
    writeU16(dv, o + 6, p2 * 16);
    writeU16(dv, o + 8, lg);
    writeU16(dv, o + 10, nt * 16 - p2 * 16);
    for (let ti = 0; ti < nt; ti++) {
      const t = fr.tables[ti];
      const r = o + 12 + ti * 16;
      writeTag(dv, r, t.tag);
      writeU32(dv, r + 4, poolChecksums[t.poolIdx]);
      writeU32(dv, r + 8, poolOffsets[t.poolIdx]);
      writeU32(dv, r + 12, t.length);
    }
  }

  for (let i = 0; i < pool.length; i++) bytes.set(pool[i], poolOffsets[i]);
  return result;
}

function buildSFNT(font) {
  const nt = font.tables.length;
  const sorted = font.tables.slice().sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
  let off = 12 + 16 * nt;
  const tableOffsets = [];
  for (const t of sorted) {
    tableOffsets.push(off);
    off += align4(t.data.length);
  }
  const buf = new ArrayBuffer(off);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  writeU32(dv, 0, font.sfVersion);
  writeU16(dv, 4, nt);
  let p2 = 1, lg = 0;
  while (p2 * 2 <= nt) { p2 *= 2; lg++; }
  writeU16(dv, 6, p2 * 16);
  writeU16(dv, 8, lg);
  writeU16(dv, 10, nt * 16 - p2 * 16);
  for (let i = 0; i < nt; i++) {
    const r = 12 + i * 16;
    writeTag(dv, r, sorted[i].tag);
    writeU32(dv, r + 4, calcChecksum(sorted[i].data));
    writeU32(dv, r + 8, tableOffsets[i]);
    writeU32(dv, r + 12, sorted[i].data.length);
  }
  for (let i = 0; i < nt; i++) bytes.set(sorted[i].data, tableOffsets[i]);
  const headIdx = sorted.findIndex(t => t.tag === 'head');
  if (headIdx >= 0) {
    const ho = tableOffsets[headIdx];
    dv.setUint32(ho + 8, 0, false);
    const headLen = sorted[headIdx].data.length;
    writeU32(dv, 12 + headIdx * 16 + 4, calcChecksum(new Uint8Array(buf, ho, headLen)));
    const total = calcChecksum(new Uint8Array(buf));
    dv.setUint32(ho + 8, (0xB1B0AFBA - total) >>> 0, false);
  }
  return buf;
}

function convertOne(sources, mode, offsets) {
  log('info', `  映射配置: ${mode}, 开始组装数据结构...`);
  const wOff = offsets?.weightOffset || 0;
  const sOff = offsets?.sizeOffset || 0;
  const lOff = offsets?.lineHeightOffset || 0;
  if (wOff || sOff || lOff) {
    log('info', `  应用偏移: 粗细${wOff>=0?'+':''}${wOff}, 大小${sOff>=0?'+':''}${sOff}, 行距${lOff>=0?'+':''}${lOff}`);
  }
  const fonts = [];
  const os2Cache = new Map();
  const hheaCache = new Map();
  const headCache = new Map();
  for (let i = 0; i < TEMPLATES.length; i++) {
    const tpl = TEMPLATES[i];
    const nameData = base64ToUint8Array(tpl.nameB64);
    const src = pickSource(sources, tpl.subfamily.toLowerCase(), mode);
    const srcId = src.tables.length;
    const tables = [];
    for (const t of src.tables) {
      if (t.tag === 'name') {
        tables.push({ tag: 'name', data: nameData });
      } else if (t.tag === 'OS/2') {
        const w = Math.max(1, tpl.weightClass + wOff);
        const key = `${srcId}:${w}:${tpl.fsType}:${lOff}`;
        if (!os2Cache.has(key)) os2Cache.set(key, modifyOS2(t.data, w, tpl.fsType, lOff));
        tables.push({ tag: 'OS/2', data: os2Cache.get(key) });
      } else if (t.tag === 'hhea' && lOff) {
        const key = `${srcId}:hhea:${lOff}`;
        if (!hheaCache.has(key)) hheaCache.set(key, modifyHhea(t.data, lOff));
        tables.push({ tag: 'hhea', data: hheaCache.get(key) });
      } else if (t.tag === 'head') {
        const key = `${srcId}:head:${sOff}`;
        if (!headCache.has(key)) headCache.set(key, modifyHead(t.data, sOff));
        tables.push({ tag: 'head', data: headCache.get(key) });
      } else {
        tables.push({ tag: t.tag, data: t.data });
      }
    }
    if (!src.tables.some(t => t.tag === 'name')) {
      tables.push({ tag: 'name', data: nameData });
    }
    fonts.push({ sfVersion: src.sfVersion, tables });
    if ((i + 1) % 50 === 0) log('info', `  构建变体进度: ${Math.floor((i + 1) / TEMPLATES.length * 100)}% ...`);
  }
  return fonts;
}

function convertToTTC(fonts) {
  log('info', `  执行二进制打包 (引用级查重优化)...`);
  return buildTTC(fonts);
}

function convertToTTFs(fonts) {
  log('info', `  拆分为独立 TTF 文件 (${fonts.length} 个)...`);
  return fonts;
}

function applyTemplate(tpl, fontName) {
  return tpl.replace(/\$\{fontName\}/g, fontName);
}

self.onmessage = function(e) {
  const { type } = e.data;
  if (type === 'convert') {
    try {
      const { srcFiles, mode, compatLayer, outputFormat, outputTemplate, offsets } = e.data;
      const isLegacy = compatLayer === 'ios9';
      const isTTF = outputFormat === 'ttf';
      const fams = new Set();
      for (const t of TEMPLATES) fams.add(t.family);
      log('info', `环境就绪: 覆盖 ${fams.size} 个字体族`);
      log('info', `兼容层: ${isLegacy ? 'iOS 9-17' : 'iOS 18-26'} | 输出: ${isTTF ? 'TTF' : 'TTC'}`);

      const total = srcFiles.length;
      for (let si = 0; si < total; si++) {
        const { name, buffer } = srcFiles[si];
        const safeName = desensitize(name);
        log('step', `[${si + 1}/${total}] 正在处理: ${safeName}`);

        const sources = loadSource(buffer);
        log('info', `  检测到字重: ${[...sources.keys()].join(', ')}`);

        const firstSrc = sources.values().next().value;
        if (firstSrc && si === 0) {
          const metrics = readFontMetrics(firstSrc.tables);
          log('info', `  源字体参数: 粗细=${metrics.usWeightClass}, EM=${metrics.unitsPerEm}, 上沿=${metrics.sTypoAscender}, 下沿=${metrics.sTypoDescender}, 行间距=${metrics.sTypoLineGap}`);
          self.postMessage({ type: 'fontMetrics', metrics });
        }

        const stem = name.replace(/\.[^.]+$/, '');
        const outStem = applyTemplate(outputTemplate || '${fontName}UI', stem);

        if (isTTF) {
          const wOff = offsets?.weightOffset || 0;
          const sOff = offsets?.sizeOffset || 0;
          const lOff = offsets?.lineHeightOffset || 0;
          const seen = new Set();
          const uniqueSrcs = [];
          for (const [k, v] of sources) { if (!seen.has(v)) { seen.add(v); uniqueSrcs.push({ key: k, src: v }); } }
          for (let ui = 0; ui < uniqueSrcs.length; ui++) {
            const { src } = uniqueSrcs[ui];
            const tables = src.tables.map(t => {
              if (t.tag === 'OS/2') {
                const od = new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength);
                const ow = od.getUint16(4, false);
                const of2 = od.getUint16(8, false);
                return { tag: 'OS/2', data: modifyOS2(t.data, Math.max(1, ow + wOff), of2, lOff) };
              }
              if (t.tag === 'hhea') return { tag: 'hhea', data: modifyHhea(t.data, lOff) };
              if (t.tag === 'head' && sOff) return { tag: 'head', data: modifyHead(t.data, sOff) };
              return t;
            });
            const result = buildSFNT({ sfVersion: src.sfVersion, tables });
            const suffix = uniqueSrcs.length > 1 ? `_${uniqueSrcs[ui].key}` : '';
            const outName = outStem + suffix + '.ttf';
            const sizeMB = (result.byteLength / 1048576).toFixed(1);
            log('ok', `  输出: ${desensitize(outName)} (${sizeMB} MB)`);
            self.postMessage({ type: 'result', name: outName, buffer: result }, [result]);
          }
          log('ok', `  TTF 修改完成: ${uniqueSrcs.length} 个文件`);
        } else {
          const fonts = convertOne(sources, mode, offsets);
          const result = convertToTTC(fonts);
          const outName = outStem + '.ttc';
          const sizeMB = (result.byteLength / 1048576).toFixed(1);
          log('ok', `  封装成功: ${desensitize(outName)} (${sizeMB} MB)`);
          self.postMessage({ type: 'result', name: outName, buffer: result }, [result]);
        }
        self.postMessage({ type: 'progress', current: si + 1, total });
      }

      log('ok', `全部完成: ${total} 个字体已转换`);
      self.postMessage({ type: 'done' });
    } catch (err) {
      log('err', `错误: ${err.message}`);
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

function log(level, text) {
  self.postMessage({ type: 'log', level, text });
}

function desensitize(name) {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1];
}
