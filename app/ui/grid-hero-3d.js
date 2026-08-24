"use client";

import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { BufferGeometry, BufferAttribute, CatmullRomCurve3, Vector3 } from "three";

const SOURCE_ORDER = ["coal", "distillate", "gas", "hydro", "battery", "bioenergy", "wind", "solar"];

const SOURCE_COLORS = {
  coal: "#43424a",
  distillate: "#c17a3d",
  gas: "#ff6f3c",
  hydro: "#2fb1ef",
  battery: "#5a5cf0",
  bioenergy: "#b544e8",
  wind: "#16e0a0",
  solar: "#ffd23f",
};

const SOURCE_LABELS = {
  coal: "Coal",
  distillate: "Distillate",
  gas: "Gas",
  hydro: "Hydro",
  battery: "Battery",
  bioenergy: "Bioenergy",
  wind: "Wind",
  solar: "Solar",
};

const UNIT_X = 1.05;
const DEPTH_SCALE = 4.4;
const MAX_ALTITUDE = DEPTH_SCALE / 2;
const GROUND_EPSILON = 0.02;
const FINE_STEPS_PER_GAP = 6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normaliseSourceKey(source) {
  return source.toLowerCase().split("_")[0];
}

function aggregateSourceMix(sourceMix) {
  const totals = {};
  for (const [key, value] of Object.entries(sourceMix || {})) {
    const group = normaliseSourceKey(key);
    totals[group] = (totals[group] || 0) + (Number(value) || 0);
  }
  return totals;
}

function formatHour(timestamp) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function hasWebGL() {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext) && Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function getFullSourceLegend() {
  return SOURCE_ORDER.map((source) => ({ source, label: SOURCE_LABELS[source], color: SOURCE_COLORS[source] }));
}

