// ===== const TONE_DESAT =====
const TONE_DESAT = 0.08;

// ===== const SKY_LIGHT_DIR =====
const SKY_LIGHT_DIR = (() => {
  // lightYaw=-2.0344439358, lightPitch=-0.52
  const yaw = -2.0344439358, pitch = -0.52;
  const cp = Math.cos(pitch);
  const d = [cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)];
  const l = Math.hypot(d[0], d[1], d[2]);
  return new THREE.Vector3(d[0] / l, d[1] / l, d[2] / l);
})();

// ===== const SKY_MAX_BONES =====
const SKY_MAX_BONES = 128;

// ===== const SKY_FS =====
const SKY_FS = `
  precision highp float;
  varying vec3 vNormalW;
  varying vec2 vUv;
  varying vec3 vColorV;
  varying vec3 vViewPos;
  #ifdef USE_UV13
    varying vec2 vUv1;
    varying vec2 vUv3;
  #endif
  uniform sampler2D uDiffuse2Tex; // 第二层色（uv3）——门/石头真实颜色
  uniform int uHasDiffuse2;
  uniform vec2 uDiffuse2Offset;   // 第二层色 uv 偏移
  uniform sampler2D uLightTex;    // 光照/AO 图（uv1）——烘焙的明暗光影
  uniform int uHasLightTex;
  uniform vec3 uLightDir;
  uniform vec3 uAmbient;
  uniform vec3 uKey;
  uniform vec3 uFill;
  uniform float uSpecStrength;  // 镜面高光强度（按材质类型调；0=纯漫反射）
  uniform float uShininess;     // 高光锐度（越大越集中，金属/水高、岩石/布料低）
  uniform float uFresnel;       // 菲涅尔边缘光强度（体积/轮廓感）
  uniform vec3 uBaseColor;
  uniform sampler2D uTex;
  uniform int uHasTex;
  uniform sampler2D uNormTex;   // 切线空间法线贴图（与 uTex 共用 uv0）
  uniform int uHasNormTex;      // 是否有法线贴图
  uniform float uNormStrength;  // 法线扰动强度（0=不扰动）
  uniform int uHasVCol;
  uniform float uOpacity;
  uniform float uAlphaTest;
  uniform vec3 uBaseHsv;
  uniform int uHasColorOverride;
uniform float uDesaturate;
uniform int uForceDesat;
  uniform float uExposure;
  uniform int uColorOn;      // 全局上色开关：0=白模(仅光照)，1=正常贴图/颜色/染色
  uniform float uToneDesat;  // 整体轻微降饱和（0=不变），让色调更柔和不刺眼
  uniform vec3 uClayColor;   // 白模底色（浅灰黏土，避免纯白过曝顶死）
  // 输出编码：exposure 微调后做 linear→sRGB 显示编码。
  // 关键修复：之前只在采样端做 srgb2lin 却没在输出端编码回显示空间，
  // 导致暗部被线性值直接输出而黑死。参考 APP 靠 sRGB framebuffer 硬件编码抬亮暗部，
  // 我们输出走 LinearSRGBColorSpace（不自动编码），故必须在此手动 lin2srgb。
  vec3 softClip(vec3 c) {
    c *= uExposure;
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
  }
  // HSV(h:0-360, s:0-100, v:0-100) -> RGB，逐行对齐参考实现 _skyviewer_ref/MeshRenderer hsv2rgb
  vec3 hsv2rgb(vec3 hsv) {
    float h = hsv.x / 360.0;
    float s = hsv.y / 100.0;
    float v = hsv.z / 100.0;
    vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
  }
  // sRGB -> linear：复现参考实现中 GPU 对 SRGB8_ETC2 纹理的硬件采样解码
  vec3 srgb2lin(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  // 整体轻微降饱和：往亮度灰靠拢一点，削弱过艳、增强和谐感（不改亮度）
  vec3 toneDesat(vec3 c) {
    if (uToneDesat <= 0.0) return c;
    float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(c, vec3(g), clamp(uToneDesat, 0.0, 1.0));
  }
  void main() {
    // 精确复现参考实现 _skyviewer_ref 的真实链路（关键：纹理是 SRGB8_ETC2，GPU 采样自动 sRGB→linear）：
    //   lighting = uAmbient + uKey*NdotL + uFill*NdotF   （光照系数按原值直接用，不转换）
    //   base = srgb2lin(texColor.rgb)                    （复现 GPU 对 sRGB 纹理的硬件解码）
    //   base *= vColor.rgb                               （顶点色按原值）
    //   base *= hsv2rgb(uBaseHsv)                         （染色 uniform 按原值直乘）
    //   直接输出线性值到非 sRGB framebuffer（LinearSRGBColorSpace，不做 linear→sRGB 编码）
    // 用平滑插值法线（保持圆润），不做屏幕空间面法线混合——
    // 面法线混合等同 flat-shading，会把低模每个三角面凸显成棱块（分面感），与"精致"相反。
    vec3 N = normalize(vNormalW);
    // ── 切线空间法线贴图（对齐真实 MeshSh：屏幕导数构造 TBN，不需顶点切线）──
    // 真实 shader 解包：n.xy = tex.xy*2.0079-1.0079，n.z=sqrt(1-|xy|²)，再乘余切帧。
    // 这里给低模加回表面凹凸/雕刻高频细节，且不做 sRGB 解码（法线数据是线性存储）。
    if (uHasNormTex == 1 && uHasTex == 1) {
      vec3 npk = texture2D(uNormTex, vUv).xyz;
      vec2 nxy = npk.xy * 2.0078125 - 1.0078125;
      float nz2 = dot(nxy, nxy);
      vec3 nTan = (nz2 <= 0.9975) ? vec3(nxy, sqrt(1.0 - nz2)) : vec3(normalize(nxy) * 0.9985, 0.0447);
      nTan.xy *= uNormStrength;
      nTan = normalize(nTan);
      // 屏幕空间余切帧（Mikkelsen）：由 uv 与视图坐标导数解出 T/B
      vec3 dpx = dFdx(vViewPos), dpy = dFdy(vViewPos);
      vec2 dux = dFdx(vUv), duy = dFdy(vUv);
      vec3 dpyp = cross(dpy, N), dpxp = cross(N, dpx);
      vec3 T = dpyp * dux.x + dpxp * duy.x;
      vec3 B = dpyp * dux.y + dpxp * duy.y;
      float inv = inversesqrt(max(dot(T, T), dot(B, B)));
      if (inv < 1e8) { // 有效 UV 导数才扰动，退化三角/无 UV 保持原法线
        mat3 tbn = mat3(T * inv, B * inv, N);
        N = normalize(tbn * nTan);
      }
    }
    vec3 L = normalize(-uLightDir);
    float NdotL = max(dot(N, L), 0.0);
    vec3 keyC = uKey * NdotL;
    vec3 fillLight = normalize(vec3(-uLightDir.z, uLightDir.y, -uLightDir.x));
    float NdotF = max(dot(N, normalize(-fillLight)), 0.0) * 0.3;
    vec3 fillC = uFill * NdotF;
    vec3 lighting = uAmbient + keyC + fillC;
    // ── 烘焙光照/AO（u_lightTex，用 uv1）──：门/石头"中间那光影"就是这层。
    // 真实 MeshSh 用 .x 调直射+高光、.y 调环境遮蔽；White 贴图(=1)时不改变光照。
    #ifdef USE_UV13
    if (uHasLightTex == 1) {
      vec2 ao = texture2D(uLightTex, vUv1).xy;
      lighting = uAmbient * ao.y + (keyC + fillC) * ao.x;
    }
    #endif
    // ── 镜面高光（Blinn-Phong）+ 菲涅尔边缘光 ──
    // 视图空间：相机在原点，视线 V = 归一化(-坐标)。半角向量 H=归一化(L+V)。
    vec3 V = normalize(-vViewPos);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecStrength * NdotL;
    // 菲涅尔：视线越掠射边缘越亮，给出体积/轮廓感（Schlick 近似）
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0) * uFresnel;
    vec3 gSpec = uKey * spec + uFill * fres;
    // ── 白模（全局上色关闭）：只显示带光照的浅灰素模，便于看结构 ──
    // 白模保留细节法线与轻微边缘光，让结构起伏更清楚，但不加彩色高光。
    if (uColorOn == 0) {
      // 透明大气/水面片在白模下直接隐去，避免灰片糊住画面
      if (uOpacity < 0.99) discard;
      gl_FragColor = vec4(softClip(uClayColor * lighting + uFill * fres * 0.5), 1.0);
      return;
    }
    // 逐行对齐参考：纹理与顶点色是两个独立 if（累乘），而非互斥
    vec3 base = uBaseColor;
    float alpha = uOpacity;
    if (uHasTex == 1) {
      vec4 t = texture2D(uTex, vUv);
      base *= srgb2lin(t.rgb);
      alpha *= t.a;
    }
    // ── 第二层色（u_diffuse2Tex，用 uv3）──：与 diffuse1 相乘得反照率，给灰底石纹上真实颜色。
    // 真实 MeshSh：albedo = diffuse1 * diffuse2（第 314-318 行 _1155=_1138*_1150）。
    #ifdef USE_UV13
    if (uHasDiffuse2 == 1) {
      vec4 t2 = texture2D(uDiffuse2Tex, vUv3 + uDiffuse2Offset);
      base *= srgb2lin(t2.rgb);
    }
    #endif
    if (uHasVCol == 1) {
      base *= vColorV;
    }
    // 「原始颜色」开关：直接显示 ramp/贴图原色，不做 HSV 染色
    if (uForceDesat == 1) {
      if (alpha < uAlphaTest) discard;
      gl_FragColor = vec4(softClip(toneDesat(base) * lighting + gSpec), alpha);
      return;
    }
    // ── 染色：逐行对齐参考实现 ──
    //   uHasColorOverride==1（纯色覆盖件）：base = hsvColor * 光照，丢弃贴图/顶点色
    //   否则（普通染色）：base *= hsvColor
    //   base_hsv=[0,0,100](白) → hsv2rgb=(1,1,1) 即原样显示
    vec3 hsvColor = hsv2rgb(uBaseHsv);
    if (uHasColorOverride == 1) {
      if (alpha < uAlphaTest) discard;
      gl_FragColor = vec4(softClip(toneDesat(hsvColor) * lighting + gSpec), alpha);
      return;
    }
    base *= hsvColor;
    // 去饱和：仅当显式请求（uDesaturate>0，对应游戏 u_desaturateAmount+u_ghost）
    if (uDesaturate > 0.0) {
      float g = dot(base, vec3(0.15, 0.30, 0.5));
      base = mix(base, vec3(g), clamp(uDesaturate, 0.0, 1.0));
    }
    if (alpha < uAlphaTest) discard;
    gl_FragColor = vec4(softClip(toneDesat(base) * lighting + gSpec), alpha);
  }`;

