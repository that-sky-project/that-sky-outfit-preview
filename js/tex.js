/* ===== tex.js ===== */
// ============================================================
// Sky Mesh Viewer —— 纹理模块 (KTX + ETC2 软解码)
// 纯 JS 将 ETC2/EAC 压缩纹理解码为 RGBA8，供 Three.js DataTexture 使用
// 参考 Khronos ETC2 规范 (OpenGL ES 3.0)
// ============================================================

/* ---------- ETC1/ETC2 查表 ---------- */
// 亮度修正表 (ETC1)
const ETC1_MODIFIER = [
  [2, 8, -2, -8],
  [5, 17, -5, -17],
  [9, 29, -9, -29],
  [13, 42, -13, -42],
  [18, 60, -18, -60],
  [24, 80, -24, -80],
  [33, 106, -33, -106],
  [47, 183, -47, -183]
];
// ETC2 distance 表 (T/H 模式)
const ETC2_DISTANCE = [3, 6, 11, 16, 23, 32, 41, 64];
// EAC alpha 修正表
const EAC_MODIFIER = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8]
];

function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
function extend4to8(c) { return (c << 4) | c; }
function extend5to8(c) { return (c << 3) | (c >> 2); }

/* ---------- ETC2 RGB 块解码（8字节 → 4x4 RGBA） ---------- */
// out: Uint8Array(width*height*4), bx/by: 块坐标
function decodeEtc2RgbBlock(dv, off, out, width, height, bx, by, alphaBlock) {
  // 读高低 32 位（大端）
  const bhi = dv.getUint32(off, false);
  const blo = dv.getUint32(off + 4, false);

  const r = (bhi >>> 27) & 0x1f, dr = (bhi << 5 >> 29); // 有符号 3 位（下方另算）
  // 重新按位取，避免符号处理错误
  const R = (bhi >>> 27) & 0x1f;
  const dR = signed3((bhi >>> 24) & 0x07);
  const G = (bhi >>> 19) & 0x1f;
  const dG = signed3((bhi >>> 16) & 0x07);
  const B = (bhi >>> 11) & 0x1f;
  const dB = signed3((bhi >>> 8) & 0x07);

  const diffbit = (bhi >>> 1) & 1;
  const flipbit = bhi & 1;

  let pixels; // 16 个 [r,g,b]
  if (diffbit === 0) {
    // individual 模式判定要看差分溢出，否则可能是 T/H/Planar
    pixels = decodeIndividual(bhi, blo, flipbit);
  } else {
    // 检查差分溢出 → T / H / Planar 模式
    const r5 = R + dR, g5 = G + dG, b5 = B + dB;
    if (r5 < 0 || r5 > 31) {
      pixels = decodeT(bhi, blo);
    } else if (g5 < 0 || g5 > 31) {
      pixels = decodeH(bhi, blo);
    } else if (b5 < 0 || b5 > 31) {
      pixels = decodePlanar(bhi, blo);
    } else {
      pixels = decodeDifferential(bhi, blo, flipbit);
    }
  }

  // 写入输出（ETC 块内像素顺序：列优先，x*4+y）
  for (let i = 0; i < 16; i++) {
    const px = bx * 4 + (i >> 2);
    const py = by * 4 + (i & 3);
    if (px >= width || py >= height) continue;
    const o = (py * width + px) * 4;
    out[o] = pixels[i][0];
    out[o + 1] = pixels[i][1];
    out[o + 2] = pixels[i][2];
    out[o + 3] = 255;
  }
}

function signed3(v) { return v >= 4 ? v - 8 : v; }

function pixelIndex(blo, i) {
  // 索引：msb 在 bit(16+i)，lsb 在 bit(i)
  const lsb = (blo >>> i) & 1;
  const msb = (blo >>> (16 + i)) & 1;
  return (msb << 1) | lsb;
}

function decodeIndividual(bhi, blo, flip) {
  const r1 = extend4to8((bhi >>> 28) & 0x0f), r2 = extend4to8((bhi >>> 24) & 0x0f);
  const g1 = extend4to8((bhi >>> 20) & 0x0f), g2 = extend4to8((bhi >>> 16) & 0x0f);
  const b1 = extend4to8((bhi >>> 12) & 0x0f), b2 = extend4to8((bhi >>> 8) & 0x0f);
  const t1 = (bhi >>> 5) & 0x07, t2 = (bhi >>> 2) & 0x07;
  return assembleEtc1([r1, g1, b1], [r2, g2, b2], t1, t2, flip, blo);
}
function decodeDifferential(bhi, blo, flip) {
  const R = (bhi >>> 27) & 0x1f, dR = signed3((bhi >>> 24) & 0x07);
  const G = (bhi >>> 19) & 0x1f, dG = signed3((bhi >>> 16) & 0x07);
  const B = (bhi >>> 11) & 0x1f, dB = signed3((bhi >>> 8) & 0x07);
  const c1 = [extend5to8(R), extend5to8(G), extend5to8(B)];
  const c2 = [extend5to8(R + dR), extend5to8(G + dG), extend5to8(B + dB)];
  const t1 = (bhi >>> 5) & 0x07, t2 = (bhi >>> 2) & 0x07;
  return assembleEtc1(c1, c2, t1, t2, flip, blo);
}
function assembleEtc1(c1, c2, t1, t2, flip, blo) {
  const px = new Array(16);
  for (let i = 0; i < 16; i++) {
    const x = i >> 2, y = i & 3;
    let sub;
    if (flip === 0) sub = x < 2 ? 0 : 1; // 左右分块
    else sub = y < 2 ? 0 : 1;            // 上下分块
    const base = sub === 0 ? c1 : c2;
    const tbl = sub === 0 ? t1 : t2;
    const idx = pixelIndex(blo, i);
    const mod = ETC1_MODIFIER[tbl][idx];
    px[i] = [clamp255(base[0] + mod), clamp255(base[1] + mod), clamp255(base[2] + mod)];
  }
  return px;
}
function decodeT(bhi, blo) {
  // T 模式：两个颜色 c0,c1（4位/通道），distance
  const r0a = (bhi >>> 27) & 0x03, r0b = (bhi >>> 24) & 0x03;
  let R0 = (r0a << 2) | r0b;
  const G0 = (bhi >>> 20) & 0x0f, B0 = (bhi >>> 16) & 0x0f;
  const R1 = (bhi >>> 12) & 0x0f, G1 = (bhi >>> 8) & 0x0f, B1 = (bhi >>> 4) & 0x0f;
  const da = (bhi >>> 2) & 0x03, db = (bhi >>> 0) & 0x01;
  const dist = ETC2_DISTANCE[(da << 1) | db];
  const c0 = [extend4to8(R0), extend4to8(G0), extend4to8(B0)];
  const c1 = [extend4to8(R1), extend4to8(G1), extend4to8(B1)];
  const paint = [
    c0,
    [clamp255(c1[0] + dist), clamp255(c1[1] + dist), clamp255(c1[2] + dist)],
    c1,
    [clamp255(c1[0] - dist), clamp255(c1[1] - dist), clamp255(c1[2] - dist)]
  ];
  const px = new Array(16);
  for (let i = 0; i < 16; i++) px[i] = paint[pixelIndex(blo, i)];
  return px;
}
function decodeH(bhi, blo) {
  const R0 = (bhi >>> 27) & 0x0f, G0a = (bhi >>> 24) & 0x07, G0b = (bhi >>> 20) & 0x01;
  const G0 = (G0a << 1) | G0b;
  const B0a = (bhi >>> 19) & 0x01, B0b = (bhi >>> 15) & 0x07;
  const B0 = (B0a << 3) | B0b;
  const R1 = (bhi >>> 11) & 0x0f, G1 = (bhi >>> 7) & 0x0f, B1a = (bhi >>> 3) & 0x0f;
  const B1 = B1a;
  const c0 = [extend4to8(R0), extend4to8(G0), extend4to8(B0)];
  const c1 = [extend4to8(R1), extend4to8(G1), extend4to8(B1)];
  const v0 = (c0[0] << 16) | (c0[1] << 8) | c0[2];
  const v1 = (c1[0] << 16) | (c1[1] << 8) | c1[2];
  const da = (bhi >>> 2) & 0x01, db = (bhi >>> 0) & 0x01;
  let dIdx = (da << 2) | (db << 1) | (v0 >= v1 ? 1 : 0);
  const dist = ETC2_DISTANCE[dIdx & 0x07];
  const paint = [
    [clamp255(c0[0] + dist), clamp255(c0[1] + dist), clamp255(c0[2] + dist)],
    [clamp255(c0[0] - dist), clamp255(c0[1] - dist), clamp255(c0[2] - dist)],
    [clamp255(c1[0] + dist), clamp255(c1[1] + dist), clamp255(c1[2] + dist)],
    [clamp255(c1[0] - dist), clamp255(c1[1] - dist), clamp255(c1[2] - dist)]
  ];
  const px = new Array(16);
  for (let i = 0; i < 16; i++) px[i] = paint[pixelIndex(blo, i)];
  return px;
}
function decodePlanar(bhi, blo) {
  const R0 = (bhi >>> 25) & 0x3f;
  const G0a = (bhi >>> 24) & 0x01, G0b = (bhi >>> 17) & 0x3f;
  const G0 = (G0a << 6) | G0b;
  const B0a = (bhi >>> 16) & 0x01, B0b = (bhi >>> 11) & 0x07, B0c = (bhi >>> 7) & 0x07;
  const B0 = (B0a << 5) | (B0b << 2) | B0c;
  const RH1 = (bhi >>> 2) & 0x1f, RH0 = (bhi >>> 0) & 0x01;
  const RH = (RH1 << 1) | RH0;
  const GH = (blo >>> 25) & 0x7f;
  const BH = (blo >>> 19) & 0x3f;
  const RV = (blo >>> 13) & 0x3f;
  const GV = (blo >>> 6) & 0x7f;
  const BV = (blo >>> 0) & 0x3f;
  const ro = ext6(R0), go = ext7(G0), bo = ext6(B0);
  const rh = ext6(RH), gh = ext7(GH), bh = ext6(BH);
  const rv = ext6(RV), gv = ext7(GV), bv = ext6(BV);
  const px = new Array(16);
  for (let i = 0; i < 16; i++) {
    const x = i >> 2, y = i & 3;
    px[i] = [
      clamp255((x * (rh - ro) + y * (rv - ro) + 4 * ro + 2) >> 2),
      clamp255((x * (gh - go) + y * (gv - go) + 4 * go + 2) >> 2),
      clamp255((x * (bh - bo) + y * (bv - bo) + 4 * bo + 2) >> 2)
    ];
  }
  return px;
}
function ext6(c) { return (c << 2) | (c >> 4); }
function ext7(c) { return (c << 1) | (c >> 6); }

