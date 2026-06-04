import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import { D1DatabaseCI } from "../_internal/interfaces";

// ---- Zod Enums for Config Options ----

const PrimaryLocationHint = z.enum([
  "wnam",
  "enam",
  "weur",
  "eeur",
  "apac",
  "oc",
]);

const Jurisdiction = z.enum(["eu", "fedramp"]);

const ReadReplicationMode = z.enum(["auto", "disabled"]);

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    bind: {
      description: "binds the D1 database to a connecting Cloudflare Worker",
      interface: D1DatabaseCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    accountId: z.string(),
    primaryLocationHint: PrimaryLocationHint.optional(),
    jurisdiction: Jurisdiction.optional(),
    readReplication: ReadReplicationMode.default("disabled"),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    uuid: z.string(),
  }),
});

// ---- Cloudflare Provider Implementation ----

component.implement(CloudProvider.cloudflare, {
  stateSchema: z.object({
    databaseName: z.string(),
    databaseId: z.string(),
    accountId: z.string(),
  }),
  initialState: {},

  pulumi: async ({
    $,
    inputs,
    state,
    cloudflare: cfProvider,
  }) => {
    const { accountId, primaryLocationHint, jurisdiction, readReplication } =
      inputs;

    // Default opts for all Cloudflare resources — uses the explicit provider
    const cfOpts: pulumi.CustomResourceOptions = cfProvider
      ? { provider: cfProvider }
      : {};

    const databaseName = $`database`;

    const database = new cloudflare.D1Database(
      $`d1`,
      {
        accountId,
        name: databaseName,
        primaryLocationHint,
        jurisdiction,
        readReplication: { mode: readReplication },
      },
      cfOpts,
    );

    // Store state for connection handlers
    state.databaseName = databaseName;
    state.databaseId = database.uuid;
    state.accountId = accountId;

    return {
      id: database.id,
      name: database.name,
      uuid: database.uuid,
    };
  },

  connect: (({ state }: any) => [
    connectionHandler({
      interface: D1DatabaseCI,
      handler: async (_ctx: any) => {
        return {
          uri: pulumi.interpolate`d1://${state.databaseName}`,
          metadata: {
            databaseId: state.databaseId,
          },
        };
      },
    }),
  ]),
});

export default component;
