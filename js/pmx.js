/* ===== pmx.js — 当前穿搭导出为 MMD PMX 2.0（zip：model.pmx + 纹理 PNG） =====
 * 原理：与带骨骼 GLB 共用同一条数据管线——
 *   骨骼 = 解包自光遇 mesh 文件内嵌骨架（skeletonBones：名称/父层级/绑定矩阵），
 *   顶点权重 = 模型自带 4 通道骨权（boneIndices/boneWeights）。
 * 导出内容：
 *   - 顶点 = 烘焙当前站姿（世界坐标），保证打开即所见姿势
 *   - 骨骼 = 合并当前穿搭全部蒙皮部件骨骼；位置 = 当前动画姿势平移；层级保留
 *   - 权重 = BDEF4（4 骨骼 × 权重），MMD 中可编辑骨骼、蒙皮近似跟随
 *   - 材质 = 每部件一材质，纹理导出为同名 PNG（zip 内相对路径引用）
 */
'use strict';

function pmxWriter() {
  const chunks = [];
  const enc = new TextEncoder();
  const u8 = (v) => chunks.push(new Uint8Array([v & 255]));
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xFFFF, true); chunks.push(b); };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); chunks.push(b); };
  const f32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); chunks.push(b); };
  // PMX 字符串：UTF-16LE（MMD 原生标准），长度 = 字节数
  const str = (s) => {
    s = s || '';
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[i * 2] = c & 0xFF;
      b[i * 2 + 1] = (c >> 8) & 0xFF;
    }
    u32(b.length);
    chunks.push(b);
  };
  const raw = (b) => chunks.push(b);
  const out = () => {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const o = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { o.set(c, p); p += c.length; }
    return o;
  };
  return { u8, u16, u32, f32, str, raw, out };
}