/* ---------- EAC alpha 块解码（8字节 → 16 个 alpha） ---------- */
function decodeEacBlock(dv, off) {
  const base = dv.getUint8(off);
  const mulTbl = dv.getUint8(off + 1);
  const mult = (mulTbl >>> 4) & 0x0f;
  const tblIdx = mulTbl & 0x0f;
  // 48 位索引：拆成高 24 位(bit24..47)+低 24 位(bit0..23)，避开 BigInt（BigInt 移位极慢，
  // 整张图集上百万次会明显卡主线程）。每像素取 3 位不跨越 24 位边界，可安全用 Number 位运算。
  const hi = (dv.getUint8(off + 2) << 16) | (dv.getUint8(off + 3) << 8) | dv.getUint8(off + 4);
  const lo = (dv.getUint8(off + 5) << 16) | (dv.getUint8(off + 6) << 8) | dv.getUint8(off + 7);
  const alpha = new Array(16);
  const tbl = EAC_MODIFIER[tblIdx];
  const m = mult === 0 ? 1 : mult;
  for (let i = 0; i < 16; i++) {
    // 像素顺序同 ETC：列优先
    const shift = 45 - i * 3;
    const idx = shift >= 24 ? ((hi >>> (shift - 24)) & 0x07) : ((lo >>> shift) & 0x07);
    alpha[i] = clamp255(base + tbl[idx] * m);
  }
  return alpha;
}

/* ---------- KTX 解析 + 解码为 RGBA ---------- */
const KTX_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x31, 0x31, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
// ETC2 内部格式常量
const GL_ETC2_RGB = 0x9274, GL_ETC2_SRGB = 0x9275;
const GL_ETC2_RGBA = 0x9278, GL_ETC2_SRGBA = 0x9279; // RGBA8 + EAC alpha
// ASTC 内部格式 -> block 尺寸 + 是否 sRGB（iOS 包用；0x93bx=LDR 线性, 0x93dx=sRGB）
const ASTC_FORMAT_TABLE = {
  0x93b0: { bw: 4, bh: 4, srgb: false },  // RGBA_ASTC_4x4
  0x93b4: { bw: 6, bh: 6, srgb: false },  // RGBA_ASTC_6x6
  0x93d0: { bw: 4, bh: 4, srgb: true },   // SRGB8_ALPHA8_ASTC_4x4
  0x93d4: { bw: 6, bh: 6, srgb: true },   // SRGB8_ALPHA8_ASTC_6x6
};

/* ---------- ASTC LDR 软解码器（iOS 包纹理为 ASTC，安卓为 ETC2） ----------
 * 移植自 tex-decoder(纯 JS，源出 Ishotihadus/mikunyan astc.c)。包进 IIFE 隔离作用域，
 * 只暴露 astcDecode(src,width,height,bw,bh) -> Uint8Array(RGBA)。仅需 LDR 4x4/6x6，但算法通用。
 */
