"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Vector3 } from "three";
import { aggregateSourceMix, formatHour, SOURCE_COLORS, SOURCE_LABELS, SOURCE_ORDER } from "@/lib/energy-sources";

// A flowing surface of your compute load. X is time, Z is the NEM's fuel mix, and
// the altitude is how much compute you were running that hour. Hitting Optimise
// morphs the surface from the schedule you ran to the schedule you could run,
// so the load visibly drains out of the coal-dark hours into the solar-bright ones.

const INTRO_DURATION = 2.1;
const UNIT_X = 1.05;
const DEPTH_SCALE = 4.4;
const MAX_ALTITUDE = DEPTH_SCALE / 2;
const GROUND_EPSILON = 0.02;
const GROUND_REF = -1;
const FINE_STEPS_PER_GAP = 6;
const SHIFT_SPEED = 1.4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function buildCurve(values) {
  const points = values.map((value, index) => new Vector3(index, value, 0));
  if (points.length === 1) points.push(new Vector3(1, values[0], 0));
  return new CatmullRomCurve3(points, false, "catmullrom", 0.5);
}

function resample(values, fineCount) {
  const curve = buildCurve(values);
  return Array.from({ length: fineCount }, (_, index) => curve.getPoint(index / (fineCount - 1)).y);
}

