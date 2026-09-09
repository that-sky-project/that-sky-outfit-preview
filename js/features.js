/* ===== features.js — 自由光影调节 / 分类栏滚轮横滚 / 导出按钮 ===== */
'use strict';

/* ---------- 分类栏：滚轮横向滚动（解决“无法选择后方选项”） ---------- */
(function () {
  const bar = document.querySelector('.wiki-cat-bar');
  if (bar) {
    bar.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        bar.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }
})();

/* ================================================================
 * 自由光影调节
 * ================================================================ */
const LIGHT_DEFAULTS = {
  bg: '#4a6072',
  ambient: '#808c94', ambientInt: 0.6,
  key: '#fff2dc', keyInt: 1.5,
  az: 218.7, el: 51.3,
  fill: '#7ab3e6', fillInt: 0.5,
};
let LIGHT_CUSTOM = { ...LIGHT_DEFAULTS };

function hexToVec3(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function lightDirFromAzEl(azDeg, elDeg) {
  const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el)
  ).normalize();
}

function applyCustomLight() {
  if (!scene) return;
  const L = LIGHT_CUSTOM;
  scene.background = new THREE.Color(L.bg);
  ambientLight.color.set(L.ambient);
  ambientLight.intensity = Number(L.ambientInt);
  const dir = lightDirFromAzEl(L.az, L.el);
  shadowLight.color.set(L.key);
  shadowLight.intensity = Number(L.keyInt);
  shadowLight.position.copy(dir).multiplyScalar(10);
  fillLight.color.set(L.fill);
  fillLight.intensity = Number(L.fillInt);
  const keyN = hexToVec3(L.key).multiplyScalar(Number(L.keyInt));
  const ambN = hexToVec3(L.ambient).multiplyScalar(Number(L.ambientInt));
  const fillN = hexToVec3(L.fill).multiplyScalar(Number(L.fillInt));
  if (outfitGroup) {
    outfitGroup.traverse(o => {
      if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uAmbient) {
        o.material.uniforms.uAmbient.value.copy(ambN);
        o.material.uniforms.uKey.value.copy(keyN);
        o.material.uniforms.uFill.value.copy(fillN);
        o.material.uniforms.uLightDir.value.copy(dir);
      }
    });
  }
}

/* 把当前场景光照状态同步进面板（预设切换后调用） */
function syncLightFromScene() {
  if (!scene) return;
  LIGHT_CUSTOM.bg = '#' + scene.background.getHexString();
  LIGHT_CUSTOM.ambient = '#' + ambientLight.color.getHexString();
  LIGHT_CUSTOM.ambientInt = ambientLight.intensity;
  LIGHT_CUSTOM.key = '#' + shadowLight.color.getHexString();
  LIGHT_CUSTOM.keyInt = shadowLight.intensity;
  LIGHT_CUSTOM.fill = '#' + fillLight.color.getHexString();
  LIGHT_CUSTOM.fillInt = fillLight.intensity;
  const d = shadowLight.position.clone().normalize();
  LIGHT_CUSTOM.az = (Math.atan2(d.x, d.z) * 180 / Math.PI + 360) % 360;
  LIGHT_CUSTOM.el = Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI;
  updateLightPanel();
}

/* ---------- 构建光影面板 ---------- */
const LIGHT_ROWS = [
  { k: 'ambientInt', label: '环境光强度', type: 'range', min: 0, max: 2, step: 0.05 },
  { k: 'keyInt', label: '主光强度', type: 'range', min: 0, max: 5, step: 0.1 },
  { k: 'key', label: '主光颜色', type: 'color' },
  { k: 'az', label: '主光方位角', type: 'range', min: 0, max: 360, step: 1, unit: '°' },
  { k: 'el', label: '主光仰角', type: 'range', min: 0, max: 90, step: 1, unit: '°' },
  { k: 'fillInt', label: '补光强度', type: 'range', min: 0, max: 3, step: 0.05 },
  { k: 'fill', label: '补光颜色', type: 'color' },
  { k: 'ambient', label: '环境光颜色', type: 'color' },
  { k: 'bg', label: '背景色', type: 'color' },
];
let lightPanelEl = null;

