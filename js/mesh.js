/* ===== mesh.js ===== */
// ============================================================
// Sky Mesh Viewer —— .mesh 解析模块
// ============================================================

/* ===================== 工具 ===================== */
function halfToFloat(h) {
  const sign = (h >> 15) & 1;
  let exp = (h >> 10) & 0x1f;
  let mant = h & 0x3ff;
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    while ((mant & 0x400) === 0) { mant <<= 1; exp--; }
    exp++; mant &= 0x3ff;
  } else if (exp === 31) return mant ? NaN : (sign ? -Infinity : Infinity);
  const bits = (sign << 31) | ((exp + 112) << 23) | (mant << 13);
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = bits >>> 0;
  return new Float32Array(buf)[0];
}
function baseName(path) {
  const s = path.replace(/\\/g, '/');
  const b = s.substring(s.lastIndexOf('/') + 1);
  const d = b.lastIndexOf('.');
  return d >= 0 ? b.substring(0, d) : b;
}

/* ===================== LZ4 块解压 ===================== */
function lz4Decompress(src, expectedMax) {
  if (!src || src.length === 0) return new Uint8Array(0);
  const maxOut = Math.min(expectedMax > 0 ? expectedMax : 0xC00000, 128 * 1024 * 1024);
  let out = new Uint8Array(Math.min(maxOut, Math.max(src.length * 4, 1024)));
  let outLen = 0, i = 0;
  const n = src.length;
  const grow = (need) => {
    let ns = Math.min(Math.max(out.length * 2, need), maxOut);
    if (ns <= out.length) ns = Math.min(need, maxOut);
    const na = new Uint8Array(ns); na.set(out.subarray(0, outLen)); out = na;
  };
  while (i < n) {
    const token = src[i++];
    let litLen = token >> 4;
    if (litLen === 15) { let s; do { s = src[i++]; litLen += s; } while (s === 255 && i < n); }
    if (outLen + litLen > out.length) grow(outLen + litLen);
    // grow 受 maxOut 上限约束仍不足时，out.set 会抛 RangeError；截断退出
    if (outLen + litLen > out.length) break;
    if (i + litLen > n) break;
    out.set(src.subarray(i, i + litLen), outLen);
    i += litLen; outLen += litLen;
    if (i >= n) break;
    if (i + 2 > n) break;
    const offset = src[i] | (src[i + 1] << 8); i += 2;
    if (offset === 0 || offset > outLen) break;
    let matchLen = (token & 0x0F) + 4;
    if ((token & 0x0F) === 15) { let s; do { s = src[i++]; matchLen += s; } while (s === 255 && i < n); }
    if (outLen + matchLen > out.length) grow(outLen + matchLen);
    // grow 受 maxOut 上限约束，可能仍不够：此时若继续写会越界(静默丢弃)并让 outLen 虚高，返回损坏数据。截断退出更安全。
    if (outLen + matchLen > out.length) break;
    let start = outLen - offset;
    for (let k = 0; k < matchLen; k++) out[outLen + k] = out[start + k];
    outLen += matchLen;
    if (outLen > maxOut) break;
  }
  return out.subarray(0, outLen);
}

/* ===================== .mesh 解析 ===================== */
function readMesh(buffer, filename) {
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (raw.length < 4) throw new Error('文件太小');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = dv.getInt32(0, true);
  const nameNoExt = baseName(filename);
  switch (version) {
    case 0x17: case 0x18: return parseLegacy17(raw, nameNoExt, version, filename);
    case 0x19: case 0x1A: case 0x1B: return parseLegacy1A(raw, nameNoExt, version, filename);
    case 0x1C: case 0x1D: return parseLegacy1C(raw, nameNoExt, version, filename);
    case 0x1E: return parseLegacy1E(raw, nameNoExt, version, filename);
    case 0x1F: case 0x20: return parseModern(raw, nameNoExt, version, filename);
    default: throw new Error('不支持的 mesh 版本: 0x' + version.toString(16));
  }
}

/* 扫描头部区域找合法的 LZ4 载荷签名 [1,cs,us]：解压后长度精确匹配 us 且解压内容以相同版本号开头 */
function findMeshPayload(raw, from, version) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const end = Math.min(raw.length - 12, from + 0x2000);
  for (let pos = from; pos < end; pos++) {
    if (dv.getInt32(pos, true) !== 1) continue;
    const cs = dv.getInt32(pos + 4, true);
    const us = dv.getInt32(pos + 8, true);
    if (cs <= 0 || us <= 0 || pos + 12 + cs > raw.length || us > 4 * 1024 * 1024) continue;
    try {
      const src = raw.subarray(pos + 12, pos + 12 + cs);
      const dest = lz4Decompress(src, us);
      if (dest.length !== us) continue;
      return pos;
    } catch (e) { /* 继续扫 */ }
  }
  return -1;
}

