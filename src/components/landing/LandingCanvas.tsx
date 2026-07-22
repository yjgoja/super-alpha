"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Float } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

type BarSpec = {
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number, number];
};

const BARS: BarSpec[] = [
  {
    label: "XAU",
    position: [0.1, 0.92, 0.08],
    rotation: [0.1, -0.42, 0.05],
    size: [2.4, 0.58, 0.78],
  },
  {
    label: "EUR",
    position: [-0.08, 0.12, 0.04],
    rotation: [-0.05, -0.32, -0.04],
    size: [2.6, 0.58, 0.78],
  },
  {
    label: "MT5",
    position: [0.18, -0.68, 0],
    rotation: [0.12, -0.48, 0.07],
    size: [2.25, 0.58, 0.78],
  },
];

function makeLabelTexture(label: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = "#f5f5f5";
  ctx.font = "700 72px system-ui, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 28, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function AssetBar({
  label,
  position,
  rotation,
  size,
  reduced,
}: BarSpec & { reduced: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const phase = useMemo(() => label.length * 0.7, [label]);
  const labelMap = useMemo(() => makeLabelTexture(label), [label]);

  useEffect(() => () => labelMap.dispose(), [labelMap]);

  useFrame(({ clock }) => {
    if (!ref.current || reduced) return;
    const t = clock.getElapsedTime();
    ref.current.position.y = position[1] + Math.sin(t * 0.65 + phase) * 0.04;
  });

  return (
    <group ref={ref} position={position} rotation={rotation}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial
          color="#3a3a40"
          metalness={0.88}
          roughness={0.28}
          emissive="#1a1410"
          emissiveIntensity={0.35}
        />
      </mesh>
      {/* front bevel highlight */}
      <mesh position={[0, 0, size[2] / 2 + 0.001]}>
        <planeGeometry args={[size[0] * 0.98, size[1] * 0.98]} />
        <meshStandardMaterial
          color="#2a2a2e"
          metalness={0.85}
          roughness={0.4}
          transparent
          opacity={0.55}
        />
      </mesh>
      <mesh position={[-size[0] * 0.22, 0.02, size[2] / 2 + 0.01]}>
        <planeGeometry args={[size[0] * 0.55, size[1] * 0.55]} />
        <meshBasicMaterial map={labelMap} transparent depthWrite={false} />
      </mesh>
      {/* top rim light */}
      <mesh position={[0, size[1] / 2 + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size[0] * 0.95, size[2] * 0.95]} />
        <meshBasicMaterial color="#3f3f44" transparent opacity={0.35} />
      </mesh>
    </group>
  );
}

function ChromeOrb({ reduced }: { reduced: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    if (reduced) return;
    const t = clock.getElapsedTime();
    if (ref.current) {
      ref.current.position.set(
        0.62 + Math.cos(t * 0.55) * 0.14,
        0.32 + Math.sin(t * 0.7) * 0.12,
        0.95 + Math.sin(t * 0.4) * 0.1,
      );
    }
    if (light.current) {
      light.current.intensity = 3.2 + Math.sin(t * 1.5) * 0.6;
      if (ref.current) {
        light.current.position.copy(ref.current.position);
        light.current.position.z += 0.25;
        light.current.position.y += 0.1;
      }
    }
  });

  return (
    <group>
      <mesh ref={ref} position={[0.62, 0.32, 0.95]} castShadow>
        <sphereGeometry args={[0.34, 64, 64]} />
        <meshStandardMaterial
          color="#f2eee8"
          metalness={1}
          roughness={0.12}
          emissive="#ff6a20"
          emissiveIntensity={0.25}
        />
      </mesh>
      <pointLight
        ref={light}
        color="#ff7a2e"
        intensity={3.4}
        distance={6}
        decay={2}
      />
      <mesh position={[0.78, 0.42, 1.15]}>
        <sphereGeometry args={[0.04, 16, 16]} />
        <meshBasicMaterial color="#ffb078" />
      </mesh>
    </group>
  );
}

function WarmFill() {
  // Fake environment: bright hemisphere so metal reads without HDR
  return (
    <>
      <hemisphereLight args={["#fff0e0", "#0a0a0c", 0.55]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={[3.5, 4.5, 2.5]}
        intensity={2.2}
        color="#ffe6c8"
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight position={[-4, 1.5, -1]} intensity={0.55} color="#6d7f99" />
      <spotLight
        position={[1.5, 3.5, 2.2]}
        angle={0.5}
        penumbra={0.65}
        intensity={2.4}
        color="#ff8a3d"
      />
    </>
  );
}

function Dust({ reduced }: { reduced: boolean }) {
  const count = reduced ? 50 : 180;
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 9;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 5.5;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 5;
    }
    return arr;
  }, [count]);
  const ref = useRef<THREE.Points>(null);
  useFrame((_, dt) => {
    if (!ref.current || reduced) return;
    ref.current.rotation.y += dt * 0.018;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.015}
        color="#ff9a4a"
        transparent
        opacity={0.45}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

function CameraRig({ reduced }: { reduced: boolean }) {
  const { camera } = useThree();
  useFrame((state) => {
    if (reduced) {
      camera.lookAt(0.05, 0.1, 0);
      return;
    }
    const { x, y } = state.pointer;
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, 1.2 + x * 0.4, 0.05);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.2 + y * 0.22, 0.05);
    camera.lookAt(0.05, 0.1, 0);
  });
  return null;
}

function Scene({ reduced }: { reduced: boolean }) {
  return (
    <>
      {/* Transparent clear — CSS stacked bars sit underneath */}
      <WarmFill />

      <Float speed={reduced ? 0 : 0.85} rotationIntensity={0.1} floatIntensity={0.18}>
        <group position={[0.2, 0.15, 0.4]} scale={1.15}>
          {BARS.map((bar) => (
            <AssetBar key={bar.label} {...bar} reduced={reduced} />
          ))}
          <ChromeOrb reduced={reduced} />
        </group>
      </Float>

      <Dust reduced={reduced} />
      <ContactShadows
        position={[0, -1.35, 0]}
        opacity={0.55}
        scale={14}
        blur={2.8}
        far={5}
        color="#000000"
      />
      <CameraRig reduced={reduced} />
    </>
  );
}

export function LandingCanvas({ reduced = false }: { reduced?: boolean }) {
  return (
    <Canvas
      className="lp-canvas"
      dpr={[1, 1.75]}
      camera={{ position: [1.2, 0.2, 5.2], fov: 36 }}
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      shadows
      onCreated={({ gl }) => {
        gl.setClearColor("#000000", 0);
      }}
    >
      <Scene reduced={reduced} />
    </Canvas>
  );
}
