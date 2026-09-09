/* ============================================================
 * Sky 衣柜 — 主逻辑
 * UI 风格：Field Journal（第三个 HTML 的橄榄绿/米白配色）
 * 渲染：游戏原版 ramp 着色器（skyMaterial）+ 环境预设灯光 + 阴影
 * 数据：本地打包 .mesh/.ktx/.animpack，无需导入 APK
 * ============================================================ */
'use strict';

/* ---------- sky-core.js 依赖的全局（原 app.js 状态） ---------- */
let colorOn = true;          // 全局上色开关
let wireframe = false;       // 线框开关
let animState = { pack: null, decoded: null, skinnedParts: [], frameCount: 1, time: 0, fps: 30, playing: false, entries: [], curIndex: -1, name: '' };

/* ---------- 全局状态 ---------- */
const W = {
  data: null,            // outfitdefs.min.json（slots 数组）
  category: 'body',
  worn: {},              // slotKey -> item
  visible: 72,
  search: '',
  envPreset: 'day',
  spinning: true,
  buildToken: 0,
  atlasMode: false,
  portraitMode: false,
};

/* ---------- 分类（第三个 HTML 的顺序与图标） ---------- */
const CAT_ORDER = [
  { id: 'body',  icon: 'UiOutfitBodyClassicPants',      iconFile: 'UiOutfitBodyClassicPants_100.png',      label: '身体' },
  { id: 'feet',  icon: 'UiOutfitFeetAP10Overalls',      iconFile: 'UiOutfitFeetAP10Overalls_100.png',      label: '鞋' },
  { id: 'mask',  icon: 'UiOutfitMaskBasic',             iconFile: 'UiOutfitMaskBasic_100.png',             label: '面具' },
  { id: 'face',  icon: 'UiOutfitMaskAP07Sunglasses',    iconFile: 'UiOutfitFaceAP28RoundGlasses_100.png',  label: '脸' },
  { id: 'neck',  icon: 'UiOutfitNeckAP07BowTie',        iconFile: 'UiOutfitNeckAP07BowTie_100.png',        label: '颈饰' },
  { id: 'hair',  icon: 'UiOutfitHairBraidSideSmall',    iconFile: 'UiOutfitHairBraidSideSmall_100.png',    label: '发型' },
  { id: 'hat',   icon: 'UiOutfitHatAP24ClassicEars',    iconFile: 'UiOutfitHatAP24ClassicEars_100.png',    label: '帽子' },
  { id: 'horn',  icon: 'UiOutfitHornAP09Yeti',          iconFile: 'UiOutfitHornAP09Yeti_100.png',          label: '头饰' },
  { id: 'wing',  icon: 'UiOutfitCape',                  iconFile: 'UiOutfitCape_30003030.png',             label: '斗篷' },
  { id: 'prop',  icon: 'UiOutfitPropHarp',              iconFile: 'UiOutfitPropHarp_100.png',              label: '道具' },
];

/* ---------- 环境预设（第三个 HTML 的天空衣柜灯光） ---------- */
const ENV_PRESETS = {
  dawn: {
    bg: 0x2b2431, fog: { color: 0x40323c, near: 3, far: 14 },
    ambient: 0x616b85, ambientInt: 0.55,
    dir: 0xff8c47, dirInt: 1.15, dirPos: [-5, 7, -6],
    dir2: 0x5973b3, dir2Int: 0.32, label: '黎明',
  },
  day: {
    bg: 0x4a6072, fog: null,
    ambient: 0x808c94, ambientInt: 0.6,
    dir: 0xfff2dc, dirInt: 1.5, dirPos: [-4, 8, -5],
    dir2: 0x7ab3e6, dir2Int: 0.5, label: '白天',
  },
  afternoon: {
    bg: 0x54473a, fog: { color: 0x4a3c30, near: 3.5, far: 16 },
    ambient: 0x6b666b, ambientInt: 0.5,
    dir: 0xffad59, dirInt: 1.35, dirPos: [5, 6, -4],
    dir2: 0x617ab3, dir2Int: 0.34, label: '午后',
  },
  night: {
    bg: 0x0d1122, fog: { color: 0x11162b, near: 3, far: 15 },
    ambient: 0x384061, ambientInt: 0.38,
    dir: 0x7394ff, dirInt: 0.85, dirPos: [-4, 7, -5],
    dir2: 0x334073, dir2Int: 0.25, label: '夜晚',
  },
};
const ENV_ORDER = ['dawn', 'day', 'afternoon', 'night'];