function parseModern(raw, name, version, filename) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 0x58) throw new Error('文件太小');
  const animated = dv.getUint8(0x48) !== 0;
  let payloadOffset = (version >= 0x20) ? 0x4e : 0x4a;
  let isCompressed = dv.getInt32(payloadOffset, true);
  let cs = dv.getInt32(payloadOffset + 4, true);
  let us = dv.getInt32(payloadOffset + 8, true);
  // 新版部分网格（如带 Capestar 标记表的斗篷）头部有附加变长记录，标准偏移处不是载荷。扫描头部区域找合法的 [1,cs,us] LZ4 载荷签名。
  if (cs <= 0 || us <= 0 || payloadOffset + 12 + cs > raw.length) {
    const found = findMeshPayload(raw, payloadOffset, version);
    if (found < 0) throw new Error('压缩数据边界无效');
    payloadOffset = found;
    isCompressed = dv.getInt32(payloadOffset, true);
    cs = dv.getInt32(payloadOffset + 4, true);
    us = dv.getInt32(payloadOffset + 8, true);
  }
  const src = raw.subarray(payloadOffset + 12, payloadOffset + 12 + cs);
  const dest = isCompressed !== 0 ? lz4Decompress(src, us) : src;
  // 文件末尾（LZ4 载荷之后）是未压缩的嵌入式骨架数据
  const skelStart = payloadOffset + 12 + cs;
  const embeddedSkeletonRaw = skelStart < raw.length ? raw.subarray(skelStart) : new Uint8Array(0);

  const d = new DataView(dest.buffer, dest.byteOffset, dest.byteLength);
  const u8 = dest;
  let p = 4;
  const vec3 = (o) => [d.getFloat32(o, true), d.getFloat32(o + 4, true), d.getFloat32(o + 8, true)];
  const aabbA = vec3(p); p += 12;
  const aabbB = vec3(p); p += 12;
  const aabbA2 = vec3(p); p += 12;
  const aabbB2 = vec3(p); p += 12;
  const quantMin = []; for (let i = 0; i < 8; i++) { quantMin.push(d.getFloat32(p, true)); p += 4; }
  const quantMax = []; for (let i = 0; i < 8; i++) { quantMax.push(d.getFloat32(p, true)); p += 4; }
  const sharedVertices = d.getUint32(p, true); p += 4;
  const totalVertices = d.getUint32(p, true); p += 4;
  const isIdx32 = d.getUint32(p, true) !== 0; p += 4;
  const numPoints = d.getUint32(p, true); p += 4;
  const prop11 = d.getUint32(p, true); p += 4;
  const prop12 = d.getUint32(p, true); p += 4;
  const prop13 = d.getUint32(p, true); p += 4;
  const prop14 = d.getUint32(p, true); p += 4;
  const loadMeshNorms = d.getUint8(p) !== 0; p += 1;
  const loadInfo2 = d.getUint8(p) !== 0; p += 1;
  p += 1;
  const skipMeshPos = d.getUint32(p, true); p += 4;
  const skipUvs = d.getUint32(p, true); p += 4;
  const flag3 = d.getUint32(p, true); p += 4;
  p += 0x10;

  const faceCount = Math.floor(totalVertices / 3);
  const idxUnit = isIdx32 ? 4 : 2;
  const verts = [], uvs = [];
  // 多套 UV（仅 16B/vert 精确 UV 段才有）：uv1=光照/AO 图坐标，uv3=第二层色(渐变带)坐标。
  // 真实 MeshSh 用 uv1 采 u_lightTex、uv3 采 u_diffuse2Tex；离线复现门的颜色+光影需要它们。
  const uvs1 = [], uvs3 = [];

  if (skipMeshPos === 0) {
    for (let i = 0; i < sharedVertices; i++) {
      const off = p + i * 16;
      verts.push(d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true));
    }
    p += sharedVertices * 16;
  }
  // 原生法线段：每顶点 4 字节打包法线 (xyz snorm8 + 1)
  let norms = null;
  if (loadMeshNorms) {
    norms = new Float32Array(sharedVertices * 3);
    for (let i = 0; i < sharedVertices; i++) {
      const off = p + i * 4;
      let nx = (u8[off] << 24 >> 24) / 127;
      let ny = (u8[off + 1] << 24 >> 24) / 127;
      let nz = (u8[off + 2] << 24 >> 24) / 127;
      const len = Math.hypot(nx, ny, nz) || 1;
      norms[i*3] = nx/len; norms[i*3+1] = ny/len; norms[i*3+2] = nz/len;
    }
    p += sharedVertices * 4;
  }

  if (skipUvs === 0) {
    // 每顶点 16B = 4 套 half UV：uv0(主漫反射) uv1(光照/AO) uv2(未用) uv3(第二层色)
    for (let i = 0; i < sharedVertices; i++) {
      const base = p + i * 16;
      uvs.push(halfToFloat(d.getUint16(base, true)), halfToFloat(d.getUint16(base + 2, true)));
      uvs1.push(halfToFloat(d.getUint16(base + 4, true)), halfToFloat(d.getUint16(base + 6, true)));
      uvs3.push(halfToFloat(d.getUint16(base + 12, true)), halfToFloat(d.getUint16(base + 14, true)));
    }
    p += sharedVertices * 16;
  }
  // 骨骼权重表：每顶点 8 字节 = 4×boneIndex(u8) + 4×weight(u8)
  // 对齐参考 TgcMeshReader：真实骨骼索引 = bi-1（存储时+1），权重 = wi/255。
  // 保存为逐顶点 4 通道，供 GPU 蒙皮用（boneIndices + boneWeights 几何属性）。
  let weightedVertices = 0;
  let boneIndices = null, boneWeights = null;
  if (animated) {
    boneIndices = new Float32Array(sharedVertices * 4);
    boneWeights = new Float32Array(sharedVertices * 4);
    for (let i = 0; i < sharedVertices; i++) {
      const off = p + i * 8;
      let has = false;
      for (let j = 0; j < 4; j++) {
        const bi = u8[off + j], wi = u8[off + 4 + j];
        if (bi > 0 && wi > 0) {
          boneIndices[i*4 + j] = bi - 1;
          boneWeights[i*4 + j] = wi / 255;
          has = true;
        }
      }
      if (has) weightedVertices++;
    }
    p += sharedVertices * 8;
  }

  const indices = new Uint32Array(faceCount * 3);
  for (let i = 0; i < faceCount; i++) {
    if (isIdx32) {
      indices[i*3]=d.getInt32(p,true); indices[i*3+1]=d.getInt32(p+4,true); indices[i*3+2]=d.getInt32(p+8,true); p += 12;
    } else {
      indices[i*3]=d.getUint16(p,true); indices[i*3+1]=d.getUint16(p+2,true); indices[i*3+2]=d.getUint16(p+4,true); p += 6;
    }
  }
  if (loadInfo2) p += totalVertices * idxUnit;
  if (numPoints > 0) p += sharedVertices * idxUnit;
  if (prop11 > 0) p += sharedVertices * idxUnit;
  if (prop12 > 0) p += prop12 * idxUnit;
  if (prop13 > 0) p += prop13 * 4;
  if (prop14 > 0) p += prop14 * (isIdx32 ? 8 : 4);
  p += faceCount * 4;

  if (skipMeshPos > 0) {
    const ax = aabbA2[0], ay = aabbA2[1], az = aabbA2[2];
    const sx = aabbB2[0] - ax, sy = aabbB2[1] - ay, sz = aabbB2[2] - az;
    for (let i = 0; i < sharedVertices; i++) {
      const packed = d.getUint32(p + i * 4, true);
      const qz = packed & 0x3ff, qy = (packed >>> 10) & 0x3ff, qx = (packed >>> 20) & 0x3ff;
      verts.push(ax + (qx / 1023) * sx, ay + (qy / 1023) * sy, az + (qz / 1023) * sz);
    }
    p += sharedVertices * 4; p += sharedVertices;
  }
  if (skipUvs > 0) {
    const uMinU = quantMin[0], uMinV = quantMin[1], uSzU = quantMax[0] - uMinU, uSzV = quantMax[1] - uMinV;
    for (let i = 0; i < sharedVertices; i++) {
      const off = p + i * 4;
      const uHi = u8[off], vHi = u8[off+1], uLo = u8[off+2], vLo = u8[off+3];
      const uN = ((uHi<<8)|uLo)/65535, vN = ((vHi<<8)|vLo)/65535;
      uvs.push(uMinU + uN*uSzU, uMinV + vN*uSzV);
    }
    p += sharedVertices * 4;
  }

  const skeletonBones = (animated && embeddedSkeletonRaw.length >= 85)
    ? tryParseSkeleton(embeddedSkeletonRaw) : null;

  return {
    name, version, animated,
    vertices: new Float32Array(verts),
    uvs: uvs.length ? new Float32Array(uvs) : null,
    uvs1: uvs1.length ? new Float32Array(uvs1) : null,
    uvs3: uvs3.length ? new Float32Array(uvs3) : null,
    normals: norms,
    indices,
    weightedVertices,
    boneIndices,
    boneWeights,
    skeletonBones,
    boneCount: skeletonBones ? skeletonBones.length : 0
  };
}

