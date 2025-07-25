import { z } from "zod";
import fs from "fs/promises";
const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | { [key: string]: Json } | Json[];
const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([literalSchema, z.array(jsonSchema), z.record(jsonSchema)]),
);

const ConfigSchema = z.object({
  lsps: z.array(
    z.object({
      id: z.string(),
      extensions: z.array(z.string()),
      languages: z.array(z.string()),
      command: z.string(),
      args: z.array(z.string()),
      settings: z.optional(z.record(jsonSchema)),
      eagerStartup: z.optional(z.boolean(), { description: "Start language when the MCP is initialized" }),
      waitForConfiguration: z.optional(z.boolean(), { description: "Wait for the server to request configuration before starting" }),
      strictDiagnostics: z.optional(z.boolean(), { description: "Wait for diagnostics to be reported for every file." }),
    }),
  ),
  methods: z.optional(z.array(z.string()), {
    description: "LSP methods to enable, if not provided, all methods will be enabled",
  }),
  workspace: z.optional(z.string(), {
    description: "Path to the workspace to use for the LSP. Defaults to /"
  }),
  instructions: z.optional(z.string(), {
    description: "Instructions on how to use lspMcp",
  }),
  perToolInstructions: z.optional(z.map(z.string(), z.string()), { description: "Optional description overrides for each tool" })
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(path: string): Promise<Config> {
  const stripJsonComments = await import("strip-json-comments");
  const contents = await fs.readFile(path, "utf8");
  const config = stripJsonComments.default(contents);

  return await ConfigSchema.parseAsync(JSON.parse(config));
}
