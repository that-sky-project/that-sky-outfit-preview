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
  // 背饰（道具）分类已按用户要求移除
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
  wornList: null, btnEnv: null, btnSpin: null, btnReset: null, btnAspect: null, btnTools: null, stageTools: null, btnHidePanel: null, btnShowPanel: null,
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
  })().catch(e => { fetchCache.delete(url); throw e; });
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
  })().catch(e => { meshParseCache.delete(meshFile); throw e; });
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
  })().catch(e => { texCache.delete(key); throw e; });
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

async function buildPartFor(item, canSkin, boneCount, geo) {
  const def = itemToDef(item);
  // 光照/AO 图（attrib，用 uv1）：仅几何实际带 auv1 才启用（角色部件普遍只有 uv0，强开会采样错乱）。
  const hasUv1 = !!(geo && geo.getAttribute && geo.getAttribute('auv1'));
  const lightMap = (hasUv1 && item.attrib) ? await loadTexture(item.attrib) : null;
  // 按 shader 类型还原游戏材质：Alpha/Glitter/Glass 斗篷是半透明发光材质（游戏内星月/光丝/玻璃斗篷效果）。
  const sh = String(item.shader || '');
  const itemName = String(item.label || item.name || '');
  let emissive = 0, opacity = 1, transparent = false, sparkle = false, flowTrail = 0, flowSpeed = 1.0, flowColor = 0, clothWave = 0;
  if (/GlitterAlpha|AlphaFullGlitter|GlitterAlphaRevamp|GlitterAlphaAttrib/.test(sh)) { emissive = /AP16OrangeLove/.test(itemName) ? 1.8 : 2.0; opacity = 0.6; transparent = true; sparkle = /AP16OrangeLove/.test(itemName); }
  else if (/Butterfly/.test(sh)) { emissive = 1.8; opacity = 0.55; transparent = true; sparkle = true; }
  else if (/OceanCaustics/.test(sh)) { emissive = 1.2; opacity = 0.88; transparent = true; }
  else if (/Glitter/.test(sh)) { emissive = 1.4; opacity = 1.0; }
  else if (/Glass/.test(sh)) { emissive = 1.6; opacity = 0.7; transparent = true; }
  else if (/AlphaTest/.test(sh)) { emissive = 0.9; opacity = 0.85; transparent = true; }
  else if (/Alpha/.test(sh)) { emissive = 1.1; opacity = 0.65; transparent = true; }
  // AP31Starry 星月项链（Neck）：游戏内深蓝星空+白色星点+发光，AvatarAlpha 基础上加星光提亮
  if (/AP31Starry/.test(itemName)) { emissive = 2.0; opacity = 0.7; transparent = true; sparkle = true; flowTrail = 1.4; flowSpeed = 1.2; flowColor = 0x8fd4ff; }
  // 季节16元素蝶翼（AP16Fire/Water/Wind/Earth）：游戏内半透明发光，但 shader 是标准 AvatarCham，需按物品名特判
  if (/^Wing AP16(Fire|Water|Wind|Earth)$/.test(itemName)) { emissive = 1.8; opacity = 0.55; transparent = true; sparkle = true; }
  // 斗篷布料飘动：所有 wing 槽位在待机时有微风摆动（shader 顶点动画）
  if (item.type === 'wing' && !/None/.test(itemName)) clothWave = 0.14;
  // 发型轻微随风飘荡
  if (item.type === 'hair' && !/None/.test(itemName)) clothWave = 0.06;
  console.log('[MAT]', item.label, '| shader', sh, '| em', emissive, 'op', opacity, 'tr', transparent);
  // 注意：maskTex 是染色蒙版不是漫反射纹理，不可替代 diffuse（替代会让部分发型 UV 落到蒙版深色区变黑）。
  return buildPartMaterial(def, canSkin, boneCount || 0, { lightMap, emissive, opacity, transparent, sparkle, flowTrail, flowSpeed, flowColor, clothWave, depthWrite: !transparent });
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

/* ---------- HDR 泛光后处理（贴图 HDR 发光效果：发光斗篷过曝区域柔和泛光） ---------- */
let postFX = null;
const FX_VS = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FX_EXTRACT_FS = `
  uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;
  void main(){
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = max(0.0, l - threshold) / max(l, 1e-4);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;
const FX_BLUR_FS = `
  uniform sampler2D tDiffuse; uniform vec2 dir; uniform vec2 texel; varying vec2 vUv;
  void main(){
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
    vec2 off = dir * texel;
    sum += texture2D(tDiffuse, vUv + off * 3.2).rgb * 0.3162162;
    sum += texture2D(tDiffuse, vUv - off * 3.2).rgb * 0.3162162;
    sum += texture2D(tDiffuse, vUv + off * 7.5).rgb * 0.0702703;
    sum += texture2D(tDiffuse, vUv - off * 7.5).rgb * 0.0702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;
const FX_COMBINE_FS = `
  uniform sampler2D tBase; uniform sampler2D tBloom; uniform float strength; varying vec2 vUv;
  void main(){
    vec3 base = texture2D(tBase, vUv).rgb;
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    gl_FragColor = vec4(base + bloom * strength, 1.0);
  }
`;
function initPostFX() {
  if (!renderer) return;
  const W0 = Math.max(2, renderer.domElement.width), H0 = Math.max(2, renderer.domElement.height);
  const bw = Math.max(2, W0 >> 1), bh = Math.max(2, H0 >> 1);
  const sceneRT = new THREE.WebGLRenderTarget(W0, H0, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false });
  const bloomRT = [
    new THREE.WebGLRenderTarget(bw, bh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false }),
    new THREE.WebGLRenderTarget(bw, bh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false })
  ];
  const extractMat = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, threshold: { value: 0.85 } }, vertexShader: FX_VS, fragmentShader: FX_EXTRACT_FS, depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: new THREE.Vector2(1 / bw, 1 / bh) } }, vertexShader: FX_VS, fragmentShader: FX_BLUR_FS, depthTest: false, depthWrite: false });
  const combineMat = new THREE.ShaderMaterial({ uniforms: { tBase: { value: null }, tBloom: { value: null }, strength: { value: 2.2 } }, vertexShader: FX_VS, fragmentShader: FX_COMBINE_FS, depthTest: false, depthWrite: false });
  const fxScene = new THREE.Scene();
  const fxCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fxQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), extractMat);
  fxScene.add(fxQuad);
  postFX = { sceneRT, bloomRT, extractMat, blurMat, combineMat, fxScene, fxCam, fxQuad, enabled: true, threshold: 0.85, strength: 1.2 };
  try { window.__postFX = postFX; } catch (e) {}
}
function fxPass(target, mat, src, extra) {
  mat.uniforms.tDiffuse.value = src;
  if (extra) for (const k in extra) { const u = mat.uniforms[k]; if (u) u.value = extra[k]; }
  postFX.fxQuad.material = mat;
  renderer.setRenderTarget(target || null);
  renderer.render(postFX.fxScene, postFX.fxCam);
}
function renderPostFX() {
  if (!postFX || !postFX.enabled) { renderer.render(scene, camera); return; }
  const rt = postFX.sceneRT, brt = postFX.bloomRT;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  fxPass(brt[0], postFX.extractMat, rt.texture);
  for (let i = 0; i < 2; i++) {
    fxPass(brt[1], postFX.blurMat, brt[0].texture, { dir: new THREE.Vector2(1, 0) });
    fxPass(brt[0], postFX.blurMat, brt[1].texture, { dir: new THREE.Vector2(0, 1) });
  }
  postFX.combineMat.uniforms.tBase.value = rt.texture;
  postFX.combineMat.uniforms.tBloom.value = brt[0].texture;
  postFX.combineMat.uniforms.strength.value = postFX.strength;
  postFX.fxQuad.material = postFX.combineMat;
  renderer.setRenderTarget(null);
  renderer.render(postFX.fxScene, postFX.fxCam);
}
function resizePostFX() {
  if (!postFX || !renderer) return;
  const W0 = Math.max(2, renderer.domElement.width), H0 = Math.max(2, renderer.domElement.height);
  postFX.sceneRT.setSize(W0, H0);
  const bw = Math.max(2, W0 >> 1), bh = Math.max(2, H0 >> 1);
  postFX.bloomRT[0].setSize(bw, bh);
  postFX.bloomRT[1].setSize(bw, bh);
  postFX.blurMat.uniforms.texel.value.set(1 / bw, 1 / bh);
}


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
    // 动画推进：换装动作/待机循环（animState.playing 时按时间推进帧）
    if (animState.playing && animState.decoded && animState.frameCount > 1) {
      const fps = animState.fps || 30;
      const now = performance.now();
      const delta = Math.min(0.1, (now - (animState._lastT || now)) / 1000);
      animState._lastT = now;
      animState.time += delta;
      let fi = Math.floor(animState.time * fps);
      if (animState._dressActEnd != null) {
        if (animState.time >= animState._dressActEnd) {
          finishDressUpAction();
        } else {
          applyAnimFrame(fi);
        }
      } else {
        applyAnimFrame(fi % animState.frameCount);
      }
    } else {
      animState._lastT = null;
    }
    // 注意：不再重置 outfitGroup.rotation——buildOutfit 已把角色翻转 180°
    // 使正面朝向相机，背饰（道具）因此在角色背后。
    // 更新全局时间（发光斗篷星光闪烁）
    if (outfitGroup) {
      const now = performance.now() / 1000;
      outfitGroup.traverse(o => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of mats) if (mm && mm.uniforms && mm.uniforms.uTime) mm.uniforms.uTime.value = now;
        }
      });
    }
    renderPostFX();
  };
  animate();
  initPostFX();

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
  resizePostFX();
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
// 初始站姿 = 斗篷随机换装动画的最后一帧（用户指定：换斗篷动作 1-40 或 41-70 随机，
// 初始站姿取所播动作的最后一帧 40 或 70）
const IDLE_FRAME = (Math.random() < 0.5) ? 40 : 70;
async function loadIdlePose() {
  const raw = await fetchBytes('data/CharKidAnimPlayerAct.animpack');
  const ap = parseAnimPack(raw);
  const dec = decodeAnimation(ap);
  animState.pack = ap;
  animState.decoded = dec;
  animState.frameCount = (dec && dec.hasAnimation) ? dec.frameCount : 1;
  animState.time = IDLE_FRAME / (animState.fps || 30);
  animState.playing = false;
  idleCache = { ap, dec };
  for (const part of animState.skinnedParts) {
    part.boneToAnim = buildBoneMapping(part.skeletonBones, ap);
  }
  applyAnimFrame(IDLE_FRAME);
}