// ===== const SKY_VS_BODY =====
const SKY_VS_BODY = `
    vec3 pos = position;
    vec3 nrm = normal;
    #ifdef USE_SKINNING
      // 4 骨骼加权蒙皮（对齐参考 skinProgram：boneMat = Σ getBoneMatrix(idx)*weight）
      // 骨矩阵改从骨骼纹理采样，不再用 uniform 数组：手机顶点 uniform 向量上限（常见 256）
      // 只够 ~54 骨，超出会截断导致骨表后段的左手/左脚拿不到矩阵而定死绑定姿势。
      mat4 boneMat =
        getBoneMatrix(boneIndices.x) * boneWeights.x +
        getBoneMatrix(boneIndices.y) * boneWeights.y +
        getBoneMatrix(boneIndices.z) * boneWeights.z +
        getBoneMatrix(boneIndices.w) * boneWeights.w;
      // 权重和为 0 的顶点（无绑定）退化为单位阵，避免坍缩到原点
      if (boneWeights.x + boneWeights.y + boneWeights.z + boneWeights.w < 0.0001) boneMat = mat4(1.0);
      pos = (boneMat * vec4(position, 1.0)).xyz;
      nrm = (boneMat * vec4(normal, 0.0)).xyz;
    #endif
    vNormalW = normalize(normalMatrix * nrm);
    vUv = uv;
    #ifdef USE_UV13
      vUv1 = auv1;   // 光照/AO 图坐标
      vUv3 = auv3;   // 第二层色坐标
    #endif
    #ifdef USE_COLOR
      vColorV = color;
    #else
      vColorV = vec3(1.0);
    #endif
    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mvPos.xyz;      // 视图空间坐标：供高光/菲涅尔算视线，dFdx 算屏幕空间细节
    gl_Position = projectionMatrix * mvPos;
  }`;

