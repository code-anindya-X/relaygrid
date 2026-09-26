"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { WarehouseSnapshot } from "@/lib/types";

const palette: Record<string, number> = {
  storage: 0xb8d6c8,
  receiving: 0xaacdbd,
  packing: 0xdecdb5,
  shipping: 0xc9c4dc,
  charging: 0xbdd9ca,
};

export function WarehouseTwin({ snapshot, selectedRobot, onSelectRobot }: { snapshot: WarehouseSnapshot; selectedRobot?: string; onSelectRobot: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const robotMeshes = useRef(new Map<string, THREE.Group>());
  const snapshotRef = useRef(snapshot);
  const selectedRef = useRef(selectedRobot);
  const selectRef = useRef(onSelectRobot);

  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { selectedRef.current = selectedRobot; }, [selectedRobot]);
  useEffect(() => { selectRef.current = onSelectRobot; }, [onSelectRobot]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const initial = snapshotRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f4ee);
    scene.fog = new THREE.Fog(0xf1f4ee, 62, 105);

    const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 180);
    camera.position.set(51, 47, 49);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(initial.warehouse.width / 2, 0, initial.warehouse.depth / 2);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.08;
    controls.minDistance = 28;
    controls.maxDistance = 100;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa6b8af, 2.4));
    const sun = new THREE.DirectionalLight(0xfff5df, 3.4);
    sun.position.set(28, 52, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -55;
    sun.shadow.camera.right = 55;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(initial.warehouse.width + 4, 0.8, initial.warehouse.depth + 4),
      new THREE.MeshStandardMaterial({ color: 0xe8eee9, roughness: 0.92, metalness: 0 }),
    );
    floor.position.set(initial.warehouse.width / 2, -0.6, initial.warehouse.depth / 2);
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(Math.max(initial.warehouse.width, initial.warehouse.depth), 30, 0xa8bbb1, 0xd1ddd6);
    grid.position.set(initial.warehouse.width / 2, -0.17, initial.warehouse.depth / 2);
    grid.material.transparent = true;
    grid.material.opacity = 0.34;
    scene.add(grid);

    for (const zone of initial.zones) {
      const group = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(zone.width, 0.38, zone.depth),
        new THREE.MeshStandardMaterial({ color: palette[zone.type] ?? 0xc7d8cf, roughness: 0.72, transparent: true, opacity: 0.88 }),
      );
      slab.position.y = 0.05;
      slab.receiveShadow = true;
      group.add(slab);

      if (zone.type === "storage") {
        const rackMaterial = new THREE.MeshStandardMaterial({ color: 0x718b80, roughness: 0.58 });
        const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xd9c4a5, roughness: 0.9 });
        const rackCount = Math.max(2, Math.floor(zone.width / 3));
        for (let index = 0; index < rackCount; index += 1) {
          const rack = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.5, Math.max(2, zone.depth - 2)), rackMaterial);
          rack.position.set(-zone.width / 2 + 1.6 + index * 2.6, 1.45, 0);
          rack.castShadow = true;
          group.add(rack);
          const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 1.2), boxMaterial);
          box.position.set(rack.position.x, 1.35, -zone.depth / 3);
          group.add(box);
        }
      } else {
        const marker = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.8, zone.width * 0.42), 0.8, Math.min(2.5, zone.depth * 0.45)), new THREE.MeshStandardMaterial({ color: zone.type === "charging" ? 0x6c9d86 : 0xa58d70, roughness: 0.7 }));
        marker.position.y = 0.63;
        marker.castShadow = true;
        group.add(marker);
      }
      group.position.set(zone.x + zone.width / 2, 0, zone.y + zone.depth / 2);
      scene.add(group);
    }

    for (const mission of initial.missions) {
      if (mission.route.length < 2) continue;
      const points = mission.route.map((point) => new THREE.Vector3(point.x, 0.26, point.y));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x76a692, transparent: true, opacity: 0.62 }));
      scene.add(line);
    }

    for (const robot of initial.robots) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.75, 1.6), new THREE.MeshStandardMaterial({ color: 0x4f8173, roughness: 0.36, metalness: 0.08 }));
      body.position.y = 0.78;
      body.castShadow = true;
      body.userData.robotId = robot.id;
      group.add(body);
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.42, 1.1), new THREE.MeshStandardMaterial({ color: 0xf5f2e8, roughness: 0.48 }));
      top.position.y = 1.32;
      top.userData.robotId = robot.id;
      group.add(top);
      const signal = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.28, 12), new THREE.MeshStandardMaterial({ color: robot.state === "blocked" ? 0xc76b5b : 0xd4a866 }));
      signal.position.set(0.65, 1.62, 0);
      signal.userData.robotId = robot.id;
      group.add(signal);
      group.position.set(robot.x, 0, robot.y);
      group.rotation.y = THREE.MathUtils.degToRad(-robot.heading);
      group.userData.target = new THREE.Vector3(robot.x, 0, robot.y);
      group.userData.robotId = robot.id;
      scene.add(group);
      robotMeshes.current.set(robot.id, group);
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const click = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(Array.from(robotMeshes.current.values()), true).find((entry) => entry.object.userData.robotId);
      if (hit) selectRef.current(String(hit.object.userData.robotId));
    };
    renderer.domElement.addEventListener("pointerup", click);

    const resize = () => {
      const width = Math.max(320, element.clientWidth);
      const height = Math.max(360, element.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      for (const [id, group] of robotMeshes.current) {
        const current = snapshotRef.current.robots.find((robot) => robot.id === id);
        if (!current) continue;
        const target = group.userData.target as THREE.Vector3;
        target.set(current.x, 0, current.y);
        group.position.lerp(target, 0.055);
        group.rotation.y = THREE.MathUtils.lerp(group.rotation.y, THREE.MathUtils.degToRad(-current.heading), 0.08);
        const selected = selectedRef.current === id;
        const scale = selected ? 1.18 : 1;
        group.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.12);
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerup", click);
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      robotMeshes.current.clear();
      element.removeChild(renderer.domElement);
    };
  }, [snapshot.warehouse.id]);

  return <div className="twin-canvas" ref={host}><div className="twin-overlay"><span><i/> LIVE POSITION STREAM</span><small>Drag to orbit · scroll to zoom · click an AGV</small></div></div>;
}
