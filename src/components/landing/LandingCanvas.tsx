"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import {
  Environment,
  Float,
  MeshDistortMaterial,
  Sparkles,
} from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

function GoldCore({ reduced }: { reduced: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (!ref.current || reduced) return;
    ref.current.rotation.y += dt * 0.35;
    ref.current.rotation.x += dt * 0.12;
  });

  return (
    <Float speed={reduced ? 0 : 1.4} rotationIntensity={0.35} floatIntensity={0.55}>
      <mesh ref={ref} position={[0.15, 0.35, 0]} castShadow>
        <icosahedronGeometry args={[0.72, 1]} />
        <meshPhysicalMaterial
          color="#e8c36a"
          metalness={1}
          roughness={0.18}
          clearcoat={1}
          clearcoatRoughness={0.12}
          reflectivity={1}
          emissive="#7a5a20"
          emissiveIntensity={0.18}
        />
      </mesh>
      <mesh position={[0.15, 0.35, 0]}>
        <icosahedronGeometry args={[0.78, 1]} />
        <meshBasicMaterial color="#f5d78e" wireframe transparent opacity={0.22} />
      </mesh>
    </Float>
  );
}

function OrbitRings({ reduced }: { reduced: boolean }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!g.current || reduced) return;
    g.current.rotation.z += dt * 0.18;
    g.current.rotation.y += dt * 0.08;
  });

  return (
    <group ref={g} position={[0.1, 0.2, -0.2]}>
      {[1.55, 2.05, 2.55].map((r, i) => (
        <mesh key={r} rotation={[Math.PI / 2.4, 0.2 * i, 0.35 * i]}>
          <torusGeometry args={[r, 0.012, 16, 180]} />
          <meshStandardMaterial
            color={i === 1 ? "#4fd1c5" : "#e8c36a"}
            metalness={0.9}
            roughness={0.25}
            emissive={i === 1 ? "#1a5c55" : "#5a4315"}
            emissiveIntensity={0.35}
          />
        </mesh>
      ))}
    </group>
  );
}

function PriceRibbon({ reduced }: { reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  const tube = useMemo(() => {
    const pts = [
      new THREE.Vector3(-3.2, -0.2, 0.4),
      new THREE.Vector3(-2.0, 0.5, 0.1),
      new THREE.Vector3(-0.8, -0.35, -0.2),
      new THREE.Vector3(0.4, 0.55, 0.15),
      new THREE.Vector3(1.6, -0.15, -0.1),
      new THREE.Vector3(2.8, 0.4, 0.25),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    return new THREE.TubeGeometry(curve, 120, 0.035, 12, false);
  }, []);

  useFrame(({ clock }) => {
    if (!group.current || reduced) return;
    group.current.position.y = Math.sin(clock.getElapsedTime() * 0.7) * 0.06;
  });

  return (
    <group ref={group} position={[0, -0.15, 0.4]}>
      <mesh geometry={tube}>
        <meshPhysicalMaterial
          color="#f0d28a"
          metalness={1}
          roughness={0.2}
          emissive="#c9a227"
          emissiveIntensity={0.45}
        />
      </mesh>
    </group>
  );
}

function DustField() {
  const count = 280;
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    // 결정적 분포 — render purity / SSR hydration 안정
    for (let i = 0; i < count; i++) {
      const n = i + 1;
      const a = (n * 12.9898) % 1;
      const b = (n * 78.233) % 1;
      const c = (n * 37.719) % 1;
      arr[i * 3] = (a - 0.5) * 10;
      arr[i * 3 + 1] = (b - 0.5) * 6;
      arr[i * 3 + 2] = (c - 0.5) * 6;
    }
    return arr;
  }, []);

  const ref = useRef<THREE.Points>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    ref.current.rotation.y += dt * 0.02;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.018}
        color="#e8c36a"
        transparent
        opacity={0.65}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

function Floor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.55, 0]} receiveShadow>
      <circleGeometry args={[4.2, 64]} />
      <MeshDistortMaterial
        color="#0c1118"
        speed={1.2}
        distort={0.15}
        radius={1}
        metalness={0.6}
        roughness={0.4}
      />
    </mesh>
  );
}

function CameraRig({ reduced }: { reduced: boolean }) {
  useFrame((state) => {
    if (reduced) return;
    const { x, y } = state.pointer;
    state.camera.position.x = THREE.MathUtils.lerp(state.camera.position.x, x * 0.55, 0.04);
    state.camera.position.y = THREE.MathUtils.lerp(state.camera.position.y, 0.35 + y * 0.25, 0.04);
    state.camera.lookAt(0, 0.1, 0);
  });
  return null;
}

function Scene({ reduced }: { reduced: boolean }) {
  return (
    <>
      <color attach="background" args={["#05070b"]} />
      <fog attach="fog" args={["#05070b", 6, 14]} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[4, 6, 2]} intensity={1.4} color="#ffe9b0" castShadow />
      <pointLight position={[-3, 2, 2]} intensity={0.8} color="#4fd1c5" />
      <spotLight position={[2, 5, 3]} angle={0.4} penumbra={0.6} intensity={1.2} color="#f5d78e" />

      <GoldCore reduced={reduced} />
      <OrbitRings reduced={reduced} />
      <PriceRibbon reduced={reduced} />
      <DustField />
      <Floor />
      {!reduced && (
        <Sparkles count={40} scale={[7, 4, 4]} size={2.5} speed={0.35} color="#f5d78e" />
      )}
      <Environment preset="city" environmentIntensity={0.55} />
      <CameraRig reduced={reduced} />
    </>
  );
}

export function LandingCanvas({ reduced = false }: { reduced?: boolean }) {
  return (
    <Canvas
      className="lp-canvas"
      dpr={[1, 1.75]}
      camera={{ position: [0, 0.4, 5.2], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
    >
      <Scene reduced={reduced} />
    </Canvas>
  );
}