async function exportPMX() {
  const parts = expCollectParts();
  if (!parts.length) { alert('当前没有可导出的模型'); return; }
  const G = -1 / 15;
  const groupM = new Float32Array([G, 0, 0, 0, 0, 1 / 15, 0, 0, 0, 0, G, 0, 0, 0, 0, 1]);

  const spList = (typeof animState !== 'undefined' && animState.skinnedParts) ? animState.skinnedParts : [];
  const byMesh = new Map();
  for (const sp of spList) if (sp && sp.mesh) byMesh.set(sp.mesh, sp);
  const skinned = parts.filter(p => p.geometry.attributes.boneIndices && byMesh.has(p));
  const statics = parts.filter(p => !skinned.includes(p));

  /* ---- MMD 万能骨架（不镜像，光遇原始坐标 Y-up：L 在 -x、面向 +z）
   *      位置 = 绑定姿势位置 × 1/15（与 expBakeBind 顶点同空间） ---- */
  const mmd = expBuildMMDSkeleton(skinned, byMesh);
  const gs = 1 / 15;
  // 顶点经 expBakeBind 镜像（左腿 +x），骨骼同样 +1/15 正缩放（左足 +x）——两侧一致
  const bones = mmd.bones.map(b => ({
    name: b.name,
    parent: b.parent !== null && b.parent >= 0 ? b.parent : -1,
    x: b.pos[0] * gs, y: b.pos[1] * gs, z: b.pos[2] * gs,
    ik: b.ik || null,
  }));
  if (!bones.length) {
    bones.push({ name: 'Root', parent: -1, x: 0, y: 0, z: 0 });
  }

  /* ---- 烘焙部件（世界坐标顶点/法线/UV/索引）+ 材质 ---- */
  const texFiles = new Map(); // tex.uuid -> {file, data}
  let texIdx = 0;
  // 部件 src 骨骼名（用于权重重映射到 MMD 骨架）
  const srcNameOf = new Map();
  for (const mesh of skinned) {
    const sp = byMesh.get(mesh);
    const bs = (sp && sp.skeletonBones) || [];
    srcNameOf.set(mesh, bs.map(b => b.name));
  }
  const getTex = async (mesh) => {
    const tex = expMatTex(mesh);
    if (!tex) return null;
    if (!texFiles.has(tex.uuid)) {
      const c = expTexToCanvas(tex);
      if (c) {
        const blob = await expCanvasToBlob(c);
        const ab = await blob.arrayBuffer();
        const file = 'tex' + texIdx + '.png';
        texFiles.set(tex.uuid, { file, data: new Uint8Array(ab) });
        texIdx++;
      }
    }
    const rec = texFiles.get(tex.uuid);
    return rec ? rec.file : null;
  };

  const mats = [];   // {name, r,g,b,a, tex, triCount}
  const matOf = new Map(); // mesh -> mat idx
  let matIdx = 0;
  const partsBaked = [];
  for (const mesh of parts) {
    // 蒙皮部件用绑定姿势（与骨骼同空间）；静态部件烘焙即绑定姿势
    const b = expBakeBind(mesh);
    const texFile = await getTex(mesh);
    const c = expMatColor(mesh);
    const key = texFile || 'c' + c.join(',');
    let mIdx = matOf.get(key);
    if (mIdx === undefined) {
      mIdx = mats.length;
      mats.push({ name: 'mat_' + matIdx, r: c[0], g: c[1], b: c[2], a: 1, tex: texFile, triCount: 0 });
      matOf.set(key, mIdx);
      matIdx++;
    }
    partsBaked.push({ mesh, b, mIdx });
  }

  /* ---- 组装 PMX ---- */
  const w = pmxWriter();
  // 头部（PMX 2.0 标准：flags=8 在最前，随后 8 个配置字节，共 9 字节）
  w.raw(new TextEncoder().encode('PMX '));
  w.f32(2.0);
  w.u8(8);  // flags（固定 8）
  w.u8(0);  // 编码 0=UTF-16LE（PMX 官方 & mmd_tools 一致；1 是 UTF-8）
  w.u8(0);  // 附加 UV 数
  w.u8(4);  // 顶点索引尺寸
  w.u8(4);  // 纹理索引尺寸
  w.u8(4);  // 材质索引尺寸
  w.u8(4);  // 骨骼索引尺寸
  w.u8(4);  // 变形索引尺寸
  w.u8(4);  // 刚体索引尺寸
  w.str('SKY-YIGUI-Web');          // 模型名
  w.str('SKY YIGUI Web');       // 英文名
  w.str('Sky outfit export from SKY-YIGUI-Web'); // 注释
  w.str('Exported from SKY-YIGUI-Web');          // 英文注释

  // 顶点（权重映射到 MMD 万能骨架全局骨骼索引）
  const skSet = new Set(skinned);
  let vtxCount = 0;
  for (const { b } of partsBaked) vtxCount += b.vCount;
  w.u32(vtxCount);
  const partVtxOffset = [];
  let vOff = 0;
  for (const { mesh, b, mIdx } of partsBaked) {
    partVtxOffset.push({ mesh, b, mIdx, off: vOff });
    const pos = b.pos, nrm = b.nrm, uv = b.uv;
    const geo = mesh.geometry;
    const isSk = skSet.has(mesh);
    const bi = isSk ? geo.attributes.boneIndices.array : null;
    const bw = isSk ? geo.attributes.boneWeights.array : null;
    for (let i = 0; i < b.vCount; i++) {
      w.f32(pos[i * 3]); w.f32(pos[i * 3 + 1]); w.f32(pos[i * 3 + 2]);
      if (nrm) { w.f32(nrm[i * 3]); w.f32(nrm[i * 3 + 1]); w.f32(nrm[i * 3 + 2]); }
      else { w.f32(0); w.f32(1); w.f32(0); }
      if (uv) { w.f32(Number.isFinite(uv[i * 2]) ? uv[i * 2] : 0); w.f32(Number.isFinite(uv[i * 2 + 1]) ? uv[i * 2 + 1] : 0); }
      else { w.f32(0); w.f32(0); }
      if (isSk) {
        const o = i * 4;
        // 有效骨骼数 → 混合 BDEF1/BDEF2/BDEF4（标准 MMD，参考芙宁娜权重类型）
        // 权重骨骼：部件 src 索引 → 骨骼名 → MMD 万能骨架全局索引
        const names = srcNameOf.get(mesh) || [];
        const active = [];
        for (let j = 0; j < 4; j++) {
          const wj = bw[o + j];
          if (wj <= 0 || bi[o + j] < 0 || bi[o + j] >= names.length) continue;
          const mmdIdx = mmd.srcToMmd[names[bi[o + j]]];
          if (mmdIdx === undefined) continue;
          active.push([mmdIdx, wj]);
        }
        let wsum = 0;
        for (const [, wj] of active) wsum += wj;
        if (!active.length || wsum <= 0) { // 无权重顶点：BDEF4 绑根骨骼（权重 1,0,0,0）
          w.u8(2);
          w.u32(0); w.u32(0); w.u32(0); w.u32(0);
          w.f32(1); w.f32(0); w.f32(0); w.f32(0);
        } else if (active.length === 1) {
          // 单骨骼：BDEF4 绑 1 骨（权重 1,0,0,0）。不用 BDEF1——mmd_tools 的 BDEF1 不读权重字节，会错位
          w.u8(2);
          w.u32(active[0][0]); w.u32(active[0][0]); w.u32(active[0][0]); w.u32(active[0][0]);
          w.f32(1); w.f32(0); w.f32(0); w.f32(0);
        } else if (active.length === 2) {
          // 双骨骼：BDEF4（2 骨权重 + 补 0）。不用 BDEF2——mmd_tools 的 BDEF2 读取与规范偏移不一致
          w.u8(2);
          w.u32(active[0][0]); w.u32(active[1][0]); w.u32(0); w.u32(0);
          w.f32(active[0][1] / wsum); w.f32(active[1][1] / wsum); w.f32(0); w.f32(0);
        } else {
          w.u8(2); // BDEF4（补零到 4 通道）
          for (let j = 0; j < 4; j++) w.u32(j < active.length ? active[j][0] : 0);
          for (let j = 0; j < 4; j++) w.f32(j < active.length ? active[j][1] / wsum : 0);
        }
      } else {
        // 非蒙皮部件：BDEF4 绑根骨骼（权重 1,0,0,0）。不用 BDEF1——mmd_tools 的 BDEF1 不读权重字节
        w.u8(2);
        w.u32(0); w.u32(0); w.u32(0); w.u32(0);
        w.f32(1); w.f32(0); w.f32(0); w.f32(0);
      }
      w.f32(0); // 边缘大小
    }
    vOff += b.vCount;
  }

  // 面（三角形索引；PMX 规范 face count = 索引总数 = 3×三角形数）
  let faceCount = 0;
  for (const { b } of partsBaked) {
    const idx = b.idx || new Uint32Array(b.vCount).map((_, j) => j);
    faceCount += Math.floor(idx.length / 3);
  }
  w.u32(faceCount * 3);
  for (const { b, off } of partVtxOffset) {
    const idx = b.idx || new Uint32Array(b.vCount).map((_, j) => j);
    for (let j = 0; j + 2 < idx.length; j += 3) {
      w.u32(off + idx[j]); w.u32(off + idx[j + 1]); w.u32(off + idx[j + 2]);
    }
  }

  // 纹理（名称表）
  const texNames = Array.from(texFiles.values()).map(r => r.file);
  w.u32(texNames.length);
  for (const t of texNames) w.str(t);

  // 材质
  const triOfPart = new Map();
  for (const { b, mIdx } of partsBaked) {
    const idx = b.idx || new Uint32Array(b.vCount).map((_, j) => j);
    const n = Math.floor(idx.length / 3);
    triOfPart.set(mIdx, (triOfPart.get(mIdx) || 0) + n);
  }
  w.u32(mats.length);
  for (let mi2 = 0; mi2 < mats.length; mi2++) {
    const m = mats[mi2];
    w.str(m.name); w.str(m.name);
    w.f32(m.r); w.f32(m.g); w.f32(m.b); w.f32(m.a); // diffuse（alpha 1）
    w.f32(0); w.f32(0); w.f32(0); w.f32(32);        // specular(0) + shininess 32（参考芙宁娜）
    w.f32(0.5); w.f32(0.5); w.f32(0.5);             // ambient 0.5（参考芙宁娜）
    w.u8(1);                                          // 材质 flags（bit0 双面）
    w.f32(0); w.f32(0); w.f32(0); w.f32(1);          // 边缘色
    w.f32(1);                                         // 边缘大小
    w.u32(m.tex ? texNames.indexOf(m.tex) : -1 >>> 0); // 纹理索引（-1）
    w.u32(0xFFFFFFFF);                                // 球贴索引 -1
    w.u8(0);                                          // 球贴模式
    w.u8(1);                                          // toon flag：共享 toon（mmd_tools 内置 toon 纹理）
    w.u8(1);                                          // 共享 toon 索引 1
    w.str('');                                        // 注释
    w.u32((triOfPart.get(mi2) || 0) * 3);            // 顶点数（面数×3）
  }

  // 骨骼（PMX 2.0 规范：flags(u16) 在连接数据之前；bit0=1 → 连接=骨骼索引，bit0=0 → 连接=偏移；bit5(0x0020)=IK）
  w.u32(bones.length);
  const boneIdxByName = new Map(bones.map((b, i) => [b.name, i]));
  for (const bn of bones) {
    w.str(bn.name); w.str(bn.name);
    w.f32(bn.x); w.f32(bn.y); w.f32(bn.z);          // 绑定姿势位置
    w.u32(bn.parent >= 0 ? bn.parent : 0xFFFFFFFF); // 父索引（-1）
    w.u32(0);                                       // 变换顺序
    let flags = 0x001E;                             // bit0=0 连接=偏移 + 可旋转+可移动+可见+可操作
    if (bn.ik) flags |= 0x0020;                     // IK 骨骼
    if (bn.joint) flags |= 0x0001;                  // 捩り骨骼：连接=父
    w.u16(flags);
    if (flags & 1) {
      w.u32(bn.parent >= 0 ? bn.parent : 0);        // 连接=父骨骼索引
    } else {
      w.f32(0); w.f32(0); w.f32(0);                 // 连接偏移
    }
    if (bn.ik) {
      const tIdx = boneIdxByName.get(bn.ik.target);
      w.u32(tIdx);
      w.u32(bn.ik.loop);
      w.f32(bn.ik.limit);
      w.u32(bn.ik.links.length);
      for (const l of bn.ik.links) {
        w.u32(boneIdxByName.get(l.bone));
        if (l.min) {
          w.u8(1);
          w.f32(l.min[0]); w.f32(l.min[1]); w.f32(l.min[2]);
          w.f32(l.max[0]); w.f32(l.max[1]); w.f32(l.max[2]);
        } else {
          w.u8(0);
        }
      }
    }
  }

  // 形态（空）
  w.u32(0);

  // 显示帧（PMX 帧元素：0=骨骼、1=变形；材质不属于帧元素）
  w.u32(1);
  w.str('Default'); w.str('Default');
  w.u8(0); // 非特殊帧
  w.u32(bones.length);
  for (let i = 0; i < bones.length; i++) { w.u8(0); w.u32(i); } // 0=骨骼

  // 刚体 / 约束（空）
  w.u32(0);
  w.u32(0);

  const pmx = w.out();
  const files = [{ name: 'model.pmx', data: pmx }];
  for (const r of texFiles.values()) files.push({ name: r.file, data: r.data });
  expDownload(new Blob([expZip(files)], { type: 'application/zip' }), 'sky-outfit-pmx.zip');
}