/* ---------- 换装动作：按类别播放 GroundAct 中对应动作段 ---------- */
let idleCache = null; // 站姿动画缓存（GroundState）
let dressActCache = null; // 换装动作缓存（GroundAct）
// 类别 -> GroundAct 起始帧（每段约 45 帧 = 1.5s，值可在预览面板调整）
// CharKidAnimPlayerAct 换装动作帧段（用户逐段确认，@30fps）：
// 斗篷 1-40 / 41-70（二选一随机）；背饰 41-70；耳饰(第7分类) 71-120；
// 发型+发饰 121-160；面具 161-200；面饰 201-240；裤子+鞋 1460-1490
const DRESS_ACT_START = {
  body: 1460, // 换裤子
  mask: 161,  // 换面具
  hair: 121,  // 换发型
  hat: 121,   // 第 7 分类（帽子）→ 发饰段
  horn: 71,   // 第 8 分类（头饰）→ 耳饰段
  face: 201,  // 换面饰
  neck: 201,  // 第 5 分类（颈饰）用面饰动作（用户指定）
  wing: 1,    // 换斗篷（1-40 或 41-70 随机，见 dressActRange）
  feet: 1460, // 换鞋子
  prop: 41,   // 换背饰
};
// 每段时长（帧），与用户给的区间一致
const DRESS_ACT_LEN = {
  body: 30, mask: 40, hair: 40, hat: 40, horn: 40, // hat 与 hair 同一动画（用户要求第 6/第 7 分类一致）
  face: 40, neck: 40, wing: 40, feet: 30, prop: 30,
};
function dressActRange(slotKey) {
  if (slotKey === 'wing') {
    // 斗篷两个动作随机二选一：1-40 或 41-70
    return Math.random() < 0.5 ? [1, 40] : [41, 30];
  }
  return [DRESS_ACT_START[slotKey] || 0, DRESS_ACT_LEN[slotKey] || 40];
}

