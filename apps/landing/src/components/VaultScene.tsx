'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Pause, Play, RotateCcw } from 'lucide-react';
import { art } from '../assets';

export interface SceneCopy { label: string; open: string; close: string; pause: string; play: string; hint: string; unavailable: string }

/** Illustrative vault only. No keys, account state or vault data enter the scene. */
export default function VaultScene({ copy }: { copy: SceneCopy }) {
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<{ open(value: boolean): void; pause(value: boolean): void } | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let disposed = false;
    let clean = () => {};
    async function mount() {
      const [T, { RoundedBoxGeometry }] = await Promise.all([
        import('three'), import('three/addons/geometries/RoundedBoxGeometry.js'),
      ]);
      const container = host.current;
      if (disposed || !container) return;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.35;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.dataset.vaultScene = 'true';
      container.appendChild(renderer.domElement);
      clean = () => { renderer.dispose(); renderer.domElement.remove(); };
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(33, 1, 0.1, 50);
      camera.position.set(0.2, 1.4, 9.9);
      camera.lookAt(0, 0.12, 0);
      scene.add(new T.HemisphereLight(0xffffff, 0x868d9b, 2));
      const light = new T.DirectionalLight(0xffffff, 4.5);
      light.position.set(-3, 7, 5); light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      Object.assign(light.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
      light.shadow.normalBias = 0.03;
      scene.add(light);
      const orange = new T.MeshStandardMaterial({ color: '#e65726', metalness: 0.35, roughness: 0.3 });
      const edge = new T.MeshStandardMaterial({ color: '#9c2c0d', metalness: 0.25, roughness: 0.4 });
      const silver = new T.MeshStandardMaterial({ color: '#e6e9ee', metalness: 0.82, roughness: 0.21 });
      const dark = new T.MeshStandardMaterial({ color: '#252a32', metalness: 0.35, roughness: 0.38 });
      const paper = new T.MeshStandardMaterial({ color: '#fffaf2', roughness: 0.7 });
      const root = new T.Group();
      root.rotation.set(0.1, -0.42, -0.055);
      scene.add(root);
      function box(w: number, h: number, d: number, material: typeof orange, parent: InstanceType<typeof T.Group>, x = 0, y = 0, z = 0, radius = 0.08) {
        const mesh = new T.Mesh(new RoundedBoxGeometry(w, h, d, 4, radius), material);
        mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
        parent.add(mesh); return mesh;
      }
      // Five walls leave a real cavity behind the hinged door.
      box(2.8, 3.15, 0.18, orange, root, 0, 0, -0.6);
      box(0.2, 3.15, 1.4, orange, root, -1.3);
      box(0.2, 3.15, 1.4, orange, root, 1.3);
      box(2.8, 0.2, 1.4, orange, root, 0, 1.475);
      box(2.8, 0.2, 1.4, orange, root, 0, -1.475);
      box(2.4, 0.07, 1.1, silver, root, 0, -0.22);
      box(2.4, 2.76, 0.06, dark, root, 0, 0, -0.47);
      for (let i = 0; i < 3; i++) {
        const file = box(0.6, 0.82 + i * 0.12, 0.13, i === 1 ? orange : paper, root, -0.73 + i * 0.69, 0.3, -0.1, 0.035);
        file.rotation.z = (i - 1) * 0.09;
      }
      box(1.4, 0.56, 0.25, paper, root, 0.08, -0.95, 0.05);
      const hinge = new T.Group(); hinge.position.set(-1.25, 0, 0.7); root.add(hinge);
      box(2.54, 2.94, 0.23, edge, hinge, 1.25, 0, -0.05, 0.09);
      box(2.48, 2.88, 0.19, orange, hinge, 1.25, 0, 0.04, 0.09);
      box(2.02, 2.38, 0.08, dark, hinge, 1.25, 0, 0.17, 0.12);
      const dial = new T.Group(); dial.position.set(1.25, 0.05, 0.28); hinge.add(dial);
      const ring = new T.Mesh(new T.TorusGeometry(0.47, 0.045, 16, 64), silver); dial.add(ring);
      const hub = new T.Mesh(new T.CylinderGeometry(0.14, 0.14, 0.2, 40), silver); hub.rotation.x = Math.PI / 2; dial.add(hub);
      for (let i = 0; i < 3; i++) {
        const a = i * Math.PI * 2 / 3;
        const bar = box(0.08, 0.42, 0.07, silver, dial, Math.sin(a) * 0.24, Math.cos(a) * 0.24, 0.08, 0.03);
        bar.rotation.z = -a;
      }
      for (const y of [-0.87, 0.87]) box(0.14, 0.36, 0.21, silver, root, -1.36, y, 0.79, 0.06);
      for (const x of [-0.95, 0.95]) for (const y of [-1.32, 1.32]) {
        const screw = new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 0.04, 16), silver);
        screw.rotation.x = Math.PI / 2; screw.position.set(1.25 + x, y, 0.2); hinge.add(screw);
      }
      const floor = new T.Mesh(new T.PlaneGeometry(30, 30), new T.ShadowMaterial({ opacity: 0.12 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -1.77; floor.receiveShadow = true; scene.add(floor);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)');
      let visible = true, stopped = false, targetOpen = 0, openness = 0, px = 0, py = 0, tx = 0, ty = 0, previous = 0;
      const render = () => renderer.render(scene, camera);
      const apply = () => {
        hinge.rotation.y = -openness * 1.16;
        dial.rotation.z = -openness * Math.PI * 0.66;
        root.rotation.y = -0.42 + px * 0.18 - openness * 0.1;
        root.rotation.x = 0.1 + py * 0.08;
        render();
      };
      const moving = () => Math.abs(openness - targetOpen) + Math.abs(px - tx) + Math.abs(py - ty) > 0.0001;
      const frame = (time: number) => {
        const dt = Math.min((time - previous) / 1000 || 0.016, 0.05); previous = time;
        openness = T.MathUtils.damp(openness, targetOpen, 5, dt);
        px = T.MathUtils.damp(px, tx, 7, dt); py = T.MathUtils.damp(py, ty, 7, dt);
        apply();
        if (!moving()) renderer.setAnimationLoop(null);
      };
      function syncLoop() {
        renderer.setAnimationLoop(!reduce.matches && !stopped && visible && !document.hidden && moving() ? frame : null);
        if (reduce.matches || stopped) { openness = targetOpen; px = tx; py = ty; }
        apply();
      }
      controls.current = {
        open(value) { targetOpen = value ? 1 : 0; syncLoop(); },
        pause(value) { stopped = value; syncLoop(); },
      };
      function pointer(event: PointerEvent) {
        if (reduce.matches || stopped || event.pointerType === 'touch') return;
        const r = container!.getBoundingClientRect(); tx = (event.clientX - r.left) / r.width - 0.5; ty = (event.clientY - r.top) / r.height - 0.5; syncLoop();
      }
      function leave() { tx = 0; ty = 0; syncLoop(); }
      const resize = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!width || !height) return;
        camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); render();
      });
      resize.observe(container);
      const visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; syncLoop(); });
      visibility.observe(container);
      container.addEventListener('pointermove', pointer);
      container.addEventListener('pointerleave', leave);
      document.addEventListener('visibilitychange', syncLoop);
      reduce.addEventListener('change', syncLoop);
      const lost = (event: Event) => { event.preventDefault(); renderer.setAnimationLoop(null); setFailed(true); setReady(false); };
      renderer.domElement.addEventListener('webglcontextlost', lost);
      syncLoop(); setReady(true);
      clean = () => {
        controls.current = null; renderer.setAnimationLoop(null);
        resize.disconnect(); visibility.disconnect();
        container.removeEventListener('pointermove', pointer); container.removeEventListener('pointerleave', leave);
        document.removeEventListener('visibilitychange', syncLoop); reduce.removeEventListener('change', syncLoop);
        renderer.domElement.removeEventListener('webglcontextlost', lost);
        scene.traverse(object => { if (object instanceof T.Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
        light.shadow.dispose(); renderer.dispose(); renderer.domElement.remove();
      };
      if (disposed) clean();
    }
    mount().catch(() => { clean(); if (!disposed) { setFailed(true); setReady(false); } });
    return () => { disposed = true; clean(); };
  }, []);

  return (
    <figure className={`vault-scene${ready ? ' is-ready' : ''}`} aria-label={copy.label}>
      <div className="vault-scene__canvas" ref={host} />
      {!ready && <img className="vault-scene__fallback" src={art.hero} alt="" width={480} height={480} />}
      <figcaption className="vault-scene__caption">
        <span>{failed ? copy.unavailable : copy.hint}</span>
        <div className="vault-scene__controls">
          <button type="button" disabled={!ready} onClick={() => { const next = !opened; setOpened(next); controls.current?.open(next); }}>
            {opened ? <RotateCcw size={16} /> : <ArrowUpRight size={16} />}{opened ? copy.close : copy.open}
          </button>
          <button type="button" disabled={!ready} aria-label={paused ? copy.play : copy.pause} aria-pressed={paused} onClick={() => { setPaused(!paused); controls.current?.pause(!paused); }}>
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
        </div>
      </figcaption>
    </figure>
  );
}