/* ---------- DOM ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const dom = {
  canvas: null, viewport: null, catBar: null, grid: null, search: null,
  wornList: null, btnEnv: null, btnSpin: null, btnReset: null, btnAspect: null,
  loading: null, empty: null, headTitle: null, envLabel: null, catCount: null,
};

/* ---------- 数据加载 ---------- */
async function loadData() {
  const r = await fetch('data/outfitdefs.min.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('outfitdefs 加载失败 ' + r.status);
  W.data = await r.json();
  // 过滤 NPC 技术资产（对齐第三个 HTML）
  for (const slot of W.data.slots) {
    slot.items = slot.items.filter(it =>
      !/^(NPC_|CharSkyNPC_)/.test(it.name) && !/^CharSkyNPC_/.test(it.mesh || ''));
  }
  buildCatBar();
  resetOutfit(false);
  buildOutfit();
  renderGrid();
}

/* ---------- 资产加载（fetch 替代 APK） ---------- */
const fetchCache = new Map();
async function fetchBytes(url) {
  if (fetchCache.has(url)) return fetchCache.get(url);
  const p = (async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('加载失败 ' + url + ' ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  })();
  fetchCache.set(url, p);
  return p;
}

const meshParseCache = new Map();
async function loadMeshParsed(meshFile) {
  if (meshParseCache.has(meshFile)) return meshParseCache.get(meshFile);
  const p = (async () => {
    const raw = await fetchBytes('meshes/' + meshFile);
    const data = readMesh(raw, meshFile);
    if (!data.vertices || !data.vertices.length) throw new Error(meshFile + ' 无几何');
    return data;
  })();
  meshParseCache.set(meshFile, p);
  return p;
}

const texCache = new Map();
async function loadTextureWeb(texName) {
  if (!texName) return null;
  const key = texName.toLowerCase();
  if (texCache.has(key)) return texCache.get(key);
  const p = (async () => {
    const raw = await fetchBytes('data/textures/' + key);
    const img = decodeKtx(raw);
    if (!img) return null;
    const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  })().catch(() => null);
  texCache.set(key, p);
  return p;
}
// 兼容 sky-core.js 中 buildPartMaterial 引用的 loadTexture / showTexture
const showTexture = true;
const loadTexture = loadTextureWeb;

/* ---------- 部件材质（复用 sky-core 的 buildPartMaterial） ---------- */
function itemToDef(item) {
  return {
    diffuseTex: item.diffuse || '',
    shader: item.shader || 'Avatar',
    base_hsv: item.baseHsv || null,
    color_override: item.colorOverride ? true : false,
  };
}

async function buildPartFor(item, canSkin, boneCount) {
  return buildPartMaterial(itemToDef(item), canSkin, boneCount || 0);
}

/* ---------- 穿戴偏移（第三个 HTML 的规则） ---------- */
// TGC 数据中 |x|≥0.9 或 |y|≥0.9 的偏移是无效占位（如颈饰的 wing=[1,1,1]），
// 直接忽略，否则斗篷会被错误移位（偶发错位的根因）。
function applyWearOffsets(mesh, item) {
  const v = new THREE.Vector3();
  const take = arr => {
    if (Array.isArray(arr)) {
      if (Math.abs(arr[0]) >= 0.9 || Math.abs(arr[1]) >= 0.9) return;
      v.add(new THREE.Vector3(arr[0], arr[1], arr[2]));
    }
  };
  switch (item.type) {
    case 'neck':
      take(W.worn.body && W.worn.body.offsets && W.worn.body.offsets.neck);
      break;
    case 'prop':
      // item 自身 propOffset 已在背部挂点处应用，这里只取 body 的 prop 偏移
      take(W.worn.body && W.worn.body.offsets && W.worn.body.offsets.prop);
      break;
    case 'wing':
      take((W.worn.neck && W.worn.neck.offsets && W.worn.neck.offsets.wing)
        || (W.worn.body && W.worn.body.offsets && W.worn.body.offsets.wing));
      break;
    case 'feet': {
      const y = Number(item.offsets && item.offsets.footY) || 0;
      if (y) v.y += y;
      break;
    }
  }
  if (v.x || v.y || v.z) mesh.position.add(v);
}

/* ---------- 3D 场景 ---------- */
let scene, camera, renderer, controls, outfitGroup, ground, shadowLight, fillLight, ambientLight;

function initThree() {
  if (scene) return;
  const canvas = dom.canvas;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width || 640);
  const h = Math.max(1, rect.height || 480);

  // 渲染器：游戏着色器自带色调曲线，关闭 three 自动色彩管理
  THREE.ColorManagement.enabled = false;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x4a6072);

  camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 100);
  camera.position.set(0, 0.5, -2.2);

  // 阴影主光
  shadowLight = new THREE.DirectionalLight(0xfff2dc, 1.5);
  shadowLight.position.set(-4, 8, -5);
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.width = 1024;
  shadowLight.shadow.mapSize.height = 1024;
  shadowLight.shadow.camera.near = 0.5;
  shadowLight.shadow.camera.far = 20;
  shadowLight.shadow.camera.left = -3;
  shadowLight.shadow.camera.right = 3;
  shadowLight.shadow.camera.top = 3;
  shadowLight.shadow.camera.bottom = -3;
  scene.add(shadowLight);

  fillLight = new THREE.DirectionalLight(0x7ab3e6, 0.5);
  fillLight.position.set(-2, 2, -1);
  scene.add(fillLight);

  ambientLight = new THREE.AmbientLight(0x808c94, 0.6);
  scene.add(ambientLight);

  // 阴影地面
  const groundGeo = new THREE.PlaneGeometry(10, 10);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.22 });
  ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.015;
  ground.receiveShadow = true;
  scene.add(ground);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.45, 0);
  controls.minDistance = 0.4;
  controls.maxDistance = 6;
  controls.enablePan = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2.0;
  controls.update();

  const animate = () => {
    requestAnimationFrame(animate);
    if (W.spinning) controls.autoRotate = true;
    controls.update();
    // 注意：不再重置 outfitGroup.rotation——buildOutfit 已把角色翻转 180°
    // 使正面朝向相机，背饰（道具）因此在角色背后。
    renderer.render(scene, camera);
  };
  animate();

  window.addEventListener('resize', resizeThree);
  new ResizeObserver(resizeThree).observe(dom.viewport);
}

