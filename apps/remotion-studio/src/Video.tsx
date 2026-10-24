import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, Freeze, Img, OffthreadVideo, cancelRender, continueRender, delayRender, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { captionAt, captionLayout, cssFamily, FONT_UNITS, headlineSize, unit, videoBox, type RenderProps, type SceneProp, type VideoProp } from "./props.ts";

type Brand = RenderProps["brand"];
const C = (b: Brand) => b.colors;

/** Loads every declared font face before the first frame; fails the render if any face fails. */
function useFonts(fonts: Brand["fonts"]): void {
  const [handle] = useState(() => delayRender("Loading brand fonts"));
  useEffect(() => {
    const faces: FontFace[] = [];
    for (const slot of ["heading", "body", "mono"] as const) {
      for (const f of fonts[slot].faces) {
        faces.push(new FontFace(cssFamily(slot), `url(${staticFile(f.file)}) format("woff")`, { weight: String(f.weight), unicodeRange: f.unicodeRange }));
      }
    }
    Promise.all(faces.map((f) => f.load()))
      .then((loaded) => {
        for (const f of loaded) document.fonts.add(f);
        continueRender(handle);
      })
      .catch((e: unknown) => cancelRender(new Error(`Brand font failed to load: ${String(e)}`)));
  }, [fonts, handle]);
}

/** Restrained entrance: fade + small rise, eased with a damped spring. */
function useEntrance(delay = 0, intensity: SceneProp["motion"]["intensity"] = "medium") {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: intensity === "high" ? 14 : 22, mass: 0.8 } });
  const rise = { low: 12, medium: 24, high: 40 }[intensity];
  return { opacity: p, transform: `translateY(${(1 - p) * rise}px)` };
}