async function loadDressActCache() {
  if (dressActCache) return dressActCache;
  const raw = await fetchBytes('data/CharKidAnimPlayerAct.animpack');
  const ap = parseAnimPack(raw);
  const dec = decodeAnimation(ap);
  dressActCache = { ap, dec };
  return dressActCache;
}

async function playDressUpAction(slotKey) {
  try {
    if (!slotKey) return; // 初始加载不播换装动作
    if (!animState.skinnedParts.length) return;
    const { ap, dec } = await loadDressActCache();
    if (!dec || dec.frameCount < 2) return;
    // 骨架命中检查：GroundAct 与角色不兼容时放弃，避免顶点拉飞
    let mapped = 0, totalBones = 0;
    for (const part of animState.skinnedParts) {
      const m = buildBoneMapping(part.skeletonBones, ap);
      for (let k = 0; k < m.length; k++) { totalBones++; if (m[k] >= 0) mapped++; }
    }
    if (totalBones && mapped / totalBones < 0.5) return;
    const rng = dressActRange(slotKey);
    const start = Math.max(0, Math.min(dec.frameCount - 60, rng[0]));
    const actLen = rng[1];
    for (const part of animState.skinnedParts) part.boneToAnim = buildBoneMapping(part.skeletonBones, ap);
    animState.pack = ap;
    animState.decoded = dec;
    animState.frameCount = dec.frameCount;
    animState.time = start / (animState.fps || 30);
    animState.playing = true;
    animState._dressActEnd = (start + actLen) / (animState.fps || 30);
    console.log('DUP play', slotKey, start, Date.now() % 100000);
  } catch (e) {
    console.warn('换装动作失败', e);
  }
}