function resizeThree() {
  if (!camera || !renderer || !dom.viewport) return;
  const rect = dom.viewport.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function applyEnv(preset) {
  W.envPreset = preset;
  const p = ENV_PRESETS[preset];
  if (!p) return;
  scene.background = new THREE.Color(p.bg);
  scene.fog = p.fog ? new THREE.Fog(p.fog.color, p.fog.near, p.fog.far) : null;

  ambientLight.color.setHex(p.ambient);
  ambientLight.intensity = p.ambientInt;
  shadowLight.color.setHex(p.dir);
  shadowLight.intensity = p.dirInt;
  shadowLight.position.set(...p.dirPos);
  fillLight.color.setHex(p.dir2);
  fillLight.intensity = p.dir2Int;

  // 同步游戏着色器光照 uniform（uAmbient/uKey/uFill/uLightDir）
  const hexToN = hx => new THREE.Vector3(((hx >> 16) & 255) / 255, ((hx >> 8) & 255) / 255, (hx & 255) / 255);
  const dirN = new THREE.Vector3(...p.dirPos).normalize();
  if (outfitGroup) {
    outfitGroup.traverse(o => {
      if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uAmbient) {
        o.material.uniforms.uAmbient.value.copy(hexToN(p.ambient).multiplyScalar(p.ambientInt));
        o.material.uniforms.uKey.value.copy(hexToN(p.dir).multiplyScalar(p.dirInt));
        o.material.uniforms.uFill.value.copy(hexToN(p.dir2).multiplyScalar(p.dir2Int));
        o.material.uniforms.uLightDir.value.copy(dirN);
      }
    });
  }
  if (dom.envLabel) dom.envLabel.textContent = p.label;
  if (dom.btnEnv) {
    dom.btnEnv.className = 'wiki-view-btn wiki-view-btn--env is-' + preset;
  }
}

/* ---------- 动画（待机站姿） ---------- */
async function loadIdlePose() {
  const raw = await fetchBytes('data/CharKidAnimGroundState.animpack');
  const ap = parseAnimPack(raw);
  const dec = decodeAnimation(ap);
  animState.pack = ap;
  animState.decoded = dec;
  animState.frameCount = (dec && dec.hasAnimation) ? dec.frameCount : 1;
  animState.time = 0;
  animState.playing = false;
  for (const part of animState.skinnedParts) {
    part.boneToAnim = buildBoneMapping(part.skeletonBones, ap);
  }
  applyAnimFrame(0);
}