// ===== let skyMaxBones =====
let skyMaxBones = SKY_MAX_BONES;

// ===== const CHAR_AMBIENT =====
const CHAR_AMBIENT = [0.50, 0.46, 0.40];

// ===== const CHAR_KEY =====
const CHAR_KEY     = [0.98, 0.95, 0.88];

// ===== const CHAR_FILL =====
const CHAR_FILL    = [0.42, 0.39, 0.34];

// ===== const DEFAULT_ANIM_CANDIDATES =====
const DEFAULT_ANIM_CANDIDATES = ['CharKidAnimGroundState', 'CharKidAnimGroundNav', 'CharKidAnimPlayerAct'];

// ===== function buildSkyVS =====
function buildSkyVS(boneCount) {
  return `
  varying vec3 vNormalW;
  varying vec2 vUv;
  varying vec3 vColorV;
  varying vec3 vViewPos;
  #ifdef USE_UV13
    attribute vec2 auv1;
    attribute vec2 auv3;
    varying vec2 vUv1;
    varying vec2 vUv3;
  #endif
  #ifdef USE_SKINNING
    attribute vec4 boneIndices;
    attribute vec4 boneWeights;
    // 骨矩阵存进浮点纹理（每骨占 4 个纹素=一个 mat4），按行主序逐列读回。
    // 纹理宽度 = 4*ceil(sqrt(boneCount))，方形贴图省纹素；uBoneTexSize 为边长。
    uniform sampler2D uBoneTexture;
    uniform float uBoneTexSize;
    mat4 getBoneMatrix(float i) {
      float j = i * 4.0;
      float x = mod(j, uBoneTexSize);
      float y = floor(j / uBoneTexSize);
      float dx = 1.0 / uBoneTexSize;
      float dy = 1.0 / uBoneTexSize;
      y = dy * (y + 0.5);
      vec4 v1 = texture2D(uBoneTexture, vec2(dx * (x + 0.5), y));
      vec4 v2 = texture2D(uBoneTexture, vec2(dx * (x + 1.5), y));
      vec4 v3 = texture2D(uBoneTexture, vec2(dx * (x + 2.5), y));
      vec4 v4 = texture2D(uBoneTexture, vec2(dx * (x + 3.5), y));
      return mat4(v1, v2, v3, v4);
    }
  #endif
  void main() {`.trimStart() + SKY_VS_BODY;
}