// Each part carries a yMap: for every vertex, which fine sample supplies its
// altitude (or GROUND_REF for vertices pinned to the floor). That is what lets the
// surface be re-shaped in place every frame instead of rebuilt.
function buildEndCap(x, zBottom, zTop, sample, color) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([
    x, GROUND_EPSILON, zBottom,
    x, GROUND_EPSILON, zBottom,
    x, GROUND_EPSILON, zTop,
    x, GROUND_EPSILON, zTop,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return { geometry, color, yMap: [GROUND_REF, sample, sample, GROUND_REF] };
}

function buildQuadStrip(xs, zA, zB, yMapA, yMapB, color) {
  const count = xs.length;
  const positions = new Float32Array(count * 6);
  const yMap = new Array(count * 2);

  for (let index = 0; index < count; index += 1) {
    positions[index * 6] = xs[index];
    positions[index * 6 + 1] = GROUND_EPSILON;
    positions[index * 6 + 2] = zA[index];
    positions[index * 6 + 3] = xs[index];
    positions[index * 6 + 4] = GROUND_EPSILON;
    positions[index * 6 + 5] = zB[index];
    yMap[index * 2] = yMapA[index];
    yMap[index * 2 + 1] = yMapB[index];
  }

  const indices = [];
  for (let index = 0; index < count - 1; index += 1) {
    const a0 = index * 2;
    const b0 = a0 + 1;
    const a1 = a0 + 2;
    const b1 = a0 + 3;
    indices.push(a0, b0, a1, b0, b1, a1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return { geometry, color, yMap };
}

function useFlowGeometry({ buckets, baselineLoad, optimisedLoad, peakLoad }) {
  return useMemo(() => {
    const hourCount = buckets.length;
    if (hourCount < 2) return { bands: [], totalWidth: 0, altitudes: { base: [], optimised: [] } };

    const totalWidth = (hourCount - 1) * UNIT_X;
    const fineCount = (hourCount - 1) * FINE_STEPS_PER_GAP + 1;
    const fineXs = Array.from({ length: fineCount }, (_, index) => (index / (fineCount - 1)) * totalWidth - totalWidth / 2);
    const sampleRefs = Array.from({ length: fineCount }, (_, index) => index);
    const groundRefs = Array.from({ length: fineCount }, () => GROUND_REF);

    const stablePeakLoad = Math.max(1, Number(peakLoad) || 0, ...baselineLoad);
    const toAltitude = (series) => resample(
      series.map((watts) => (clamp(watts / stablePeakLoad, 0, 1)) * MAX_ALTITUDE),
      fineCount,
    ).map((value) => clamp(value, GROUND_EPSILON, MAX_ALTITUDE));

    const altitudes = { base: toAltitude(baselineLoad), optimised: toAltitude(optimisedLoad) };

    const rawBands = SOURCE_ORDER.map((source) => {
      const values = buckets.map((bucket) => aggregateSourceMix(bucket.sourceMix)[source] || 0);
      return resample(values, fineCount).map((value) => Math.max(0, value));
    });
    const totals = fineXs.map((_, sample) => rawBands.reduce((sum, series) => sum + series[sample], 0));

    let cumulative = fineXs.map(() => -DEPTH_SCALE / 2);
    const bands = SOURCE_ORDER.map((source, sourceIndex) => {
      const thickness = rawBands[sourceIndex].map((value, sample) => (value / (totals[sample] || 1)) * DEPTH_SCALE);
      const zBottom = cumulative.slice();
      const zTop = zBottom.map((z, sample) => z + thickness[sample]);
      cumulative = zTop;
      const last = fineCount - 1;

      return {
        source,
        zBottom,
        zTop,
        parts: [
          buildQuadStrip(fineXs, zBottom, zTop, sampleRefs, sampleRefs, SOURCE_COLORS[source]),
          buildEndCap(fineXs[0], zBottom[0], zTop[0], 0, SOURCE_COLORS[source]),
          buildEndCap(fineXs[last], zBottom[last], zTop[last], last, SOURCE_COLORS[source]),
        ],
      };
    });

    const first = bands[0];
    const last = bands[bands.length - 1];
    first.parts.push(buildQuadStrip(fineXs, first.zBottom, first.zBottom, sampleRefs, groundRefs, SOURCE_COLORS[first.source]));
    last.parts.push(buildQuadStrip(fineXs, last.zTop, last.zTop, groundRefs, sampleRefs, SOURCE_COLORS[last.source]));

    return { bands, totalWidth, altitudes, fineCount };
  }, [buckets, baselineLoad, optimisedLoad, peakLoad]);
}

function FlowSurface({ bands, altitudes, progress, totalWidth, hourCount, onHover }) {
  const group = useRef(null);
  const lastProgress = useRef(-1);
  const lastAltitudes = useRef(null);

  useFrame(() => {
    const t = progress.current;
    if (lastAltitudes.current === altitudes && Math.abs(t - lastProgress.current) < 0.0005) return;
    lastProgress.current = t;
    lastAltitudes.current = altitudes;
    const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;

    for (const band of bands) {
      for (const part of band.parts) {
        const positions = part.geometry.attributes.position.array;
        for (let vertex = 0; vertex < part.yMap.length; vertex += 1) {
          const sample = part.yMap[vertex];
          positions[vertex * 3 + 1] = sample === GROUND_REF
            ? GROUND_EPSILON
            : altitudes.base[sample] + (altitudes.optimised[sample] - altitudes.base[sample]) * eased;
        }
        part.geometry.attributes.position.needsUpdate = true;
        part.geometry.computeVertexNormals();
      }
    }
  });

  function handleMove(event) {
    event.stopPropagation();
    onHover(clamp(Math.round((event.point.x + totalWidth / 2) / UNIT_X), 0, hourCount - 1));
  }

  return (
    <group onPointerLeave={() => onHover(null)} onPointerMove={handleMove} ref={group}>
      {bands.map(({ source, parts }) => (
        <group key={source}>
          {parts.map((part, index) => (
            <mesh geometry={part.geometry} key={index}>
              <meshStandardMaterial
                color={part.color}
                emissive={part.color}
                emissiveIntensity={0.22}
                metalness={0.08}
                roughness={0.32}
                side={2}
              />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function HourLabels({ buckets, totalWidth }) {
  const labelled = buckets.filter((_, index) => index === 0 || index === buckets.length - 1 || index % 6 === 0);

  return (
    <>
      {labelled.map((bucket) => {
        const index = buckets.indexOf(bucket);
        return (
          <Html center key={bucket.timestamp} position={[index * UNIT_X - totalWidth / 2, 0, DEPTH_SCALE / 2 + 1]} style={{ pointerEvents: "none" }}>
            <div className="hero3d-hour-label">{formatHour(bucket.timestamp, { withMinute: true })}</div>
          </Html>
        );
      })}
      <Html center position={[0, 0, DEPTH_SCALE / 2 + 2]} style={{ pointerEvents: "none" }}>
        <div className="hero3d-axis-title">Time</div>
      </Html>
    </>
  );
}

function AltitudeAxis({ totalWidth }) {
  const x = -totalWidth / 2 - 0.3;
  const z = -DEPTH_SCALE / 2 - 0.4;

  return (
    <>
      <Line color="#8a8880" lineWidth={1.5} points={[[x, 0, z], [x, MAX_ALTITUDE, z]]} />
      {[0, 50, 100].map((percent) => (
        <Html center key={percent} position={[x, (percent / 100) * MAX_ALTITUDE, z]} style={{ pointerEvents: "none" }}>
          <div className="hero3d-depth-label">{percent}% load</div>
        </Html>
      ))}
      <Html center position={[x, MAX_ALTITUDE + 0.7, z]} style={{ pointerEvents: "none" }}>
        <div className="hero3d-axis-title">Compute load</div>
      </Html>
    </>
  );
}

function SourceAxis({ totalWidth }) {
  const x = -totalWidth / 2 - 0.3;
  return (
    <>
      <Line color="#8a8880" lineWidth={1.5} points={[[x, 0.05, -DEPTH_SCALE / 2], [x, 0.05, DEPTH_SCALE / 2]]} />
      <Html center position={[x, 0.05, 0]} style={{ pointerEvents: "none" }}>
        <div className="hero3d-axis-title">Energy sources</div>
      </Html>
    </>
  );
}

function HoverCursor({ buckets, totalWidth, hoveredIndex, baselineLoad, optimisedLoad, peakLoad, progress }) {
  const [blend, setBlend] = useState(progress.current);

  useFrame(() => {
    if (hoveredIndex != null) setBlend(progress.current);
  });

  if (hoveredIndex == null) return null;
  const bucket = buckets[hoveredIndex];
  if (!bucket) return null;

  const x = hoveredIndex * UNIT_X - totalWidth / 2;
  const totals = aggregateSourceMix(bucket.sourceMix);
  const breakdown = SOURCE_ORDER
    .map((key) => ({ key, value: totals[key] || 0 }))
    .filter((entry) => entry.value >= 1)
    .sort((left, right) => right.value - left.value);

  // Track the same morph progress FlowSurface animates on, not the raw target
  // state, so the cursor never floats above/below the terrain mid-transition.
  const baseWatts = baselineLoad[hoveredIndex] || 0;
  const optWatts = optimisedLoad[hoveredIndex] || 0;
  const watts = baseWatts + (optWatts - baseWatts) * blend;
  const percent = clamp((watts / peakLoad) * 100, 0, 100);
  const altitude = (percent / 100) * MAX_ALTITUDE;

  return (
    <group>
      <Line color="#31824b" lineWidth={1.5} points={[[x, 0.02, 0], [x, altitude, 0]]} />
      <Line color="#31824b" lineWidth={3} points={[[x, altitude, -DEPTH_SCALE / 2], [x, altitude, DEPTH_SCALE / 2]]} />
      <Html center position={[x, altitude + 0.9, 0]} style={{ pointerEvents: "none" }}>
        <div className="hero3d-tooltip">
          <strong>{formatHour(bucket.timestamp, { withMinute: true })}</strong>
          <span>{(watts / 1000).toFixed(2)} kW · {percent.toFixed(0)}% of peak</span>
          <small className="hero3d-breakdown">
            {breakdown.map((entry) => `${SOURCE_LABELS[entry.key] || entry.key} ${entry.value.toFixed(0)}%`).join(" · ")}
          </small>
        </div>
      </Html>
    </group>
  );
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function IntroCamera({ start, end, lookStart, lookEnd, onComplete }) {
  const { camera } = useThree();
  const elapsed = useRef(0);
  const done = useRef(false);
  const startVec = useRef(new Vector3(...start));
  const endVec = useRef(new Vector3(...end));
  const lookStartVec = useRef(new Vector3(...lookStart));
  const lookEndVec = useRef(new Vector3(...lookEnd));
  const scratch = useRef(new Vector3());

  useFrame((_, delta) => {
    if (done.current) return;
    elapsed.current += Math.min(delta, 1 / 30);
    const eased = easeOutCubic(clamp(elapsed.current / INTRO_DURATION, 0, 1));
    camera.position.lerpVectors(startVec.current, endVec.current, eased);
    camera.lookAt(scratch.current.lerpVectors(lookStartVec.current, lookEndVec.current, eased));
    if (eased >= 1) {
      done.current = true;
      onComplete?.();
    }
  });

  return null;
}

function IdleSway({ controlsRef, paused }) {
  const elapsed = useRef(0);
  const base = useRef(null);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (paused) {
      base.current = null;
      return;
    }

    if (base.current === null) {
      base.current = { az: controls.getAzimuthalAngle(), polar: controls.getPolarAngle() };
      elapsed.current = 0;
    }

    elapsed.current += Math.min(delta, 1 / 30);
    const t = elapsed.current;
    controls.setAzimuthalAngle(base.current.az + 0.22 * Math.sin(t * 0.35));
    controls.setPolarAngle(base.current.polar + 0.08 * Math.sin(t * 0.27 + 1.1));
  });

  return null;
}

function ShiftDriver({ optimised, progress }) {
  useFrame((_, delta) => {
    const target = optimised ? 1 : 0;
    const step = Math.min(delta, 1 / 30) * SHIFT_SPEED;
    progress.current = target > progress.current
      ? Math.min(target, progress.current + step)
      : Math.max(target, progress.current - step);
  });
  return null;
}

export default function GridHero3D({
  buckets,
  baselineLoad = [],
  optimisedLoad = [],
  peakLoad,
  optimised = false,
}) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [introDone, setIntroDone] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const controlsRef = useRef(null);
  const progress = useRef(0);
  const { bands, totalWidth, altitudes } = useFlowGeometry({ buckets, baselineLoad, optimisedLoad, peakLoad });

  const cursorPeakLoad = Math.max(1, Number(peakLoad) || 0, ...baselineLoad);
  const heroPosition = [totalWidth * 0.03, 6.5, 20.5];
  const heroLookAt = [0, MAX_ALTITUDE * 0.2, 0];
  const introStart = [0, 32, 0.8];

  return (
    <div className="grid-hero-canvas grid-hero-3d">
      <div className="hero3d-toolbar">
        <span className="hero3d-hint">Drag to explore · hover the flow to see the mix and compute load for that hour</span>
      </div>
      <Canvas camera={{ position: introStart, fov: 40 }} dpr={[1, 2]}>
        <color args={["#fffdf7"]} attach="background" />
        <ambientLight intensity={0.95} />
        <hemisphereLight args={["#ffffff", "#f3ead6", 0.5]} />
        <directionalLight intensity={1.05} position={[10, 16, 8]} />
        <directionalLight color="#fff3d6" intensity={0.35} position={[-8, 10, -6]} />

        <Grid
          args={[totalWidth + 6, DEPTH_SCALE + 6]}
          cellColor="#ece9df"
          cellSize={UNIT_X}
          fadeDistance={40}
          fadeStrength={1}
          infiniteGrid={false}
          position={[0, 0, 0]}
          sectionColor="#d5d2c6"
          sectionSize={UNIT_X * 6}
        />

        <FlowSurface
          altitudes={altitudes}
          bands={bands}
          hourCount={buckets.length}
          onHover={setHoveredIndex}
          progress={progress}
          totalWidth={totalWidth}
        />
        <HourLabels buckets={buckets} totalWidth={totalWidth} />
        <AltitudeAxis totalWidth={totalWidth} />
        <SourceAxis totalWidth={totalWidth} />
        <HoverCursor
          baselineLoad={baselineLoad}
          buckets={buckets}
          hoveredIndex={hoveredIndex}
          optimisedLoad={optimisedLoad}
          peakLoad={cursorPeakLoad}
          progress={progress}
          totalWidth={totalWidth}
        />

        <ShiftDriver optimised={optimised} progress={progress} />

        {!introDone && (
          <IntroCamera
            end={heroPosition}
            lookEnd={heroLookAt}
            lookStart={[0, 0, 0]}
            onComplete={() => setIntroDone(true)}
            start={introStart}
          />
        )}
        {introDone && (
          <>
            <OrbitControls
              dampingFactor={0.12}
              enableDamping
              makeDefault
              maxDistance={48}
              maxPolarAngle={Math.PI / 2.05}
              minDistance={6}
              onEnd={() => setIsInteracting(false)}
              onStart={() => setIsInteracting(true)}
              ref={controlsRef}
              target={heroLookAt}
            />
            <IdleSway controlsRef={controlsRef} paused={isInteracting || hoveredIndex !== null || optimised} />
          </>
        )}
      </Canvas>
    </div>
  );
}