/* ---------- 换装组装 ---------- */
function clearOutfit() {
  if (outfitGroup) {
    scene.remove(outfitGroup);
    outfitGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.dispose) o.material.dispose(); if (o.material.uniforms && o.material.uniforms.uBoneTexture && o.material.uniforms.uBoneTexture.value) o.material.uniforms.uBoneTexture.value.dispose(); }
    });
    outfitGroup = null;
  }
  animState.skinnedParts = [];
  animState.pack = null;
  animState.decoded = null;
}

async function buildOutfit() {
  initThree();
  const token = ++W.buildToken;
  showLoading(true);
  clearOutfit();

  const group = new THREE.Group();
  group.scale.setScalar(1 / 15);
  // 游戏网格正面朝 +z；翻转 180° 让正面朝向相机（-z），保持第三个 HTML 的相机与灯光不变
  group.rotation.y = Math.PI;
  outfitGroup = group;
  scene.add(group);

  const skinned = [];
  const slotOrder = ['body', 'mask', 'hair', 'hat', 'horn', 'face', 'neck', 'wing', 'feet', 'prop'];
  try {
    for (const slotKey of slotOrder) {
      const item = W.worn[slotKey];
      if (!item || item.none) continue;
      try {
        const data = await loadMeshParsed(item.meshFile);
        if (token !== W.buildToken) return;
        if (!data.vertices.length) continue;
        const geo = buildGeometry(data);
        const canSkin = !!(data.boneIndices && data.skeletonBones && data.skeletonBones.length);
        const mat = await buildPartFor(item, canSkin, canSkin ? data.skeletonBones.length : 0);
        if (token !== W.buildToken) { geo.dispose(); if (mat && mat.dispose) mat.dispose(); return; }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = slotKey;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 道具（无骨骼的）：挂背上 + 顶点尺度自适应。
        // 全量 420 件验证的规则：propScale≥1 → 顶点为游戏 15 尺度，scale=ps
        // （世界尺寸=extent×ps/15）；propScale<1 → 再按顶点 extent 分：
        // extent≥3（风筝/书/布偶等大坐标）scale=ps；extent<3（扫帚/伞/火炬等
        // 世界单位手持道具）scale=ps×15。propOffset 为相对背部挂点的微调。
        if (slotKey === 'prop' && !canSkin) {
          const ps = Number(item.offsets && item.offsets.propScale) || 1;
          const off = (item.offsets && item.offsets.prop) || [0, 0, 0];
          let scale = ps;
          if (ps < 1) {
            let mn0 = 1e9, mn1 = 1e9, mn2 = 1e9, mx0 = -1e9, mx1 = -1e9, mx2 = -1e9;
            const vs = data.vertices;
            for (let k = 0; k + 2 < vs.length; k += 3) {
              const a = vs[k], b = vs[k + 1], c = vs[k + 2];
              if (a < mn0) mn0 = a; if (a > mx0) mx0 = a;
              if (b < mn1) mn1 = b; if (b > mx1) mx1 = b;
              if (c < mn2) mn2 = c; if (c > mx2) mx2 = c;
            }
            const ext = Math.max(mx0 - mn0, mx1 - mn1, mx2 - mn2) || 0;
            scale = ext >= 3 ? ps : ps * 15;
          }
          mesh.scale.setScalar(scale);
          mesh.position.set(
            Array.isArray(off) ? off[0] : 0,
            9.3 + (Array.isArray(off) ? off[1] : 0),
            -4.2 + (Array.isArray(off) ? off[2] : 0)
          );
        }
        applyWearOffsets(mesh, item);
        group.add(mesh);
        if (canSkin) skinned.push({ mesh, geo, mat, skeletonBones: data.skeletonBones, boneToAnim: null });
      } catch (e) {
        console.warn('部件加载失败', slotKey, item.name, e);
      }
    }
  } catch (e) {
    console.error('换装失败', e);
  }
  if (token !== W.buildToken) return;

  animState.skinnedParts = skinned;
  if (skinned.length) {
    try { await loadIdlePose(); } catch (e) { console.warn('站姿加载失败', e); }
  }
  applyEnv(W.envPreset);
  showLoading(false);
  renderWornList();
}