// ===== function skyMaterial =====
function skyMaterial(opts) {
  const o = opts || {};
  const tex = o.map || null;
  // 蒙皮骨数：用部件实际骨数（骨矩阵走纹理，不再受顶点 uniform 上限约束）。
  const boneN = o.skinning ? Math.max(1, o.boneCount || SKY_MAX_BONES) : 0;
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: SKY_LIGHT_DIR },
      // 光照系数：降低环境光、加大方向光对比，让浮雕/凹凸的阴影显出来（原 ambient 0.46 太高把细节洗平）
      // 可被 opts 覆盖：地形是预烘焙自发光（顶点色即最终色），需高 ambient/低方向光避免二次压暗。
      uAmbient: { value: Array.isArray(o.ambient) ? new THREE.Vector3(o.ambient[0], o.ambient[1], o.ambient[2]) : new THREE.Vector3(70 / 255, 70 / 255, 72 / 255) },
      uKey: { value: Array.isArray(o.key) ? new THREE.Vector3(o.key[0], o.key[1], o.key[2]) : new THREE.Vector3(255 / 255, 255 / 255, 255 / 255) },
      uFill: { value: Array.isArray(o.fill) ? new THREE.Vector3(o.fill[0], o.fill[1], o.fill[2]) : new THREE.Vector3(150 / 255, 160 / 255, 176 / 255) },
      // 用原始归一化 RGB（Vector3），避免 THREE.Color 被 ColorManagement 自动转线性
      uBaseColor: { value: (() => { const c = o.color != null ? o.color : 0xffffff; return new THREE.Vector3(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255); })() },
      uTex: { value: tex },
      uHasTex: { value: tex ? 1 : 0 },
      uNormTex: { value: o.normalMap || null },
      uHasNormTex: { value: o.normalMap ? 1 : 0 },
      uNormStrength: { value: o.normStrength != null ? o.normStrength : 1.0 },
      uDiffuse2Tex: { value: o.diffuse2Map || null },
      uHasDiffuse2: { value: o.diffuse2Map ? 1 : 0 },
      uDiffuse2Offset: { value: Array.isArray(o.diffuse2Offset) ? new THREE.Vector2(o.diffuse2Offset[0], o.diffuse2Offset[1]) : new THREE.Vector2(0, 0) },
      uLightTex: { value: o.lightMap || null },
      uHasLightTex: { value: o.lightMap ? 1 : 0 },
      uHasVCol: { value: o.vertexColors ? 1 : 0 },
      uOpacity: { value: o.opacity != null ? o.opacity : 1.0 },
      uAlphaTest: { value: o.alphaTest != null ? o.alphaTest : 0.0 },
      uBaseHsv: { value: Array.isArray(o.baseHsv) && o.baseHsv.length === 3
        ? new THREE.Vector3(o.baseHsv[0], o.baseHsv[1], o.baseHsv[2])
        : new THREE.Vector3(0, 0, 100) },
      uHasColorOverride: { value: o.colorOverride ? 1 : 0 },
      uDesaturate: { value: o.desaturate != null ? o.desaturate : 0.0 },
      uForceDesat: { value: 0 },
      uExposure: { value: o.exposure != null ? o.exposure : 0.62 },
      uColorOn: { value: colorOn ? 1 : 0 },
      uToneDesat: { value: TONE_DESAT },
      uClayColor: { value: new THREE.Vector3(0.6, 0.6, 0.62) },
      // 表面质感参数（按材质类型可覆盖，默认适度）：高光/锐度/边缘光/细节凹凸
      uSpecStrength: { value: o.specStrength != null ? o.specStrength : 0.08 },
      uShininess: { value: o.shininess != null ? o.shininess : 16.0 },
      uFresnel: { value: o.fresnel != null ? o.fresnel : 0.06 },
    },
    vertexShader: buildSkyVS(boneN || 1),
    fragmentShader: SKY_FS,
    side: o.side != null ? o.side : THREE.DoubleSide,
    transparent: !!o.transparent,
    depthWrite: o.depthWrite != null ? o.depthWrite : true,
    wireframe: !!o.wireframe,
    vertexColors: !!o.vertexColors,
  });
  // 蒙皮：加 uBoneMatrices 数组 + USE_SKINNING 宏。默认单位阵，动画每帧更新。
  // 数组大小按部件实际骨数、并受设备上限 skyMaxBones 约束，避免手机端顶点 uniform 超限。
  // 片元用 dFdx/dFdy 算屏幕空间几何法线（细节凹凸）。WebGL1 需显式开启导数扩展；
  // WebGL2(GLSL3) 内建可用，设置该标志无副作用。
  m.extensions = Object.assign({}, m.extensions, { derivatives: true });
  // 第二层色/光照图需要 uv3/uv1 属性；仅在提供任一贴图时开宏（避免无属性几何编译报错）。
  if (o.diffuse2Map || o.lightMap) {
    m.defines = Object.assign({}, m.defines, { USE_UV13: '' });
  }
  if (o.skinning) {
    // 骨矩阵纹理：每骨 4 个 RGBA 浮点纹素（一个 mat4）。用方形贴图，边长向上取到 4 的倍数。
    const size = boneTexSizeFor(boneN);
    const data = new Float32Array(size * size * 4);
    // 初始化为单位阵（列主序写入，getBoneMatrix 用 mat4(col0..col3) 读回）
    for (let i = 0; i < boneN; i++) writeBoneIdentity(data, i);
    const btex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    btex.needsUpdate = true;
    m.uniforms.uBoneTexture = { value: btex };
    m.uniforms.uBoneTexSize = { value: size };
    m.userData.boneData = data;
    m.userData.boneTex = btex;
    m.defines = Object.assign({}, m.defines, { USE_SKINNING: '' });
    m.userData.boneCount = boneN;
  }
  return m;
}

