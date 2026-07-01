// Audio-reactive orb for the "Hang" (élő hang-mód) dashboard page.
//
// Standalone ES module (loaded via <script type="module">, see index.html importmap for
// "three") so the 12k-line app.js stays untouched -- this file only talks to the rest of the
// dashboard through two narrow channels:
//   - listens for window CustomEvent 'voice:mood'   { mood: 'idle'|'listening'|'speaking', volume?: 0..1 }
//   - reads #voicePage's `hidden` attribute (via MutationObserver) to pause/resume the render
//     loop, so an inactive tab doesn't burn a GPU render loop in the background.
//
// Colors are first-pass approximations of Mantis's two reference renders
// (store/generated/tars-orb-idle-amber.png, tars-orb-speaking-turquoise.png). Exact hex/ratio
// values are still TBD from Mantis -- see agents/rocket/docs/voice-mode-design.md section 9a.
import * as THREE from 'three'

const MOOD_COLORS = {
  idle: new THREE.Color(0xf2a541),
  listening: new THREE.Color(0xf2a541), // placeholder -- same as idle until a dedicated
                                         // "user is talking" palette is agreed with Mantis
  speaking: new THREE.Color(0x3ddfd0),
}

function buildOrbGeometry() {
  // Dense particle sphere (the orb "core") + a slanted particle ring, echoing the
  // reference renders' Saturn-like ring silhouette.
  const group = new THREE.Group()

  const CORE_COUNT = 3200
  const corePositions = new Float32Array(CORE_COUNT * 3)
  for (let i = 0; i < CORE_COUNT; i++) {
    // Uniform point on a sphere surface, radius jittered inward for a "volumetric dust" look.
    const u = Math.random()
    const v = Math.random()
    const theta = 2 * Math.PI * u
    const phi = Math.acos(2 * v - 1)
    const r = 1 * (0.72 + 0.28 * Math.random())
    corePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    corePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    corePositions[i * 3 + 2] = r * Math.cos(phi)
  }
  const coreGeo = new THREE.BufferGeometry()
  coreGeo.setAttribute('position', new THREE.BufferAttribute(corePositions, 3))
  const coreMat = new THREE.PointsMaterial({
    size: 0.018,
    sizeAttenuation: true,
    color: MOOD_COLORS.idle.clone(),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const core = new THREE.Points(coreGeo, coreMat)
  core.name = 'orbCore'
  group.add(core)

  const RING_COUNT = 2200
  const ringPositions = new Float32Array(RING_COUNT * 3)
  for (let i = 0; i < RING_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 1.15 + Math.random() * 0.55
    const wobble = (Math.random() - 0.5) * 0.05
    ringPositions[i * 3] = Math.cos(angle) * radius
    ringPositions[i * 3 + 1] = wobble
    ringPositions[i * 3 + 2] = Math.sin(angle) * radius
  }
  const ringGeo = new THREE.BufferGeometry()
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3))
  const ringMat = new THREE.PointsMaterial({
    size: 0.012,
    sizeAttenuation: true,
    color: MOOD_COLORS.idle.clone(),
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const ring = new THREE.Points(ringGeo, ringMat)
  ring.name = 'orbRing'
  ring.rotation.x = Math.PI / 2.6
  ring.rotation.z = Math.PI / 8
  group.add(ring)

  const glowGeo = new THREE.SphereGeometry(0.28, 24, 24)
  const glowMat = new THREE.MeshBasicMaterial({
    color: MOOD_COLORS.idle.clone(),
    transparent: true,
    opacity: 0.9,
  })
  const glow = new THREE.Mesh(glowGeo, glowMat)
  glow.name = 'orbGlow'
  group.add(glow)

  return group
}

function initVoiceOrb() {
  const wrap = document.getElementById('voiceOrbWrap')
  const canvas = document.getElementById('voiceOrbCanvas')
  const voicePage = document.getElementById('voicePage')
  if (!wrap || !canvas || !voicePage) return // page not present on this build -- nothing to do

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(0, 0.4, 3.1)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const orb = buildOrbGeometry()
  scene.add(orb)

  let mood = 'idle'
  let targetVolume = 0
  let smoothedVolume = 0

  function applyMoodColor() {
    const color = MOOD_COLORS[mood] || MOOD_COLORS.idle
    orb.getObjectByName('orbCore').material.color.copy(color)
    orb.getObjectByName('orbRing').material.color.copy(color)
    orb.getObjectByName('orbGlow').material.color.copy(color)
    const clockEl = document.getElementById('voiceClock')
    if (clockEl) voicePage.style.setProperty('--mood-color', `#${color.getHexString()}`)
  }
  applyMoodColor()

  window.addEventListener('voice:mood', (e) => {
    const detail = e.detail || {}
    if (detail.mood && MOOD_COLORS[detail.mood]) {
      mood = detail.mood
      applyMoodColor()
    }
    if (typeof detail.volume === 'number') targetVolume = Math.max(0, Math.min(1, detail.volume))
  })

  function resize() {
    const rect = wrap.getBoundingClientRect()
    const size = Math.max(rect.width, rect.height, 1)
    renderer.setSize(size, size, false)
    camera.aspect = 1
    camera.updateProjectionMatrix()
  }
  resize()
  new ResizeObserver(resize).observe(wrap)

  let running = false
  let rafId = null
  const clock = new THREE.Clock()

  function tick() {
    if (!running) return
    rafId = requestAnimationFrame(tick)
    const t = clock.getElapsedTime()
    smoothedVolume += (targetVolume - smoothedVolume) * 0.15
    const pulse = 1 + smoothedVolume * 0.35
    orb.rotation.y = t * 0.12
    orb.getObjectByName('orbRing').rotation.z = Math.PI / 8 + t * 0.05
    orb.scale.setScalar(1 + Math.sin(t * 1.4) * 0.02 + smoothedVolume * 0.08)
    orb.getObjectByName('orbGlow').scale.setScalar(pulse)
    renderer.render(scene, camera)
  }
  function start() { if (running) return; running = true; tick() }
  function stop() { running = false; if (rafId) cancelAnimationFrame(rafId) }

  if (!voicePage.hidden) start()
  new MutationObserver(() => { voicePage.hidden ? stop() : (resize(), start()) })
    .observe(voicePage, { attributes: true, attributeFilter: ['hidden'] })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVoiceOrb)
} else {
  initVoiceOrb()
}