/* ===================== 嵌入式骨架解析 ===================== */
function tryParseSkeleton(raw) {
  try { return parseSkeleton(raw); } catch (e) { return null; }
}
function parseSkeleton(raw) {
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let p = 0;
  p += 4;   // 跳过首个 uint32
  p += 64;
  const numBones = d.getUint32(p, true); p += 4;
  p += 4; p += 4; p += 4; p += 1;
  if (numBones <= 0 || numBones > 4096) return null;
  const bones = [];
  for (let i = 0; i < numBones; i++) {
    // 名称：64 字节定长，null 结尾，ASCII
    let len = 64;
    for (let k = 0; k < 64; k++) { if (raw[p + k] === 0) { len = k; break; } }
    let nm = '';
    for (let k = 0; k < len; k++) nm += String.fromCharCode(raw[p + k]);
    p += 64;
    const mat = new Float32Array(16);
    for (let j = 0; j < 16; j++) mat[j] = d.getFloat32(p + j * 4, true);
    p += 64;
    const parent1 = d.getUint32(p, true); p += 4;
    bones.push({ name: nm, parent: parent1 > 0 ? parent1 - 1 : -1, matrix: mat });
  }
  return bones;
}

/* ===================== .animpack 解析（骨骼动画） =====================
 * 逐行移植自参考 _skyviewer_ref/AnimPackParser.java。
 * 结构：Header(80B) → 压缩信息 → 骨骼记录(132B×N) → 动画段(refSQT? + LZ4 压缩clip)
 *       clip = clipHeader(5/6×u32) + SQT列表(40B×N) + 关键帧数据
 * SQT 磁盘布局 40B：scale(vec3 12B) + rot(quat 16B) + trans(vec3 12B)
 */
