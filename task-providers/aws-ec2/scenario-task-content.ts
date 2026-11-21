export const awsEc2ScenarioTaskContent = {
  entry: "#scenario",
  files: {
    "flake.nix": `{ outputs = { self }: { apps.scenario = { type = "app"; program = "${"${self}"}/scenario.sh"; }; }; };
`,
    "flake.lock": `{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}
`,
    "scenario.sh": "#!/bin/sh\nprintf '%s\\n' '{\"scenario\":\"aws-ec2\"}'\n",
  },
  archiveSha256: "e08fdcfbaf30b5110b828627cdd997dd4b83b5d98d23bcb02e5b0123741f8085",
  treeSha256: "45ff89f6ae206a209e101791479f4b236a6dba57c2195153258b2fa4e9913cbd",
} as const;