function buildCurve(values) {
  const points = values.map((value, index) => new Vector3(index, value, 0));
  if (points.length === 1) points.push(new Vector3(1, values[0], 0));
  return new CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

function resample(values, fineCount) {
  const curve = buildCurve(values);
  const out = new Array(fineCount);
  for (let i = 0; i < fineCount; i += 1) {
    const t = i / (fineCount - 1);
    out[i] = curve.getPoint(t).y;
  }
  return out;
}

function buildEndCap(x, altitude, zBottom, zTop, color) {
  const positions = new Float32Array([
    x, GROUND_EPSILON, zBottom,
    x, altitude, zBottom,
    x, altitude, zTop,
    x, GROUND_EPSILON, zTop,
  ]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return { geometry, color };
}

function buildQuadStrip(edgeA, edgeB, color) {
  const count = edgeA.length;
  const positions = new Float32Array(count * 2 * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 6 + 0] = edgeA[i][0];
    positions[i * 6 + 1] = edgeA[i][1];
    positions[i * 6 + 2] = edgeA[i][2];
    positions[i * 6 + 3] = edgeB[i][0];
    positions[i * 6 + 4] = edgeB[i][1];
    positions[i * 6 + 5] = edgeB[i][2];
  }
  const indices = [];
  for (let i = 0; i < count - 1; i += 1) {
    const a0 = i * 2;
    const b0 = i * 2 + 1;
    const a1 = (i + 1) * 2;
    const b1 = (i + 1) * 2 + 1;
    indices.push(a0, b0, a1, b0, b1, a1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, color };
}

function useFlowGeometry(buckets) {
  return useMemo(() => {
    const hourCount = buckets.length;
    if (hourCount < 2) return { bandMeshes: [], totalWidth: 0, fineXs: [], altitudes: [] };

    const totalWidth = (hourCount - 1) * UNIT_X;
    const fineCount = (hourCount - 1) * FINE_STEPS_PER_GAP + 1;
    const fineXs = Array.from({ length: fineCount }, (_, i) => (i / (fineCount - 1)) * totalWidth - totalWidth / 2);

    const perSourceRaw = SOURCE_ORDER.map((source) => {
      const values = buckets.map((bucket) => aggregateSourceMix(bucket.sourceMix)[source] || 0);
      return resample(values, fineCount).map((value) => Math.max(0, value));
    });

    const totalsPerSample = fineXs.map((_, sampleIndex) =>
      perSourceRaw.reduce((sum, series) => sum + series[sampleIndex], 0));
    const normalised = perSourceRaw.map((series) =>
      series.map((value, sampleIndex) => (value / (totalsPerSample[sampleIndex] || 1)) * 100));

    const computeValues = buckets.map((bucket) => clamp(Number(bucket.computePercent) || 0, 0, 100));
    const altitudes = resample(computeValues, fineCount).map((value) => (clamp(value, 0, 100) / 100) * MAX_ALTITUDE);
    const lastFine = fineXs.length - 1;

    let cumulative = fineXs.map(() => -DEPTH_SCALE / 2);
    const bands = SOURCE_ORDER.map((source) => {
      const thickness = normalised[SOURCE_ORDER.indexOf(source)].map((pct) => (pct / 100) * DEPTH_SCALE);
      const zBottom = cumulative.slice();
      const zTop = zBottom.map((z, i) => z + thickness[i]);
      cumulative = zTop;

      const topA = fineXs.map((x, i) => [x, altitudes[i], zBottom[i]]);
      const topB = fineXs.map((x, i) => [x, altitudes[i], zTop[i]]);
      const top = buildQuadStrip(topA, topB, SOURCE_COLORS[source]);
      const startCap = buildEndCap(fineXs[0], altitudes[0], zBottom[0], zTop[0], SOURCE_COLORS[source]);
      const endCap = buildEndCap(fineXs[lastFine], altitudes[lastFine], zBottom[lastFine], zTop[lastFine], SOURCE_COLORS[source]);

      return { source, top, startCap, endCap, zBottom, zTop };
    });

    const first = bands[0];
    const last = bands[bands.length - 1];
    const frontEdgeA = fineXs.map((x, i) => [x, altitudes[i], first.zBottom[i]]);
    const frontEdgeB = fineXs.map((x, i) => [x, GROUND_EPSILON, first.zBottom[i]]);
    const front = buildQuadStrip(frontEdgeA, frontEdgeB, SOURCE_COLORS[first.source]);

    const backEdgeA = fineXs.map((x, i) => [x, GROUND_EPSILON, last.zTop[i]]);
    const backEdgeB = fineXs.map((x, i) => [x, altitudes[i], last.zTop[i]]);
    const back = buildQuadStrip(backEdgeA, backEdgeB, SOURCE_COLORS[last.source]);

    const bandMeshes = bands.map(({ source, top, startCap, endCap }) => ({ source, parts: [top, startCap, endCap] }));
    bandMeshes[0].parts.push(front);
    bandMeshes[bandMeshes.length - 1].parts.push(back);

    return { bandMeshes, totalWidth, fineXs, altitudes };
  }, [buckets]);
}

function FlowSurface({ buckets, totalWidth, setHoveredIndex }) {
  const { bandMeshes } = useFlowGeometry(buckets);

  function handleMove(event) {
    event.stopPropagation();
    const index = clamp(Math.round((event.point.x + totalWidth / 2) / UNIT_X), 0, buckets.length - 1);
    setHoveredIndex(index);
  }

  return bandMeshes.map(({ source, parts }) => (
    <group key={source} onPointerMove={handleMove} onPointerLeave={() => setHoveredIndex(null)}>
      {parts.map((part, index) => (
        <mesh key={index} geometry={part.geometry}>
          <meshStandardMaterial color={part.color} emissive={part.color} emissiveIntensity={0.22} roughness={0.32} metalness={0.08} side={2} />
        </mesh>
      ))}
    </group>
  ));
}

function HourLabels({ buckets, totalWidth }) {
  const labelled = buckets.filter((_, index) => index === 0 || index === buckets.length - 1 || index % 6 === 0);
  return (
    <>
      {labelled.map((bucket) => {
        const index = buckets.indexOf(bucket);
        const x = index * UNIT_X - totalWidth / 2;
        return (
          <Html key={bucket.timestamp} position={[x, 0, DEPTH_SCALE / 2 + 1]} center style={{ pointerEvents: "none" }}>
            <div className="hero3d-hour-label">{formatHour(bucket.timestamp)}</div>
          </Html>
        );
      })}
      <Html position={[0, 0, DEPTH_SCALE / 2 + 2]} center style={{ pointerEvents: "none" }}>
        <div className="hero3d-axis-title">Time</div>
      </Html>
    </>
  );
}

function AltitudeAxis({ totalWidth }) {
  const x = -totalWidth / 2 - 1.2;
  const z = -DEPTH_SCALE / 2 - 0.4;
  return (
    <>
      <Line points={[[x, 0, z], [x, MAX_ALTITUDE, z]]} color="#c3c2b7" lineWidth={1} />
      {[0, 50, 100].map((pct) => (
        <Html key={pct} position={[x, (pct / 100) * MAX_ALTITUDE, z]} center style={{ pointerEvents: "none" }}>
          <div className="hero3d-depth-label">{pct}% load</div>
        </Html>
      ))}
      <Html position={[x, MAX_ALTITUDE + 0.7, z]} center style={{ pointerEvents: "none" }}>
        <div className="hero3d-axis-title">Compute load</div>
      </Html>
    </>
  );
}

function DepthAxisTitle() {
  return (
    <Html position={[0, 0, -DEPTH_SCALE / 2 - 1.5]} center style={{ pointerEvents: "none" }}>
      <div className="hero3d-axis-title">Energy sources</div>
    </Html>
  );
}

function HoverCursor({ buckets, totalWidth, hoveredIndex }) {
  if (hoveredIndex == null) return null;
  const bucket = buckets[hoveredIndex];
  if (!bucket) return null;
  const x = hoveredIndex * UNIT_X - totalWidth / 2;
  const sourceTotals = aggregateSourceMix(bucket.sourceMix);
  const breakdown = SOURCE_ORDER
    .map((key) => ({ key, value: sourceTotals[key] || 0 }))
    .filter((entry) => entry.value >= 1)
    .sort((left, right) => right.value - left.value);
  const computePercent = clamp(Number(bucket.computePercent) || 0, 0, 100);
  const altitude = (computePercent / 100) * MAX_ALTITUDE;

  return (
    <group>
      <Line points={[[x, 0.02, 0], [x, altitude - 0.1, 0]]} color="#31824b" lineWidth={1.5} />
      <mesh position={[x, altitude + 0.06, 0]}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshStandardMaterial color="#31824b" emissive="#31824b" emissiveIntensity={0.6} />
      </mesh>
      <Html position={[x, altitude + 0.9, 0]} center style={{ pointerEvents: "none" }}>
        <div className="hero3d-tooltip">
          <strong>{formatHour(bucket.timestamp)}</strong>
          <span>{computePercent.toFixed(0)}% relative compute</span>
          <small className="hero3d-breakdown">
            {breakdown.map((entry) => `${SOURCE_LABELS[entry.key] || entry.key} ${entry.value.toFixed(0)}%`).join(" · ")}
          </small>
        </div>
      </Html>
    </group>
  );
}

export default function GridHero3D({ buckets }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const { totalWidth } = useFlowGeometry(buckets);

  return (
    <div className="grid-hero-canvas grid-hero-3d">
      <div className="hero3d-toolbar">
        <span className="hero3d-hint">Drag to explore · hover the flow to see the mix and compute load for that hour</span>
      </div>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [totalWidth * 0.14, DEPTH_SCALE * 1.5 + 2.5, DEPTH_SCALE * 2.3 + 11], fov: 34 }}
      >
        <color attach="background" args={["#fffdf7"]} />
        <ambientLight intensity={0.95} />
        <hemisphereLight args={["#ffffff", "#f3ead6", 0.5]} />
        <directionalLight position={[10, 16, 8]} intensity={1.05} />
        <directionalLight position={[-8, 10, -6]} intensity={0.35} color="#fff3d6" />

        <Grid
          args={[totalWidth + 6, DEPTH_SCALE + 6]}
          position={[0, 0, 0]}
          cellSize={UNIT_X}
          cellColor="#ece9df"
          sectionSize={UNIT_X * 6}
          sectionColor="#d5d2c6"
          fadeDistance={40}
          fadeStrength={1}
          infiniteGrid={false}
        />

        <FlowSurface buckets={buckets} totalWidth={totalWidth} setHoveredIndex={setHoveredIndex} />
        <HourLabels buckets={buckets} totalWidth={totalWidth} />
        <AltitudeAxis totalWidth={totalWidth} />
        <DepthAxisTitle />
        <HoverCursor buckets={buckets} totalWidth={totalWidth} hoveredIndex={hoveredIndex} />

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          minDistance={6}
          maxDistance={48}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, MAX_ALTITUDE * 0.5, 0]}
          autoRotate
          autoRotateSpeed={0.5}
        />
      </Canvas>
    </div>
  );
}