const ANIM_HEADER_SIZE = 80, ANIM_NAME_FIELD = 64, ANIM_BONE_REC = 132, ANIM_SQT_DISK = 40;

function animReadFixedString(u8, off, maxLen) {
  let end = Math.min(off + maxLen, u8.length), len = maxLen;
  for (let i = off; i < end; i++) { if (u8[i] === 0) { len = i - off; break; } }
  if (off + len > end) len = end - off;
  let s = '';
  for (let k = 0; k < len; k++) s += String.fromCharCode(u8[off + k]);
  return s;
}
function animParseSQT(d, off) {
  return {
    scale: [d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true)],
    rotation: [d.getFloat32(off + 12, true), d.getFloat32(off + 16, true), d.getFloat32(off + 20, true), d.getFloat32(off + 24, true)],
    translation: [d.getFloat32(off + 28, true), d.getFloat32(off + 32, true), d.getFloat32(off + 36, true)]
  };
}
function animReadVec3(d, off) { return [d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true)]; }
function animReadQuat(d, off) { return [d.getFloat32(off, true), d.getFloat32(off + 4, true), d.getFloat32(off + 8, true), d.getFloat32(off + 12, true)]; }

function parseAnimPack(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < ANIM_HEADER_SIZE) throw new Error('animpack 太小');
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ap = { bones: [], segments: [] };
  ap.fileSize = u8.length;
  ap.version = d.getInt32(0x00, true);
  ap.name = animReadFixedString(u8, 0x04, ANIM_NAME_FIELD);
  ap.boneCount = d.getInt32(0x44, true);
  ap.boneDefsFlag = d.getInt32(0x48, true);
  ap.refSqtFlag = d.getInt32(0x4C, true);
  let boneAreaOffset;
  if (ap.version >= 10) {
    ap.compression = u8[0x50];
    ap.nameTableSize = d.getInt32(0x51, true);
    boneAreaOffset = 0x55;
  } else {
    ap.compression = 0; ap.nameTableSize = 0; boneAreaOffset = 0x50;
  }
  for (let i = 0; i < ap.boneCount; i++) {
    const base = boneAreaOffset + i * ANIM_BONE_REC;
    if (base + ANIM_BONE_REC > u8.length) break;
    const name = animReadFixedString(u8, base, ANIM_NAME_FIELD);
    const matrix = new Float32Array(16);
    for (let j = 0; j < 16; j++) matrix[j] = d.getFloat32(base + 64 + j * 4, true);
    const rawParent = d.getInt32(base + 128, true);
    ap.bones.push({ index: i, name, matrix, parentIndex: rawParent > 0 ? rawParent - 1 : -1 });
  }
  ap.animOffset = boneAreaOffset + ap.boneCount * ANIM_BONE_REC;
  ap.segments = parseAnimSegments(u8, d, ap.animOffset, ap.boneCount, ap.version, ap.refSqtFlag, ap.boneDefsFlag, ap.compression);
  return ap;
}