function setLoading(v) {
  if (dom.loading) dom.loading.classList.toggle('is-loading', v);
}
function showLoading(v) {
  setLoading(v);
  if (v && dom.empty) dom.empty.style.display = 'none';
}

/* ---------- UI：分类栏 ---------- */
function buildCatBar() {
  if (!dom.catBar) return;
  dom.catBar.innerHTML = '';
  for (const cat of CAT_ORDER) {
    const slot = W.data.slots.find(s => s.key === cat.id);
    const btn = document.createElement('button');
    btn.className = 'wiki-cat-btn' + (cat.id === W.category ? ' is-active' : '');
    btn.dataset.cat = cat.id;
    btn.title = cat.label;
    btn.setAttribute('aria-label', cat.label);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = cat.iconFile ? 'icons/' + cat.iconFile : iconSrc(cat.icon);
    img.onerror = () => { img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='; };
    btn.appendChild(img);
    const cnt = document.createElement('span');
    cnt.className = 'wiki-cat-cnt';
    cnt.textContent = slot ? slot.items.length : 0;
    btn.appendChild(cnt);
    btn.addEventListener('click', () => {
      $$('.wiki-cat-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      W.category = cat.id;
      W.visible = 72;
      renderGrid();
    });
    dom.catBar.appendChild(btn);
  }
  if (dom.headTitle) dom.headTitle.textContent = '服装 · 衣柜';
  if (dom.catCount) {
    const slot = W.data.slots.find(s => s.key === W.category);
    dom.catCount.textContent = slot ? slot.items.length : 0;
  }
}

function iconSrc(iconName) {
  // 图集图标已在构建期按 iconHsv 染色导出
  return 'icons/' + iconName + '_100.png';
}
function itemIconSrc(item) {
  if (item.iconFile) return 'icons/' + item.iconFile;
  if (item.icon) return iconSrc(item.icon);
  return 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
}

/* ---------- UI：物品网格 ---------- */
function currentSlotItems() {
  const slot = W.data.slots.find(s => s.key === W.category);
  if (!slot) return [];
  let list = slot.items;
  const q = W.search.trim().toLowerCase();
  if (q) {
    list = list.filter(it =>
      (it.label || '').toLowerCase().includes(q) || (it.name || '').toLowerCase().includes(q));
  }
  return list;
}

function renderGrid() {
  if (!dom.grid) return;
  const list = currentSlotItems();
  if (dom.catCount) dom.catCount.textContent = list.length;
  if (dom.panelCount) dom.panelCount.textContent = list.length;
  const slice = list;
  dom.grid.innerHTML = '';
  if (!slice.length) {
    const p = document.createElement('p');
    p.className = 'wiki-grid-empty';
    p.textContent = '没有找到物品';
    dom.grid.appendChild(p);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of slice) {
    const btn = document.createElement('button');
    const worn = W.worn[item.type];
    const isActive = worn && worn.name === item.name;
    btn.className = 'wiki-icon-btn' + (isActive ? ' is-active' : '') + (item.none ? ' is-none' : '');
    btn.dataset.name = item.name;
    btn.title = item.label || item.name;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.src = itemIconSrc(item);
    img.onerror = () => { img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='; };
    btn.appendChild(img);
    btn.addEventListener('click', () => pickItem(item));
    frag.appendChild(btn);
  }
  dom.grid.appendChild(frag);
}

function bindGridScroll() {
  // 全部物品一次性渲染，网格容器本身滚动即可
}

/* ---------- UI：已穿列表 ---------- */
function renderWornList() {
  if (!dom.wornList) return;
  dom.wornList.innerHTML = '';
  const worn = CAT_ORDER.filter(c => W.worn[c.id]).map(c => W.worn[c.id]);
  if (!worn.length) {
    const p = document.createElement('div');
    p.className = 'wiki-worn-empty';
    p.textContent = '还没有穿上任何物品';
    dom.wornList.appendChild(p);
    return;
  }
  for (const item of worn) {
    const row = document.createElement('div');
    row.className = 'wiki-worn-item';
    const icon = document.createElement('div');
    icon.className = 'wiki-worn-icon';
    const img = document.createElement('img');
    img.alt = '';
    img.src = itemIconSrc(item);
    img.onerror = () => { img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='; };
    icon.appendChild(img);
    const info = document.createElement('div');
    info.className = 'wiki-worn-info';
    const tag = document.createElement('span');
    tag.className = 'wiki-worn-cat';
    const cat = CAT_ORDER.find(c => c.id === item.type);
    tag.textContent = cat ? cat.label : item.type;
    const name = document.createElement('span');
    name.className = 'wiki-worn-name';
    name.textContent = item.none ? '（不穿）' : (item.label || item.name);
    info.appendChild(tag);
    info.appendChild(name);
    const remove = document.createElement('button');
    remove.className = 'wiki-worn-remove';
    remove.textContent = '×';
    remove.title = '脱下';
    remove.addEventListener('click', () => {
      delete W.worn[item.type];
      // 若为身体部件且无其他身体可选，回退默认
      if (item.type === 'body' && !W.worn.body) {
        const def = findDefaultItem('body');
        if (def) W.worn.body = def;
      }
      renderGrid();
      buildOutfit();
    });
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(remove);
    dom.wornList.appendChild(row);
  }
}

/* ---------- 选择物品 ---------- */
function findDefaultItem(type) {
  const slot = W.data.slots.find(s => s.key === type);
  if (!slot) return null;
  return slot.items.find(it => it.isDefault && !it.none)
    || (type === 'body' ? slot.items.find(it => it.name === 'CharSkyKid_Body_ClassicShortPants' && !it.none) : null)
    || null;
}

function pickItem(item) {
  if (item.none) {
    delete W.worn[item.type];
  } else {
    W.worn[item.type] = item;
  }
  // 身体不能为空
  if (item.type === 'body' && !W.worn.body) {
    const def = findDefaultItem('body');
    if (def) W.worn.body = def;
  }
  renderGrid();
  buildOutfit();
}

function resetOutfit(rebuild = true) {
  W.worn = {};
  const def = findDefaultItem('body');
  if (def) W.worn.body = def;
  if (rebuild) {
    renderGrid();
    buildOutfit();
  }
}

/* ---------- 工具按钮 ---------- */
function bindTools() {
  dom.btnEnv && dom.btnEnv.addEventListener('click', () => {
    const cur = W.envPreset || 'day';
    const idx = ENV_ORDER.indexOf(cur);
    applyEnv(ENV_ORDER[(idx + 1) % ENV_ORDER.length]);
  });
  dom.btnSpin && dom.btnSpin.addEventListener('click', () => {
    W.spinning = !W.spinning;
    if (controls) controls.autoRotate = W.spinning;
    dom.btnSpin.classList.toggle('is-active', W.spinning);
  });
  dom.btnReset && dom.btnReset.addEventListener('click', () => {
    if (!controls) return;
    camera.position.set(0, 0.5, -2.2);
    controls.target.set(0, 0.45, 0);
    controls.update();
    applyEnv('day');
  });
  dom.btnAspect && dom.btnAspect.addEventListener('click', () => {
    W.portraitMode = !W.portraitMode;
    const stage = $('.wiki-cosm-stage');
    if (stage) stage.classList.toggle('wiki-cosm-stage--portrait', W.portraitMode);
    dom.btnAspect.classList.toggle('is-active', W.portraitMode);
    setTimeout(() => { resizeThree(); }, 300);
  });
  dom.search && dom.search.addEventListener('input', () => {
    W.search = dom.search.value;
    W.visible = 72;
    renderGrid();
  });
  dom.search && dom.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dom.search.value = ''; W.search = ''; renderGrid(); }
  });
}

/* ---------- 启动 ---------- */
function init() {
  dom.canvas = $('#canvas');
  dom.viewport = $('.wiki-cosm-viewport');
  dom.catBar = $('.wiki-cat-bar');
  dom.grid = $('.wiki-icon-grid');
  dom.search = $('.wiki-search-input');
  dom.wornList = $('.wiki-worn-list');
  dom.btnEnv = $('#btnEnv');
  dom.btnSpin = $('#btnSpin');
  dom.btnReset = $('#btnReset');
  dom.btnAspect = $('#btnAspect');
  dom.loading = $('.wiki-viewport-loading');
  dom.empty = $('.wiki-grid-empty');
  dom.headTitle = $('.wiki-panel-title');
  dom.envLabel = $('#envLabel');
  dom.catCount = $('#catCount');
  dom.panelCount = $('#panelCount');
  if (dom.panelCount) dom.panelCount.textContent = dom.catCount ? dom.catCount.textContent : '';
  bindTools();
  bindGridScroll();
  loadData().catch(e => {
    console.error(e);
    if (dom.loading) dom.loading.classList.remove('is-loading');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