function buildLightPanel() {
  if (lightPanelEl || !document.body) return;
  const panel = document.createElement('div');
  panel.className = 'wiki-light-panel';
  panel.id = 'lightPanel';
  panel.hidden = true;
  let html = '<div class="wiki-light-head">光影调节<button id="btnLightClose" class="wiki-light-close" title="关闭">×</button></div>';
  for (const r of LIGHT_ROWS) {
    html += `<div class="wiki-light-row"><label>${r.label}</label>`;
    if (r.type === 'range') {
      html += `<input type="range" data-k="${r.k}" min="${r.min}" max="${r.max}" step="${r.step}"><span class="wiki-light-val" data-v="${r.k}"></span>`;
    } else {
      html += `<input type="color" data-k="${r.k}"><span class="wiki-light-val" data-v="${r.k}"></span>`;
    }
    html += '</div>';
  }
  html += `<div class="wiki-light-actions">
    <button id="btnLightSync" class="wiki-light-btn">同步当前预设</button>
    <button id="btnLightReset" class="wiki-light-btn">重置</button>
  </div>`;
  panel.innerHTML = html;
  document.body.appendChild(panel);
  lightPanelEl = panel;

  panel.querySelectorAll('input[data-k]').forEach(inp => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.k;
      LIGHT_CUSTOM[k] = inp.type === 'range' ? Number(inp.value) : inp.value;
      applyCustomLight();
      updateLightPanel();
    });
  });
  panel.querySelector('#btnLightClose').addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('#btnLightReset').addEventListener('click', () => {
    LIGHT_CUSTOM = { ...LIGHT_DEFAULTS };
    applyCustomLight();
    updateLightPanel();
  });
  panel.querySelector('#btnLightSync').addEventListener('click', syncLightFromScene);
}

function updateLightPanel() {
  if (!lightPanelEl) return;
  lightPanelEl.querySelectorAll('input[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    if (inp.type === 'range') inp.value = LIGHT_CUSTOM[k];
    else inp.value = LIGHT_CUSTOM[k];
    const valEl = lightPanelEl.querySelector(`[data-v="${k}"]`);
    if (valEl) {
      const v = LIGHT_CUSTOM[k];
      valEl.textContent = inp.type === 'color' ? String(v) : (Math.round(Number(v) * 100) / 100 + (inp.dataset.k === 'az' || inp.dataset.k === 'el' ? '°' : ''));
    }
  });
}

/* ---------- 绑定入口 ---------- */
function initFeatures() {
  buildLightPanel();
  const btnLight = document.getElementById('btnLight');
  if (btnLight) {
    btnLight.addEventListener('click', () => {
      if (!lightPanelEl) buildLightPanel();
      lightPanelEl.hidden = !lightPanelEl.hidden;
      if (!lightPanelEl.hidden) updateLightPanel();
    });
  }
  const btnEnv = document.getElementById('btnEnv');
  if (btnEnv) {
    btnEnv.addEventListener('click', () => {
      // wardrobe.js 的 applyEnv 已执行完，这里把新预设值同步进自定义面板
      setTimeout(syncLightFromScene, 0);
    });
  }
  const btnObj = document.getElementById('btnExportObj');
  if (btnObj) btnObj.addEventListener('click', () => { btnObj.disabled = true; exportOBJ().finally(() => { btnObj.disabled = false; }); });
  const btnGlb = document.getElementById('btnExportGlb');
  if (btnGlb) btnGlb.addEventListener('click', () => { btnGlb.disabled = true; exportGLBSkinned().finally(() => { btnGlb.disabled = false; }); });
  const btnPmx = document.getElementById('btnExportPmx');
  if (btnPmx) btnPmx.addEventListener('click', () => { btnPmx.disabled = true; exportPMX().finally(() => { btnPmx.disabled = false; }); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFeatures);
} else {
  initFeatures();
}