function finishDressUpAction() {
  animState.playing = false;
  animState._dressActEnd = null;
  if (idleCache) {
    for (const part of animState.skinnedParts) part.boneToAnim = buildBoneMapping(part.skeletonBones, idleCache.ap);
    animState.pack = idleCache.ap;
    animState.decoded = idleCache.dec;
    animState.frameCount = idleCache.dec ? idleCache.dec.frameCount : 1;
  }
  applyAnimFrame(IDLE_FRAME);
  console.log('DUP finish', Date.now() % 100000);
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
  try { window.__outfitGroup = group; } catch (e) {}
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
        const mat = await buildPartFor(item, canSkin, canSkin ? data.skeletonBones.length : 0, geo);
        if (token !== W.buildToken) { geo.dispose(); if (mat && mat.dispose) mat.dispose(); return; }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = slotKey;
        mesh.frustumCulled = false;
        mesh.castShadow = false; // 阴影由影子替身（70 帧站姿）统一投射
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
  rebuildShadow();
  showLoading(false);
  renderWornList();
  // 换装动作由 pickItem → playDressUpAction 触发（第 5 帧替换），初始加载/重置不播放
  clearTimeout(W._dressUpTimer);
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

/* ---- 换装音效（游戏原生 FMOD 提取：ObjectSelect 选择音 / cloth_3_x 布料摩擦声） ---- */
const _sfxCache = {};
function _sfx(name) {
  if (!(name in _sfxCache)) {
    try { const a = new Audio('data/sfx/' + name + '.wav'); a.preload = 'auto'; a.volume = 0.9; _sfxCache[name] = a; }
    catch (e) { _sfxCache[name] = null; }
  }
  return _sfxCache[name];
}
function playSFX(name) {
  try {
    const a = _sfx(name);
    if (a) { a.currentTime = 0; const pp = a.play(); if (pp && pp.catch) pp.catch(function(){}); }
  } catch (e) {}
}

function pickItem(item) {
  W.lastSlot = item.type; // 记录本次换装槽位，供换装动作选择
  W.pending = { slotKey: item.type, item };
  playSFX('ObjectSelect'); // 点击物品：游戏原生选择音
  renderGrid();
  applyPending(); // 立即换装（用户要求去掉第 5 帧延迟）
  playSFX('cloth_3_' + (1 + Math.floor(Math.random() * 4))); // 换装完成：游戏原生布料摩擦声
  if (W.dressUpAnim !== false) playDressUpAction(item.type); // 换装动作照常播放
}

/* 影子替身：CPU 蒙皮到第 70 帧站姿的静态影子（不可见、只投阴影）。
   阴影固定为站姿形态，不随换装动作实时变化（用户要求）。 */
let shadowGroup = null;
let shadowMat = null;
function rebuildShadow() {
  if (shadowGroup) {
    outfitGroup.remove(shadowGroup);
    shadowGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== shadowMat && o.material.dispose) o.material.dispose();
    });
  }
  shadowGroup = new THREE.Group();
  if (!shadowMat) {
    shadowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  }
  const animMats = computeAnimBoneMatrices(IDLE_FRAME);
  for (const part of animState.skinnedParts) {
    const pos = skinPositionsFromGeo(part.geo, animMats);
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (part.geo.index) {
      sgeo.setIndex(new THREE.BufferAttribute(part.geo.index.array, 1));
    }
    const smesh = new THREE.Mesh(sgeo, shadowMat);
    smesh.castShadow = true;
    smesh.position.copy(part.mesh.position);
    smesh.scale.copy(part.mesh.scale);
    smesh.rotation.copy(part.mesh.rotation);
    shadowGroup.add(smesh);
  }
  // 非蒙皮部件（道具等）：直接复制几何作为影子
  for (const child of outfitGroup.children) {
    if (child === shadowGroup) continue;
    if (animState.skinnedParts.some(pp => pp.mesh === child)) continue;
    if (!child.geometry) continue;
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(child.geometry.attributes.position.array), 3));
    if (child.geometry.index) sgeo.setIndex(new THREE.BufferAttribute(child.geometry.index.array, 1));
    const smesh = new THREE.Mesh(sgeo, shadowMat);
    smesh.castShadow = true;
    smesh.position.copy(child.position);
    smesh.scale.copy(child.scale);
    smesh.rotation.copy(child.rotation);
    shadowGroup.add(smesh);
  }
  outfitGroup.add(shadowGroup);
  window.__shadowCount = shadowGroup.children.length; // 调试：影子替身数量
}