// ===== function boneTexSizeFor =====
function boneTexSizeFor(boneN) {
  let size = Math.ceil(Math.sqrt(boneN * 4));
  size = Math.ceil(size / 4) * 4;
  return Math.max(4, size);
}

// ===== function writeBoneIdentity =====
function writeBoneIdentity(data, bone) {
  const o = bone * 16;
  data[o] = 1; data[o+1] = 0; data[o+2] = 0; data[o+3] = 0;
  data[o+4] = 0; data[o+5] = 1; data[o+6] = 0; data[o+7] = 0;
  data[o+8] = 0; data[o+9] = 0; data[o+10] = 1; data[o+11] = 0;
  data[o+12] = 0; data[o+13] = 0; data[o+14] = 0; data[o+15] = 1;
}

// ===== function buildGeometry =====
function buildGeometry(data) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
  if (data.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  // 第二/第三套 UV：uv1=光照/AO（u_lightTex），uv3=第二层色（u_diffuse2Tex）。
  // 命名为自定义属性 auv1/auv3，避免与 three 内建 uv1 语义冲突，shader 内直接引用。
  if (data.uvs1) geo.setAttribute('auv1', new THREE.BufferAttribute(data.uvs1, 2));
  if (data.uvs3) geo.setAttribute('auv3', new THREE.BufferAttribute(data.uvs3, 2));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // 优先使用文件内的原生法线；数量匹配才用，否则回退重算
  if (data.normals && data.normals.length === data.vertices.length) {
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  } else {
    geo.computeVertexNormals();
  }
  // 骨骼蒙皮属性（仅动画部件有）：每顶点 4 骨骼索引 + 权重
  if (data.boneIndices && data.boneWeights) {
    geo.setAttribute('boneIndices', new THREE.BufferAttribute(data.boneIndices, 4));
    geo.setAttribute('boneWeights', new THREE.BufferAttribute(data.boneWeights, 4));
  }
  return geo;
}

// ===== function isDyeRamp =====
function isDyeRamp(shader, diffuseTex) {
  const sh = (shader || '').toLowerCase();
  const tex = (diffuseTex || '').toLowerCase();
  // Avatar 系列角色材质（含 Clipped/HairClipped/Cham/Fur/Alpha 等变体）
  if (/^avatar/.test(sh)) return true;
  // 兜底：diffuseTex 是 CharRamp* 调色板贴图
  if (/^charramp/.test(tex)) return true;
  return false;
}

// ===== function animComposeMat4 =====
function animComposeMat4(t, r, s) {
  const x=r[0], y=r[1], z=r[2], w=r[3];
  const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
  const r00=1-2*(yy+zz), r01=2*(xy-wz), r02=2*(xz+wy);
  const r10=2*(xy+wz), r11=1-2*(xx+zz), r12=2*(yz-wx);
  const r20=2*(xz-wy), r21=2*(yz+wx), r22=1-2*(xx+yy);
  const sx=s[0], sy=s[1], sz=s[2];
  return new Float32Array([
    r00*sx, r10*sx, r20*sx, 0,
    r01*sy, r11*sy, r21*sy, 0,
    r02*sz, r12*sz, r22*sz, 0,
    t[0], t[1], t[2], 1
  ]);
}

// ===== function animMulMat4 =====
function animMulMat4(a, b) {
  const r = new Float32Array(16);
  for (let col=0; col<4; col++) for (let row=0; row<4; row++) {
    let sum=0; for (let k=0;k<4;k++) sum += a[k*4+row]*b[col*4+k];
    r[col*4+row] = sum;
  }
  return r;
}