const astcDecode = (function () {
  function clamp(n, l, h) { return n <= l ? l : n >= h ? h : n; }
  function color(r, g, b, a) { return (((a & 0xFF) << 24) | ((b & 0xFF) << 16) | ((g & 0xFF) << 8) | (r & 0xFF)) >>> 0; }
  function fp16_ieee_to_fp32_value(h) {
    const sign = (h & 0x8000) >> 15, exponent = (h & 0x7C00) >> 10, fraction = h & 0x03FF;
    if (exponent === 0) return (sign === 0 ? 1 : -1) * Math.pow(2, -14) * (fraction / 0x0400);
    else if (exponent === 0x1F) return fraction === 0 ? (sign === 0 ? Infinity : -Infinity) : NaN;
    return (sign === 0 ? 1 : -1) * Math.pow(2, exponent - 15) * (1 + fraction / 0x0400);
  }
  const BIT_REVERSE_TABLE = new Uint8Array([
    0x00,0x80,0x40,0xC0,0x20,0xA0,0x60,0xE0,0x10,0x90,0x50,0xD0,0x30,0xB0,0x70,0xF0,
    0x08,0x88,0x48,0xC8,0x28,0xA8,0x68,0xE8,0x18,0x98,0x58,0xD8,0x38,0xB8,0x78,0xF8,
    0x04,0x84,0x44,0xC4,0x24,0xA4,0x64,0xE4,0x14,0x94,0x54,0xD4,0x34,0xB4,0x74,0xF4,
    0x0C,0x8C,0x4C,0xCC,0x2C,0xAC,0x6C,0xEC,0x1C,0x9C,0x5C,0xDC,0x3C,0xBC,0x7C,0xFC,
    0x02,0x82,0x42,0xC2,0x22,0xA2,0x62,0xE2,0x12,0x92,0x52,0xD2,0x32,0xB2,0x72,0xF2,
    0x0A,0x8A,0x4A,0xCA,0x2A,0xAA,0x6A,0xEA,0x1A,0x9A,0x5A,0xDA,0x3A,0xBA,0x7A,0xFA,
    0x06,0x86,0x46,0xC6,0x26,0xA6,0x66,0xE6,0x16,0x96,0x56,0xD6,0x36,0xB6,0x76,0xF6,
    0x0E,0x8E,0x4E,0xCE,0x2E,0xAE,0x6E,0xEE,0x1E,0x9E,0x5E,0xDE,0x3E,0xBE,0x7E,0xFE,
    0x01,0x81,0x41,0xC1,0x21,0xA1,0x61,0xE1,0x11,0x91,0x51,0xD1,0x31,0xB1,0x71,0xF1,
    0x09,0x89,0x49,0xC9,0x29,0xA9,0x69,0xE9,0x19,0x99,0x59,0xD9,0x39,0xB9,0x79,0xF9,
    0x05,0x85,0x45,0xC5,0x25,0xA5,0x65,0xE5,0x15,0x95,0x55,0xD5,0x35,0xB5,0x75,0xF5,
    0x0D,0x8D,0x4D,0xCD,0x2D,0xAD,0x6D,0xED,0x1D,0x9D,0x5D,0xDD,0x3D,0xBD,0x7D,0xFD,
    0x03,0x83,0x43,0xC3,0x23,0xA3,0x63,0xE3,0x13,0x93,0x53,0xD3,0x33,0xB3,0x73,0xF3,
    0x0B,0x8B,0x4B,0xCB,0x2B,0xAB,0x6B,0xEB,0x1B,0x9B,0x5B,0xDB,0x3B,0xBB,0x7B,0xFB,
    0x07,0x87,0x47,0xC7,0x27,0xA7,0x67,0xE7,0x17,0x97,0x57,0xD7,0x37,0xB7,0x77,0xF7,
    0x0F,0x8F,0x4F,0xCF,0x2F,0xAF,0x6F,0xEF,0x1F,0x9F,0x5F,0xDF,0x3F,0xBF,0x7F,0xFF]);
  const WEIGHT_PREC_TABLE_A = new Int32Array([0,0,0,3,0,5,3,0,0,0,5,3,0,5,3,0]);
  const WEIGHT_PREC_TABLE_B = new Int32Array([0,0,1,0,2,0,1,3,0,0,1,2,4,2,3,5]);
  const CEM_TABLE_A = new Int32Array([0,3,5,0,3,5,0,3,5,0,3,5,0,3,5,0,3,0,0]);
  const CEM_TABLE_B = new Int32Array([8,6,5,7,5,4,6,4,3,5,3,2,4,2,1,3,1,2,1]);
  function bit_reverse_u8(c, bits) { const x = BIT_REVERSE_TABLE[c] >>> (8 - bits); return x !== 0 ? x : 0; }
  function bit_reverse_u64(d, bits) {
    const ret = BigInt(BIT_REVERSE_TABLE[Number(d & 0xffn)]) << 56n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 8n) & 0xffn)]) << 48n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 16n) & 0xffn)]) << 40n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 24n) & 0xffn)]) << 32n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 32n) & 0xffn)]) << 24n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 40n) & 0xffn)]) << 16n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 48n) & 0xffn)]) << 8n |
      BigInt(BIT_REVERSE_TABLE[Number((d >> 56n) & 0xffn)]);
    return ret >> (64n - BigInt(bits));
  }
  function u8ptr_to_u16(ptr) { return ((ptr[1] << 8) | ptr[0]) & 0xFFFF; }
  function bit_transfer_signed_alt(v, a, b) {
    v[b] = (v[b] >> 1) | (v[a] & 0x80); v[a] = (v[a] >> 1) & 0x3f;
    if ((v[a] & 0x20) != 0) v[a] -= 0x40;
  }
  function set_endpoint(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=r1;e[1]=g1;e[2]=b1;e[3]=a1;e[4]=r2;e[5]=g2;e[6]=b2;e[7]=a2; }
  function set_endpoint_clamp(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=clamp(r1,0,255);e[1]=clamp(g1,0,255);e[2]=clamp(b1,0,255);e[3]=clamp(a1,0,255);e[4]=clamp(r2,0,255);e[5]=clamp(g2,0,255);e[6]=clamp(b2,0,255);e[7]=clamp(a2,0,255); }
  function set_endpoint_blue(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=(r1+b1)>>1;e[1]=(g1+b1)>>1;e[2]=b1;e[3]=a1;e[4]=(r2+b2)>>1;e[5]=(g2+b2)>>1;e[6]=b2;e[7]=a2; }
  function set_endpoint_blue_clamp(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=clamp((r1+b1)>>1,0,255);e[1]=clamp((g1+b1)>>1,0,255);e[2]=clamp(b1,0,255);e[3]=clamp(a1,0,255);e[4]=clamp((r2+b2)>>1,0,255);e[5]=clamp((g2+b2)>>1,0,255);e[6]=clamp(b2,0,255);e[7]=clamp(a2,0,255); }
  function set_endpoint_hdr(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=r1;e[1]=g1;e[2]=b1;e[3]=a1;e[4]=r2;e[5]=g2;e[6]=b2;e[7]=a2; }
  function set_endpoint_hdr_clamp(e, r1,g1,b1,a1,r2,g2,b2,a2) { e[0]=clamp(r1,0,0xfff);e[1]=clamp(g1,0,0xfff);e[2]=clamp(b1,0,0xfff);e[3]=clamp(a1,0,0xfff);e[4]=clamp(r2,0,0xfff);e[5]=clamp(g2,0,0xfff);e[6]=clamp(b2,0,0xfff);e[7]=clamp(a2,0,0xfff); }
  function select_color(v0, v1, weight) { return Math.floor(((((v0<<8|v0)*(64-weight)+(v1<<8|v1)*weight+32)>>6)*255+32768)/65536) & 0xFF; }
  function select_color_hdr(v0, v1, weight) {
    let c = (((v0<<4)*(64-weight)+(v1<<4)*weight+32)>>6) & 0xFFFF;
    let m = new Uint16Array([(c & 0x7ff)]);
    if (m[0] < 512) m[0] *= 3; else if (m[0] < 1536) m[0] = 4*m[0]-512; else m[0] = 5*m[0]-2048;
    let f = fp16_ieee_to_fp32_value((c >> 1 & 0x7c00) | m[0] >> 3);
    return Number.isFinite(f) ? clamp(Math.round(f*255.0),0,255) : 255;
  }
  function f32_to_u8(f) { return clamp(Math.round(f*255.0),0.0,255.0); }
  function f16ptr_to_u8(ptr) { return f32_to_u8(fp16_ieee_to_fp32_value(((ptr[1]<<8)|ptr[0])) & 0xFFFF); }
  function getbits64(buf, bit, len) {
    let value = 0n, off_in_bits = bit;
    for (let i = 0; i < len;) {
      const bitOffset = off_in_bits & 7, currentByte = buf[off_in_bits >> 3];
      const read = Math.min(len - i, 8 - bitOffset), mask = ~(0xFF << read);
      value |= BigInt((currentByte >> bitOffset) & mask) << BigInt(i);
      off_in_bits += read; i += read;
    }
    return value;
  }
  function getbits(buf, bitOffset, numBits) {
    let value = 0, off_in_bits = bitOffset;
    for (let i = 0; i < numBits;) {
      const bo = off_in_bits & 7, currentByte = buf[off_in_bits >> 3];
      const read = Math.min(numBits - i, 8 - bo), mask = ~(0xFF << read);
      value |= ((currentByte >> bo) & mask) << i;
      off_in_bits += read; i += read;
    }
    return value >>> 0;
  }
  function BlockDataDefault() {
    return { bw:0,bh:0,width:0,height:0,part_num:0,dual_plane:false,plane_selector:0,weight_range:0,weight_num:0,
      cem:new Int32Array(4),cem_range:0,endpoint_value_num:0,
      endpoints:Array.from({length:4},()=>new Int32Array(8)),
      weights:Array.from({length:144},()=>new Int32Array(2)),
      partition:new Int32Array(144) };
  }
  const ASTC_TRITS_TABLE = [
    new Int32Array([0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,0,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,1,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,0,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,1,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2,0,1,2,0,0,1,2,1,0,1,2,2,0,1,2,2]),
    new Int32Array([0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,0,0,0,0,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,1,1,1,0,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,2,2,2,0,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,2,2,2,0,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,0,0,0,1,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,1,1,1,1,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,2,2,2,1,0,0,0,0,1,1,1,0,2,2,2,0,2,2,2,0,0,0,0,1,1,1,1,1,2,2,2,1,2,2,2,1]),
    new Int32Array([0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,2,2,2,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,1,1,1,2,0,0,0,2,0,0,0,2,0,0,0,2,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,2,2,2,2]),
    new Int32Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2]),
    new Int32Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2])
  ];
  const ASTC_QUINTS_TABLE = [
    new Int32Array([0,1,2,3,4,0,4,4,0,1,2,3,4,1,4,4,0,1,2,3,4,2,4,4,0,1,2,3,4,3,4,4,0,1,2,3,4,0,4,0,0,1,2,3,4,1,4,1,0,1,2,3,4,2,4,2,0,1,2,3,4,3,4,3,0,1,2,3,4,0,2,3,0,1,2,3,4,1,2,3,0,1,2,3,4,2,2,3,0,1,2,3,4,3,2,3,0,1,2,3,4,0,0,1,0,1,2,3,4,1,0,1,0,1,2,3,4,2,0,1,0,1,2,3,4,3,0,1]),
    new Int32Array([0,0,0,0,0,4,4,4,1,1,1,1,1,4,4,4,2,2,2,2,2,4,4,4,3,3,3,3,3,4,4,4,0,0,0,0,0,4,0,4,1,1,1,1,1,4,1,4,2,2,2,2,2,4,2,4,3,3,3,3,3,4,3,4,0,0,0,0,0,4,0,0,1,1,1,1,1,4,1,1,2,2,2,2,2,4,2,2,3,3,3,3,3,4,3,3,0,0,0,0,0,4,0,0,1,1,1,1,1,4,1,1,2,2,2,2,2,4,2,2,3,3,3,3,3,4,3,3]),
    new Int32Array([0,0,0,0,0,0,0,4,0,0,0,0,0,0,1,4,0,0,0,0,0,0,2,4,0,0,0,0,0,0,3,4,1,1,1,1,1,1,4,4,1,1,1,1,1,1,4,4,1,1,1,1,1,1,4,4,1,1,1,1,1,1,4,4,2,2,2,2,2,2,4,4,2,2,2,2,2,2,4,4,2,2,2,2,2,2,4,4,2,2,2,2,2,2,4,4,3,3,3,3,3,3,4,4,3,3,3,3,3,3,4,4,3,3,3,3,3,3,4,4,3,3,3,3,3,3,4,4])
  ];
  function decode_intseq(buf, offset, a, b, count, reverse, out) {
    const MT = new Int32Array([0,2,4,5,7]);
    const MQ = new Int32Array([0,3,5]);
    const TRITS_TABLE = ASTC_TRITS_TABLE;
    const QUINTS_TABLE = ASTC_QUINTS_TABLE;
    if (count <= 0) return;
    let n = 0;
    if (a == 3) {
      const mask = (1 << b) - 1;
      const block_count = Math.floor((count + 4) / 5);
      const last_block_count = (count + 4) % 5 + 1;
      const block_size = 8 + 5 * b;
      const last_block_size = Math.floor((block_size * last_block_count + 4) / 5);
      if (reverse) {
        for (let i = 0, p = offset; i < block_count; i++, p -= block_size) {
          const now_size = (i < block_count - 1) ? block_size : last_block_size;
          const d = bit_reverse_u64(getbits64(buf, p - now_size, now_size), now_size);
          const x = (d >> BigInt(b) & 3n) | (d >> BigInt(b)*2n & 0xcn) | (d >> BigInt(b)*3n & 0x10n) | (d >> BigInt(b)*4n & 0x60n) | (d >> BigInt(b)*5n & 0x80n);
          for (let j = 0; j < 5 && n < count; j++, n++) { out[n].bits = Number(d >> BigInt(MT[j]+b*j)) & mask; out[n].nonbits = TRITS_TABLE[j][Number(x)]; }
        }
      } else {
        for (let i = 0, p = offset; i < block_count; i++, p += block_size) {
          const now_size = (i < block_count - 1) ? block_size : last_block_size;
          const d = getbits64(buf, p, now_size);
          const x = (d >> BigInt(b) & 3n) | (d >> BigInt(b)*2n & 0xcn) | (d >> BigInt(b)*3n & 0x10n) | (d >> BigInt(b)*4n & 0x60n) | (d >> BigInt(b)*5n & 0x80n);
          for (let j = 0; j < 5 && n < count; j++, n++) { out[n].bits = Number(d >> BigInt(MT[j]+b*j)) & mask; out[n].nonbits = TRITS_TABLE[j][Number(x)]; }
        }
      }
    } else if (a == 5) {
      const mask = (1 << b) - 1;
      const block_count = Math.floor((count + 2) / 3);
      const last_block_count = (count + 2) % 3 + 1;
      const block_size = 7 + 3 * b;
      const last_block_size = Math.floor((block_size * last_block_count + 2) / 3);
      if (reverse) {
        for (let i = 0, p = offset; i < block_count; i++, p -= block_size) {
          const now_size = (i < block_count - 1) ? block_size : last_block_size;
          const d = bit_reverse_u64(getbits64(buf, p - now_size, now_size), now_size);
          const x = (d >> BigInt(b) & 7n) | (d >> BigInt(b)*2n & 0x18n) | (d >> BigInt(b)*3n & 0x60n);
          for (let j = 0; j < 3 && n < count; j++, n++) { out[n].bits = Number(d >> BigInt(MQ[j]+b*j)) & mask; out[n].nonbits = QUINTS_TABLE[j][Number(x)]; }
        }
      } else {
        for (let i = 0, p = offset; i < block_count; i++, p += block_size) {
          const d = getbits64(buf, p, (i < block_count - 1) ? block_size : last_block_size);
          const x = (d >> BigInt(b) & 7n) | (d >> BigInt(b)*2n & 0x18n) | (d >> BigInt(b)*3n & 0x60n);
          for (let j = 0; j < 3 && n < count; j++, n++) { out[n].bits = Number(d >> BigInt(MQ[j]+b*j)) & mask; out[n].nonbits = QUINTS_TABLE[j][Number(x)]; }
        }
      }
    } else {
      if (reverse) { for (let p = offset - b; n < count; n++, p -= b) { out[n].bits = bit_reverse_u8(getbits(buf, p, b), b); out[n].nonbits = 0; } }
      else { for (let p = offset; n < count; n++, p += b) { out[n].bits = getbits(buf, p, b); out[n].nonbits = 0; } }
    }
  }
  function decode_endpoints_hdr7(endpoints, v) {
    let modeval = (v[2] >> 4 & 0x8) | (v[1] >> 5 & 0x4) | (v[0] >> 6);
    let major_component = (modeval & 0xc) != 0xc ? modeval >> 2 : (modeval != 0xf) ? modeval & 3 : 0;
    let mode = (modeval & 0xc) != 0xc ? modeval & 3 : (modeval != 0xf) ? 4 : 5;
    let c = new Int32Array([v[0] & 0x3f, v[1] & 0x1f, v[2] & 0x1f, v[3] & 0x1f]);
    switch (mode) {
      case 0: c[3]|=v[3]&0x60; c[0]|=v[3]>>1&0x40; c[0]|=v[2]<<1&0x80; c[0]|=v[1]<<3&0x300; c[0]|=v[2]<<5&0x400; c[0]<<=1;c[1]<<=1;c[2]<<=1;c[3]<<=1; break;
      case 1: c[1]|=v[1]&0x20; c[2]|=v[2]&0x20; c[0]|=v[3]>>1&0x40; c[0]|=v[2]<<1&0x80; c[0]|=v[1]<<2&0x100; c[0]|=v[3]<<4&0x600; c[0]<<=1;c[1]<<=1;c[2]<<=1;c[3]<<=1; break;
      case 2: c[3]|=v[3]&0xe0; c[0]|=v[2]<<1&0xc0; c[0]|=v[1]<<3&0x300; c[0]<<=2;c[1]<<=2;c[2]<<=2;c[3]<<=2; break;
      case 3: c[1]|=v[1]&0x20; c[2]|=v[2]&0x20; c[3]|=v[3]&0x60; c[0]|=v[3]>>1&0x40; c[0]|=v[2]<<1&0x80; c[0]|=v[1]<<2&0x100; c[0]<<=3;c[1]<<=3;c[2]<<=3;c[3]<<=3; break;
      case 4: c[1]|=v[1]&0x60; c[2]|=v[2]&0x60; c[3]|=v[3]&0x20; c[0]|=v[3]>>1&0x40; c[0]|=v[3]<<1&0x80; c[0]<<=4;c[1]<<=4;c[2]<<=4;c[3]<<=4; break;
      case 5: c[1]|=v[1]&0x60; c[2]|=v[2]&0x60; c[3]|=v[3]&0x60; c[0]|=v[3]>>1&0x40; c[0]<<=5;c[1]<<=5;c[2]<<=5;c[3]<<=5; break;
    }
    if (mode != 5) { c[1] = c[0] - c[1]; c[2] = c[0] - c[2]; }
    switch (major_component) {
      case 1: set_endpoint_hdr_clamp(endpoints, c[1]-c[3],c[0]-c[3],c[2]-c[3],0x780,c[1],c[0],c[2],0x780); break;
      case 2: set_endpoint_hdr_clamp(endpoints, c[2]-c[3],c[1]-c[3],c[0]-c[3],0x780,c[2],c[1],c[0],0x780); break;
      default: set_endpoint_hdr_clamp(endpoints, c[0]-c[3],c[1]-c[3],c[2]-c[3],0x780,c[0],c[1],c[2],0x780); break;
    }
  }
  function decode_endpoints_hdr11(endpoints, v, alpha1, alpha2) {
    let major_component = (v[4] >> 7) | (v[5] >> 6 & 2);
    if (major_component == 3) { set_endpoint_hdr(endpoints, v[0]<<4,v[2]<<4,v[4]<<5&0xfe0,alpha1,v[1]<<4,v[3]<<4,v[5]<<5&0xfe0,alpha2); return; }
    let mode = (v[1]>>7)|(v[2]>>6&2)|(v[3]>>5&4);
    let va = v[0] | (v[1]<<2&0x100);
    let vb0 = v[2]&0x3f, vb1 = v[3]&0x3f, vc = v[1]&0x3f, vd0, vd1;
    switch (mode) {
      case 0: case 2: vd0=v[4]&0x7f; if(vd0&0x40)vd0|=0xff80; vd1=v[5]&0x7f; if(vd1&0x40)vd1|=0xff80; break;
      case 1: case 3: case 5: case 7: vd0=v[4]&0x3f; if(vd0&0x20)vd0|=0xffc0; vd1=v[5]&0x3f; if(vd1&0x20)vd1|=0xffc0; break;
      default: vd0=v[4]&0x1f; if(vd0&0x10)vd0|=0xffe0; vd1=v[5]&0x1f; if(vd1&0x10)vd1|=0xffe0; break;
    }
    switch (mode) {
      case 0: vb0|=v[2]&0x40; vb1|=v[3]&0x40; break;
      case 1: vb0|=v[2]&0x40; vb1|=v[3]&0x40; vb0|=v[4]<<1&0x80; vb1|=v[5]<<1&0x80; break;
      case 2: va|=v[2]<<3&0x200; vc|=v[3]&0x40; break;
      case 3: va|=v[4]<<3&0x200; vc|=v[5]&0x40; vb0|=v[2]&0x40; vb1|=v[3]&0x40; break;
      case 4: va|=v[4]<<4&0x200; va|=v[5]<<5&0x400; vb0|=v[2]&0x40; vb1|=v[3]&0x40; vb0|=v[4]<<1&0x80; vb1|=v[5]<<1&0x80; break;
      case 5: va|=v[2]<<3&0x200; va|=v[3]<<4&0x400; vc|=v[5]&0x40; vc|=v[4]<<1&0x80; break;
      case 6: va|=v[4]<<4&0x200; va|=v[5]<<5&0x400; va|=v[4]<<5&0x800; vc|=v[5]&0x40; vb0|=v[2]&0x40; vb1|=v[3]&0x40; break;
      case 7: va|=v[2]<<3&0x200; va|=v[3]<<4&0x400; va|=v[4]<<5&0x800; vc|=v[5]&0x40; break;
    }
    let shamt = (mode>>1)^3;
    va<<=shamt; vb0<<=shamt; vb1<<=shamt; vc<<=shamt;
    let mult = 1<<shamt; vd0*=mult; vd1*=mult;
    switch (major_component) {
      case 1: set_endpoint_hdr_clamp(endpoints, va-vb0-vc-vd0,va-vc,va-vb1-vc-vd1,alpha1,va-vb0,va,va-vb1,alpha2); break;
      case 2: set_endpoint_hdr_clamp(endpoints, va-vb1-vc-vd1,va-vb0-vc-vd0,va-vc,alpha1,va-vb1,va-vb0,va,alpha2); break;
      default: set_endpoint_hdr_clamp(endpoints, va-vc,va-vb0-vc-vd0,va-vb1-vc-vd1,alpha1,va,va-vb0,va-vb1,alpha2); break;
    }
  }
  function decode_endpoints(buf, data) {
    const TRITS_TABLE = new Int32Array([0,204,93,44,22,11,5]);
    const QUINTS_TABLE = new Int32Array([0,113,54,26,13,6]);
    let seq = Array.from({length:32}, () => ({bits:0,nonbits:0}));
    let ev = new Int32Array(32);
    decode_intseq(buf, data.part_num == 1 ? 17 : 29, CEM_TABLE_A[data.cem_range], CEM_TABLE_B[data.cem_range], data.endpoint_value_num, false, seq);
    switch (CEM_TABLE_A[data.cem_range]) {
      case 3:
        for (let i = 0, b = 0, c = TRITS_TABLE[CEM_TABLE_B[data.cem_range]]; i < data.endpoint_value_num; i++) {
          let a = (seq[i].bits & 1) * 0x1ff, x = seq[i].bits >> 1;
          switch (CEM_TABLE_B[data.cem_range]) {
            case 1: b=0; break;
            case 2: b=0b100010110*x; break;
            case 3: b=x<<7|x<<2|x; break;
            case 4: b=x<<6|x; break;
            case 5: b=x<<5|x>>2; break;
            case 6: b=x<<4|x>>4; break;
          }
          ev[i] = (a & 0x80) | ((seq[i].nonbits*c+b)^a)>>2;
        }
        break;
      case 5:
        for (let i = 0, b = 0, c = QUINTS_TABLE[CEM_TABLE_B[data.cem_range]]; i < data.endpoint_value_num; i++) {
          let a = (seq[i].bits & 1) * 0x1ff, x = seq[i].bits >> 1;
          switch (CEM_TABLE_B[data.cem_range]) {
            case 1: b=0; break;
            case 2: b=0b100001100*x; break;
            case 3: b=x<<7|x<<1|x>>1; break;
            case 4: b=x<<6|x>>1; break;
            case 5: b=x<<5|x>>3; break;
          }
          ev[i] = (a & 0x80) | ((seq[i].nonbits*c+b)^a)>>2;
        }
        break;
      default:
        switch (CEM_TABLE_B[data.cem_range]) {
          case 1: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits*0xff; break;
          case 2: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits*0x55; break;
          case 3: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits<<5|seq[i].bits<<2|seq[i].bits>>1; break;
          case 4: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits<<4|seq[i].bits; break;
          case 5: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits<<3|seq[i].bits>>2; break;
          case 6: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits<<2|seq[i].bits>>4; break;
          case 7: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits<<1|seq[i].bits>>6; break;
          case 8: for (let i=0;i<data.endpoint_value_num;i++) ev[i]=seq[i].bits; break;
        }
    }
    let v = ev;
    for (let cem = 0; cem < data.part_num; v = v.subarray((Math.floor(data.cem[cem]/4)+1)*2), cem++) {
      switch (data.cem[cem]) {
        case 0: set_endpoint(data.endpoints[cem], v[0],v[0],v[0],255,v[1],v[1],v[1],255); break;
        case 1: { let l0=(v[0]>>2)|(v[1]&0xc0), l1=clamp(l0+(v[1]&0x3f),0,255); set_endpoint(data.endpoints[cem], l0,l0,l0,255,l1,l1,l1,255); } break;
        case 2: { let y0,y1; if(v[0]<=v[1]){y0=v[0]<<4;y1=v[1]<<4;}else{y0=(v[1]<<4)+8;y1=(v[0]<<4)-8;} set_endpoint_hdr(data.endpoints[cem], y0,y0,y0,0x780,y1,y1,y1,0x780); } break;
        case 3: { let y0,d; if(v[0]&0x80){y0=(v[1]&0xe0)<<4|(v[0]&0x7f)<<2;d=(v[1]&0x1f)<<2;}else{y0=(v[1]&0xf0)<<4|(v[0]&0x7f)<<1;d=(v[1]&0x0f)<<1;} let y1=clamp(y0+d,0,0xfff); set_endpoint_hdr(data.endpoints[cem], y0,y0,y0,0x780,y1,y1,y1,0x780); } break;
        case 4: set_endpoint(data.endpoints[cem], v[0],v[0],v[0],v[2],v[1],v[1],v[1],v[3]); break;
        case 5: bit_transfer_signed_alt(v,1,0); bit_transfer_signed_alt(v,3,2); v[1]+=v[0]; set_endpoint_clamp(data.endpoints[cem], v[0],v[0],v[0],v[2],v[1],v[1],v[1],v[2]+v[3]); break;
        case 6: set_endpoint(data.endpoints[cem], v[0]*v[3]>>8,v[1]*v[3]>>8,v[2]*v[3]>>8,255,v[0],v[1],v[2],255); break;
        case 7: decode_endpoints_hdr7(data.endpoints[cem], v); break;
        case 8: if(v[0]+v[2]+v[4]<=v[1]+v[3]+v[5]) set_endpoint(data.endpoints[cem], v[0],v[2],v[4],255,v[1],v[3],v[5],255); else set_endpoint_blue(data.endpoints[cem], v[1],v[3],v[5],255,v[0],v[2],v[4],255); break;
        case 9: bit_transfer_signed_alt(v,1,0); bit_transfer_signed_alt(v,3,2); bit_transfer_signed_alt(v,5,4); if(v[1]+v[3]+v[5]>=0) set_endpoint_clamp(data.endpoints[cem], v[0],v[2],v[4],255,v[0]+v[1],v[2]+v[3],v[4]+v[5],255); else set_endpoint_blue_clamp(data.endpoints[cem], v[0]+v[1],v[2]+v[3],v[4]+v[5],255,v[0],v[2],v[4],255); break;
        case 10: set_endpoint(data.endpoints[cem], v[0]*v[3]>>8,v[1]*v[3]>>8,v[2]*v[3]>>8,v[4],v[0],v[1],v[2],v[5]); break;
        case 11: decode_endpoints_hdr11(data.endpoints[cem], v, 0x780, 0x780); break;
        case 12: if(v[0]+v[2]+v[4]<=v[1]+v[3]+v[5]) set_endpoint(data.endpoints[cem], v[0],v[2],v[4],v[6],v[1],v[3],v[5],v[7]); else set_endpoint_blue(data.endpoints[cem], v[1],v[3],v[5],v[7],v[0],v[2],v[4],v[6]); break;
        case 13: bit_transfer_signed_alt(v,1,0); bit_transfer_signed_alt(v,3,2); bit_transfer_signed_alt(v,5,4); bit_transfer_signed_alt(v,7,6); if(v[1]+v[3]+v[5]>=0) set_endpoint_clamp(data.endpoints[cem], v[0],v[2],v[4],v[6],v[0]+v[1],v[2]+v[3],v[4]+v[5],v[6]+v[7]); else set_endpoint_blue_clamp(data.endpoints[cem], v[0]+v[1],v[2]+v[3],v[4]+v[5],v[6]+v[7],v[0],v[2],v[4],v[6]); break;
        case 14: decode_endpoints_hdr11(data.endpoints[cem], v, v[6], v[7]); break;
        case 15: { let mode=((v[6]>>7)&1)|((v[7]>>6)&2); v[6]&=0x7f; v[7]&=0x7f; if(mode==3){decode_endpoints_hdr11(data.endpoints[cem], v, v[6]<<5, v[7]<<5);}else{v[6]|=(v[7]<<(mode+1))&0x780; v[7]=((v[7]&(0x3f>>mode))^(0x20>>mode))-(0x20>>mode); v[6]<<=4-mode; v[7]<<=4-mode; decode_endpoints_hdr11(data.endpoints[cem], v, v[6], clamp(v[6]+v[7],0,0xfff));} } break;
        default: throw new Error("Unsupported ASTC format");
      }
    }
  }
  function decode_block_params(buf, block_data) {
    block_data.dual_plane = (buf[1] & 4) != 0;
    block_data.weight_range = ((buf[0] >> 4 & 1) | (buf[1] << 2 & 8));
    if ((buf[0] & 3) != 0) {
      block_data.weight_range |= buf[0] << 1 & 6;
      switch (buf[0] & 0xc) {
        case 0: block_data.width = (u8ptr_to_u16(buf) >> 7 & 3) + 4; block_data.height = (buf[0] >> 5 & 3) + 2; break;
        case 4: block_data.width = (u8ptr_to_u16(buf) >> 7 & 3) + 8; block_data.height = (buf[0] >> 5 & 3) + 2; break;
        case 8: block_data.width = (buf[0] >> 5 & 3) + 2; block_data.height = (u8ptr_to_u16(buf) >> 7 & 3) + 8; break;
        case 12:
          if ((buf[1] & 1) != 0) { block_data.width = (buf[0] >> 7 & 1) + 2; block_data.height = (buf[0] >> 5 & 3) + 2; }
          else { block_data.width = (buf[0] >> 5 & 3) + 2; block_data.height = (buf[0] >> 7 & 1) + 6; }
          break;
      }
    } else {
      block_data.weight_range |= buf[0] >> 1 & 6;
      switch (u8ptr_to_u16(buf) & 0x180) {
        case 0: block_data.width = 12; block_data.height = (buf[0] >> 5 & 3) + 2; break;
        case 0x80: block_data.width = (buf[0] >> 5 & 3) + 2; block_data.height = 12; break;
        case 0x100: block_data.width = (buf[0] >> 5 & 3) + 6; block_data.height = (buf[1] >> 1 & 3) + 6; block_data.dual_plane = false; block_data.weight_range &= 7; break;
        case 0x180: block_data.width = (buf[0] & 0x20) != 0 ? 10 : 6; block_data.height = (buf[0] & 0x20) != 0 ? 6 : 10; break;
      }
    }
    block_data.part_num = (buf[1] >> 3 & 3) + 1;
    block_data.weight_num = block_data.width * block_data.height;
    if (block_data.dual_plane) block_data.weight_num *= 2;
    let config_bits, cem_base = 0, weight_bits;
    switch (WEIGHT_PREC_TABLE_A[block_data.weight_range]) {
      case 3: weight_bits = Math.floor(block_data.weight_num * WEIGHT_PREC_TABLE_B[block_data.weight_range] + (block_data.weight_num*8+4)/5); break;
      case 5: weight_bits = Math.floor(block_data.weight_num * WEIGHT_PREC_TABLE_B[block_data.weight_range] + (block_data.weight_num*7+2)/3); break;
      default: weight_bits = block_data.weight_num * WEIGHT_PREC_TABLE_B[block_data.weight_range]; break;
    }
    if (block_data.part_num == 1) { block_data.cem[0] = u8ptr_to_u16(buf.subarray(1)) >> 5 & 0xf; config_bits = 17; }
    else {
      cem_base = u8ptr_to_u16(buf.subarray(2)) >> 7 & 3;
      if (cem_base == 0) { let cem = buf[3] >> 1 & 0xf; for (let dd=0;dd<block_data.part_num;dd++) block_data.cem[dd]=cem; config_bits = 29; }
      else {
        for (let i=0;i<Number(block_data.part_num);i++) block_data.cem[i]=(buf[3]>>(i+1)&1)+cem_base-1<<2;
        switch (block_data.part_num) {
          case 2: block_data.cem[0]|=buf[3]>>3&3; block_data.cem[1]|=getbits(buf,126-weight_bits,2); break;
          case 3: block_data.cem[0]|=buf[3]>>4&1; block_data.cem[0]|=getbits(buf,122-weight_bits,2)&2; block_data.cem[1]|=getbits(buf,124-weight_bits,2); block_data.cem[2]|=getbits(buf,126-weight_bits,2); break;
          case 4: for (let xx=0;xx<4;xx++) block_data.cem[xx]|=getbits(buf,120+xx*2-weight_bits,2); break;
        }
        config_bits = 25 + block_data.part_num * 3;
      }
    }
    if (block_data.dual_plane) {
      config_bits += 2;
      block_data.plane_selector = getbits(buf, cem_base != 0 ? 130-weight_bits-block_data.part_num*3 : 126-weight_bits, 2);
    }
    let remain_bits = 128 - config_bits - weight_bits;
    block_data.endpoint_value_num = 0;
    for (let i=0;i<block_data.part_num;i++) block_data.endpoint_value_num += (block_data.cem[i]>>1&6)+2;
    let endpoint_bits;
    for (let i=0;i<CEM_TABLE_A.length;i++) {
      switch (CEM_TABLE_A[i]) {
        case 3: endpoint_bits = Math.floor(block_data.endpoint_value_num*CEM_TABLE_B[i]+(block_data.endpoint_value_num*8+4)/5); break;
        case 5: endpoint_bits = Math.floor(block_data.endpoint_value_num*CEM_TABLE_B[i]+(block_data.endpoint_value_num*7+2)/3); break;
        default: endpoint_bits = block_data.endpoint_value_num*CEM_TABLE_B[i];
      }
      if (endpoint_bits <= remain_bits) { block_data.cem_range = i; break; }
    }
  }
  function decode_weights(buf, data) {
    let seq = Array.from({length:128}, () => ({bits:0,nonbits:0}));
    let wv = new Int32Array(128);
    decode_intseq(buf, 128, WEIGHT_PREC_TABLE_A[data.weight_range], WEIGHT_PREC_TABLE_B[data.weight_range], data.weight_num, true, seq);
    if (WEIGHT_PREC_TABLE_A[data.weight_range] == 0) {
      switch (WEIGHT_PREC_TABLE_B[data.weight_range]) {
        case 1: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].bits!=0?63:0; break;
        case 2: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].bits<<4|seq[i].bits<<2|seq[i].bits; break;
        case 3: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].bits<<3|seq[i].bits; break;
        case 4: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].bits<<2|seq[i].bits>>2; break;
        case 5: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].bits<<1|seq[i].bits>>4; break;
        default: throw new Error("Unsupported ASTC format: " + WEIGHT_PREC_TABLE_B[data.weight_range]);
      }
      for (let i=0;i<data.weight_num;i++) if (wv[i]>32) wv[i]+=1;
    } else if (WEIGHT_PREC_TABLE_B[data.weight_range] == 0) {
      let s = WEIGHT_PREC_TABLE_A[data.weight_range] == 3 ? 32 : 16;
      for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].nonbits*s;
    } else {
      if (WEIGHT_PREC_TABLE_A[data.weight_range] == 3) {
        switch (WEIGHT_PREC_TABLE_B[data.weight_range]) {
          case 1: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].nonbits*50; break;
          case 2: for (let i=0;i<data.weight_num;i++){ wv[i]=seq[i].nonbits*23; if((seq[i].bits&2)!=0) wv[i]+=0b1000101; } break;
          case 3: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].nonbits*11+((seq[i].bits<<4|seq[i].bits>>1)&0b1100011); break;
          default: throw new Error("Unsupported ASTC format: " + WEIGHT_PREC_TABLE_B[data.weight_range]);
        }
      } else if (WEIGHT_PREC_TABLE_A[data.weight_range] == 5) {
        switch (WEIGHT_PREC_TABLE_B[data.weight_range]) {
          case 1: for (let i=0;i<data.weight_num;i++) wv[i]=seq[i].nonbits*28; break;
          case 2: for (let i=0;i<data.weight_num;i++){ wv[i]=seq[i].nonbits*13; if((seq[i].bits&2)!=0) wv[i]+=0b1000010; } break;
          default: throw new Error("Unsupported ASTC format: " + WEIGHT_PREC_TABLE_B[data.weight_range]);
        }
      }
      for (let i=0;i<data.weight_num;i++) { let a=(seq[i].bits&1)*0x7f; wv[i]=(a&0x20)|((wv[i]^a)>>2); if(wv[i]>32) wv[i]+=1; }
    }
    let ds = Math.floor((1024 + data.bw/2)/(data.bw-1));
    let dt = Math.floor((1024 + data.bh/2)/(data.bh-1));
    let pn = data.dual_plane ? 2 : 1;
    let i = 0;
    for (let t = 0; t < data.bh; t++) {
      for (let s = 0; s < data.bw; s++) {
        let gs = (ds*s*(data.width-1)+32)>>6;
        let gt = (dt*t*(data.height-1)+32)>>6;
        let fs = gs & 0xf, ft = gt & 0xf;
        let v = (gs>>4) + (gt>>4)*data.width;
        let w11 = ((fs*ft+8)>>4), w10 = ft-w11, w01 = fs-w11, w00 = 16-fs-ft+w11;
        for (let p = 0; p < pn; p++) {
          let p00 = wv[v*pn+p], p01 = wv[(v+1)*pn+p], p10 = wv[(v+data.width)*pn+p], p11 = wv[(v+data.width+1)*pn+p];
          data.weights[i][p] = (p00*w00+p01*w01+p10*w10+p11*w11+8)>>4;
        }
        i += 1;
      }
    }
  }
  function select_partition(buf, data) {
    let small_block = data.bw * data.bh < 31;
    let seed = (((buf[3] & 0xFF) << 24) | ((buf[2] & 0xFF) << 16) | ((buf[1] & 0xFF) << 8) | (buf[0] & 0xFF));
    seed = (seed >> 13 & 0x3ff) | (data.part_num - 1) << 10;
    let rnum1 = new Uint32Array([seed]);
    rnum1[0] ^= rnum1[0] >>> 15; rnum1[0] -= rnum1[0] << 17; rnum1[0] += rnum1[0] << 7; rnum1[0] += rnum1[0] << 4;
    rnum1[0] ^= rnum1[0] >>> 5; rnum1[0] += rnum1[0] << 16; rnum1[0] ^= rnum1[0] >>> 7; rnum1[0] ^= rnum1[0] >>> 3;
    rnum1[0] ^= rnum1[0] << 6; rnum1[0] ^= rnum1[0] >>> 17;
    let rnum = rnum1[0];
    let seeds = new Int32Array(8);
    for (let i = 0; i < 8; i++) { let v = rnum >> (i*4) & 0xF; seeds[i] = v*v; }
    let sh = new Int32Array([(seed & 2) != 0 ? 4 : 5, data.part_num == 3 ? 6 : 5]);
    if ((seed & 1) != 0) { for (let i=0;i<8;i++) seeds[i] >>= sh[i%2]; }
    else { for (let i=0;i<8;i++) seeds[i] >>= sh[1-i%2]; }
    if (small_block) {
      for (let t=0,i=0;t<data.bh;t++) for (let s=0;s<data.bw;s++,i++) {
        let x=s<<1,y=t<<1;
        let a=(seeds[0]*x+seeds[1]*y+(rnum>>14))&0x3f;
        let b=(seeds[2]*x+seeds[3]*y+(rnum>>10))&0x3f;
        let c=data.part_num<3?0:(seeds[4]*x+seeds[5]*y+(rnum>>6))&0x3f;
        let d=data.part_num<4?0:(seeds[6]*x+seeds[7]*y+(rnum>>2))&0x3f;
        data.partition[i]=(a>=b&&a>=c&&a>=d)?0:(b>=c&&b>=d)?1:(c>=d)?2:3;
      }
    } else {
      for (let y=0,i=0;y<data.bh;y++) for (let x=0;x<data.bw;x++,i++) {
        let a=(seeds[0]*x+seeds[1]*y+(rnum>>14))&0x3f;
        let b=(seeds[2]*x+seeds[3]*y+(rnum>>10))&0x3f;
        let c=data.part_num<3?0:(seeds[4]*x+seeds[5]*y+(rnum>>6))&0x3f;
        let d=data.part_num<4?0:(seeds[6]*x+seeds[7]*y+(rnum>>2))&0x3f;
        data.partition[i]=(a>=b&&a>=c&&a>=d)?0:(b>=c&&b>=d)?1:(c>=d)?2:3;
      }
    }
  }
  const FUNC_TABLE_C = [select_color,select_color,select_color_hdr,select_color_hdr,select_color,select_color,select_color,select_color_hdr,select_color,select_color,select_color,select_color_hdr,select_color,select_color,select_color_hdr,select_color_hdr];
  const FUNC_TABLE_A = [select_color,select_color,select_color_hdr,select_color_hdr,select_color,select_color,select_color,select_color_hdr,select_color,select_color,select_color,select_color_hdr,select_color,select_color,select_color,select_color_hdr];
  function applicate_color(data, outbuf) {
    if (data.dual_plane) {
      let ps = [0,0,0,0]; ps[data.plane_selector] = 1;
      if (data.part_num > 1) {
        for (let i=0;i<data.bw*data.bh;i++) {
          let p=data.partition[i], pp=data.cem[p];
          let r=FUNC_TABLE_C[pp](data.endpoints[p][0],data.endpoints[p][4],data.weights[i][ps[0]]);
          let g=FUNC_TABLE_C[pp](data.endpoints[p][1],data.endpoints[p][5],data.weights[i][ps[1]]);
          let b=FUNC_TABLE_C[pp](data.endpoints[p][2],data.endpoints[p][6],data.weights[i][ps[2]]);
          let a=FUNC_TABLE_A[pp](data.endpoints[p][3],data.endpoints[p][7],data.weights[i][ps[3]]);
          outbuf[i]=color(r,g,b,a);
        }
      } else {
        for (let i=0;i<data.bw*data.bh;i++) {
          let pp=data.cem[0];
          let r=FUNC_TABLE_C[pp](data.endpoints[0][0],data.endpoints[0][4],data.weights[i][ps[0]]);
          let g=FUNC_TABLE_C[pp](data.endpoints[0][1],data.endpoints[0][5],data.weights[i][ps[1]]);
          let b=FUNC_TABLE_C[pp](data.endpoints[0][2],data.endpoints[0][6],data.weights[i][ps[2]]);
          let a=FUNC_TABLE_A[pp](data.endpoints[0][3],data.endpoints[0][7],data.weights[i][ps[3]]);
          outbuf[i]=color(r,g,b,a);
        }
      }
    } else if (data.part_num > 1) {
      for (let i=0;i<data.bw*data.bh;i++) {
        let p=data.partition[i], pp=data.cem[p];
        let r=FUNC_TABLE_C[pp](data.endpoints[p][0],data.endpoints[p][4],data.weights[i][0]);
        let g=FUNC_TABLE_C[pp](data.endpoints[p][1],data.endpoints[p][5],data.weights[i][0]);
        let b=FUNC_TABLE_C[pp](data.endpoints[p][2],data.endpoints[p][6],data.weights[i][0]);
        let a=FUNC_TABLE_A[pp](data.endpoints[p][3],data.endpoints[p][7],data.weights[i][0]);
        outbuf[i]=color(r,g,b,a);
      }
    } else {
      for (let i=0;i<data.bw*data.bh;i++) {
        let pp=data.cem[0];
        let r=FUNC_TABLE_C[pp](data.endpoints[0][0],data.endpoints[0][4],data.weights[i][0]);
        let g=FUNC_TABLE_C[pp](data.endpoints[0][1],data.endpoints[0][5],data.weights[i][0]);
        let b=FUNC_TABLE_C[pp](data.endpoints[0][2],data.endpoints[0][6],data.weights[i][0]);
        let a=FUNC_TABLE_A[pp](data.endpoints[0][3],data.endpoints[0][7],data.weights[i][0]);
        outbuf[i]=color(r,g,b,a);
      }
    }
  }
  function decode_astc_block(buf, block_width, block_height, outbuf) {
    if (buf[0] == 0xfc && (buf[1] & 1) == 1) {
      let c;
      if ((buf[1] & 2) != 0) c = color(f16ptr_to_u8(buf.subarray(8)),f16ptr_to_u8(buf.subarray(10)),f16ptr_to_u8(buf.subarray(12)),f16ptr_to_u8(buf.subarray(14)));
      else c = color(buf[9],buf[11],buf[13],buf[15]);
      for (let i=0;i<block_width*block_height;i++) outbuf[i]=c;
    } else if (((buf[0] & 0xc3) == 0xc0 && (buf[1] & 1) == 1) || (buf[0] & 0xf) == 0) {
      let c = color(255,0,255,255);
      for (let i=0;i<block_width*block_height;i++) outbuf[i]=c;
    } else {
      let block_data = BlockDataDefault();
      block_data.bw = block_width; block_data.bh = block_height;
      decode_block_params(buf, block_data);
      decode_endpoints(buf, block_data);
      decode_weights(buf, block_data);
      if (block_data.part_num > 1) select_partition(buf, block_data);
      applicate_color(block_data, outbuf);
    }
  }
  function copy_block_buffer(bx, by, w, h, bw, bh, buffer, image) {
    let x = bw * bx;
    let copy_width = bw * (bx+1) > w ? (w - bw*bx) : bw;
    let y_0 = by * bh;
    let copy_height = bh * (by+1) > h ? h - y_0 : bh;
    let buffer_offset = 0;
    for (let y = y_0; y < y_0 + copy_height; y++) {
      let image_offset = y * w + x, bufferIndex = buffer_offset;
      for (let i = 0; i < copy_width; i++) { image[image_offset+i] = buffer[bufferIndex]; bufferIndex++; }
      buffer_offset += bw;
    }
  }
  function decodeASTC(src, width, height, block_width, block_height) {
    const num_blocks_x = Math.floor((width + block_width - 1) / block_width);
    const num_blocks_y = Math.floor((height + block_height - 1) / block_height);
    const raw_block_size = 16;
    const buffer = new Uint32Array(144);
    let data_offset = 0;
    if (src.length < num_blocks_x * num_blocks_y * raw_block_size) throw new Error("ASTC source too short");
    let image = new Uint32Array(width * height);
    if (block_width * block_height > 144) throw new Error("ASTC block too big");
    for (let by = 0; by < num_blocks_y; by++) {
      for (let bx = 0; bx < num_blocks_x; bx++) {
        decode_astc_block(src.subarray(data_offset, data_offset + raw_block_size), block_width, block_height, buffer);
        copy_block_buffer(bx, by, width, height, block_width, block_height, buffer, image);
        data_offset += raw_block_size;
      }
    }
    return new Uint8Array(image.buffer);
  }
  return decodeASTC;
})();