/* 移除单个部件（仅删场景与部件表，不触碰换装动作） */
function removePart(slotKey) {
  const oldMesh = outfitGroup.getObjectByName(slotKey);
  if (oldMesh) {
    outfitGroup.remove(oldMesh);
    if (oldMesh.geometry) oldMesh.geometry.dispose();
    const m = oldMesh.material;
    if (Array.isArray(m)) m.forEach(x => x && x.dispose && x.dispose());
    else if (m && m.dispose) m.dispose();
  }
  const si = animState.skinnedParts.findIndex(pp => pp.mesh.name === slotKey);
  if (si >= 0) animState.skinnedParts.splice(si, 1);
}

/* 单部件替换（不重建整个场景，不打断换装动作）。
   先构建新的、成功后再移除旧的：加载/构建失败时保留旧部件，避免部件消失。 */
async function replacePart(slotKey, item) {
  if (!item || item.none) { removePart(slotKey); return; }
  let data, geo, canSkin, mat;
  try {
    data = await loadMeshParsed(item.meshFile);
    if (!data.vertices || !data.vertices.length) { console.warn('部件无几何', slotKey, item.meshFile); return; }
    geo = buildGeometry(data);
    canSkin = !!(data.boneIndices && data.skeletonBones && data.skeletonBones.length);
    mat = await buildPartFor(item, canSkin, canSkin ? data.skeletonBones.length : 0, geo);
  } catch (e) {
    console.warn('部件加载失败，保留旧部件', slotKey, item.name, e && e.message);
    return;
  }
  removePart(slotKey);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = slotKey;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
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
  outfitGroup.add(mesh);
  if (canSkin) {
    const part = { mesh, geo, mat, skeletonBones: data.skeletonBones, boneToAnim: null };
    part.boneToAnim = buildBoneMapping(part.skeletonBones, animState.pack);
    animState.skinnedParts.push(part);
  }
}