function parseAnimSegments(u8, d, startOffset, boneCount, version, refSqtFlag, boneDefsFlag, compression) {
  const segments = [];
  let offset = startOffset, segIdx = 0;
  while (offset < u8.length) {
    const seg = { index: segIdx, sqtList: [], decompressionError: '' };
    if (refSqtFlag > 0 && boneDefsFlag > 0) {
      const sqtEnd = offset + boneCount * ANIM_SQT_DISK;
      if (sqtEnd > u8.length) break;
      for (let i = 0; i < boneCount; i++) seg.sqtList.push(animParseSQT(d, offset + i * ANIM_SQT_DISK));
      offset = sqtEnd;
    }
    if (compression > 0) {
      if (offset + 8 > u8.length) break;
      const totalSize = d.getUint32(offset, true);
      const decompSize = d.getUint32(offset + 4, true);
      const compStart = offset + 8;
      if (totalSize === 0 || compStart + totalSize > u8.length) break;
      seg.compressedSize = totalSize; seg.decompressedSize = decompSize;
      try {
        const decomp = lz4Decompress(u8.subarray(compStart, compStart + totalSize), decompSize);
        if (decomp && decomp.length > 0) seg.clipData = parseClipData(decomp, boneCount, version);
      } catch (e) { seg.decompressionError = String(e); }
      segments.push(seg); segIdx++;
      offset = compStart + totalSize;
    } else {
      const remaining = u8.length - offset;
      const clipHeaderSize = (version >= 10 ? 6 : 5) * 4;
      if (remaining < clipHeaderSize + boneCount * ANIM_SQT_DISK) break;
      const inlineData = u8.slice(offset, offset + remaining);
      seg.compressedSize = remaining; seg.decompressedSize = remaining;
      seg.clipData = parseClipData(inlineData, boneCount, version);
      segments.push(seg); break;
    }
  }
  return segments;
}

function parseClipData(dArr, boneCount, version) {
  const u8 = dArr instanceof Uint8Array ? dArr : new Uint8Array(dArr);
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const clip = { sqtList: [], rawBytes: u8 };
  const u32Count = version >= 10 ? 6 : 5;
  const headerSize = u32Count * 4;
  if (u8.length < headerSize) return clip;
  clip.header = [];
  for (let i = 0; i < u32Count; i++) clip.header.push(d.getUint32(i * 4, true));
  let pos = headerSize;
  for (let i = 0; i < boneCount; i++) {
    if (pos + ANIM_SQT_DISK > u8.length) break;
    clip.sqtList.push(animParseSQT(d, pos));
    pos += ANIM_SQT_DISK;
  }
  return clip;
}

