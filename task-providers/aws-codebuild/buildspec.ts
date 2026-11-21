export const renderCodeBuildBuildspec=()=>`version: 0.2
phases:
  build:
    commands:
      - node "$SDLC_TASK_CARRIAGE_PATH" --delivery "$SDLC_TASK_DELIVERY_URI"
`;
export const codeBuildCarriageProgram=new TextEncoder().encode(`import { readFile } from "node:fs/promises";\nawait import(process.env.SDLC_TASK_CARRIAGE_PATH);\n`);
