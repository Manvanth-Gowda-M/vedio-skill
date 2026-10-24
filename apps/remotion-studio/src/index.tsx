import React from "react";
import { Composition, registerRoot } from "remotion";
import { COMPOSITION_ID, type RenderProps } from "./props.ts";
import { CreatorFlowVideo } from "./Video.tsx";

const EMPTY: RenderProps = {
  format: { width: 1080, height: 1920, fps: 30, durationInFrames: 30 },
  brand: {
    name: "",
    colors: { primary: "#7C5CFF", secondary: "#22D3EE", accent: "#F59E0B", background: "#0B0D12", text: "#F5F7FA" },
    fonts: { heading: { family: "", faces: [] }, body: { family: "", faces: [] }, mono: { family: "", faces: [] } },
  },
  scenes: [],
  captions: [],
  captionsTiming: "estimated",
};

/** Dimensions, fps and duration come only from the validated input props. */
const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={CreatorFlowVideo}
    defaultProps={EMPTY}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30}
    calculateMetadata={({ props }) => ({ width: props.format.width, height: props.format.height, fps: props.format.fps, durationInFrames: props.format.durationInFrames })}
  />
);

registerRoot(Root);