function animNormalizeQuat(q) {
  const mag = q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3];
  if (mag > 1e-10) { const inv = 1 / Math.sqrt(mag); q[0]*=inv; q[1]*=inv; q[2]*=inv; q[3]*=inv; }
}
function animDecodeI16Quat(d, pos) {
  return [
    (d.getUint16(pos, true) - 32768) / 32767,
    (d.getUint16(pos + 2, true) - 32768) / 32767,
    (d.getUint16(pos + 4, true) - 32768) / 32767,
    (d.getUint16(pos + 6, true) - 32768) / 32767
  ];
}
function animDecodeI16Trans(d, pos, e1, e2) {
  return [
    e1[0] + (d.getUint16(pos, true) / 65535) * e2[0],
    e1[1] + (d.getUint16(pos + 2, true) / 65535) * e2[1],
    e1[2] + (d.getUint16(pos + 4, true) / 65535) * e2[2]
  ];
}
// 关键帧两趟解码：第一趟求帧范围，第二趟填充 frameData[boneCount*frameCount*10]（NaN=未设置）
function decodeAnimation(ap) {
  if (!ap || !ap.segments || !ap.segments.length) return null;
  const seg = ap.segments[0];
  if (!seg.clipData || !seg.clipData.rawBytes) return null;
  const u8 = seg.clipData.rawBytes;
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const bc = ap.boneCount, comp = ap.compression, version = ap.version;
  const res = { boneCount: bc, baseSqt: seg.clipData.sqtList, minFrame: 0, maxFrame: 0, frameCount: 0, frameData: null, hasAnimation: false };
  const u32Count = version >= 10 ? 6 : 5;
  const headerSize = u32Count * 4;
  const sqtSize = bc * ANIM_SQT_DISK;
  const pos0 = headerSize + sqtSize;
  if (pos0 >= u8.length) return res;
  const numSets = (seg.clipData.header && seg.clipData.header.length) ? seg.clipData.header[0] : 0;
  if (numSets === 0) return res;

  // 第一趟：帧范围
  let scanOff = 0;
  const scanRemaining = u8.length - pos0;
  res.minFrame = Infinity; res.maxFrame = -Infinity;
  let anySub = false;
  for (let si = 0; si < numSets; si++) {
    if (scanOff + 12 > scanRemaining) break;
    const f1 = d.getUint32(pos0 + scanOff, true); scanOff += 4;
    const f2 = d.getUint32(pos0 + scanOff, true); scanOff += 4;
    const flags = d.getUint32(pos0 + scanOff, true); scanOff += 4;
    if (f1 < res.minFrame) res.minFrame = f1;
    if (f2 > res.maxFrame) res.maxFrame = f2;
    let skip = 0;
    if (version > 8) skip += 24;
    if (version >= 11) skip += 24;
    scanOff += skip;
    if (scanOff + bc > scanRemaining) break;
    let s2c = 0, q2c = 0, t2c = 0, sc = 0, qc = 0, tc = 0;
    for (let bi = 0; bi < bc; bi++) {
      const f = u8[pos0 + scanOff + bi];
      if (f & 0x08) sc++; if (f & 0x10) qc++; if (f & 0x20) tc++;
      if (f & 0x01) s2c++; if (f & 0x02) q2c++; if (f & 0x04) t2c++;
    }
    scanOff += bc;
    if (q2c || t2c || s2c) anySub = true;
    const useI16Trans = (comp === 2) && ((flags & 1) !== 0);
    const quatSz = (comp === 2) ? 8 : 16;
    const transSz = useI16Trans ? 6 : 12;
    const scaleSz = 12;
    const fc = (f2 >= f1) ? (f2 - f1 + 1) : 1;
    const mainSz = sc * scaleSz + qc * quatSz + tc * transSz;
    const subSz = s2c * scaleSz + q2c * quatSz + t2c * transSz;
    scanOff += mainSz + fc * subSz;
  }
  if (res.minFrame === Infinity) return res;
  res.frameCount = res.maxFrame - res.minFrame + 1;
  if (res.frameCount <= 0) res.frameCount = 1;
  res.hasAnimation = anySub;
  res.frameData = new Float32Array(bc * res.frameCount * 10).fill(NaN);

  const setFrame = (frameIdx, boneIdx, sc, q, t) => {
    if (frameIdx < 0 || frameIdx >= res.frameCount || boneIdx < 0 || boneIdx >= bc) return;
    const b = (boneIdx * res.frameCount + frameIdx) * 10;
    if (b + 10 > res.frameData.length) return;
    if (sc) { res.frameData[b] = sc[0]; res.frameData[b+1] = sc[1]; res.frameData[b+2] = sc[2]; }
    if (q) { res.frameData[b+3] = q[0]; res.frameData[b+4] = q[1]; res.frameData[b+5] = q[2]; res.frameData[b+6] = q[3]; }
    if (t) { res.frameData[b+7] = t[0]; res.frameData[b+8] = t[1]; res.frameData[b+9] = t[2]; }
  };

  // 第二趟：解码填充
  let off = 0;
  const remaining = u8.length - pos0;
  for (let si = 0; si < numSets; si++) {
    if (off + 12 > remaining) break;
    const f1 = d.getUint32(pos0 + off, true); off += 4;
    const f2 = d.getUint32(pos0 + off, true); off += 4;
    const flags = d.getUint32(pos0 + off, true); off += 4;
    let e1 = [0,0,0], e2 = [0,0,0];
    if (version > 8) { if (off + 24 > remaining) break; off += 24; }
    if (version >= 11) { if (off + 24 > remaining) break; e1 = animReadVec3(d, pos0 + off); off += 12; e2 = animReadVec3(d, pos0 + off); off += 12; }
    if (off + bc > remaining) break;
    const pbf = new Uint8Array(bc);
    for (let k = 0; k < bc; k++) pbf[k] = u8[pos0 + off + k];
    off += bc;
    const fc = (f2 >= f1) ? (f2 - f1 + 1) : 1;
    const useI16Trans = (comp === 2) && ((flags & 1) !== 0);
    const quatSz = (comp === 2) ? 8 : 16;
    const transSz = useI16Trans ? 6 : 12;
    const scaleSz = 12;
    let mainFrameIdx = f1 - res.minFrame; if (mainFrameIdx < 0) mainFrameIdx = 0;
    // 主通道（读1次，存于 f1）
    for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x08)) continue; if (off + scaleSz > remaining) break; setFrame(mainFrameIdx, bi, animReadVec3(d, pos0 + off), null, null); off += scaleSz; }
    for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x10)) continue; if (off + quatSz > remaining) break; let q = comp === 2 ? animDecodeI16Quat(d, pos0 + off) : animReadQuat(d, pos0 + off); animNormalizeQuat(q); off += quatSz; setFrame(mainFrameIdx, bi, null, q, null); }
    for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x20)) continue; if (off + transSz > remaining) break; let t = useI16Trans ? animDecodeI16Trans(d, pos0 + off, e1, e2) : animReadVec3(d, pos0 + off); off += transSz; setFrame(mainFrameIdx, bi, null, null, t); }
    // 子通道（读 fc 次，存于 f1..f2）
    for (let fi = 0; fi < fc; fi++) {
      const frameIdx = (f1 + fi) - res.minFrame;
      const outOfRange = frameIdx < 0 || frameIdx >= res.frameCount;
      for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x01)) continue; if (off + scaleSz > remaining) break; const v = animReadVec3(d, pos0 + off); off += scaleSz; if (!outOfRange) setFrame(frameIdx, bi, v, null, null); }
      for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x02)) continue; if (off + quatSz > remaining) break; let q = comp === 2 ? animDecodeI16Quat(d, pos0 + off) : animReadQuat(d, pos0 + off); animNormalizeQuat(q); off += quatSz; if (!outOfRange) setFrame(frameIdx, bi, null, q, null); }
      for (let bi = 0; bi < bc; bi++) { if (!(pbf[bi] & 0x04)) continue; if (off + transSz > remaining) break; let t = useI16Trans ? animDecodeI16Trans(d, pos0 + off, e1, e2) : animReadVec3(d, pos0 + off); off += transSz; if (!outOfRange) setFrame(frameIdx, bi, null, null, t); }
    }
  }
  return res;
}