/* 动作播放到第 5 帧时执行实际换装（由 animate 轮询触发） */
async function applyPending() {
  if (!W.pending) return;
  const { slotKey, item } = W.pending;
  W.pending = null;
  let target = item;
  if (slotKey === 'body' && (!item || item.none)) target = findDefaultItem('body');
  if (item && item.none) delete W.worn[slotKey];
  else W.worn[slotKey] = target;
  await replacePart(slotKey, target);
  rebuildShadow();
  renderWornList();
  renderGrid();
}

function resetOutfit(rebuild = true) {
  W.worn = {};
  W.lastSlot = undefined;
  W.pending = null;
  const def = findDefaultItem('body');
  if (def) W.worn.body = def;
  // 初始附带第一个发型（用户要求：人物初始需要第一个发型）
  const hairSlot = W.data.slots.find(s => s.key === 'hair');
  const firstHair = hairSlot ? hairSlot.items.find(it => !it.none) : null;
  if (firstHair) W.worn.hair = firstHair;
  if (rebuild) {
    renderGrid();
    buildOutfit();
  }
}

/* ---------- FPS 指示器 ---------- */
let _fpsFrames = 0, _fpsLast = performance.now();
function tickFPS() {
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLast >= 500) {
    const fps = Math.round(_fpsFrames * 1000 / (now - _fpsLast));
    const el = $('#fpsLabel');
    if (el) el.textContent = fps;
    _fpsFrames = 0;
    _fpsLast = now;
  }
  requestAnimationFrame(tickFPS);
}

/* ---------- 工具按钮 ---------- */
function bindTools() {
  dom.btnTools && dom.btnTools.addEventListener('click', () => {
    if (!dom.stageTools) return;
    const collapsed = dom.stageTools.classList.toggle('is-collapsed');
    dom.btnTools.textContent = collapsed ? '▸' : '▾';
  });
  dom.btnHidePanel && dom.btnHidePanel.addEventListener('click', () => {
    const panel = $('.wiki-sky-panel');
    if (panel) panel.classList.add('wiki-panel-hidden');
    if (dom.btnShowPanel) dom.btnShowPanel.classList.add('is-visible');
  });
  dom.btnShowPanel && dom.btnShowPanel.addEventListener('click', () => {
    const panel = $('.wiki-sky-panel');
    if (panel) panel.classList.remove('wiki-panel-hidden');
    if (dom.btnShowPanel) dom.btnShowPanel.classList.remove('is-visible');
  });
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
  dom.btnTools = $('#btnTools');
  dom.stageTools = $('#stageTools');
  dom.btnHidePanel = $('#btnHidePanel');
  dom.btnShowPanel = $('#btnShowPanel');
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
  tickFPS();
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