// ===== function animFindComp =====
function animFindComp(dec, boneIdx, fi, compOff, compLen) {
  const fc = dec.frameCount, fd = dec.frameData;
  // 向后
  let f = fi;
  while (f > 0) { const b=(boneIdx*fc+f)*10; if (b+compOff+compLen<=fd.length && !isNaN(fd[b+compOff])) break; f--; }
  let b = (boneIdx*fc+f)*10;
  if (b+compOff+compLen<=fd.length && isNaN(fd[b+compOff])) {
    // 向前
    f = fi+1;
    while (f < fc) { const bb=(boneIdx*fc+f)*10; if (bb+compOff+compLen<=fd.length && !isNaN(fd[bb+compOff])) break; f++; }
  }
  b = (boneIdx*fc+Math.min(f,fc-1))*10;
  if (b+compOff+compLen<=fd.length && f<fc && !isNaN(fd[b+compOff])) {
    const out=[]; for (let k=0;k<compLen;k++) out.push(fd[b+compOff+k]); return out;
  }
  // 全局兜底
  for (let sf=0; sf<fc; sf++) { const bb=(boneIdx*fc+sf)*10; if (bb+compOff+compLen<=fd.length && !isNaN(fd[bb+compOff])) { const out=[]; for(let k=0;k<compLen;k++) out.push(fd[bb+compOff+k]); return out; } }
  return null;
}

// ===== function computeAnimBoneMatrices =====
function computeAnimBoneMatrices(frameIdx) {
  const ap = animState.pack, dec = animState.decoded;
  if (!ap) return null;
  const bc = ap.boneCount;
  const base = animGetBoneSqtList(ap);
  const locals = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    let t, r, s;
    if (dec && dec.frameData) {
      const fi = Math.max(0, Math.min(frameIdx, dec.frameCount - 1));
      r = animFindComp(dec, i, fi, 3, 4) || (base[i] ? base[i].rotation : [0,0,0,1]);
      t = animFindComp(dec, i, fi, 7, 3) || (base[i] ? base[i].translation : [0,0,0]);
      s = animFindComp(dec, i, fi, 0, 3) || (base[i] ? base[i].scale : [1,1,1]);
    } else if (base[i]) {
      t = base[i].translation; r = base[i].rotation; s = base[i].scale;
    } else { t=[0,0,0]; r=[0,0,0,1]; s=[1,1,1]; }
    locals.set(animComposeMat4(t, r, s), i * 16);
  }
  // 世界矩阵（父层级累乘）
  const worlds = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    const parent = ap.bones[i].parentIndex;
    const local = locals.subarray(i*16, i*16+16);
    if (parent >= 0 && parent < i) {
      worlds.set(animMulMat4(worlds.subarray(parent*16, parent*16+16), local), i*16);
    } else {
      worlds.set(local, i*16);
    }
  }
  // 最终 = world × IBM（bone.matrix 直接作 IBM）
  const out = new Float32Array(bc * 16);
  for (let i = 0; i < bc; i++) {
    const ibm = ap.bones[i].matrix;
    out.set(animMulMat4(worlds.subarray(i*16, i*16+16), ibm), i*16);
  }
  return out;
}

// ===== function applyAnimFrame =====
function applyAnimFrame(frameIdx) {
  if (!animState.pack || !animState.skinnedParts.length) return;
  const animMats = computeAnimBoneMatrices(frameIdx);
  if (!animMats) return;
  for (const part of animState.skinnedParts) {
    const data = part.mat.userData.boneData;
    const btex = part.mat.userData.boneTex;
    if (!data) continue;
    const map = part.boneToAnim; // 部件骨序 -> animpack 骨序
    const boneN = part.mat.userData.boneCount || part.skeletonBones.length;
    const n = Math.min(part.skeletonBones.length, boneN);
    for (let mi = 0; mi < n; mi++) {
      const ai = map[mi];
      const o = mi * 16;
      if (ai >= 0) {
        // 列主序整块拷贝 animpack 骨矩阵到骨骼纹理数据
        const src = ai * 16;
        for (let k = 0; k < 16; k++) data[o + k] = animMats[src + k];
      } else {
        writeBoneIdentity(data, mi);
      }
    }
    if (btex) btex.needsUpdate = true;
  }
}

// ===== function buildBoneMapping =====
function buildBoneMapping(skeletonBones, ap) {
  const map = new Int32Array(skeletonBones.length).fill(-1);
  for (let mi = 0; mi < skeletonBones.length; mi++) {
    const mn = skeletonBones[mi].name;
    for (let ai = 0; ai < ap.bones.length; ai++) {
      if (animBoneNamesMatch(mn, ap.bones[ai].name)) { map[mi] = ai; break; }
    }
  }
  return map;
}

// ===== function pickDefaultIdleAnim =====
function pickDefaultIdleAnim() {
  const es = animState.entries || [];
  if (!es.length) return -1;
  const nameOf = e => e.name.substring(e.name.lastIndexOf('/') + 1).replace(/\.animpack$/i, '');
  for (const cand of DEFAULT_ANIM_CANDIDATES) {
    const i = es.findIndex(e => nameOf(e).toLowerCase() === cand.toLowerCase());
    if (i >= 0) return i;
  }
  const ck = es.findIndex(e => /^CharKidAnim/i.test(nameOf(e)));
  return ck >= 0 ? ck : 0;
}