// 取 clip 基础姿势 SQT（动画基准帧，非绑定 T-pose）
function animGetBoneSqtList(ap) {
  if (ap.segments && ap.segments.length) {
    const seg = ap.segments[0];
    if (seg.clipData && seg.clipData.sqtList && seg.clipData.sqtList.length) return seg.clipData.sqtList;
    if (seg.sqtList && seg.sqtList.length) return seg.sqtList;
  }
  const r = []; for (let i = 0; i < ap.boneCount; i++) r.push({ scale:[1,1,1], rotation:[0,0,0,1], translation:[0,0,0] }); return r;
}
// 骨名匹配：去 Rig: 前缀 + 后缀匹配
function animNormalizeBoneName(name) {
  if (!name) return '';
  if (name.startsWith('Rig:') || name.startsWith('rig:')) return name.substring(4);
  return name;
}
function animBoneNamesMatch(meshName, animName) {
  if (!meshName || !animName) return false;
  if (meshName === animName) return true;
  const nm = animNormalizeBoneName(meshName), na = animNormalizeBoneName(animName);
  if (nm === na) return true;
  if (animName.endsWith(meshName) && meshName.length) return true;
  if (meshName.endsWith(animName) && animName.length) return true;
  return false;
}

function readHalfDV(d, o) { return halfToFloat(d.getUint16(o, true)); }