function SafeArea({ s, children, justify = "center" }: { s: SceneProp; children: React.ReactNode; justify?: "center" | "flex-start" | "flex-end" }) {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        paddingTop: s.safeArea.top * height,
        paddingBottom: s.safeArea.bottom * height,
        paddingLeft: s.safeArea.left * width,
        paddingRight: s.safeArea.right * width,
        justifyContent: justify,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

function SourceLabel({ text, brand, delay = 10 }: { text?: string; brand: Brand; delay?: number }) {
  const { width, height } = useVideoConfig();
  const style = useEntrance(delay, "low");
  if (!text) return null;
  return (
    <div style={{ ...style, marginTop: unit(width, height) * 4, fontFamily: cssFamily("body"), fontWeight: 600, fontSize: unit(width, height) * FONT_UNITS.sourceLabel, color: C(brand).secondary, letterSpacing: 0.5 }}>
      {text}
    </div>
  );
}

function Headline({ text, brand, kind, delay = 0, intensity }: { text: string; brand: Brand; kind: "hook" | "headline" | "body"; delay?: number; intensity: SceneProp["motion"]["intensity"] }) {
  const { width, height } = useVideoConfig();
  const style = useEntrance(delay, intensity);
  return (
    <div style={{ ...style, fontFamily: cssFamily(kind === "body" ? "body" : "heading"), fontWeight: kind === "body" ? 400 : 700, fontSize: headlineSize(text, width, height, kind), lineHeight: 1.18, color: C(brand).text, letterSpacing: kind === "hook" ? -1 : -0.3, whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>
      {text}
    </div>
  );
}

function AccentBar({ brand, delay = 0 }: { brand: Brand; delay?: number }) {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const w = interpolate(frame - delay, [0, 18], [0, unit(width, height) * 14], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ width: w, height: unit(width, height) * 0.9, background: C(brand).accent, borderRadius: 4, marginBottom: unit(width, height) * 4 }} />;
}

// ------------------------------------------------------------------ scene components

function Hook({ s, brand }: { s: SceneProp; brand: Brand }) {
  return (
    <SafeArea s={s}>
      <AccentBar brand={brand} />
      <Headline text={s.primary} brand={brand} kind="hook" intensity={s.motion.intensity} />
      <SourceLabel text={s.secondary} brand={brand} />
    </SafeArea>
  );
}

function Title({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  return (
    <SafeArea s={s}>
      <div style={{ fontFamily: cssFamily("body"), fontWeight: 600, fontSize: unit(width, height) * FONT_UNITS.label, color: C(brand).secondary, textTransform: "uppercase", letterSpacing: 3, marginBottom: unit(width, height) * 3 }}>{brand.name}</div>
      <Headline text={s.primary} brand={brand} kind="headline" intensity={s.motion.intensity} delay={4} />
      <SourceLabel text={s.secondary} brand={brand} />
    </SafeArea>
  );
}

function Explanation({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  return (
    <SafeArea s={s}>
      <div style={{ borderLeft: `${u * 0.9}px solid ${C(brand).primary}`, paddingLeft: u * 5 }}>
        <Headline text={s.primary} brand={brand} kind="headline" intensity={s.motion.intensity} />
        <SourceLabel text={s.secondary} brand={brand} />
      </div>
    </SafeArea>
  );
}

function Comparison({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const style = useEntrance(0, s.motion.intensity);
  return (
    <SafeArea s={s}>
      <div style={{ ...style, display: "flex", flexDirection: "column", gap: u * 3, border: `2px solid ${C(brand).secondary}55`, borderRadius: u * 2.5, padding: u * 6, background: `${C(brand).primary}14` }}>
        <div style={{ fontFamily: cssFamily("body"), fontWeight: 600, fontSize: u * FONT_UNITS.label, color: C(brand).accent, textTransform: "uppercase", letterSpacing: 2 }}>Comparison point</div>
        <Headline text={s.primary} brand={brand} kind="headline" intensity="low" delay={6} />
        <SourceLabel text={s.secondary} brand={brand} />
      </div>
    </SafeArea>
  );
}

function Framed({ s, brand, children }: { s: SceneProp; brand: Brand; children: React.ReactNode }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const style = useEntrance(0, s.motion.intensity);
  return (
    <SafeArea s={s}>
      <div style={{ ...style, borderRadius: u * 2, overflow: "hidden", border: `1px solid ${C(brand).text}22`, background: "#00000055", marginBottom: u * 5 }}>{children}</div>
      <Headline text={s.primary} brand={brand} kind="body" intensity="low" delay={8} />
      <SourceLabel text={s.secondary} brand={brand} delay={14} />
    </SafeArea>
  );
}

// ------------------------------------------------------------------ video clips

/**
 * A registered clip: plays [trimBefore, trimBefore + playFrames) of the source,
 * muted (narration is the only audio), then holds the last shown frame if the
 * scene is longer than the clip window. Rendered with OffthreadVideo, so frames
 * are extracted by Remotion's compositor rather than a browser <video>.
 */
function Clip({ v, style }: { v: VideoProp; style: React.CSSProperties }) {
  const media = <OffthreadVideo src={staticFile(v.file)} trimBefore={v.trimBefore > 0 ? v.trimBefore : undefined} trimAfter={v.trimBefore + v.playFrames} muted style={{ width: "100%", height: "100%", objectFit: v.fit, display: "block", ...style }} />;
  return (
    <>
      <Sequence durationInFrames={v.playFrames} layout="none" name="clip">
        {media}
      </Sequence>
      {v.holdFrames > 0 ? (
        <Sequence from={v.playFrames} durationInFrames={v.holdFrames} layout="none" name="clip hold">
          <Freeze frame={v.playFrames - 1}>{media}</Freeze>
        </Sequence>
      ) : null}
    </>
  );
}

function FramedClip({ s, maxShare }: { s: SceneProp; maxShare: number }) {
  const { width, height } = useVideoConfig();
  const v = s.video!;
  const inner = width * (1 - s.safeArea.left - s.safeArea.right);
  const box = videoBox(v, inner, height * maxShare);
  return (
    <div style={{ width: box.width, height: box.height, background: "#000000" }}>
      <Clip v={v} style={{}} />
    </div>
  );
}

/** Video behind a scene's text, dimmed with a flat scrim so captions and headlines stay legible. */
function Backdrop({ v }: { v: VideoProp }) {
  return (
    <AbsoluteFill>
      <Clip v={v} style={{}} />
      <AbsoluteFill style={{ background: "rgba(0,0,0,0.58)" }} />
    </AbsoluteFill>
  );
}

function Attribution({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  if (!s.attribution) return null;
  const u = unit(width, height);
  return (
    <div style={{ position: "absolute", top: s.safeArea.top * height * 0.55, left: s.safeArea.left * width, right: s.safeArea.right * width, fontFamily: cssFamily("body"), fontWeight: 400, fontSize: u * FONT_UNITS.attribution, color: C(brand).secondary, opacity: 0.9 }}>
      {s.attribution}
    </div>
  );
}

function ScreenCapture({ s, brand }: { s: SceneProp; brand: Brand }) {
  return (
    <Framed s={s} brand={brand}>
      <FramedClip s={s} maxShare={0.46} />
    </Framed>
  );
}

function Diagram({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { height } = useVideoConfig();
  if (!s.image) return <Explanation s={s} brand={brand} />;
  return (
    <Framed s={s} brand={brand}>
      <Img src={staticFile(s.image.file)} alt={s.image.alt} style={{ width: "100%", maxHeight: height * 0.42, objectFit: "contain", display: "block", background: "#ffffff" }} />
    </Framed>
  );
}

function CodeDemo({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const lines = (s.code ?? "").split("\n").slice(0, 18);
  return (
    <Framed s={s} brand={brand}>
      <div style={{ display: "flex", gap: u, padding: `${u * 1.6}px ${u * 2}px`, background: "#ffffff10" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <div key={c} style={{ width: u * 1.6, height: u * 1.6, borderRadius: "50%", background: c }} />
        ))}
      </div>
      {s.video && s.video.layout === "frame" ? (
        <FramedClip s={s} maxShare={0.4} />
      ) : s.image ? (
        <Img src={staticFile(s.image.file)} alt={s.image.alt} style={{ width: "100%", maxHeight: height * 0.4, objectFit: "contain", display: "block" }} />
      ) : (
        <pre style={{ margin: 0, padding: u * 3, fontFamily: cssFamily("mono"), fontSize: u * FONT_UNITS.code, lineHeight: 1.45, color: C(brand).text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{lines.join("\n")}</pre>
      )}
    </Framed>
  );
}

function Quote({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  return (
    <SafeArea s={s}>
      <div style={{ fontFamily: cssFamily("heading"), fontWeight: 700, fontSize: u * 16, lineHeight: 0.6, color: C(brand).accent, marginBottom: u * 2 }}>“</div>
      {s.image ? <Img src={staticFile(s.image.file)} alt={s.image.alt} style={{ width: "100%", maxHeight: height * 0.3, objectFit: "contain", marginBottom: u * 4, borderRadius: u }} /> : null}
      <Headline text={s.primary} brand={brand} kind="headline" intensity="low" />
      <SourceLabel text={s.secondary} brand={brand} />
    </SafeArea>
  );
}

function Summary({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const style = useEntrance(0, s.motion.intensity);
  return (
    <SafeArea s={s}>
      <div style={{ ...style, background: `${C(brand).primary}22`, border: `2px solid ${C(brand).primary}`, borderRadius: u * 2.5, padding: u * 6 }}>
        <div style={{ fontFamily: cssFamily("body"), fontWeight: 600, fontSize: u * FONT_UNITS.label, color: C(brand).accent, textTransform: "uppercase", letterSpacing: 2, marginBottom: u * 3 }}>Key point</div>
        <Headline text={s.primary} brand={brand} kind="headline" intensity="low" delay={4} />
      </div>
      <SourceLabel text={s.secondary} brand={brand} />
    </SafeArea>
  );
}

function Outro({ s, brand }: { s: SceneProp; brand: Brand }) {
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const style = useEntrance(0, "low");
  return (
    <SafeArea s={s}>
      <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: u * 4 }}>
        {s.image ? <Img src={staticFile(s.image.file)} alt={s.image.alt} style={{ width: u * 22, height: u * 22, objectFit: "contain" }} /> : null}
        <div style={{ fontFamily: cssFamily("heading"), fontWeight: 700, fontSize: u * 7, color: C(brand).text }}>{brand.name}</div>
        {s.primary !== brand.name ? <div style={{ fontFamily: cssFamily("body"), fontSize: u * 4, color: C(brand).secondary }}>{s.primary}</div> : null}
        <div style={{ width: u * 10, height: u * 0.6, background: C(brand).accent, borderRadius: 3 }} />
      </div>
    </SafeArea>
  );
}

const COMPONENTS: Record<SceneProp["component"], React.FC<{ s: SceneProp; brand: Brand }>> = { Hook, Title, Explanation, Diagram, CodeDemo, Comparison, Quote, Summary, Outro, ScreenCapture };

// ------------------------------------------------------------------ chrome: progress, captions, transitions

function SceneFrame({ s, brand }: { s: SceneProp; brand: Brand }) {
  const frame = useCurrentFrame();
  const Comp = COMPONENTS[s.component];
  const fade = s.motion.transitionIn === "fade" || s.motion.transitionIn === "slide" ? interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const out = interpolate(frame, [s.durationInFrames - 6, s.durationInFrames], [1, 0.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const isLast = s.index === s.total - 1;
  return (
    <AbsoluteFill style={{ opacity: Math.min(fade, isLast ? 1 : out) }}>
      {s.video && s.video.layout === "backdrop" ? <Backdrop v={s.video} /> : null}
      <Comp s={s} brand={brand} />
      <Attribution s={s} brand={brand} />
    </AbsoluteFill>
  );
}

function Progress({ total, brand }: { total: number; brand: Brand }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return <div style={{ position: "absolute", top: 0, left: 0, height: unit(width, height) * 0.5, width: `${(frame / Math.max(1, total - 1)) * 100}%`, background: C(brand).primary }} />;
}

function Captions({ props }: { props: RenderProps }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = unit(width, height);
  const cue = captionAt(props.captions, frame);
  const scene = props.scenes.find((x) => frame >= x.startFrame && frame < x.startFrame + x.durationInFrames);
  if (!cue) return null;
  // Geometry shared with the QA step (props.ts captionLayout).
  const L = captionLayout(width, height, scene?.safeArea.bottom ?? 0.15, cue.lines.length);
  return (
    <div style={{ position: "absolute", left: "8%", right: "8%", bottom: L.bottomPx, display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,0.72)", borderRadius: u * 1.2, padding: `${L.padV}px ${L.padH}px`, fontFamily: cssFamily("body"), fontWeight: 600, fontSize: L.fontPx, lineHeight: 1.3, color: "#ffffff", textAlign: "center", whiteSpace: "pre-line" }}>
        {cue.lines.join("\n")}
      </div>
    </div>
  );
}

export const CreatorFlowVideo: React.FC<RenderProps> = (props) => {
  useFonts(props.brand.fonts);
  return (
    <AbsoluteFill style={{ background: C(props.brand).background }}>
      {props.scenes.map((s) => (
        <Sequence key={s.sceneId} from={s.startFrame} durationInFrames={s.durationInFrames} name={`${s.sceneId} ${s.type}`}>
          <SceneFrame s={s} brand={props.brand} />
        </Sequence>
      ))}
      <Progress total={props.format.durationInFrames} brand={props.brand} />
      {props.captions.length ? <Captions props={props} /> : null}
      {props.audio ? <Audio src={staticFile(props.audio.file)} /> : null}
    </AbsoluteFill>
  );
};
