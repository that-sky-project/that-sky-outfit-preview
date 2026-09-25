/* ===== exporter.js — 当前穿搭导出为 OBJ(+MTL+PNG zip) 或 GLB ===== */
'use strict';

/* ---------- 矩阵工具（列主序 4x4，与 three.js / GLSL 一致） ---------- */
function expMul4(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let rw = 0; rw < 4; rw++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rw] * b[c * 4 + k];
    r[c * 4 + rw] = s;
  }
  return r;
}
function expVec(m, v, w) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
  ];
}
/* 4x4 逆（列主序；仿射通用） */
function expInvert4(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return new Float32Array(16);
  det = 1.0 / det;
  const r = new Float32Array(16);
  r[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  r[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  r[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  r[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  r[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  r[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  r[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  r[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  r[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  r[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  r[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  r[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  r[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  r[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  r[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  r[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return r;
}
/* mat4 → 平移 / 四元数 / 缩放（glTF TRS，列主序） */
function expMatToTRS(m) {
  const tx = m[12], ty = m[13], tz = m[14];
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const ix = sx ? m[0] / sx : m[0], iy = sx ? m[1] / sx : m[1], iz = sx ? m[2] / sx : m[2];
  const jx = sy ? m[4] / sy : m[4], jy = sy ? m[5] / sy : m[5], jz = sy ? m[6] / sy : m[6];
  const kx = sz ? m[8] / sz : m[8], ky = sz ? m[9] / sz : m[9], kz = sz ? m[10] / sz : m[10];
  // 3x3 → 四元数（标准算法）
  const t = ix + jy + kz;
  let qx, qy, qz, qw;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    qw = 0.25 * s; qx = (kz - jy) / s; qy = (ix - kz) / s; qz = (jy - ix) / s;
  } else if (ix > jy && ix > kz) {
    const s = Math.sqrt(1 + ix - jy - kz) * 2;
    qw = (kz - jy) / s; qx = 0.25 * s; qy = (iy + jx) / s; qz = (iz + kx) / s;
  } else if (jy > kz) {
    const s = Math.sqrt(1 + jy - ix - kz) * 2;
    qw = (ix - kz) / s; qx = (iy + jx) / s; qy = 0.25 * s; qz = (jz + ky) / s;
  } else {
    const s = Math.sqrt(1 + kz - ix - jy) * 2;
    qw = (jy - ix) / s; qx = (iz + kx) / s; qy = (jz + ky) / s; qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return { t: [tx, ty, tz], q: [qx / n, qy / n, qz / n, qw / n], s: [sx, sy, sz] };
}

/* ---------- 姿态烘焙：当前动画帧的骨骼矩阵乘到顶点上 ---------- */
function expSkinMatrix(mesh, vtxIdx) {
  const data = mesh.material && mesh.material.userData ? mesh.material.userData.boneData : null;
  const g = mesh.geometry;
  if (!data || !g.attributes.boneIndices) return null;
  const bi = g.attributes.boneIndices.array;
  const bw = g.attributes.boneWeights.array;
  const o = vtxIdx * 4;
  const m = new Float32Array(16);
  let wsum = 0;
  for (let i = 0; i < 4; i++) {
    const b = bi[o + i], w = bw[o + i];
    if (!w) continue;
    const src = b * 16;
    if (b < 0 || src + 16 > data.length) continue; // 未映射/越界骨骼：跳过
    wsum += w;
    for (let k = 0; k < 16; k++) m[k] += data[src + k] * w;
  }
  if (wsum > 0 && Math.abs(wsum - 1) > 1e-4) {
    for (let k = 0; k < 16; k++) m[k] /= wsum;
  }
  return m;
}

/* 烘焙单个部件：返回世界空间（组缩放 1/15 + 正面朝 -Z）的顶点/法线/UV/索引 */
function expBakeMesh(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const idx = geo.index ? geo.index.array : null;
  const vCount = pos.length / 3;
  const t = mesh.position, s = mesh.scale;
  const local = new Float32Array([s.x, 0, 0, 0, 0, s.y, 0, 0, 0, 0, s.z, 0, t.x, t.y, t.z, 1]);
  const gs = 1 / 15;
  // 官方 SkyEditor Fx=-1/Fz=-1（绕 Y 180°）：光遇面向 +z → 导出面向 -z（MMD/Blender 背面朝默认视角，L 在观察者左侧=游戏视角）
  const group = new Float32Array([-gs, 0, 0, 0, 0, gs, 0, 0, 0, 0, -gs, 0, 0, 0, 0, 1]);
  const outPos = new Float32Array(pos.length);
  const outNrm = nrm ? new Float32Array(nrm.length) : null;
  const outUv = uv ? new Float32Array(uv.length) : null;
  if (outUv) {
    for (let i = 0; i < uv.length; i++) outUv[i] = Number.isFinite(uv[i]) ? uv[i] : 0;
  }
  for (let i = 0; i < vCount; i++) {
    let m = null;
    if (geo.attributes.boneIndices) m = expSkinMatrix(mesh, i);
    let v = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    if (m) v = expVec(m, v, 1);
    v = expVec(local, v, 1);
    v = expVec(group, v, 1);
    outPos[i * 3] = Number.isFinite(v[0]) ? v[0] : 0;
    outPos[i * 3 + 1] = Number.isFinite(v[1]) ? v[1] : 0;
    outPos[i * 3 + 2] = Number.isFinite(v[2]) ? v[2] : 0;
    if (outNrm) {
      let n = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
      if (m) n = expVec(m, n, 0);
      n = expVec(local, n, 0);
      n = expVec(group, n, 0);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      outNrm[i * 3] = Number.isFinite(n[0]) ? n[0] / l : 0;
      outNrm[i * 3 + 1] = Number.isFinite(n[1]) ? n[1] / l : 0;
      outNrm[i * 3 + 2] = Number.isFinite(n[2]) ? n[2] / l : 0;
    }
  }
  return { pos: outPos, nrm: outNrm, uv: outUv, idx, vCount };
}

/* 构建基础 MMD 骨架：头/手/身体/腿（腰为根）
 * + 光遇附加骨骼（hair/cap/wing/AUX 等保留原名）挂到基础链。
 * 坐标：光遇原始绑定位置（Y-up，不镜像）。
 * 返回 { bones:[{name,parent,pos,srcName}], srcToMmd:{光遇名:mmdIdx} }
 */
/* 构建 Auto-Rig Pro 兼容骨架：ARP 3.77 Deform 骨骼命名（root.x/spine_01.x/spine_02.x/neck.x/head.x、
 * shoulder.l/arm.l/arm_twist.l/forearm.l/forearm_twist.l/hand.l、thigh.l/thigh_twist.l/leg.l/leg_twist.l/
 * foot.l/toes_01.l + .r/.x 后缀），层级与 ARP humanoid preset 一致；光遇附加骨骼（hair/cap/wing/AUX 等）
 * 保留原名挂到 ARP 链。opts.withIK=true 时追加 MMD IK 骨骼（左足ＩＫ 等，target 指向 ARP foot/toes），
 * 供 PMX 使用。坐标：光遇原始绑定位置（Y-up，不镜像——L 骨骼在 +x，导出时由调用方决定翻 x）。
 * 返回 { bones:[{name,parent,pos,srcName,ik}], srcToMmd:{光遇名:arpIdx} }
 */
function expBuildMMDSkeleton(skinned, byMesh, opts) {
  const withIK = !!(opts && opts.withIK);
  // 1. 收集光遇骨骼（名 → {pos, parentName}），跨部件去重
  const src = new Map();
  for (const mesh of skinned) {
    const sp = byMesh.get(mesh);
    const bs = (sp && sp.skeletonBones) || [];
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (src.has(b.name)) continue;
      const bindM = expInvert4(new Float32Array(b.matrix));
      const pname = (b.parent >= 0 && bs[b.parent]) ? bs[b.parent].name : null;
      src.set(b.name, { pos: [bindM[12], bindM[13], bindM[14]], parentName: pname });
    }
  }
  const S = (n) => (src.get(n) || { pos: null }).pos;
  // 2. 基础骨架：只保留头/手/身体/腿（腰为根；无重心链/捩り/両目；位置取光遇对应骨骼绑定位置）
  const MAIN = [
    { name: '腰', parent: null, src: 'M_hip' },
    { name: '下半身', parent: '腰', src: 'M_hip' },
    { name: '上半身', parent: '下半身', src: 'M_spine' },
    { name: '上半身2', parent: '上半身', src: 'M_chest' },
    { name: '首', parent: '上半身2', src: 'M_neckRoot' },
    { name: '頭', parent: '首', src: 'M_head' },
    { name: '左肩', parent: '上半身2', src: 'L_shoulder' },
    { name: '左腕', parent: '左肩', src: 'L_armRoot' },
    { name: '左ひじ', parent: '左腕', src: 'L_elbow' },
    { name: '左手首', parent: '左ひじ', src: 'L_hand' },
    { name: '右肩', parent: '上半身2', src: 'R_shoulder' },
    { name: '右腕', parent: '右肩', src: 'R_armRoot' },
    { name: '右ひじ', parent: '右腕', src: 'R_elbow' },
    { name: '右手首', parent: '右ひじ', src: 'R_hand' },
    { name: '左足', parent: '下半身', src: 'L_legRoot' },
    { name: '左ひざ', parent: '左足', src: 'L_knee' },
    { name: '左足首', parent: '左ひざ', src: 'L_foot' },
    { name: '左つま先', parent: '左足首', src: 'L_toe' },
    { name: '右足', parent: '下半身', src: 'R_legRoot' },
    { name: '右ひざ', parent: '右足', src: 'R_knee' },
    { name: '右足首', parent: '右ひざ', src: 'R_foot' },
    { name: '右つま先', parent: '右足首', src: 'R_toe' },
  ];
  // 3. 可选 IK（PMX 用；基础版默认不带，需显式 withIK:true）
  if (withIK) {
    MAIN.push(
      { name: '左足ＩＫ', parent: '下半身', ref: 'L_foot', y: 0.1,
        ik: { target: '左足首', loop: 40, limit: 2.0,
              links: [{ bone: '左ひざ', min: [-Math.PI, 0, 0], max: [0, 0, 0] }, { bone: '左足' }] } },
      { name: '右足ＩＫ', parent: '下半身', ref: 'R_foot', y: 0.1,
        ik: { target: '右足首', loop: 40, limit: 2.0,
              links: [{ bone: '右ひざ', min: [-Math.PI, 0, 0], max: [0, 0, 0] }, { bone: '右足' }] } }
    );
  }
  const bones = [];
  const nameToIdx = new Map();
  for (const d of MAIN) {
    let pos;
    if (d.src) {
      pos = S(d.src);
      if (!pos) { // 光遇缺该骨骼：回退父骨骼位置
        const p = (d.parent && nameToIdx.has(d.parent)) ? bones[nameToIdx.get(d.parent)].pos : [0, 0, 0];
        pos = [p[0] + (d.dx || 0), p[1] + (d.dy || 0), p[2] + (d.dz || 0)];
      }
    }
    else if (d.pos) pos = d.pos.slice();
    else {
      const r = S(d.ref) || [0, 0, 0];
      pos = [r[0] + (d.dx || 0), r[1] + (d.dy || 0), r[2] + (d.dz || 0)];
    }
    if (d.y !== undefined) pos = [pos[0], d.y, pos[2]];
    const pIdx = (d.parent && nameToIdx.has(d.parent)) ? nameToIdx.get(d.parent) : null;
    nameToIdx.set(d.name, bones.length);
    bones.push({ name: d.name, parent: pIdx, pos: pos.slice(), srcName: d.src || null, ik: d.ik || null, joint: !!d.joint });
  }
  // 4. 主链映射（光遇名 → MMD idx；多个骨骼共用同一光遇 src 时只映射第一个，
  //    使 腰 等主骨骼获得权重，跟随骨骼（下半身）只取位置不占映射）
  const srcToMmd = {};
  for (const d of MAIN) if (d.src && srcToMmd[d.src] === undefined) srcToMmd[d.src] = nameToIdx.get(d.name);
  // 5. 附加骨骼：未映射的光遇骨骼保留原名；父按原父名挂接（父是主链→MMD 名；父是附加→原名）
  const addBone = (nm) => {
    if (srcToMmd[nm] !== undefined) return srcToMmd[nm];
    const rec = src.get(nm);
    if (!rec) return -1;
    let pIdx = -1;
    if (rec.parentName) {
      if (srcToMmd[rec.parentName] !== undefined) pIdx = srcToMmd[rec.parentName];
      else if (nameToIdx.has(rec.parentName)) pIdx = nameToIdx.get(rec.parentName);
      else pIdx = addBone(rec.parentName); // 父也是附加，递归先注册
    }
    nameToIdx.set(nm, bones.length);
    bones.push({ name: nm, parent: pIdx >= 0 ? pIdx : null, pos: rec.pos.slice(), srcName: nm });
    srcToMmd[nm] = bones.length - 1;
    return srcToMmd[nm];
  };
  for (const nm of src.keys()) addBone(nm);
  return { bones, srcToMmd };
}




/* 烘焙绑定姿势部件：顶点 = 绑定姿势 × mesh local × group（1/15 正缩放，不镜像），不蒙皮。
 * 与 expBakeMesh 同空间，供 PMX 绑定姿势导出（顶点/骨骼同绑定空间，L 在 -x 不翻转）。 */
function expBakeBind(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
  const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const idx = geo.index ? geo.index.array : null;
  const vCount = pos.length / 3;
  const t = mesh.position, s = mesh.scale;
  const local = new Float32Array([s.x, 0, 0, 0, 0, s.y, 0, 0, 0, 0, s.z, 0, t.x, t.y, t.z, 1]);
  const gs = 1 / 15;
  // 与 expBakeMesh 同空间：绕 Y 180° 镜像（x/z 取反），L 在观察者左侧（游戏视角）
  const group = new Float32Array([-gs, 0, 0, 0, 0, gs, 0, 0, 0, 0, -gs, 0, 0, 0, 0, 1]);
  const outPos = new Float32Array(pos.length);
  const outNrm = nrm ? new Float32Array(nrm.length) : null;
  const outUv = uv ? new Float32Array(uv.length) : null;
  if (outUv) {
    for (let i = 0; i < uv.length; i++) outUv[i] = Number.isFinite(uv[i]) ? uv[i] : 0;
  }
  for (let i = 0; i < vCount; i++) {
    let v = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    v = expVec(local, v, 1);
    v = expVec(group, v, 1);
    outPos[i * 3] = Number.isFinite(v[0]) ? v[0] : 0;
    outPos[i * 3 + 1] = Number.isFinite(v[1]) ? v[1] : 0;
    outPos[i * 3 + 2] = Number.isFinite(v[2]) ? v[2] : 0;
    if (outNrm) {
      let n = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
      n = expVec(local, n, 0);
      n = expVec(group, n, 0);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      outNrm[i * 3] = Number.isFinite(n[0]) ? n[0] / l : 0;
      outNrm[i * 3 + 1] = Number.isFinite(n[1]) ? n[1] / l : 0;
      outNrm[i * 3 + 2] = Number.isFinite(n[2]) ? n[2] / l : 0;
    }
  }
  return { pos: outPos, nrm: outNrm, uv: outUv, idx, vCount };
}

/* ---------- 纹理 → PNG Blob ---------- */
function expTexToCanvas(tex) {
  if (!tex || !tex.image || !tex.image.data) return null;
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = img.width || 1;
  c.height = img.height || 1;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(c.width, c.height);
  const src = img.data;
  if (src.length === c.width * c.height * 3) {
    // 3 通道 RGB：补 alpha=255，保证导出 PNG 带透明通道
    const dst = id.data;
    for (let i = 0; i < src.length; i += 3) {
      dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = 255;
    }
  } else {
    id.data.set(src.subarray ? src.subarray(0, id.data.length) : src);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
function expCanvasToBlob(c) {
  return new Promise(res => c.toBlob(b => res(b), 'image/png'));
}
function expMatColor(mesh) {
  const u = mesh.material && mesh.material.uniforms;
  if (u && u.uBaseColor && u.uBaseColor.value) {
    const v = u.uBaseColor.value;
    return [v.x, v.y, v.z];
  }
  return [1, 1, 1];
}
function expMatTex(mesh) {
  const u = mesh.material && mesh.material.uniforms;
  const tex = u && u.uTex ? u.uTex.value : null;
  return tex && tex.image && tex.image.data ? tex : null;
}
function expIsTrans(mesh) {
  const mat = mesh && mesh.material;
  if (!mat) return false;
  if (mat.transparent === true) return true;
  if (mat.uniforms && mat.uniforms.uOpacity && mat.uniforms.uOpacity.value < 0.99) return true;
  return false;
}
function expOpacity(mesh) {
  const mat = mesh && mesh.material;
  if (mat && mat.uniforms && mat.uniforms.uOpacity) return mat.uniforms.uOpacity.value;
  if (mat && typeof mat.opacity === 'number') return mat.opacity;
  return 1;
}

/* ---------- 收集所有部件 ---------- */
function expCollectParts() {
  const parts = [];
  if (outfitGroup) {
    outfitGroup.traverse(o => { if (o.isMesh && o.geometry) parts.push(o); });
  }
  return parts;
}

/* ---------- 下载 ---------- */
function expDownload(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 6000);
}

/* ================================================================
 * OBJ + MTL + PNG → zip
 * ================================================================ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function expCrc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function expZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = expCrc32(data);
    const lh = new Uint8Array(30);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    chunks.push(lh, name, data);
    const ch = new Uint8Array(46);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    // 中央目录条目统一在循环结束后写入（local 全部之后）
    central.push({ name, ch });
    offset += 30 + name.length + data.length;
  }
  for (const c of central) chunks.push(c.ch, c.name);
  const cdSize = central.reduce((s, c) => s + 46 + c.name.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  chunks.push(eocd);
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
function expNum(n) {
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
}

async function exportOBJ() {
  const parts = expCollectParts();
  if (!parts.length) { alert('当前没有可导出的模型'); return; }
  const baked = [];
  const texFiles = new Map();
  let texIdx = 0;
  for (const mesh of parts) {
    const b = expBakeMesh(mesh);
    const tex = expMatTex(mesh);
    let texFile = null;
    if (tex && !texFiles.has(tex.uuid)) {
      const c = expTexToCanvas(tex);
      if (c) {
        const blob = await expCanvasToBlob(c);
        const ab = await blob.arrayBuffer();
        const file = 'tex' + texIdx + '.png';
        texFiles.set(tex.uuid, { file, data: new Uint8Array(ab) });
        texIdx++;
      }
    }
    texFile = texFiles.get(tex && tex.uuid) || null;
    baked.push({ b, mesh, texFile });
  }
  let obj = '# SKY-YIGUI-Web OBJ export\nmtllib model.mtl\n';
  let mtl = '# SKY-YIGUI-Web MTL\n';
  let vOff = 0;
  baked.forEach((e, i) => {
    const { b } = e;
    obj += `o part_${i}\nusemtl mat_${i}\n`;
    for (let j = 0; j < b.vCount; j++) {
      // 原生 Y-up（y 高度），group 正缩放不镜像
      obj += `v ${expNum(b.pos[j * 3])} ${expNum(b.pos[j * 3 + 1])} ${expNum(b.pos[j * 3 + 2])}\n`;
    }
    if (b.uv) for (let j = 0; j < b.vCount; j++) {
      obj += `vt ${expNum(b.uv[j * 2])} ${expNum(b.uv[j * 2 + 1])}\n`;
    }
    if (b.nrm) for (let j = 0; j < b.vCount; j++) {
      obj += `vn ${expNum(b.nrm[j * 3])} ${expNum(b.nrm[j * 3 + 1])} ${expNum(b.nrm[j * 3 + 2])}\n`;
    }
    const idx = b.idx || new Uint32Array(b.vCount).map((_, j) => j);
    const hasUV = !!b.uv, hasN = !!b.nrm;
    for (let j = 0; j < idx.length; j += 3) {
      const a = idx[j] + 1 + vOff, c2 = idx[j + 1] + 1 + vOff, d = idx[j + 2] + 1 + vOff;
      if (hasUV && hasN) obj += `f ${a}/${a}/${a} ${c2}/${c2}/${c2} ${d}/${d}/${d}\n`;
      else if (hasN) obj += `f ${a}//${a} ${c2}//${c2} ${d}//${d}\n`;
      else if (hasUV) obj += `f ${a}/${a} ${c2}/${c2} ${d}/${d}\n`;
      else obj += `f ${a} ${c2} ${d}\n`;
    }
    vOff += b.vCount;
    const c = expMatColor(e.mesh);
    mtl += `newmtl mat_${i}\nKa 0.05 0.05 0.05\nKd ${expNum(c[0])} ${expNum(c[1])} ${expNum(c[2])}\nKs 0 0 0\nillum 2\n`;
    if (expIsTrans(e.mesh)) mtl += `d ${expNum(expOpacity(e.mesh))}\nTr ${expNum(1 - expOpacity(e.mesh))}\n`;
    if (e.texFile) mtl += `map_Kd ${e.texFile.file}\n`;
    mtl += '\n';
  });
  const files = [
    { name: 'model.obj', data: new TextEncoder().encode(obj) },
    { name: 'model.mtl', data: new TextEncoder().encode(mtl) },
  ];
  for (const [, tf] of texFiles) files.push({ name: tf.file, data: tf.data });
  const zip = expZip(files);
  expDownload(new Blob([zip], { type: 'application/zip' }), 'sky-outfit.obj.zip');
}

/* ================================================================
 * GLB（glTF 2.0 二进制，静态烘焙姿态）
 * ================================================================ */
async function exportGLB() {
  const parts = expCollectParts();
  if (!parts.length) { alert('当前没有可导出的模型'); return; }
  const baked = [];
  for (const mesh of parts) baked.push({ b: expBakeMesh(mesh), mesh });

  const json = {
    asset: { version: '2.0', generator: 'SKY-YIGUI-Web' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
  };
  const binChunks = [];
  let binLen = 0;
  const pushBin = (u8) => {
    const byteLen = u8.byteLength || u8.length; // TypedArray -> byteLength; Uint8Array -> 等同 length
    const pad = (4 - (byteLen % 4)) % 4;
    const buf = new Uint8Array(byteLen + pad);
    if (u8 instanceof Uint8Array) buf.set(u8);
    else buf.set(new Uint8Array(u8.buffer, u8.byteOffset, byteLen)); // 按字节拷贝任意 TypedArray
    binChunks.push(buf);
    binLen += buf.length;
    return buf;
  };
  const matIndex = new Map(); // key(texUuid|color) -> material idx
  const imgIndex = new Map(); // texUuid -> image idx
  const texIndex = new Map(); // texUuid -> texture idx

  let mi = 0;
  for (const { b, mesh } of baked) {
    const prim = { attributes: {} };
    const addAcc = (data, count, compType, type, minMax) => {
      const view = pushBin(data);
      const bvIdx = json.bufferViews.length;
      json.bufferViews.push({ buffer: 0, byteOffset: binLen - view.length, byteLength: data.byteLength });
      const acc = { bufferView: bvIdx, componentType: compType, count, type };
      if (minMax) { acc.min = minMax.min; acc.max = minMax.max; }
      json.accessors.push(acc);
      return json.accessors.length - 1;
    };
    // POSITION
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < b.vCount; i++) {
      for (let k = 0; k < 3; k++) {
        const v = b.pos[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    prim.attributes.POSITION = addAcc(b.pos, b.vCount, 5126, 'VEC3', { min, max });
    if (b.nrm) prim.attributes.NORMAL = addAcc(b.nrm, b.vCount, 5126, 'VEC3');
    if (b.uv) prim.attributes.TEXCOORD_0 = addAcc(b.uv, b.vCount, 5126, 'VEC2');
    if (b.idx) {
      const is32 = b.idx.length && Math.max(...b.idx) > 65535;
      let idxData;
      let compType;
      if (is32) { idxData = b.idx instanceof Uint32Array ? b.idx : new Uint32Array(b.idx); compType = 5125; }
      else { idxData = b.idx instanceof Uint16Array ? b.idx : new Uint16Array(b.idx); compType = 5123; }
      prim.indices = addAcc(idxData, b.idx.length, compType, 'SCALAR');
    }
    // 材质
    const tex = expMatTex(mesh);
    const c = expMatColor(mesh);
    const _tr = expIsTrans(mesh);
    const _op = expOpacity(mesh);
    let key = (tex ? 't:' + tex.uuid : 'c:' + c.join(',')) + (_tr ? ':tr' : '');
    if (!matIndex.has(key)) {
      const pbr = { metallicFactor: 0, roughnessFactor: 1, baseColorFactor: [c[0], c[1], c[2], _tr ? _op : 1] };
      if (tex) {
        if (!imgIndex.has(tex.uuid)) {
          const cv = expTexToCanvas(tex);
          if (cv) {
            const blob = await expCanvasToBlob(cv);
            const u8 = new Uint8Array(await blob.arrayBuffer());
            const pad4 = (4 - (u8.length % 4)) % 4;
            const view = new Uint8Array(u8.length + pad4);
            view.set(u8);
            binChunks.push(view);
            binLen += view.length;
            json.bufferViews.push({ buffer: 0, byteOffset: binLen - view.length, byteLength: u8.length });
            json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' });
            json.textures.push({ sampler: 0, source: json.images.length - 1 });
            imgIndex.set(tex.uuid, json.images.length - 1);
            texIndex.set(tex.uuid, json.textures.length - 1);
          }
        }
        if (texIndex.has(tex.uuid)) {
          pbr.baseColorTexture = { index: texIndex.get(tex.uuid) };
        }
      }
      json.materials.push({ name: 'mat_' + mi, pbrMetallicRoughness: pbr, doubleSided: true, alphaMode: _tr ? 'BLEND' : 'OPAQUE' });
      matIndex.set(key, json.materials.length - 1);
    }
    prim.material = matIndex.get(key);
    json.meshes.push({ primitives: [prim] });
    json.nodes.push({ mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
    mi++;
  }

  json.buffers[0].byteLength = binLen;
  const jsonStr = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonFull = new Uint8Array(jsonBytes.length + jsonPad);
  jsonFull.set(jsonBytes);
  jsonFull.fill(0x20, jsonBytes.length);

  const binFull = new Uint8Array(binLen);
  let p = 0;
  for (const c of binChunks) { binFull.set(c, p); p += c.length; }

  const total = 12 + 8 + jsonFull.length + 8 + binFull.length;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546C67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonFull.length, true);
  dv.setUint32(16, 0x4E4F534A, true); // JSON
  glb.set(jsonFull, 20);
  dv.setUint32(20 + jsonFull.length, binFull.length, true);
  dv.setUint32(24 + jsonFull.length, 0x004E4942, true); // BIN
  glb.set(binFull, 28 + jsonFull.length);
  expDownload(new Blob([glb], { type: 'model/gltf-binary' }), 'sky-outfit.glb');
}

/* ================================================================
 * 带骨骼 GLB 导出（Skinned GLB）
 * 数据源：
 *   - 骨骼层级/名称/绑定矩阵：animState.skinnedParts[].skeletonBones
 *   - 当前动画姿势（游戏坐标世界矩阵）：material.userData.boneData
 *   - 顶点权重：geometry boneIndices / boneWeights
 * 结构：
 *   - 骨骼 node = 当前姿势（local = curWorld ÷ 父 curWorld）
 *   - skin.IBM = 绑定姿势世界逆（skeletonBones.matrix × group）⁻¹
 *   - 蒙皮 mesh 顶点 = 绑定姿势（模型空间），mesh node 挂 group(1/15+π) 变换
 * 效果：静态显示即当前站姿；Blender/其他工具打开带骨骼、可编辑、蒙皮跟随。
 * ================================================================ */
async function exportGLBSkinned() {
  const parts = expCollectParts();
  if (!parts.length) { alert('当前没有可导出的模型'); return; }
  const G = -1 / 15;
  const groupM = new Float32Array([G, 0, 0, 0, 0, 1 / 15, 0, 0, 0, 0, G, 0, 0, 0, 0, 1]);

  const spList = (typeof animState !== 'undefined' && animState.skinnedParts) ? animState.skinnedParts : [];
  const byMesh = new Map();
  for (const sp of spList) if (sp && sp.mesh) byMesh.set(sp.mesh, sp);
  const skinned = parts.filter(p => p.geometry.attributes.boneIndices && byMesh.has(p));
  const statics = parts.filter(p => !skinned.includes(p));

  const json = {
    asset: { version: '2.0', generator: 'SKY-YIGUI-Web skinned' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    skins: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
  };
  const binChunks = [];
  let binLen = 0;
  const pushBin = (u8) => {
    const byteLen = u8.byteLength || u8.length;
    const pad = (4 - (byteLen % 4)) % 4;
    const buf = new Uint8Array(byteLen + pad);
    if (u8 instanceof Uint8Array) buf.set(u8);
    else buf.set(new Uint8Array(u8.buffer, u8.byteOffset, byteLen));
    binChunks.push(buf);
    binLen += buf.length;
    return buf;
  };
  const addAcc = (data, count, compType, type, minMax) => {
    const view = pushBin(data);
    json.bufferViews.push({ buffer: 0, byteOffset: binLen - view.length, byteLength: data.byteLength });
    const acc = { bufferView: json.bufferViews.length - 1, componentType: compType, count, type };
    if (minMax) { acc.min = minMax.min; acc.max = minMax.max; }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };

  /* ---- 合并骨骼 → 基础 MMD 骨架（腰/上半身×2/首/頭 + 肩腕肘手 + 足膝踝趾；
   *      无重心链/捩り/両目；光遇附加骨骼保留原名挂链；权重重映射到新骨架）
   *  ---- */
  const mmd = expBuildMMDSkeleton(skinned, byMesh);
  // 光遇骨骼绑定空间与组件本地顶点左右相反（骨骼 L 在 +x，顶点左腿在 -x）：
  // 骨骼 pos 翻 x（左足 → -x=左腿侧），顶点保持组件本地原样，使骨骼与蒙皮同侧。
  for (const b of mmd.bones) b.pos = [-b.pos[0], b.pos[1], b.pos[2]];
  const boneRecs = [];   // {name, parentNode, bindM, curM}
  const partSkin = [];   // {joints:[MMD idx], srcName:[部件骨骼名]}
  for (const mesh of skinned) {
    const sp = byMesh.get(mesh);
    const bones = (sp && sp.skeletonBones) || [];
    const data = mesh.material.userData.boneData;
    if (!data) continue;
    // 部件骨骼名 → 该部件内的 src 索引映射（用于权重）
    const nameToSrc = new Map();
    for (let i = 0; i < bones.length; i++) nameToSrc.set(bones[i].name, i);
    const joints = [];
    for (let i = 0; i < bones.length; i++) {
      const mmdIdx = mmd.srcToMmd[bones[i].name];
      if (mmdIdx === undefined || joints.includes(mmdIdx)) continue;
      joints.push(mmdIdx);
    }
    partSkin.push({ joints, nameToSrc });
  }
  // 虚拟根节点：作为 skin.skeleton（Blender 将其作为 armature 对象而非骨骼），
  // 使操作中心等顶层骨骼能作为 joints 祖先链被完整导入
  const rootNodeIdx = json.nodes.length;
  json.nodes.push({ name: 'Root', children: [] });
  json.scenes[0].nodes.push(rootNodeIdx);
  // MMD 骨骼 node：local = inv(parentBind) × childBind（纯平移，绑定姿势），IBM = inv(bindM)
  const boneNodeIdx = [];
  for (let i = 0; i < mmd.bones.length; i++) {
    const rec = mmd.bones[i];
    const T = (p) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1]);
    const local = (rec.parent !== null && rec.parent >= 0)
      ? expMul4(expInvert4(T(mmd.bones[rec.parent].pos)), T(rec.pos))
      : T(rec.pos);
    const node = { name: rec.name, matrix: Array.from(local).map(v => Math.round(v * 1e6) / 1e6) };
    boneNodeIdx.push(json.nodes.length);
    json.nodes.push(node);
  }
  for (let i = 0; i < mmd.bones.length; i++) {
    const p = mmd.bones[i].parent;
    if (p !== null && p >= 0) {
      if (!json.nodes[boneNodeIdx[p]].children) json.nodes[boneNodeIdx[p]].children = [];
      json.nodes[boneNodeIdx[p]].children.push(boneNodeIdx[i]);
    } else {
      if (!json.nodes[rootNodeIdx].children) json.nodes[rootNodeIdx].children = [];
      json.nodes[rootNodeIdx].children.push(boneNodeIdx[i]);
    }
  }

  /* ---- 材质（与 exportGLB 同逻辑） ---- */
  const matIndex = new Map(), imgIndex = new Map(), texIndex = new Map();
  let mi = 0;
  const addMaterial = async (mesh) => {
    const tex = expMatTex(mesh);
    const c = expMatColor(mesh);
    const _tr = expIsTrans(mesh);
    const _op = expOpacity(mesh);
    const key = (tex ? 't:' + tex.uuid : 'c:' + c.join(',')) + (_tr ? ':tr' : '');
    if (matIndex.has(key)) return matIndex.get(key);
    const pbr = { metallicFactor: 0, roughnessFactor: 1, baseColorFactor: [c[0], c[1], c[2], _tr ? _op : 1] };
    if (tex) {
      if (!imgIndex.has(tex.uuid)) {
        const cv = expTexToCanvas(tex);
        if (cv) {
          const blob = await expCanvasToBlob(cv);
          const u8 = new Uint8Array(await blob.arrayBuffer());
          const pad4 = (4 - (u8.length % 4)) % 4;
          const view = new Uint8Array(u8.length + pad4);
          view.set(u8);
          binChunks.push(view);
          binLen += view.length;
          json.bufferViews.push({ buffer: 0, byteOffset: binLen - view.length, byteLength: u8.length });
          json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' });
          json.textures.push({ sampler: 0, source: json.images.length - 1 });
          imgIndex.set(tex.uuid, json.images.length - 1);
          texIndex.set(tex.uuid, json.textures.length - 1);
        }
      }
      if (texIndex.has(tex.uuid)) pbr.baseColorTexture = { index: texIndex.get(tex.uuid) };
    }
    json.materials.push({ name: 'mat_' + mi, pbrMetallicRoughness: pbr, doubleSided: true, alphaMode: _tr ? 'BLEND' : 'OPAQUE' });
    matIndex.set(key, json.materials.length - 1);
    return json.materials.length - 1;
  };

  /* ---- 蒙皮 mesh（标准绑定姿势：顶点=组件本地原样（不镜像），
   *      JOINTS 权重映射到 MMD 骨架，mesh 无变换） ---- */
  for (let si = 0; si < skinned.length; si++) {
    const mesh = skinned[si];
    const geo = mesh.geometry;
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
    const uv = geo.attributes.uv ? geo.attributes.uv.array : null;
    const idx = geo.index ? geo.index.array : null;
    const vCount = pos.length / 3;
    const bi = geo.attributes.boneIndices.array;
    const bw = geo.attributes.boneWeights.array;
    const bones = (byMesh.get(mesh) && byMesh.get(mesh).skeletonBones) || [];
    const jl = partSkin[si].joints.length;
    // 部件 src 索引 → skin.joints 列表内位置
    const srcToPos = new Uint16Array(65536).fill(0);
    const nameToSrc = partSkin[si].nameToSrc;
    for (const [nm, srcI] of nameToSrc) {
      const mmdIdx = mmd.srcToMmd[nm];
      if (mmdIdx === undefined) continue;
      const p = partSkin[si].joints.indexOf(mmdIdx);
      if (p >= 0) srcToPos[srcI] = p;
    }
    const need16 = (jl > 255);
    const jointsArr = need16 ? new Uint16Array(vCount * 4) : new Uint8Array(vCount * 4);
    const weightsArr = new Float32Array(vCount * 4);
    for (let i = 0; i < vCount * 4; i++) {
      const bi2 = bi[i];
      jointsArr[i] = (bi2 >= 0 && bi2 < srcToPos.length) ? srcToPos[bi2] : 0;
      weightsArr[i] = Number.isFinite(bw[i]) ? bw[i] : 0;
    }
    // 绑定姿势顶点/法线：组件本地原样（光遇原始：左腿在 -x、面向 +z；骨骼 pos 已翻 x 与顶点同侧）
    const outPos = new Float32Array(pos.length);
    for (let i = 0; i < vCount; i++) {
      outPos[i * 3] = pos[i * 3];
      outPos[i * 3 + 1] = pos[i * 3 + 1];
      outPos[i * 3 + 2] = pos[i * 3 + 2];
    }
    let outNrm = null;
    if (nrm) {
      outNrm = new Float32Array(nrm.length);
      for (let i = 0; i < vCount; i++) {
        const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        outNrm[i * 3] = nx / l; outNrm[i * 3 + 1] = ny / l; outNrm[i * 3 + 2] = nz / l;
      }
    }
    let outUv = null;
    if (uv) {
      outUv = new Float32Array(uv.length);
      for (let i = 0; i < uv.length; i++) outUv[i] = Number.isFinite(uv[i]) ? uv[i] : 0;
    }
    const prim = { attributes: {} };
    const pmin = [1e9, 1e9, 1e9], pmax = [-1e9, -1e9, -1e9];
    for (let i = 0; i < vCount; i++) for (let k = 0; k < 3; k++) {
      const v = outPos[i * 3 + k];
      if (v < pmin[k]) pmin[k] = v;
      if (v > pmax[k]) pmax[k] = v;
    }
    prim.attributes.POSITION = addAcc(outPos, vCount, 5126, 'VEC3', { min: pmin, max: pmax });
    if (outNrm) prim.attributes.NORMAL = addAcc(outNrm, vCount, 5126, 'VEC3');
    if (outUv) prim.attributes.TEXCOORD_0 = addAcc(outUv, vCount, 5126, 'VEC2');
    prim.attributes.JOINTS_0 = addAcc(jointsArr, vCount, need16 ? 5123 : 5121, 'VEC4');
    prim.attributes.WEIGHTS_0 = addAcc(weightsArr, vCount, 5126, 'VEC4');
    if (idx) {
      const is32 = idx.length && Math.max(...idx) > 65535;
      const idxData = is32 ? (idx instanceof Uint32Array ? idx : new Uint32Array(idx)) : (idx instanceof Uint16Array ? idx : new Uint16Array(idx));
      prim.indices = addAcc(idxData, idx.length, is32 ? 5125 : 5123, 'SCALAR');
    }
    prim.material = await addMaterial(mesh);
    // IBM = inv(T(bindPos))（MMD 骨架，顶点/骨骼/IBM 全同空间，静止蒙皮恒等）
    const ibm = new Float32Array(jl * 16);
    const T = (p) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1]);
    for (let j = 0; j < jl; j++) {
      ibm.set(expInvert4(T(mmd.bones[partSkin[si].joints[j]].pos)), j * 16);
    }
    const ibmView = pushBin(ibm);
    json.bufferViews.push({ buffer: 0, byteOffset: binLen - ibmView.length, byteLength: ibm.byteLength });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: jl, type: 'MAT4' });
    const ibmAcc = json.accessors.length - 1;
    json.skins.push({ joints: partSkin[si].joints.map(i => boneNodeIdx[i]), inverseBindMatrices: ibmAcc, skeleton: rootNodeIdx });
    const skinIdx = json.skins.length - 1;
    json.meshes.push({ primitives: [prim] });
    // mesh node 无变换：顶点为组件本地原样，与骨骼绑定位置/IBM 同空间
    json.nodes.push({ mesh: json.meshes.length - 1, skin: skinIdx });
    json.scenes[0].nodes.push(json.nodes.length - 1);
    mi++;
  }

  /* ---- 静态 mesh（烘焙，含 group） ---- */
  for (const mesh of statics) {
    const b = expBakeMesh(mesh);
    const prim = { attributes: {} };
    const pmin = [1e9, 1e9, 1e9], pmax = [-1e9, -1e9, -1e9];
    for (let i = 0; i < b.vCount; i++) for (let k = 0; k < 3; k++) {
      const v = b.pos[i * 3 + k];
      if (v < pmin[k]) pmin[k] = v;
      if (v > pmax[k]) pmax[k] = v;
    }
    prim.attributes.POSITION = addAcc(b.pos, b.vCount, 5126, 'VEC3', { min: pmin, max: pmax });
    if (b.nrm) prim.attributes.NORMAL = addAcc(b.nrm, b.vCount, 5126, 'VEC3');
    if (b.uv) prim.attributes.TEXCOORD_0 = addAcc(b.uv, b.vCount, 5126, 'VEC2');
    if (b.idx) {
      const is32 = b.idx.length && Math.max(...b.idx) > 65535;
      const idxData = is32 ? (b.idx instanceof Uint32Array ? b.idx : new Uint32Array(b.idx)) : (b.idx instanceof Uint16Array ? b.idx : new Uint16Array(b.idx));
      prim.indices = addAcc(idxData, b.idx.length, is32 ? 5125 : 5123, 'SCALAR');
    }
    prim.material = await addMaterial(mesh);
    json.meshes.push({ primitives: [prim] });
    json.nodes.push({ mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
    mi++;
  }

  /* ---- 动画段（v=an 起移除）：Blender 导入带动画 glTF 会在 pose 残留动画值导致
   *      蒙皮显示异常；页面默认站姿与绑定姿势一致，纯绑定姿势导出最稳。
   *      需要摆姿势时用户直接在 Blender 里编辑骨骼即可（标准骨骼层级）。 ---- */

  json.buffers[0].byteLength = binLen;
  const jsonStr = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonFull = new Uint8Array(jsonBytes.length + jsonPad);
  jsonFull.set(jsonBytes);
  jsonFull.fill(0x20, jsonBytes.length);
  const binFull = new Uint8Array(binLen);
  let p = 0;
  for (const c of binChunks) { binFull.set(c, p); p += c.length; }
  const total = 12 + 8 + jsonFull.length + 8 + binFull.length;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546C67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonFull.length, true);
  dv.setUint32(16, 0x4E4F534A, true);
  glb.set(jsonFull, 20);
  dv.setUint32(20 + jsonFull.length, binFull.length, true);
  dv.setUint32(24 + jsonFull.length, 0x004E4942, true);
  glb.set(binFull, 28 + jsonFull.length);
  expDownload(new Blob([glb], { type: 'model/gltf-binary' }), 'sky-outfit-skinned.glb');
}