function decodeKtx(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length < 68) return null;
  for (let i = 0; i < 12; i++) if (raw[i] !== KTX_MAGIC[i]) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(12, true) !== 0x04030201) return null;
  const glInternalFormat = dv.getUint32(28, true);
  const width = dv.getUint32(36, true);
  const height = dv.getUint32(40, true);
  const kvSize = dv.getUint32(60, true);
  let offset = 64 + kvSize;
  if (offset + 4 > raw.length) return null;
  const imageSize = dv.getUint32(offset, true); offset += 4;
  if (offset + imageSize > raw.length) return null;

  // ASTC（iOS 包纹理格式）：4x4/6x6 各 LDR 线性 + sRGB。走内联 astcDecode。
  const ASTC_FMT = ASTC_FORMAT_TABLE[glInternalFormat];
  if (ASTC_FMT) {
    if (offset + imageSize > raw.length) return null;
    const astcData = raw.subarray(offset, offset + imageSize);
    let data;
    try { data = astcDecode(astcData, width, height, ASTC_FMT.bw, ASTC_FMT.bh); }
    catch (e) { return null; }
    return { width, height, data, srgb: ASTC_FMT.srgb };
  }

  const hasAlpha = (glInternalFormat === GL_ETC2_RGBA || glInternalFormat === GL_ETC2_SRGBA);
  const isEtc2 = (glInternalFormat === GL_ETC2_RGB || glInternalFormat === GL_ETC2_SRGB || hasAlpha);
  if (!isEtc2) return null; // 只软解 ETC2 系列

  const out = new Uint8Array(width * height * 4);
  const bdv = new DataView(raw.buffer, raw.byteOffset + offset, imageSize);
  const bxCount = Math.ceil(width / 4), byCount = Math.ceil(height / 4);
  let p = 0;
  for (let by = 0; by < byCount; by++) {
    for (let bx = 0; bx < bxCount; bx++) {
      let alpha = null;
      if (hasAlpha) { alpha = decodeEacBlock(bdv, p); p += 8; }
      decodeEtc2RgbBlock(bdv, p, out, width, height, bx, by); p += 8;
      if (alpha) {
        for (let i = 0; i < 16; i++) {
          const px = bx * 4 + (i >> 2), py = by * 4 + (i & 3);
          if (px >= width || py >= height) continue;
          out[(py * width + px) * 4 + 3] = alpha[i];
        }
      }
    }
  }
  return { width, height, data: out, srgb: (glInternalFormat === GL_ETC2_SRGB || glInternalFormat === GL_ETC2_SRGBA) };
}