// ===== function loadAnimation =====
async function loadAnimation(entry, index, silent, staticPose) {
  const myAnimToken = ++animLoadToken;
  try {
    const raw = await extractEntry(apkFile, entry);
    // 解析期间用户又切了动画，丢弃这次过期结果，避免旧动画覆盖新选择
    if (myAnimToken !== animLoadToken) return;
    const ap = parseAnimPack(raw);
    const dec = decodeAnimation(ap);
    animState.pack = ap;
    animState.decoded = dec;
    animState.curIndex = (index != null) ? index : (animState.entries ? animState.entries.indexOf(entry) : -1);
    animState.frameCount = (dec && dec.hasAnimation) ? dec.frameCount : 1;
    animState.name = entry.name.substring(entry.name.lastIndexOf('/') + 1).replace(/\.animpack$/i, '');
    animState.time = 0;
    // 为每个蒙皮部件建立骨骼映射，并统计骨名命中率。
    // 命中率过低说明选了不兼容骨架的动画（如 NPC 动画套到 CharSkyKid），
    // 套用会把顶点拉飞变形——此时放弃套用、保持原姿势并提示。
    let mapped = 0, totalBones = 0;
    const newMaps = [];
    for (const part of animState.skinnedParts) {
      const m = buildBoneMapping(part.skeletonBones, ap);
      newMaps.push(m);
      for (let k = 0; k < m.length; k++) { totalBones++; if (m[k] >= 0) mapped++; }
    }
    const hitRate = totalBones ? mapped / totalBones : 0;
    if (animState.skinnedParts.length && hitRate < 0.5) {
      animState.pack = null; animState.decoded = null;
      animState.curIndex = -1; animState.playing = false;
      updateAnimUI();
      if (!silent) toast(`该动画骨架与当前角色不匹配（命中 ${Math.round(hitRate*100)}%），已跳过`, true);
      return;
    }
    for (let pi = 0; pi < animState.skinnedParts.length; pi++) {
      animState.skinnedParts[pi].boneToAnim = newMaps[pi];
    }
    applyAnimFrame(0);
    animState.playing = staticPose ? false : (animState.frameCount > 1);
    updateAnimUI();
    if (!silent) toast(`动画：${animState.name}（${ap.boneCount} 骨 / ${animState.frameCount} 帧）`);
  } catch (e) {
    console.error('动画加载失败', e);
    if (!silent) toast('动画加载失败：' + (e.message || e), true);
  }
}

// ===== function clearAnimation =====
function clearAnimation() {
  animState.pack = null; animState.decoded = null;
  animState.curIndex = -1;
  animState.frameCount = 0; animState.time = 0; animState.playing = false;
  // 重置各部件骨矩阵为单位阵（回 T-pose）
  for (const part of animState.skinnedParts) {
    const data = part.mat.userData.boneData;
    const btex = part.mat.userData.boneTex;
    if (!data) continue;
    const boneN = part.mat.userData.boneCount || 0;
    for (let i = 0; i < boneN; i++) writeBoneIdentity(data, i);
    if (btex) btex.needsUpdate = true;
  }
}

// ===== function resolvePlaceableScale =====
function resolvePlaceableScale(meshName) {
  if (!Array.isArray(placeableDefs)) return 1;
  const meshLower = stripVariant(meshName).toLowerCase();
  let best = 1, bestLen = 0;
  for (const p of placeableDefs) {
    const em = (p && p.mesh || '').toLowerCase();
    if (!em) continue;
    if (meshLower === em || meshLower.startsWith(em + '_') || meshLower.endsWith('_' + em)) {
      if (em.length <= bestLen) continue;
      const s = Array.isArray(p.scale) && p.scale.length ? Number(p.scale[0]) : null;
      if (s != null && s > 0) { best = s; bestLen = em.length; }
    }
  }
  return best;
}

// ===== function findMeshEntryByName =====
function findMeshEntryByName(meshName) {
  const key = meshName.toLowerCase();
  if (meshEntryIndex.has(key)) return meshEntryIndex.get(key);
  // 前缀匹配：Body_Ghost -> Body_Ghost_StripAnim_...
  let best = null, bestLen = 1e9;
  for (const [base, entry] of meshEntryIndex) {
    if (base === key || base.startsWith(key + '_')) {
      if (base.length < bestLen) { best = entry; bestLen = base.length; }
    }
  }
  return best;
}

// ===== function buildPartMaterial =====
async function buildPartMaterial(def, skinning, boneCount) {
  const difName = def.diffuseTex || '';
  const tex = await loadTexture(difName);
  const dye = isDyeRamp(def.shader, def.diffuseTex);
  const hsv = { baseHsv: def.base_hsv || null, colorOverride: !!def.color_override };
  return skyMaterial({ color: 0xffffff, map: (tex && showTexture) ? tex : null, side: THREE.DoubleSide, baseHsv: hsv.baseHsv, colorOverride: hsv.colorOverride, rampDye: dye, skinning: !!skinning, boneCount: boneCount || 0,
    ambient: CHAR_AMBIENT, key: CHAR_KEY, fill: CHAR_FILL });
}