function parseLegacy17(raw, name, version, filename) {
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const isStrip = filename.includes('StripAnim');
  let vip, iip, vs;
  if (isStrip) { vip = 0x4061; iip = 0x4065; vs = 0x408D; }
  else {
    let p01 = -1;
    for (let i = 0; i < raw.length; i++) { if (raw[i] === 1) { p01 = i; break; } }
    if (p01 === -1) throw new Error('v17: 未找到标记');
    vip = p01 + 45; iip = 0x75; vs = 0x9D;
  }
  const vnum = d.getInt32(vip, true), inum = d.getInt32(iip, true);
  if (vnum <= 0 || inum <= 0) throw new Error('v17: 计数无效');
  const verts = [], uvs = [];
  for (let i = 0; i < vnum; i++) { const o = vs + i*16; verts.push(d.getFloat32(o,true),d.getFloat32(o+4,true),d.getFloat32(o+8,true)); }
  const vbufLen = vnum*16, gap = vbufLen/4, us = vs+vbufLen+gap;
  for (let i = 0; i < vnum; i++) { const o = us+i*16; uvs.push(readHalfDV(d,o),readHalfDV(d,o+2)); }
  const idxS = isStrip ? (us+vbufLen+vnum*8) : (us+vbufLen);
  const indices = new Uint32Array(Math.floor(inum/3)*3);
  for (let i = 0; i < inum/3; i++) { const o = idxS+i*12; indices[i*3]=d.getInt32(o,true);indices[i*3+1]=d.getInt32(o+4,true);indices[i*3+2]=d.getInt32(o+8,true); }
  return { name, version, animated:isStrip, vertices:new Float32Array(verts), uvs:new Float32Array(uvs), indices };
}
function parseLegacy1A(raw, name, version, filename) {
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const vco=0x66, ico=0x6A, vs=0x92;
  const vnum=d.getInt32(vco,true), inum=d.getInt32(ico,true);
  if (vnum<=0||inum<=0) throw new Error('v1A: 计数无效');
  const verts=[],uvs=[];
  for(let i=0;i<vnum;i++){const o=vs+i*16;verts.push(d.getFloat32(o,true),d.getFloat32(o+4,true),d.getFloat32(o+8,true));}
  const vbufLen=vnum*16,gap=vbufLen/4,us=vs+vbufLen+gap;
  for(let i=0;i<vnum;i++){const o=us+i*16;uvs.push(readHalfDV(d,o),readHalfDV(d,o+2));}
  const fnl=filename.toLowerCase();
  const isSp=(fnl.includes('anim')||fnl.includes('anc'))&&!fnl.includes('ancestor');
  const idxS=us+vbufLen+(isSp?vnum*8:0);
  const indices=new Uint32Array(Math.floor(inum/3)*3);
  for(let i=0;i<inum/3;i++){const o=idxS+i*12;indices[i*3]=d.getInt32(o,true);indices[i*3+1]=d.getInt32(o+4,true);indices[i*3+2]=d.getInt32(o+8,true);}
  return {name,version,animated:isSp,vertices:new Float32Array(verts),uvs:new Float32Array(uvs),indices};
}
function parseLegacy1C(raw, name, version, filename) {
  const d0=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const cs=d0.getInt32(0x4E,true),us0=d0.getInt32(0x52,true);
  if(cs<=0||us0<=0||0x56+cs>raw.length) throw new Error('v1C: LZ4 边界无效');
  const comp=raw.subarray(0x56,0x56+cs);
  const dr=lz4Decompress(comp,us0);
  const d=new DataView(dr.buffer,dr.byteOffset,dr.byteLength);
  const vco=0x34,ico=0x38,vs=0x60;
  const vnum=d.getInt32(vco,true),inum=d.getInt32(ico,true);
  if(vnum<=0||inum<=0) throw new Error('v1C: 计数无效');
  const verts=[],uvs=[];
  for(let i=0;i<vnum;i++){const o=vs+i*16;verts.push(d.getFloat32(o,true),d.getFloat32(o+4,true),d.getFloat32(o+8,true));}
  const vbufLen=vnum*16,gap=vbufLen/4,usS=vs+vbufLen+gap;
  for(let i=0;i<vnum;i++){const o=usS+i*16;uvs.push(readHalfDV(d,o),readHalfDV(d,o+2));}
  const fnl=filename.toLowerCase();
  const isSp=(fnl.includes('anim')||fnl.includes('anc'))&&!fnl.includes('ancestor');
  const idxS=usS+vbufLen+(isSp?vnum*8:0);
  const indices=new Uint32Array(Math.floor(inum/3)*3);
  for(let i=0;i<inum/3;i++){const o=idxS+i*12;indices[i*3]=d.getInt32(o,true);indices[i*3+1]=d.getInt32(o+4,true);indices[i*3+2]=d.getInt32(o+8,true);}
  return {name,version,animated:isSp,vertices:new Float32Array(verts),uvs:new Float32Array(uvs),indices};
}
function parseLegacy1E(raw, name, version, filename) {
  const d0=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const cs=d0.getInt32(0x4E,true),us0=d0.getInt32(0x52,true);
  if(cs<=0||us0<=0||0x56+cs>raw.length) throw new Error('v1E: LZ4 边界无效');
  const comp=raw.subarray(0x56,0x56+cs);
  const dr=lz4Decompress(comp,us0);
  const d=new DataView(dr.buffer,dr.byteOffset,dr.byteLength);
  const vnum=d.getInt32(0x74,true),inum=d.getInt32(0x78,true);
  if(vnum<=0||inum<=0) throw new Error('v1E: 计数无效');
  const vs=0xB3,vbufLen=vnum*16;
  const verts=[],uvs=[];
  for(let i=0;i<vnum;i++){const o=vs+i*16;verts.push(d.getFloat32(o,true),d.getFloat32(o+4,true),d.getFloat32(o+8,true));}
  const fnl=filename.toLowerCase();
  const isSp=fnl.includes('anim')||(fnl.includes('anc')&&!fnl.includes('ancestor'));
  let usS,uvsz,idxS;
  if(isSp){const gap=vbufLen/4;usS=vs+vbufLen+gap;uvsz=vbufLen;idxS=usS+uvsz+vnum*8;}
  else{const gap=vnum*4-4;usS=vs+vbufLen+gap;uvsz=vnum*16;idxS=usS+uvsz+4;}
  for(let i=0;i<vnum;i++){const o=usS+i*16;uvs.push(readHalfDV(d,o+4),readHalfDV(d,o+6));}
  const indices=new Uint32Array(Math.floor(inum/3)*3);
  for(let i=0;i<inum/3;i++){const o=idxS+i*6;indices[i*3]=d.getUint16(o,true);indices[i*3+1]=d.getUint16(o+2,true);indices[i*3+2]=d.getUint16(o+4,true);}
  return {name,version,animated:isSp,vertices:new Float32Array(verts),uvs:new Float32Array(uvs),indices};
}