// ===== function loadDressCharacter =====
async function loadDressCharacter() {
  const myToken = ++loadToken;
  clearScene();
  dressGroup = new THREE.Group();
  let loaded = 0, total = 0;
  const box = new THREE.Box3();
  const skinned = [];
  for (const slot of DRESS_SLOTS) {
    const sel = dressSelection[slot.key];
    if (!sel || !sel.mesh || sel.mesh === 'Outfit_None') continue;
    total++;
    const entry = findMeshEntryByName(sel.mesh);
    if (!entry) continue;
    try {
      const raw = await extractEntry(apkFile, entry);
      const data = readMesh(raw, entry.name);
      if (!data.vertices.length) continue;
      const geo = buildGeometry(data);
      // 有骨骼权重 + 内嵌骨架的部件走 GPU 蒙皮（道具若自带骨架，播放动画时会自行挂到背后）
      const canSkin = !!(data.boneIndices && data.skeletonBones && data.skeletonBones.length);
      const mat = await buildPartMaterial(sel.def, canSkin, canSkin ? data.skeletonBones.length : 0);
      if (myToken !== loadToken) { geo.dispose(); if (mat && mat.dispose) mat.dispose(); return; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = slot.key;
      mesh.frustumCulled = false; // 蒙皮后包围盒会变，关闭裁剪避免误剔除
      dressGroup.add(mesh);
      box.expandByObject(mesh);
      if (canSkin) skinned.push({ mesh, geo, mat, skeletonBones: data.skeletonBones, boneToAnim: null });
      loaded++;
    } catch (e) { console.error('部件加载失败', slot.key, e); }
  }
  if (myToken !== loadToken) { disposeObject3D(dressGroup); dressGroup = null; return; }
  scene.add(dressGroup);
  currentMesh = dressGroup; currentData = null;
  curBox = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1,-1,-1), new THREE.Vector3(1,1,1)) : box;
  animState.skinnedParts = skinned;
  // 若已有动画在播，换装后重建骨骼映射并继续。
  // 帧号必须与 animate() 循环一致做 % frameCount 取模，否则超范围会被钳到最后一帧，
  // 导致新换部件停在末帧、与其它部件当前帧错位（现象：换装后面具等挂点偏移）。
  if (animState.pack) {
    for (const part of skinned) part.boneToAnim = buildBoneMapping(part.skeletonBones, animState.pack);
    const fc = animState.frameCount || 1;
    const frameIdx = Math.floor(animState.time * animState.fps) % fc;
    applyAnimFrame(frameIdx);
  }
  setView('reset');
  hintEl.style.display = 'none';
  toast(`已组合 ${loaded}/${total} 个部件`);
  // 默认摆站姿：还没加载过任何动画时，自动套用第一个站姿（用户仍可在下拉里换）。
  // 道具挂点也依赖动画骨架，套站姿后背饰才会到背后。
  if (!animState.pack && skinned.length) {
    const idx = pickDefaultIdleAnim();
    if (idx >= 0) { await loadAnimation(animState.entries[idx], idx, true, true); }
  }
  updateAnimUI();
}

// ===== function disposeObject3D =====
function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.dispose) m.dispose();
    }
  });
}

// ===== function setView =====
function setView(mode) {
  if (!currentMesh || !curBox) return;
  const size = curBox.getSize(new THREE.Vector3());
  const center = curBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // 按 FOV 计算刚好填满视口的距离，再留一点边距
  const fov = camera.fov * Math.PI / 180;
  const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.3;
  controls.target.copy(center);
  if (mode === 'front') camera.position.set(center.x, center.y, center.z + dist);
  else if (mode === 'top') camera.position.set(center.x, center.y + dist, center.z + 0.001);
  else if (mode === 'side') camera.position.set(center.x + dist, center.y, center.z);
  else camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist);
  updateClip();
  controls.update();
  // 网格/坐标轴随模型缩放定位
  const s = Math.max(1, Math.round(maxDim));
  gridHelper.scale.setScalar(s / 10);
  gridHelper.position.set(center.x, curBox.min.y, center.z);
  axesHelper.scale.setScalar(maxDim * 0.4);
  axesHelper.position.set(curBox.min.x, curBox.min.y, curBox.min.z);
}

// ===== function updateClip =====
function updateClip() {
  // 用相机到包围盒中心的距离为基准，同时考虑到目标点的距离，取较小者算 near，避免怼近物件时被裁
  let dist = camera.position.distanceTo(controls.target) || 1;
  if (curBox) {
    const c = curBox.getCenter(new THREE.Vector3());
    const dc = camera.position.distanceTo(c);
    if (dc < dist) dist = dc;
  }
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = Math.max(dist * 1000, 1000);
  camera.updateProjectionMatrix();
}
